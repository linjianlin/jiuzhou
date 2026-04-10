use std::collections::HashMap;
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use chrono::{Local, TimeZone, Utc};
use serde::Deserialize;
use sqlx::{Postgres, Row, Transaction};

use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::month_card::{
    MonthCardBenefitValuesView, MonthCardClaimDataView, MonthCardRouteServices, MonthCardStatusView,
    MonthCardUseItemDataView,
};

const DEFAULT_MONTH_CARD_ID: &str = "monthcard-001";
const DEFAULT_MONTH_CARD_ITEM_DEF_ID: &str = "cons-monthcard-001";
const DEFAULT_DAILY_SPIRIT_STONES: i64 = 10_000;
const DAY_MILLIS: i64 = 24 * 60 * 60 * 1_000;

static MONTH_CARD_DEFINITIONS: OnceLock<Result<HashMap<String, MonthCardDefinition>, String>> =
    OnceLock::new();

/**
 * month_card 月卡应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/monthcard/status|use-item|claim` 三个接口，把状态读取、库存消耗和每日领奖收敛到单一服务。
 * 2. 做什么：复用 Node `month_card.json` 权威定义并缓存静态索引，避免每次请求重复解析配置文件。
 * 3. 不做什么：不补尚未迁移的成就推进、角色推送和体力缓存副作用，也不在这里做 HTTP 鉴权。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、`month_card_id`，以及激活接口可选的 `item_instance_id`。
 * - 输出：Node 兼容的 `ServiceResultResponse<MonthCardStatusView | MonthCardUseItemDataView | MonthCardClaimDataView>`。
 *
 * 数据流 / 状态流：
 * - 路由层完成 Bearer 鉴权 -> 本服务读取静态定义与 `characters/month_card_ownership/item_instance`
 * - 激活、领取在事务里锁定目标记录并完成扣道具 / 写 ownership / 加灵石
 * - 返回统一业务结果给路由层。
 *
 * 复用设计说明：
 * - 月卡定义缓存、权益数值裁剪、日期键生成与 ownership 读取都集中在这里，后续首页聚合和挂机权益可直接复用。
 * - 道具扣减逻辑与 ownership 续期逻辑共享同一个事务入口，避免路由层或其他模块再复制“选最早实例并扣 1 个”的规则。
 *
 * 关键边界条件与坑点：
 * 1. `itemInstanceId` 命中时必须只消费指定实例，不能退回到“自动挑一个”逻辑，否则会破坏 Node 当前的精确激活语义。
 * 2. `expire_at` 续期必须以“现有未过期时间”和“当前时间”较大值为基准，不能无条件从当前时间起算，否则会吞掉剩余有效期。
 */
#[derive(Debug, Clone)]
pub struct RustMonthCardRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone)]
struct MonthCardDefinition {
    id: String,
    name: String,
    description: Option<String>,
    duration_days: i64,
    daily_spirit_stones: i64,
    price_spirit_stones: i64,
    benefits: MonthCardBenefitValuesView,
}

#[derive(Debug, Clone, Deserialize)]
struct MonthCardSeedFile {
    #[serde(rename = "month_cards")]
    month_cards: Vec<MonthCardSeedEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonthCardSeedEntry {
    id: String,
    name: String,
    description: Option<String>,
    duration_days: Option<i64>,
    daily_spirit_stones: Option<i64>,
    price_spirit_stones: Option<i64>,
    cooldown_reduction_rate: Option<f64>,
    stamina_recovery_rate: Option<f64>,
    fuyuan_bonus: Option<i64>,
    idle_max_duration_hours: Option<i64>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CharacterWallet {
    character_id: i64,
    spirit_stones: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnershipSnapshot {
    ownership_id: i64,
    expire_at_ms: Option<i64>,
    last_claim_date: Option<String>,
}

impl RustMonthCardRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_status_impl(
        &self,
        user_id: i64,
        month_card_id: String,
    ) -> Result<ServiceResultResponse<MonthCardStatusView>, BusinessError> {
        let character = match self.load_character_wallet(user_id).await? {
            Some(value) => value,
            None => {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("角色不存在".to_string()),
                    None,
                ));
            }
        };
        let Some(definition) = month_card_definition(&month_card_id)? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("月卡不存在".to_string()),
                None,
            ));
        };

        let ownership = self
            .load_ownership_snapshot(&self.pool, character.character_id, &definition.id)
            .await?;
        let now_ms = current_timestamp_ms();
        let today = current_local_date_key();
        let active = ownership
            .as_ref()
            .and_then(|value| value.expire_at_ms)
            .map(|expire_at_ms| expire_at_ms > now_ms)
            .unwrap_or(false);
        let days_left = ownership
            .as_ref()
            .and_then(|value| value.expire_at_ms)
            .map(|expire_at_ms| {
                if expire_at_ms <= now_ms {
                    0
                } else {
                    ((expire_at_ms - now_ms) + DAY_MILLIS - 1) / DAY_MILLIS
                }
            })
            .unwrap_or(0);
        let expire_at = ownership
            .as_ref()
            .and_then(|value| value.expire_at_ms)
            .and_then(timestamp_ms_to_iso_string);
        let last_claim_date = ownership.and_then(|value| value.last_claim_date);
        let can_claim = active && last_claim_date.as_deref() != Some(today.as_str());

        Ok(ServiceResultResponse::new(
            true,
            Some("获取成功".to_string()),
            Some(MonthCardStatusView {
                month_card_id: definition.id.clone(),
                name: definition.name.clone(),
                description: definition.description.clone(),
                duration_days: definition.duration_days,
                daily_spirit_stones: definition.daily_spirit_stones,
                price_spirit_stones: definition.price_spirit_stones,
                benefits: definition.benefits.clone(),
                active,
                expire_at,
                days_left,
                today,
                last_claim_date,
                can_claim,
                spirit_stones: character.spirit_stones,
            }),
        ))
    }

    async fn use_item_impl(
        &self,
        user_id: i64,
        month_card_id: String,
        item_instance_id: Option<i64>,
    ) -> Result<ServiceResultResponse<MonthCardUseItemDataView>, BusinessError> {
        let Some(definition) = month_card_definition(&month_card_id)? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("月卡不存在或未启用".to_string()),
                None,
            ));
        };
        let character = match self.load_character_wallet(user_id).await? {
            Some(value) => value,
            None => {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("角色不存在".to_string()),
                    None,
                ));
            }
        };

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let consumed = self
            .consume_month_card_item(
                &mut transaction,
                character.character_id,
                item_instance_id,
                DEFAULT_MONTH_CARD_ITEM_DEF_ID,
            )
            .await?;
        if !consumed {
            return Ok(ServiceResultResponse::new(
                false,
                Some("背包中没有可用的月卡道具".to_string()),
                None,
            ));
        }

        let ownership = self
            .load_ownership_snapshot(&mut *transaction, character.character_id, &definition.id)
            .await?;
        let now_ms = current_timestamp_ms();
        let base_ms = ownership
            .as_ref()
            .and_then(|value| value.expire_at_ms)
            .filter(|expire_at_ms| *expire_at_ms > now_ms)
            .unwrap_or(now_ms);
        let next_expire_at_ms =
            base_ms.saturating_add(definition.duration_days.max(0).saturating_mul(DAY_MILLIS));
        let next_expire_at = timestamp_ms_to_iso_string(next_expire_at_ms)
            .ok_or_else(|| internal_business_error("invalid expire_at timestamp"))?;

        if let Some(snapshot) = ownership {
            let expired = snapshot
                .expire_at_ms
                .map(|value| value <= now_ms)
                .unwrap_or(true);
            if expired {
                sqlx::query(
                    r#"
                    UPDATE month_card_ownership
                    SET start_at = NOW(),
                        expire_at = $1::timestamptz,
                        updated_at = NOW()
                    WHERE id = $2
                    "#,
                )
                .bind(&next_expire_at)
                .bind(snapshot.ownership_id)
                .execute(&mut *transaction)
                .await
                .map_err(internal_business_error)?;
            } else {
                sqlx::query(
                    r#"
                    UPDATE month_card_ownership
                    SET expire_at = $1::timestamptz,
                        updated_at = NOW()
                    WHERE id = $2
                    "#,
                )
                .bind(&next_expire_at)
                .bind(snapshot.ownership_id)
                .execute(&mut *transaction)
                .await
                .map_err(internal_business_error)?;
            }
        } else {
            sqlx::query(
                r#"
                INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
                VALUES ($1, $2, NOW(), $3::timestamptz)
                "#,
            )
            .bind(character.character_id)
            .bind(&definition.id)
            .bind(&next_expire_at)
            .execute(&mut *transaction)
            .await
            .map_err(internal_business_error)?;
        }

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        let days_left = ((next_expire_at_ms - now_ms) + DAY_MILLIS - 1) / DAY_MILLIS;
        Ok(ServiceResultResponse::new(
            true,
            Some("使用成功".to_string()),
            Some(MonthCardUseItemDataView {
                month_card_id: definition.id,
                expire_at: next_expire_at,
                days_left,
            }),
        ))
    }

    async fn claim_impl(
        &self,
        user_id: i64,
        month_card_id: String,
    ) -> Result<ServiceResultResponse<MonthCardClaimDataView>, BusinessError> {
        let Some(definition) = month_card_definition(&month_card_id)? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("月卡不存在或未启用".to_string()),
                None,
            ));
        };
        let character = match self.load_character_wallet(user_id).await? {
            Some(value) => value,
            None => {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("角色不存在".to_string()),
                    None,
                ));
            }
        };

        let today = current_local_date_key();
        let reward_spirit_stones = definition.daily_spirit_stones;
        let now_ms = current_timestamp_ms();
        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let Some(ownership) = self
            .load_ownership_snapshot(&mut *transaction, character.character_id, &definition.id)
            .await?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("未激活月卡".to_string()),
                None,
            ));
        };

        let active = ownership
            .expire_at_ms
            .map(|expire_at_ms| expire_at_ms > now_ms)
            .unwrap_or(false);
        if !active {
            return Ok(ServiceResultResponse::new(
                false,
                Some("月卡已到期".to_string()),
                None,
            ));
        }
        if ownership.last_claim_date.as_deref() == Some(today.as_str()) {
            return Ok(ServiceResultResponse::new(
                false,
                Some("今日已领取".to_string()),
                None,
            ));
        }

        sqlx::query(
            r#"
            INSERT INTO month_card_claim_record (character_id, month_card_id, claim_date, reward_spirit_stones)
            VALUES ($1, $2, $3::date, $4)
            ON CONFLICT (character_id, month_card_id, claim_date) DO NOTHING
            "#,
        )
        .bind(character.character_id)
        .bind(&definition.id)
        .bind(&today)
        .bind(reward_spirit_stones)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        let spirit_stones = sqlx::query_scalar::<_, i64>(
            r#"
            UPDATE characters
            SET spirit_stones = COALESCE(spirit_stones, 0) + $2
            WHERE id = $1
            RETURNING spirit_stones
            "#,
        )
        .bind(character.character_id)
        .bind(reward_spirit_stones)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        sqlx::query(
            r#"
            UPDATE month_card_ownership
            SET last_claim_date = $1::date,
                updated_at = NOW()
            WHERE id = $2
            "#,
        )
        .bind(&today)
        .bind(ownership.ownership_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some("领取成功".to_string()),
            Some(MonthCardClaimDataView {
                month_card_id: definition.id,
                date: today,
                reward_spirit_stones,
                spirit_stones,
            }),
        ))
    }

    async fn load_character_wallet(
        &self,
        user_id: i64,
    ) -> Result<Option<CharacterWallet>, BusinessError> {
        sqlx::query(
            r#"
            SELECT id, COALESCE(spirit_stones, 0)::bigint AS spirit_stones
            FROM characters
            WHERE user_id = $1
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map(|row| {
            row.map(|value| CharacterWallet {
                character_id: value.get::<i64, _>("id"),
                spirit_stones: value.get::<i64, _>("spirit_stones"),
            })
        })
        .map_err(internal_business_error)
    }

    async fn load_ownership_snapshot<'a, E>(
        &self,
        executor: E,
        character_id: i64,
        month_card_id: &str,
    ) -> Result<Option<OwnershipSnapshot>, BusinessError>
    where
        E: sqlx::Executor<'a, Database = Postgres>,
    {
        sqlx::query(
            r#"
            SELECT
              id,
              CASE
                WHEN expire_at IS NULL THEN NULL
                ELSE CAST(EXTRACT(EPOCH FROM expire_at) * 1000 AS BIGINT)
              END AS expire_at_ms,
              CASE
                WHEN last_claim_date IS NULL THEN NULL
                ELSE to_char(last_claim_date, 'YYYY-MM-DD')
              END AS last_claim_date
            FROM month_card_ownership
            WHERE character_id = $1
              AND month_card_id = $2
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .bind(month_card_id)
        .fetch_optional(executor)
        .await
        .map(|row| {
            row.map(|value| OwnershipSnapshot {
                ownership_id: value.get::<i64, _>("id"),
                expire_at_ms: value.try_get::<Option<i64>, _>("expire_at_ms").unwrap_or(None),
                last_claim_date: value
                    .try_get::<Option<String>, _>("last_claim_date")
                    .unwrap_or(None),
            })
        })
        .map_err(internal_business_error)
    }

    async fn consume_month_card_item(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        character_id: i64,
        item_instance_id: Option<i64>,
        item_def_id: &str,
    ) -> Result<bool, BusinessError> {
        let row = if let Some(instance_id) = item_instance_id.filter(|value| *value > 0) {
            sqlx::query(
                r#"
                SELECT id, qty
                FROM item_instance
                WHERE owner_character_id = $1
                  AND id = $2
                  AND item_def_id = $3
                  AND location = 'bag'
                LIMIT 1
                FOR UPDATE
                "#,
            )
            .bind(character_id)
            .bind(instance_id)
            .bind(item_def_id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(internal_business_error)?
        } else {
            sqlx::query(
                r#"
                SELECT id, qty
                FROM item_instance
                WHERE owner_character_id = $1
                  AND item_def_id = $2
                  AND location = 'bag'
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                FOR UPDATE
                "#,
            )
            .bind(character_id)
            .bind(item_def_id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(internal_business_error)?
        };
        let Some(row) = row else {
            return Ok(false);
        };

        let instance_id = row.get::<i64, _>("id");
        let qty = row.get::<i32, _>("qty");
        if qty <= 0 {
            return Ok(false);
        }

        if qty == 1 {
            sqlx::query("DELETE FROM item_instance WHERE id = $1")
                .bind(instance_id)
                .execute(&mut **transaction)
                .await
                .map_err(internal_business_error)?;
        } else {
            sqlx::query(
                r#"
                UPDATE item_instance
                SET qty = qty - 1,
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(instance_id)
            .execute(&mut **transaction)
            .await
            .map_err(internal_business_error)?;
        }

        Ok(true)
    }
}

impl MonthCardRouteServices for RustMonthCardRouteService {
    fn get_status<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardStatusView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_status_impl(user_id, month_card_id).await })
    }

    fn use_item<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
        item_instance_id: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardUseItemDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.use_item_impl(user_id, month_card_id, item_instance_id)
                .await
        })
    }

    fn claim<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardClaimDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.claim_impl(user_id, month_card_id).await })
    }
}

fn month_card_definition(
    month_card_id: &str,
) -> Result<Option<MonthCardDefinition>, BusinessError> {
    let definitions = MONTH_CARD_DEFINITIONS.get_or_init(load_month_card_definitions);
    match definitions {
        Ok(catalog) => Ok(catalog.get(month_card_id).cloned()),
        Err(message) => Err(internal_business_error(message)),
    }
}

fn load_month_card_definitions() -> Result<HashMap<String, MonthCardDefinition>, String> {
    let file = read_seed_json::<MonthCardSeedFile>("month_card.json").map_err(|error| {
        format!("failed to read month card seed: {error}")
    })?;
    let mut definitions = HashMap::with_capacity(file.month_cards.len());
    for entry in file.month_cards {
        if entry.enabled == Some(false) {
            continue;
        }
        let id = entry.id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        definitions.insert(
            id.clone(),
            MonthCardDefinition {
                id,
                name: entry.name,
                description: entry.description.filter(|value| !value.trim().is_empty()),
                duration_days: entry.duration_days.unwrap_or(30).max(0),
                daily_spirit_stones: entry
                    .daily_spirit_stones
                    .unwrap_or(DEFAULT_DAILY_SPIRIT_STONES)
                    .max(0),
                price_spirit_stones: entry.price_spirit_stones.unwrap_or(0).max(0),
                benefits: MonthCardBenefitValuesView {
                    cooldown_reduction_rate: clamp_rate(entry.cooldown_reduction_rate.unwrap_or(0.0)),
                    stamina_recovery_rate: clamp_rate(entry.stamina_recovery_rate.unwrap_or(0.0)),
                    fuyuan_bonus: entry.fuyuan_bonus.unwrap_or(0).max(0),
                    idle_max_duration_hours: entry.idle_max_duration_hours.unwrap_or(0).max(0),
                },
            },
        );
    }
    Ok(definitions)
}

fn clamp_rate(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else if value >= 1.0 {
        1.0
    } else {
        value
    }
}

fn timestamp_ms_to_iso_string(timestamp_ms: i64) -> Option<String> {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn current_timestamp_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn current_local_date_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn default_month_card_id() -> &'static str {
    DEFAULT_MONTH_CARD_ID
}
