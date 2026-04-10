use std::collections::HashMap;

use sqlx::{Postgres, Row, Transaction};

use crate::edge::http::error::BusinessError;

const DEFAULT_BAG_CAPACITY: i32 = 100;

/**
 * 背包物品发放复用模块。
 *
 * 作用：
 * 1. 做什么：把“可堆叠物品优先并堆、背包空槽分配、新实例入包”这套通用写链路收敛成单一入口，供战令奖励、成就奖励等多个发奖场景复用。
 * 2. 做什么：统一锁定背包现有实例与已占用槽位，避免不同奖励入口各自实现时出现并堆规则或锁顺序漂移。
 * 3. 不做什么：不决定奖励是否合法，不负责货币/经验写入，也不读取业务规则层的奖励配置。
 *
 * 输入 / 输出：
 * - 输入：事务句柄、`user_id`、`character_id`、奖励来源 `obtained_from`、待发放条目列表与每个 `item_def_id` 对应的最小发放元数据。
 * - 输出：成功时仅完成数据库写入；若背包不足或缺少物品元数据则返回 `BusinessError`。
 *
 * 数据流 / 状态流：
 * - 上层业务先归一化奖励 -> 本模块锁定 `inventory/item_instance`
 * - -> 优先更新已有可堆叠实例 -> 不足部分按空槽新建 `item_instance`
 * - -> 事务由上层统一提交，保证与奖励状态更新原子完成。
 *
 * 复用设计说明：
 * - 战令奖励和成就奖励都需要同一套“按 `stack_max + bind_type` 合并入包”的逻辑；集中在这里后，背包槽位分配、并堆条件与 `obtained_from` 写入只维护一处。
 * - 该模块只依赖最小元数据 `bind_type/stack_max`，调用方可以复用各自已有的静态配置索引，不必为了复用强绑具体业务结构。
 *
 * 关键边界条件与坑点：
 * 1. 这里只处理普通背包实例；带 metadata/affixes/quality 的复杂奖励实例不能误走这个入口，否则会把实例属性丢失。
 * 2. `item_meta_by_id` 缺失时必须立即报错，不能静默跳过，否则会出现“领奖成功但物品没到账”的假成功。
 */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BagGrantItemMeta {
    pub bind_type: String,
    pub stack_max: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BagGrantEntry {
    pub item_def_id: String,
    pub qty: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StackableBagRow {
    id: i64,
    qty: i64,
    location_slot: i32,
}

pub async fn grant_items_to_bag(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: i64,
    character_id: i64,
    obtained_from: &str,
    entries: &[BagGrantEntry],
    item_meta_by_id: &HashMap<String, BagGrantItemMeta>,
) -> Result<(), BusinessError> {
    let reward_items = entries
        .iter()
        .filter_map(|entry| {
            let normalized_item_def_id = entry.item_def_id.trim().to_string();
            let normalized_qty = entry.qty.max(0);
            if normalized_item_def_id.is_empty() || normalized_qty <= 0 {
                return None;
            }
            Some(BagGrantEntry {
                item_def_id: normalized_item_def_id,
                qty: normalized_qty,
            })
        })
        .collect::<Vec<_>>();
    if reward_items.is_empty() {
        return Ok(());
    }

    let bag_capacity = sqlx::query_scalar::<_, i32>(
        r#"
        SELECT COALESCE(bag_capacity, $2)::int AS bag_capacity
        FROM inventory
        WHERE character_id = $1
        "#,
    )
    .bind(character_id)
    .bind(DEFAULT_BAG_CAPACITY)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(internal_business_error)?
    .unwrap_or(DEFAULT_BAG_CAPACITY)
    .max(0);

    let occupied_slot_rows = sqlx::query(
        r#"
        SELECT location_slot
        FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND location_slot IS NOT NULL
          AND location_slot >= 0
        ORDER BY location_slot ASC
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(internal_business_error)?;
    let mut occupied_slots = occupied_slot_rows
        .into_iter()
        .map(|row| row.get::<i32, _>("location_slot"))
        .collect::<Vec<_>>();
    occupied_slots.sort_unstable();
    occupied_slots.dedup();

    let stackable_rows = sqlx::query(
        r#"
        SELECT
          id,
          item_def_id,
          COALESCE(qty, 0)::bigint AS qty,
          location_slot,
          COALESCE(NULLIF(BTRIM(bind_type), ''), 'none') AS bind_type
        FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND location_slot IS NOT NULL
          AND location_slot >= 0
          AND (metadata IS NULL OR metadata = 'null'::jsonb)
          AND (affixes IS NULL OR affixes = 'null'::jsonb)
          AND quality IS NULL
          AND (quality_rank IS NULL OR quality_rank <= 0)
          AND (equipped_slot IS NULL OR equipped_slot = '')
          AND COALESCE(strengthen_level, 0) = 0
          AND COALESCE(refine_level, 0) = 0
          AND COALESCE(locked, FALSE) = FALSE
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(internal_business_error)?;

    let mut stackable_rows_by_key: HashMap<(String, String), Vec<StackableBagRow>> =
        HashMap::new();
    for row in stackable_rows {
        let key = (
            row.get::<String, _>("item_def_id"),
            normalize_item_bind_type(row.get::<String, _>("bind_type")),
        );
        stackable_rows_by_key
            .entry(key)
            .or_default()
            .push(StackableBagRow {
                id: row.get::<i64, _>("id"),
                qty: row.get::<i64, _>("qty").max(0),
                location_slot: row.get::<i32, _>("location_slot"),
            });
    }
    for rows in stackable_rows_by_key.values_mut() {
        rows.sort_by(|left, right| {
            left.location_slot
                .cmp(&right.location_slot)
                .then_with(|| left.id.cmp(&right.id))
        });
    }

    for entry in reward_items {
        let Some(meta) = item_meta_by_id.get(entry.item_def_id.as_str()) else {
            return Err(internal_business_error("missing inventory grant item meta"));
        };
        let bind_type = normalize_item_bind_type(meta.bind_type.clone());
        let stack_max = meta.stack_max.max(1) as i64;
        let key = (entry.item_def_id.clone(), bind_type.clone());
        let stack_rows = stackable_rows_by_key.entry(key).or_default();
        let mut remaining = entry.qty;

        if stack_max > 1 {
            for row in stack_rows.iter_mut() {
                if remaining <= 0 {
                    break;
                }
                let available = (stack_max - row.qty).max(0);
                if available <= 0 {
                    continue;
                }
                let add_qty = remaining.min(available);
                sqlx::query(
                    r#"
                    UPDATE item_instance
                    SET qty = qty + $2, updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(row.id)
                .bind(add_qty)
                .execute(&mut **transaction)
                .await
                .map_err(internal_business_error)?;
                row.qty += add_qty;
                remaining -= add_qty;
            }
        }

        while remaining > 0 {
            let Some(slot) = take_next_free_bag_slot(&mut occupied_slots, bag_capacity) else {
                return Err(BusinessError::new("背包已满"));
            };
            let add_qty = remaining.min(stack_max);
            let inserted_id = sqlx::query_scalar::<_, i64>(
                r#"
                INSERT INTO item_instance (
                  owner_user_id,
                  owner_character_id,
                  item_def_id,
                  qty,
                  location,
                  location_slot,
                  bind_type,
                  obtained_from
                )
                VALUES ($1, $2, $3, $4, 'bag', $5, $6, $7)
                RETURNING id
                "#,
            )
            .bind(user_id)
            .bind(character_id)
            .bind(entry.item_def_id.as_str())
            .bind(add_qty)
            .bind(slot)
            .bind(bind_type.as_str())
            .bind(obtained_from)
            .fetch_one(&mut **transaction)
            .await
            .map_err(internal_business_error)?;
            stack_rows.push(StackableBagRow {
                id: inserted_id,
                qty: add_qty,
                location_slot: slot,
            });
            remaining -= add_qty;
        }
    }

    Ok(())
}

fn normalize_item_bind_type(value: impl Into<String>) -> String {
    match value.into().trim() {
        "bound" => "bound".to_string(),
        "bind_on_equip" => "bind_on_equip".to_string(),
        _ => "none".to_string(),
    }
}

fn take_next_free_bag_slot(occupied_slots: &mut Vec<i32>, bag_capacity: i32) -> Option<i32> {
    let mut cursor = 0_i32;
    for occupied_slot in occupied_slots.iter().copied() {
        if occupied_slot < cursor {
            continue;
        }
        if occupied_slot > cursor {
            break;
        }
        cursor += 1;
    }
    if cursor >= bag_capacity {
        return None;
    }
    occupied_slots.push(cursor);
    occupied_slots.sort_unstable();
    Some(cursor)
}

fn internal_business_error(message: &'static str) -> BusinessError {
    let _ = message;
    BusinessError::with_status(
        "服务器错误",
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    )
}
