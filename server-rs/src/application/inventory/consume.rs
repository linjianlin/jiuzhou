use std::collections::BTreeMap;

use axum::http::StatusCode;
use sqlx::{Postgres, Row, Transaction};

use crate::edge::http::error::BusinessError;

/**
 * 角色存量资源与材料原子扣费模块。
 *
 * 作用：
 * 1. 做什么：统一处理角色银两/灵石/经验与背包材料的扣减，输出 Node 兼容的不足提示，供功法升级、境界突破等成长写链路复用。
 * 2. 做什么：把角色行锁、背包行锁、材料扣减计划与最终写库收敛到单一入口，避免多个服务各自维护不同的扣费顺序与报错口径。
 * 3. 不做什么：不决定具体业务消耗规则，不负责成就/主线推进，也不处理带 metadata 的复杂实例消耗。
 *
 * 输入 / 输出：
 * - 输入：事务句柄、`character_id`、标准化后的资源成本与材料需求。
 * - 输出：成功时返回扣费后的剩余资源；失败时返回业务失败消息，由上层决定是否直接回包。
 *
 * 数据流 / 状态流：
 * - 业务服务先计算成本 -> 本模块锁定 `characters` 资源行
 * - -> 若资源足够，再批量锁定 `item_instance` 背包材料并生成扣减计划
 * - -> 在同一事务内完成资源与材料写库 -> 上层继续自己的业务写入并提交事务。
 *
 * 复用设计说明：
 * - realm 与 character technique 都有“资源 + 材料”扣费需求；集中在这里后，锁顺序、报错文案与材料消费顺序只维护一份。
 * - 材料计划先聚合 `item_def_id`，再一次性查询并顺序消费最早实例，避免调用方各自重复扫描背包，后续 craft/partner 等链路也可直接复用。
 *
 * 关键边界条件与坑点：
 * 1. 这里只支持普通背包材料扣减；若未来要消费仓库或指定实例，必须走独立入口，不能偷偷扩展这里的语义。
 * 2. 资源不足时不应先锁整批材料实例，否则高并发下会把无关请求一起拖慢；因此必须先锁角色资源，再按需锁材料。
 */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CharacterStoredResourceCost {
    pub silver: i64,
    pub spirit_stones: i64,
    pub exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterialConsumeRequirement {
    pub item_def_id: String,
    pub qty: i64,
    pub item_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CharacterStoredResourcesConsumeInput {
    pub resources: CharacterStoredResourceCost,
    pub materials: Vec<MaterialConsumeRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterStoredResourcesConsumeResult {
    pub remaining_silver: i64,
    pub remaining_spirit_stones: i64,
    pub remaining_exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CharacterStoredResourcesConsumeOutcome {
    Success(CharacterStoredResourcesConsumeResult),
    Failure { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockedMaterialRow {
    id: i64,
    qty: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MaterialMutation {
    Delete { instance_id: i64 },
    Decrement { instance_id: i64, consume_qty: i64 },
}

enum MaterialMutationBuildOutcome {
    Success(Vec<MaterialMutation>),
    Failure { message: String },
}

pub async fn consume_character_stored_resources_and_materials_atomically(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
    input: &CharacterStoredResourcesConsumeInput,
) -> Result<CharacterStoredResourcesConsumeOutcome, BusinessError> {
    let normalized_resources = CharacterStoredResourceCost {
        silver: input.resources.silver.max(0),
        spirit_stones: input.resources.spirit_stones.max(0),
        exp: input.resources.exp.max(0),
    };
    let normalized_materials = normalize_material_requirements(&input.materials);

    let character_row = sqlx::query(
        r#"
        SELECT
          COALESCE(silver, 0)::bigint AS silver,
          COALESCE(spirit_stones, 0)::bigint AS spirit_stones,
          COALESCE(exp, 0)::bigint AS exp
        FROM characters
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(internal_business_error)?;
    let Some(character_row) = character_row else {
        return Ok(CharacterStoredResourcesConsumeOutcome::Failure {
            message: "角色不存在".to_string(),
        });
    };

    let current_silver = character_row.get::<i64, _>("silver").max(0);
    let current_spirit_stones = character_row.get::<i64, _>("spirit_stones").max(0);
    let current_exp = character_row.get::<i64, _>("exp").max(0);

    if current_silver < normalized_resources.silver {
        return Ok(CharacterStoredResourcesConsumeOutcome::Failure {
            message: format!("银两不足，需要{}", normalized_resources.silver),
        });
    }
    if current_spirit_stones < normalized_resources.spirit_stones {
        return Ok(CharacterStoredResourcesConsumeOutcome::Failure {
            message: format!("灵石不足，需要{}", normalized_resources.spirit_stones),
        });
    }
    if current_exp < normalized_resources.exp {
        return Ok(CharacterStoredResourcesConsumeOutcome::Failure {
            message: format!("经验不足，需要{}", normalized_resources.exp),
        });
    }

    let material_mutations = build_material_mutations(
        transaction,
        character_id,
        &normalized_materials,
    )
    .await?;
    let material_mutations = match material_mutations {
        MaterialMutationBuildOutcome::Success(mutations) => mutations,
        MaterialMutationBuildOutcome::Failure { message } => {
            return Ok(CharacterStoredResourcesConsumeOutcome::Failure { message });
        }
    };

    for mutation in material_mutations {
        match mutation {
            MaterialMutation::Delete { instance_id } => {
                sqlx::query("DELETE FROM item_instance WHERE id = $1")
                    .bind(instance_id)
                    .execute(&mut **transaction)
                    .await
                    .map_err(internal_business_error)?;
            }
            MaterialMutation::Decrement {
                instance_id,
                consume_qty,
            } => {
                sqlx::query(
                    r#"
                    UPDATE item_instance
                    SET qty = qty - $2,
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(instance_id)
                .bind(consume_qty)
                .execute(&mut **transaction)
                .await
                .map_err(internal_business_error)?;
            }
        }
    }

    let next_silver = current_silver - normalized_resources.silver;
    let next_spirit_stones = current_spirit_stones - normalized_resources.spirit_stones;
    let next_exp = current_exp - normalized_resources.exp;
    if normalized_resources.silver > 0
        || normalized_resources.spirit_stones > 0
        || normalized_resources.exp > 0
    {
        sqlx::query(
            r#"
            UPDATE characters
            SET silver = $2,
                spirit_stones = $3,
                exp = $4,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(character_id)
        .bind(next_silver)
        .bind(next_spirit_stones)
        .bind(next_exp)
        .execute(&mut **transaction)
        .await
        .map_err(internal_business_error)?;
    }

    Ok(CharacterStoredResourcesConsumeOutcome::Success(
        CharacterStoredResourcesConsumeResult {
            remaining_silver: next_silver,
            remaining_spirit_stones: next_spirit_stones,
            remaining_exp: next_exp,
        },
    ))
}

async fn build_material_mutations(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
    requirements: &[MaterialConsumeRequirement],
) -> Result<MaterialMutationBuildOutcome, BusinessError> {
    if requirements.is_empty() {
        return Ok(MaterialMutationBuildOutcome::Success(Vec::new()));
    }

    let item_def_ids = requirements
        .iter()
        .map(|entry| entry.item_def_id.clone())
        .collect::<Vec<_>>();
    let rows = sqlx::query(
        r#"
        SELECT id, item_def_id, COALESCE(qty, 0)::bigint AS qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND item_def_id = ANY($2::text[])
        ORDER BY item_def_id ASC, created_at ASC, id ASC
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .bind(item_def_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(internal_business_error)?;

    let mut rows_by_item_def_id = BTreeMap::<String, Vec<LockedMaterialRow>>::new();
    for row in rows {
        rows_by_item_def_id
            .entry(row.get::<String, _>("item_def_id"))
            .or_default()
            .push(LockedMaterialRow {
                id: row.get::<i64, _>("id"),
                qty: row.get::<i64, _>("qty").max(0),
            });
    }

    let mut mutations = Vec::new();
    for requirement in requirements {
        let material_rows = rows_by_item_def_id
            .entry(requirement.item_def_id.clone())
            .or_default();
        let current_qty = material_rows.iter().map(|row| row.qty).sum::<i64>();
        if current_qty < requirement.qty {
            let item_name = requirement
                .item_name
                .clone()
                .unwrap_or_else(|| requirement.item_def_id.clone());
            return Ok(MaterialMutationBuildOutcome::Failure {
                message: format!(
                    "材料不足：{}，需要{}，当前{}",
                    item_name, requirement.qty, current_qty
                ),
            });
        }

        let mut remaining = requirement.qty;
        for row in material_rows.iter_mut() {
            if remaining <= 0 {
                break;
            }
            if row.qty <= 0 {
                continue;
            }
            let consume_qty = remaining.min(row.qty);
            if consume_qty == row.qty {
                mutations.push(MaterialMutation::Delete {
                    instance_id: row.id,
                });
                row.qty = 0;
            } else {
                mutations.push(MaterialMutation::Decrement {
                    instance_id: row.id,
                    consume_qty,
                });
                row.qty -= consume_qty;
            }
            remaining -= consume_qty;
        }
    }

    Ok(MaterialMutationBuildOutcome::Success(mutations))
}

fn normalize_material_requirements(
    requirements: &[MaterialConsumeRequirement],
) -> Vec<MaterialConsumeRequirement> {
    let mut aggregated = BTreeMap::<String, MaterialConsumeRequirement>::new();
    for requirement in requirements {
        let item_def_id = requirement.item_def_id.trim().to_string();
        let qty = requirement.qty.max(0);
        if item_def_id.is_empty() || qty <= 0 {
            continue;
        }
        let entry = aggregated
            .entry(item_def_id.clone())
            .or_insert_with(|| MaterialConsumeRequirement {
                item_def_id: item_def_id.clone(),
                qty: 0,
                item_name: requirement.item_name.clone().filter(|item| !item.trim().is_empty()),
            });
        entry.qty += qty;
        if entry.item_name.is_none() {
            entry.item_name = requirement.item_name.clone().filter(|item| !item.trim().is_empty());
        }
    }
    aggregated.into_values().collect()
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    tracing::error!("inventory consume failed: {error}");
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
