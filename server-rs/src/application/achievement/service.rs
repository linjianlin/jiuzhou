use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::types::Json;
use sqlx::{Postgres, Row, Transaction};

use crate::application::inventory::grant::{
    grant_items_to_bag, BagGrantEntry, BagGrantItemMeta,
};
use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::achievement::{
    AchievementActionResult, AchievementClaimDataView, AchievementDetailDataView,
    AchievementItemView, AchievementListDataView, AchievementListQuery,
    AchievementPointRewardClaimDataView, AchievementPointRewardListDataView,
    AchievementPointRewardView, AchievementPointsByCategoryView, AchievementPointsInfoView,
    AchievementProgressView, AchievementRewardView, AchievementRouteServices,
    AchievementTitleRewardView,
};

static ACHIEVEMENT_DEFINITION_CACHE: OnceLock<Result<Vec<AchievementDefinition>, String>> =
    OnceLock::new();
static ACHIEVEMENT_POINT_REWARD_CACHE: OnceLock<Result<Vec<AchievementPointRewardDefinition>, String>> =
    OnceLock::new();
static ACHIEVEMENT_ITEM_META_CACHE: OnceLock<Result<HashMap<String, AchievementItemMeta>, String>> =
    OnceLock::new();
static ACHIEVEMENT_TITLE_META_CACHE: OnceLock<Result<HashMap<String, AchievementTitleMeta>, String>> =
    OnceLock::new();

/**
 * achievement 应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node 成就系统的列表、详情、奖励领取与成就点奖励接口，并把静态配置读取、状态同步和奖励写库收敛到单一入口。
 * 2. 做什么：优先复用 Node 权威 `achievement_def.json / achievement_points_rewards.json / item_def.json / title_def.json`，避免 Rust 侧再维护一套平行配置。
 * 3. 不做什么：不接管实时进度事件派发，不实现 socket 推送，也不补 mail/market 等与成就无关的奖励副作用链。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、`character_id`、列表查询参数、`achievement_id`、点数阈值。
 * - 输出：Node 兼容的成就列表/详情 DTO，以及 `sendResult` 风格的领取结果。
 *
 * 数据流 / 状态流：
 * - 路由层完成鉴权 -> 本服务先确保 `character_achievement(_points)` 基础行存在
 * - -> 读取静态定义与当前角色状态，按 Node 规则同步静态 flag 类成就
 * - -> 读链路返回 DTO；领奖链路在单事务内完成奖励发放、称号归属和状态更新。
 *
 * 复用设计说明：
 * - 奖励物品入包复用 `application/inventory/grant.rs`，与战令共享同一套并堆和空槽分配逻辑，避免第二处继续复制。
 * - 静态种子缓存和奖励富化都集中在这里，后续首页红点、称号面板或成就推送若要读取相同协议，可直接复用同一份 DTO 构建逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 静态 flag 成就同步只能在 `status = in_progress` 时增加点数，不能重复给点，否则打开成就面板会把总点数刷高。
 * 2. 奖励领取必须与 `character_achievement(_points)` 状态更新在同一事务内提交，不能先发放奖励再改状态。
 */
#[derive(Debug, Clone)]
pub struct RustAchievementRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize)]
struct AchievementDefinitionFile {
    achievements: Vec<AchievementDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct AchievementDefinitionSeed {
    id: String,
    name: String,
    description: String,
    category: Option<String>,
    points: Option<i64>,
    icon: Option<String>,
    hidden: Option<bool>,
    prerequisite_id: Option<String>,
    track_type: Option<String>,
    track_key: String,
    target_value: Option<i64>,
    target_list: Option<Vec<Value>>,
    rewards: Option<Vec<AchievementRewardSeed>>,
    title_id: Option<String>,
    sort_weight: Option<i64>,
    enabled: Option<bool>,
    version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct AchievementPointRewardFile {
    rewards: Vec<AchievementPointRewardSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct AchievementPointRewardSeed {
    id: String,
    points_threshold: Option<i64>,
    name: String,
    description: String,
    rewards: Option<Vec<AchievementRewardSeed>>,
    title_id: Option<String>,
    enabled: Option<bool>,
    sort_weight: Option<i64>,
    version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct AchievementRewardSeed {
    #[serde(rename = "type")]
    reward_type: String,
    amount: Option<i64>,
    item_def_id: Option<String>,
    qty: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedFile {
    items: Vec<ItemSeedEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedEntry {
    id: String,
    name: String,
    icon: Option<String>,
    bind_type: Option<String>,
    stack_max: Option<i32>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TitleSeedFile {
    titles: Vec<TitleSeedEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct TitleSeedEntry {
    id: String,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct AchievementDefinition {
    id: String,
    name: String,
    description: String,
    category: String,
    points: i64,
    icon: Option<String>,
    hidden: bool,
    track_type: String,
    track_key: String,
    target_value: i64,
    target_list: Vec<String>,
    rewards: Vec<AchievementRewardSeed>,
    title_id: Option<String>,
    sort_weight: i64,
}

#[derive(Debug, Clone)]
struct AchievementPointRewardDefinition {
    id: String,
    threshold: i64,
    name: String,
    description: String,
    rewards: Vec<AchievementRewardSeed>,
    title_id: Option<String>,
    sort_weight: i64,
}

#[derive(Debug, Clone)]
struct AchievementItemMeta {
    name: String,
    icon: Option<String>,
    bind_type: String,
    stack_max: i32,
}

#[derive(Debug, Clone)]
struct AchievementTitleMeta {
    id: String,
    name: String,
    color: Option<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone)]
struct AchievementProgressRecord {
    status: String,
    progress: i64,
    progress_data: Value,
}

#[derive(Debug, Clone)]
struct AchievementPointState {
    total_points: i64,
    combat_points: i64,
    cultivation_points: i64,
    exploration_points: i64,
    social_points: i64,
    collection_points: i64,
    claimed_thresholds: Vec<i64>,
}

impl RustAchievementRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_achievement_list_impl(
        &self,
        character_id: i64,
        query: AchievementListQuery,
    ) -> Result<AchievementListDataView, BusinessError> {
        self.ensure_character_achievement_points(character_id).await?;
        self.sync_character_achievements(character_id).await?;
        self.sync_static_achievement_progress(character_id).await?;

        let page = parse_positive_i64(query.page.as_deref()).unwrap_or(1).max(1);
        let limit = parse_positive_i64(query.limit.as_deref())
            .unwrap_or(20)
            .clamp(1, 100);
        let offset = (page - 1) * limit;
        let category = normalize_optional_text(query.category);
        let status_filter = normalize_status_filter(query.status.as_deref());

        let progress_by_id = self.load_achievement_progress_map(character_id).await?;
        let mut rows = achievement_definitions()?
            .iter()
            .filter(|definition| {
                category
                    .as_deref()
                    .map(|value| value == definition.category)
                    .unwrap_or(true)
            })
            .filter(|definition| {
                let progress = progress_by_id.get(definition.id.as_str());
                filter_status(progress.map(|record| record.status.as_str()), status_filter)
            })
            .map(|definition| {
                self.build_achievement_item_view(
                    definition,
                    progress_by_id.get(definition.id.as_str()),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows.sort_by(|left, right| {
            left.category
                .cmp(&right.category)
                .then_with(|| right.sort_weight.cmp(&left.sort_weight))
                .then_with(|| left.id.cmp(&right.id))
        });

        let total = rows.len() as i64;
        let achievements = rows
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect::<Vec<_>>();
        let point_state = self.load_achievement_point_state(character_id).await?;

        Ok(AchievementListDataView {
            achievements,
            total,
            page,
            limit,
            points: build_points_info_view(&point_state),
        })
    }

    async fn get_achievement_detail_impl(
        &self,
        character_id: i64,
        achievement_id: String,
    ) -> Result<Option<AchievementDetailDataView>, BusinessError> {
        self.ensure_character_achievement_points(character_id).await?;
        self.sync_character_achievements(character_id).await?;
        self.sync_static_achievement_progress(character_id).await?;

        let normalized_achievement_id = achievement_id.trim().to_string();
        if normalized_achievement_id.is_empty() {
            return Ok(None);
        }
        let Some(definition) = achievement_definitions()?
            .iter()
            .find(|definition| definition.id == normalized_achievement_id)
        else {
            return Ok(None);
        };
        let progress_by_id = self.load_achievement_progress_map(character_id).await?;
        let achievement = self.build_achievement_item_view(
            definition,
            progress_by_id.get(normalized_achievement_id.as_str()),
        )?;

        Ok(Some(AchievementDetailDataView {
            progress: achievement.progress.clone(),
            achievement,
        }))
    }

    async fn claim_achievement_impl(
        &self,
        user_id: i64,
        character_id: i64,
        achievement_id: String,
    ) -> Result<AchievementActionResult<AchievementClaimDataView>, BusinessError> {
        if user_id <= 0 {
            return Ok(action_failure("未登录"));
        }
        if character_id <= 0 {
            return Ok(action_failure("角色不存在"));
        }
        let normalized_achievement_id = achievement_id.trim().to_string();
        if normalized_achievement_id.is_empty() {
            return Ok(action_failure("成就ID不能为空"));
        }
        let Some(definition) = achievement_definitions()?
            .iter()
            .find(|definition| definition.id == normalized_achievement_id)
            .cloned()
        else {
            return Ok(action_failure("成就不存在或未解锁"));
        };

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let locked_row = sqlx::query(
            r#"
            SELECT status
            FROM character_achievement
            WHERE character_id = $1
              AND achievement_id = $2
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .bind(&normalized_achievement_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;
        let Some(locked_row) = locked_row else {
            return Ok(action_failure("成就不存在或未解锁"));
        };
        let status = normalize_status(locked_row.try_get::<String, _>("status").ok().as_deref());
        if status == "claimed" {
            return Ok(action_failure("奖励已领取"));
        }
        if status != "completed" {
            return Ok(action_failure("成就尚未完成"));
        }

        let rewards = self
            .grant_rewards_tx(
                &mut transaction,
                user_id,
                character_id,
                &definition.rewards,
                "achievement_reward",
            )
            .await?;
        let title = self
            .grant_title_tx(&mut transaction, character_id, definition.title_id.as_deref())
            .await?;

        sqlx::query(
            r#"
            UPDATE character_achievement
            SET status = 'claimed',
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE character_id = $1
              AND achievement_id = $2
            "#,
        )
        .bind(character_id)
        .bind(&normalized_achievement_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction.commit().await.map_err(internal_business_error)?;

        Ok(AchievementActionResult {
            success: true,
            message: "ok".to_string(),
            data: Some(AchievementClaimDataView {
                achievement_id: normalized_achievement_id,
                rewards,
                title,
            }),
        })
    }

    async fn get_achievement_point_rewards_impl(
        &self,
        character_id: i64,
    ) -> Result<AchievementPointRewardListDataView, BusinessError> {
        self.ensure_character_achievement_points(character_id).await?;
        let point_state = self.load_achievement_point_state(character_id).await?;

        let mut rewards = point_reward_definitions()?
            .iter()
            .map(|definition| AchievementPointRewardView {
                id: definition.id.clone(),
                threshold: definition.threshold,
                name: definition.name.clone(),
                description: definition.description.clone(),
                rewards: build_reward_views(&definition.rewards)?,
                title: lookup_title_reward(definition.title_id.as_deref())?,
                claimable: point_state.total_points >= definition.threshold
                    && !point_state.claimed_thresholds.contains(&definition.threshold),
                claimed: point_state.claimed_thresholds.contains(&definition.threshold),
            })
            .collect::<Result<Vec<_>, BusinessError>>()?;
        rewards.sort_by(|left, right| left.threshold.cmp(&right.threshold));

        Ok(AchievementPointRewardListDataView {
            total_points: point_state.total_points,
            claimed_thresholds: point_state.claimed_thresholds,
            rewards,
        })
    }

    async fn claim_achievement_point_reward_impl(
        &self,
        user_id: i64,
        character_id: i64,
        threshold: Option<Value>,
    ) -> Result<AchievementActionResult<AchievementPointRewardClaimDataView>, BusinessError> {
        if user_id <= 0 {
            return Ok(action_failure("未登录"));
        }
        if character_id <= 0 {
            return Ok(action_failure("角色不存在"));
        }
        let Some(normalized_threshold) = parse_threshold_value(threshold.as_ref()) else {
            return Ok(action_failure("阈值无效"));
        };
        let Some(definition) = point_reward_definitions()?
            .iter()
            .find(|definition| definition.threshold == normalized_threshold)
            .cloned()
        else {
            return Ok(action_failure("点数奖励不存在"));
        };

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        ensure_character_achievement_points_tx(&mut transaction, character_id).await?;
        let state = load_achievement_point_state_tx(&mut transaction, character_id).await?;

        if state.claimed_thresholds.contains(&normalized_threshold) {
            return Ok(action_failure("该点数奖励已领取"));
        }
        if state.total_points < normalized_threshold {
            return Ok(action_failure("成就点数不足"));
        }

        let rewards = self
            .grant_rewards_tx(
                &mut transaction,
                user_id,
                character_id,
                &definition.rewards,
                "achievement_points_reward",
            )
            .await?;
        let title = self
            .grant_title_tx(&mut transaction, character_id, definition.title_id.as_deref())
            .await?;
        let mut claimed_thresholds = state.claimed_thresholds;
        claimed_thresholds.push(normalized_threshold);
        claimed_thresholds.sort_unstable();
        claimed_thresholds.dedup();

        sqlx::query(
            r#"
            UPDATE character_achievement_points
            SET claimed_thresholds = $2::jsonb,
                updated_at = NOW()
            WHERE character_id = $1
            "#,
        )
        .bind(character_id)
        .bind(Json(json!(claimed_thresholds)))
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction.commit().await.map_err(internal_business_error)?;

        Ok(AchievementActionResult {
            success: true,
            message: "ok".to_string(),
            data: Some(AchievementPointRewardClaimDataView {
                threshold: normalized_threshold,
                rewards,
                title,
            }),
        })
    }

    async fn ensure_character_achievement_points(
        &self,
        character_id: i64,
    ) -> Result<(), BusinessError> {
        sqlx::query(
            r#"
            INSERT INTO character_achievement_points (character_id)
            VALUES ($1)
            ON CONFLICT (character_id) DO NOTHING
            "#,
        )
        .bind(character_id)
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(())
    }

    async fn sync_character_achievements(&self, character_id: i64) -> Result<(), BusinessError> {
        let achievement_ids = achievement_definitions()?
            .iter()
            .map(|definition| definition.id.clone())
            .collect::<Vec<_>>();
        if achievement_ids.is_empty() {
            return Ok(());
        }
        sqlx::query(
            r#"
            INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)
            SELECT $1, x.achievement_id, 'in_progress', 0, '{}'::jsonb
            FROM unnest($2::varchar[]) AS x(achievement_id)
            ON CONFLICT (character_id, achievement_id) DO NOTHING
            "#,
        )
        .bind(character_id)
        .bind(&achievement_ids)
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(())
    }

    async fn sync_static_achievement_progress(
        &self,
        character_id: i64,
    ) -> Result<(), BusinessError> {
        let definitions = achievement_definitions()?;
        let tracked_ids = definitions
            .iter()
            .filter(|definition| {
                definition.track_key.starts_with("realm:reach:")
                    || definition.track_key.starts_with("skill:level:layer:")
                    || definition.track_key == "sect:join"
            })
            .map(|definition| definition.id.clone())
            .collect::<Vec<_>>();
        if tracked_ids.is_empty() {
            return Ok(());
        }

        let character_row = sqlx::query(
            r#"
            SELECT realm, sub_realm
            FROM characters
            WHERE id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;
        let current_realm_rank = character_row
            .as_ref()
            .map(|row| {
                realm_rank(
                    row.try_get::<Option<String>, _>("realm")
                        .ok()
                        .flatten()
                        .as_deref(),
                    row.try_get::<Option<String>, _>("sub_realm")
                        .ok()
                        .flatten()
                        .as_deref(),
                )
            })
            .unwrap_or(-1);

        let sect_member_exists = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT 1
            FROM sect_member
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?
        .is_some();

        let max_layer = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COALESCE(MAX(current_layer), 0)::bigint AS max_layer
            FROM character_technique
            WHERE character_id = $1
            "#,
        )
        .bind(character_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_business_error)?
        .max(0);

        let pending_rows = sqlx::query(
            r#"
            SELECT achievement_id
            FROM character_achievement
            WHERE character_id = $1
              AND achievement_id = ANY($2::varchar[])
              AND COALESCE(status, 'in_progress') = 'in_progress'
            "#,
        )
        .bind(character_id)
        .bind(&tracked_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let definition_by_id = definitions
            .iter()
            .map(|definition| (definition.id.clone(), definition.clone()))
            .collect::<HashMap<_, _>>();
        let mut completed = Vec::new();
        for row in pending_rows {
            let achievement_id = row.get::<String, _>("achievement_id");
            let Some(definition) = definition_by_id.get(achievement_id.as_str()) else {
                continue;
            };
            if definition.track_key == "sect:join" && sect_member_exists {
                completed.push(definition.clone());
                continue;
            }
            if let Some(required_realm) = definition.track_key.strip_prefix("realm:reach:") {
                if current_realm_rank >= realm_rank(Some(required_realm), None) {
                    completed.push(definition.clone());
                }
                continue;
            }
            if let Some(layer_required) = parse_required_layer(definition.track_key.as_str()) {
                if max_layer >= layer_required {
                    completed.push(definition.clone());
                }
            }
        }
        if completed.is_empty() {
            return Ok(());
        }

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        ensure_character_achievement_points_tx(&mut transaction, character_id).await?;

        let mut point_delta = AchievementPointsByCategoryView {
            combat: 0,
            cultivation: 0,
            exploration: 0,
            social: 0,
            collection: 0,
        };
        for definition in completed {
            let update_result = sqlx::query(
                r#"
                UPDATE character_achievement
                SET progress = GREATEST(progress, $3),
                    status = 'completed',
                    completed_at = COALESCE(completed_at, NOW()),
                    updated_at = NOW()
                WHERE character_id = $1
                  AND achievement_id = $2
                  AND COALESCE(status, 'in_progress') = 'in_progress'
                "#,
            )
            .bind(character_id)
            .bind(definition.id.as_str())
            .bind(definition.target_value.max(1))
            .execute(&mut *transaction)
            .await
            .map_err(internal_business_error)?;
            if update_result.rows_affected() == 0 {
                continue;
            }
            apply_points_delta(&mut point_delta, definition.category.as_str(), definition.points);
        }

        if point_delta.combat != 0
            || point_delta.cultivation != 0
            || point_delta.exploration != 0
            || point_delta.social != 0
            || point_delta.collection != 0
        {
            let total_delta = point_delta.combat
                + point_delta.cultivation
                + point_delta.exploration
                + point_delta.social
                + point_delta.collection;
            sqlx::query(
                r#"
                UPDATE character_achievement_points
                SET total_points = GREATEST(total_points + $2, 0),
                    combat_points = GREATEST(combat_points + $3, 0),
                    cultivation_points = GREATEST(cultivation_points + $4, 0),
                    exploration_points = GREATEST(exploration_points + $5, 0),
                    social_points = GREATEST(social_points + $6, 0),
                    collection_points = GREATEST(collection_points + $7, 0),
                    updated_at = NOW()
                WHERE character_id = $1
                "#,
            )
            .bind(character_id)
            .bind(total_delta)
            .bind(point_delta.combat)
            .bind(point_delta.cultivation)
            .bind(point_delta.exploration)
            .bind(point_delta.social)
            .bind(point_delta.collection)
            .execute(&mut *transaction)
            .await
            .map_err(internal_business_error)?;
        }

        transaction.commit().await.map_err(internal_business_error)?;
        Ok(())
    }

    async fn load_achievement_progress_map(
        &self,
        character_id: i64,
    ) -> Result<HashMap<String, AchievementProgressRecord>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT achievement_id, status, progress, progress_data
            FROM character_achievement
            WHERE character_id = $1
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;
        let mut result = HashMap::with_capacity(rows.len());
        for row in rows {
            let achievement_id = row.get::<String, _>("achievement_id");
            result.insert(
                achievement_id,
                AchievementProgressRecord {
                    status: normalize_status(row.try_get::<Option<String>, _>("status").ok().flatten().as_deref())
                        .to_string(),
                    progress: row.try_get::<Option<i64>, _>("progress")
                        .ok()
                        .flatten()
                        .unwrap_or(0)
                        .max(0),
                    progress_data: row
                        .try_get::<Option<Value>, _>("progress_data")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| Value::Object(Map::new())),
                },
            );
        }
        Ok(result)
    }

    fn build_achievement_item_view(
        &self,
        definition: &AchievementDefinition,
        progress: Option<&AchievementProgressRecord>,
    ) -> Result<AchievementItemView, BusinessError> {
        let status = normalize_status(progress.map(|record| record.status.as_str()));
        let current = progress.map(|record| record.progress).unwrap_or(0).max(0);
        let target = if definition.track_type == "multi" && !definition.target_list.is_empty() {
            definition.target_list.len() as i64
        } else {
            definition.target_value.max(1)
        };
        let current_value = current.min(target).max(0);
        let done = matches!(status, "completed" | "claimed") || current >= target;
        let percent = if target > 0 {
            ((current_value as f64 / target as f64) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let hidden_unfinished = definition.hidden && status == "in_progress";

        Ok(AchievementItemView {
            id: definition.id.clone(),
            name: if hidden_unfinished {
                "？？？".to_string()
            } else {
                definition.name.clone()
            },
            description: if hidden_unfinished {
                "隐藏成就，完成后解锁描述".to_string()
            } else {
                definition.description.clone()
            },
            category: definition.category.clone(),
            points: definition.points,
            icon: definition.icon.clone(),
            hidden: definition.hidden,
            status: status.to_string(),
            claimable: status == "completed",
            track_type: definition.track_type.clone(),
            track_key: definition.track_key.clone(),
            progress: AchievementProgressView {
                current: current_value,
                target,
                percent,
                done,
                status: status.to_string(),
                progress_data: if definition.track_type == "multi" {
                    progress.map(|record| record.progress_data.clone())
                } else {
                    None
                },
            },
            rewards: build_reward_views(&definition.rewards)?,
            title_id: definition.title_id.clone(),
            sort_weight: definition.sort_weight,
        })
    }

    async fn load_achievement_point_state(
        &self,
        character_id: i64,
    ) -> Result<AchievementPointState, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              total_points,
              combat_points,
              cultivation_points,
              exploration_points,
              social_points,
              collection_points,
              claimed_thresholds
            FROM character_achievement_points
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(parse_achievement_point_state(row.as_ref()))
    }

    async fn grant_rewards_tx(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        user_id: i64,
        character_id: i64,
        rewards: &[AchievementRewardSeed],
        obtained_from: &str,
    ) -> Result<Vec<AchievementRewardView>, BusinessError> {
        let mut silver_delta = 0_i64;
        let mut spirit_stones_delta = 0_i64;
        let mut exp_delta = 0_i64;
        let item_meta_map = item_meta_by_id()?;
        let mut item_entries = Vec::new();
        let mut reward_views = Vec::new();

        for reward in rewards {
            match reward.reward_type.trim() {
                "silver" => {
                    let amount = reward.amount.unwrap_or(0).max(0);
                    if amount <= 0 {
                        continue;
                    }
                    silver_delta += amount;
                    reward_views.push(AchievementRewardView::Silver { amount });
                }
                "spirit_stones" => {
                    let amount = reward.amount.unwrap_or(0).max(0);
                    if amount <= 0 {
                        continue;
                    }
                    spirit_stones_delta += amount;
                    reward_views.push(AchievementRewardView::SpiritStones { amount });
                }
                "exp" => {
                    let amount = reward.amount.unwrap_or(0).max(0);
                    if amount <= 0 {
                        continue;
                    }
                    exp_delta += amount;
                    reward_views.push(AchievementRewardView::Exp { amount });
                }
                "item" => {
                    let Some(item_def_id) = normalize_optional_text(reward.item_def_id.clone()) else {
                        continue;
                    };
                    let qty = reward.qty.unwrap_or(1).max(1);
                    let item_meta = item_meta_map
                        .get(item_def_id.as_str())
                        .cloned()
                        .ok_or_else(|| internal_logic_business_error("missing achievement reward item meta"))?;
                    item_entries.push(BagGrantEntry {
                        item_def_id: item_def_id.clone(),
                        qty,
                    });
                    reward_views.push(AchievementRewardView::Item {
                        item_def_id,
                        qty,
                        item_name: Some(item_meta.name),
                        item_icon: item_meta.icon,
                    });
                }
                _ => {}
            }
        }

        if silver_delta != 0 || spirit_stones_delta != 0 || exp_delta != 0 {
            sqlx::query(
                r#"
                UPDATE characters
                SET silver = COALESCE(silver, 0) + $2,
                    spirit_stones = COALESCE(spirit_stones, 0) + $3,
                    exp = COALESCE(exp, 0) + $4,
                    updated_at = NOW()
                WHERE id = $1
                "#,
            )
            .bind(character_id)
            .bind(silver_delta)
            .bind(spirit_stones_delta)
            .bind(exp_delta)
            .execute(&mut *transaction)
            .await
            .map_err(internal_business_error)?;
        }

        if !item_entries.is_empty() {
            let item_grant_meta = item_entries
                .iter()
                .map(|entry| {
                    let meta = item_meta_map
                        .get(entry.item_def_id.as_str())
                        .ok_or_else(|| internal_logic_business_error("missing achievement reward item meta"))?;
                    Ok((
                        entry.item_def_id.clone(),
                        BagGrantItemMeta {
                            bind_type: meta.bind_type.clone(),
                            stack_max: meta.stack_max,
                        },
                    ))
                })
                .collect::<Result<HashMap<_, _>, BusinessError>>()?;
            grant_items_to_bag(
                transaction,
                user_id,
                character_id,
                obtained_from,
                &item_entries,
                &item_grant_meta,
            )
            .await?;
        }

        Ok(reward_views)
    }

    async fn grant_title_tx(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        character_id: i64,
        title_id: Option<&str>,
    ) -> Result<Option<AchievementTitleRewardView>, BusinessError> {
        let Some(normalized_title_id) = title_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        let Some(title_meta) = title_meta_by_id()?.get(normalized_title_id).cloned() else {
            return Ok(None);
        };

        sqlx::query(
            r#"
            INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, expires_at, updated_at)
            VALUES ($1, $2, false, NOW(), NULL, NOW())
            ON CONFLICT (character_id, title_id)
            DO UPDATE SET
              expires_at = EXCLUDED.expires_at,
              obtained_at = NOW(),
              updated_at = NOW()
            "#,
        )
        .bind(character_id)
        .bind(normalized_title_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        Ok(Some(AchievementTitleRewardView {
            id: title_meta.id,
            name: title_meta.name,
            color: title_meta.color,
            icon: title_meta.icon,
        }))
    }
}

impl AchievementRouteServices for RustAchievementRouteService {
    fn get_achievement_list<'a>(
        &'a self,
        character_id: i64,
        query: AchievementListQuery,
    ) -> Pin<Box<dyn Future<Output = Result<AchievementListDataView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_achievement_list_impl(character_id, query).await })
    }

    fn get_achievement_detail<'a>(
        &'a self,
        character_id: i64,
        achievement_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<AchievementDetailDataView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.get_achievement_detail_impl(character_id, achievement_id)
                .await
        })
    }

    fn claim_achievement<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementActionResult<AchievementClaimDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.claim_achievement_impl(user_id, character_id, achievement_id)
                .await
        })
    }

    fn get_achievement_point_rewards<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementPointRewardListDataView, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_achievement_point_rewards_impl(character_id).await })
    }

    fn claim_achievement_point_reward<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        threshold: Option<Value>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementPointRewardClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.claim_achievement_point_reward_impl(user_id, character_id, threshold)
                .await
        })
    }
}

fn achievement_definitions() -> Result<&'static Vec<AchievementDefinition>, BusinessError> {
    ACHIEVEMENT_DEFINITION_CACHE
        .get_or_init(|| load_achievement_definitions().map_err(|error| error.message))
        .as_ref()
        .map_err(|error| internal_logic_business_error(error))
}

fn point_reward_definitions() -> Result<&'static Vec<AchievementPointRewardDefinition>, BusinessError> {
    ACHIEVEMENT_POINT_REWARD_CACHE
        .get_or_init(|| load_point_reward_definitions().map_err(|error| error.message))
        .as_ref()
        .map_err(|error| internal_logic_business_error(error))
}

fn item_meta_by_id() -> Result<&'static HashMap<String, AchievementItemMeta>, BusinessError> {
    ACHIEVEMENT_ITEM_META_CACHE
        .get_or_init(|| load_item_meta_by_id().map_err(|error| error.message))
        .as_ref()
        .map_err(|error| internal_logic_business_error(error))
}

fn title_meta_by_id() -> Result<&'static HashMap<String, AchievementTitleMeta>, BusinessError> {
    ACHIEVEMENT_TITLE_META_CACHE
        .get_or_init(|| load_title_meta_by_id().map_err(|error| error.message))
        .as_ref()
        .map_err(|error| internal_logic_business_error(error))
}

fn load_achievement_definitions() -> Result<Vec<AchievementDefinition>, BusinessError> {
    let file = read_seed_json::<AchievementDefinitionFile>("achievement_def.json")
        .map_err(internal_seed_business_error)?;
    let mut definitions = file
        .achievements
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| AchievementDefinition {
            id: row.id.trim().to_string(),
            name: row.name.trim().to_string(),
            description: row.description,
            category: normalize_optional_text(row.category).unwrap_or_else(|| "combat".to_string()),
            points: row.points.unwrap_or(0).max(0),
            icon: normalize_optional_text(row.icon),
            hidden: row.hidden == Some(true),
            track_type: normalize_track_type(row.track_type.as_deref()).to_string(),
            track_key: row.track_key.trim().to_string(),
            target_value: row.target_value.unwrap_or(1).max(1),
            target_list: normalize_target_list(row.target_list),
            rewards: row.rewards.unwrap_or_default(),
            title_id: normalize_optional_text(row.title_id),
            sort_weight: row.sort_weight.unwrap_or(0),
        })
        .filter(|row| !row.id.is_empty() && !row.name.is_empty() && !row.track_key.is_empty())
        .collect::<Vec<_>>();
    definitions.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then_with(|| right.sort_weight.cmp(&left.sort_weight))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(definitions)
}

fn load_point_reward_definitions() -> Result<Vec<AchievementPointRewardDefinition>, BusinessError> {
    let file = read_seed_json::<AchievementPointRewardFile>("achievement_points_rewards.json")
        .map_err(internal_seed_business_error)?;
    let mut rewards = file
        .rewards
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| AchievementPointRewardDefinition {
            id: row.id.trim().to_string(),
            threshold: row.points_threshold.unwrap_or(-1),
            name: row.name.trim().to_string(),
            description: row.description,
            rewards: row.rewards.unwrap_or_default(),
            title_id: normalize_optional_text(row.title_id),
            sort_weight: row.sort_weight.unwrap_or(0),
        })
        .filter(|row| !row.id.is_empty() && !row.name.is_empty() && row.threshold >= 0)
        .collect::<Vec<_>>();
    rewards.sort_by(|left, right| {
        left.threshold
            .cmp(&right.threshold)
            .then_with(|| right.sort_weight.cmp(&left.sort_weight))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(rewards)
}

fn load_item_meta_by_id() -> Result<HashMap<String, AchievementItemMeta>, BusinessError> {
    let file =
        read_seed_json::<ItemSeedFile>("item_def.json").map_err(internal_seed_business_error)?;
    Ok(file
        .items
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .filter_map(|row| {
            let item_id = row.id.trim().to_string();
            let item_name = row.name.trim().to_string();
            if item_id.is_empty() || item_name.is_empty() {
                return None;
            }
            Some((
                item_id,
                AchievementItemMeta {
                    name: item_name,
                    icon: normalize_optional_text(row.icon),
                    bind_type: normalize_item_bind_type(row.bind_type),
                    stack_max: row.stack_max.unwrap_or(1).max(1),
                },
            ))
        })
        .collect())
}

fn load_title_meta_by_id() -> Result<HashMap<String, AchievementTitleMeta>, BusinessError> {
    let file =
        read_seed_json::<TitleSeedFile>("title_def.json").map_err(internal_seed_business_error)?;
    Ok(file
        .titles
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .filter_map(|row| {
            let title_id = row.id.trim().to_string();
            let title_name = row.name.trim().to_string();
            if title_id.is_empty() || title_name.is_empty() {
                return None;
            }
            Some((
                title_id.clone(),
                AchievementTitleMeta {
                    id: title_id,
                    name: title_name,
                    color: normalize_optional_text(row.color),
                    icon: normalize_optional_text(row.icon),
                },
            ))
        })
        .collect())
}

async fn ensure_character_achievement_points_tx(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
) -> Result<(), BusinessError> {
    sqlx::query(
        r#"
        INSERT INTO character_achievement_points (character_id)
        VALUES ($1)
        ON CONFLICT (character_id) DO NOTHING
        "#,
    )
    .bind(character_id)
    .execute(&mut **transaction)
    .await
    .map_err(internal_business_error)?;
    Ok(())
}

async fn load_achievement_point_state_tx(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
) -> Result<AchievementPointState, BusinessError> {
    let row = sqlx::query(
        r#"
        SELECT
          total_points,
          combat_points,
          cultivation_points,
          exploration_points,
          social_points,
          collection_points,
          claimed_thresholds
        FROM character_achievement_points
        WHERE character_id = $1
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(internal_business_error)?;
    Ok(parse_achievement_point_state(row.as_ref()))
}

fn parse_achievement_point_state(row: Option<&sqlx::postgres::PgRow>) -> AchievementPointState {
    AchievementPointState {
        total_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("total_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        combat_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("combat_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        cultivation_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("cultivation_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        exploration_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("exploration_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        social_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("social_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        collection_points: row
            .and_then(|value| value.try_get::<Option<i64>, _>("collection_points").ok().flatten())
            .unwrap_or(0)
            .max(0),
        claimed_thresholds: row
            .and_then(|value| value.try_get::<Option<Value>, _>("claimed_thresholds").ok().flatten())
            .map(|value| parse_claimed_thresholds(&value))
            .unwrap_or_default(),
    }
}

fn build_reward_views(rewards: &[AchievementRewardSeed]) -> Result<Vec<AchievementRewardView>, BusinessError> {
    let item_meta = item_meta_by_id()?;
    let mut result = Vec::new();
    for reward in rewards {
        match reward.reward_type.trim() {
            "silver" => {
                let amount = reward.amount.unwrap_or(0).max(0);
                if amount > 0 {
                    result.push(AchievementRewardView::Silver { amount });
                }
            }
            "spirit_stones" => {
                let amount = reward.amount.unwrap_or(0).max(0);
                if amount > 0 {
                    result.push(AchievementRewardView::SpiritStones { amount });
                }
            }
            "exp" => {
                let amount = reward.amount.unwrap_or(0).max(0);
                if amount > 0 {
                    result.push(AchievementRewardView::Exp { amount });
                }
            }
            "item" => {
                let Some(item_def_id) = normalize_optional_text(reward.item_def_id.clone()) else {
                    continue;
                };
                let qty = reward.qty.unwrap_or(1).max(1);
                let meta = item_meta.get(item_def_id.as_str());
                result.push(AchievementRewardView::Item {
                    item_def_id: item_def_id.clone(),
                    qty,
                    item_name: meta.map(|value| value.name.clone()),
                    item_icon: meta.and_then(|value| value.icon.clone()),
                });
            }
            _ => {}
        }
    }
    Ok(result)
}

fn lookup_title_reward(
    title_id: Option<&str>,
) -> Result<Option<AchievementTitleRewardView>, BusinessError> {
    let Some(normalized_title_id) = title_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(meta) = title_meta_by_id()?.get(normalized_title_id) else {
        return Ok(None);
    };
    Ok(Some(AchievementTitleRewardView {
        id: meta.id.clone(),
        name: meta.name.clone(),
        color: meta.color.clone(),
        icon: meta.icon.clone(),
    }))
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.map(|raw| raw.trim().to_string()).filter(|raw| !raw.is_empty())
}

fn normalize_track_type(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("flag") => "flag",
        Some("multi") => "multi",
        _ => "counter",
    }
}

fn normalize_status(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("completed") => "completed",
        Some("claimed") => "claimed",
        _ => "in_progress",
    }
}

fn normalize_status_filter(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("in_progress") => "in_progress",
        Some("completed") => "completed",
        Some("claimed") => "claimed",
        Some("claimable") => "claimable",
        _ => "all",
    }
}

fn filter_status(progress_status: Option<&str>, status_filter: &str) -> bool {
    let normalized_status = normalize_status(progress_status);
    match status_filter {
        "in_progress" => normalized_status == "in_progress",
        "completed" | "claimable" => normalized_status == "completed",
        "claimed" => normalized_status == "claimed",
        _ => true,
    }
}

fn normalize_target_list(value: Option<Vec<Value>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for entry in value.unwrap_or_default() {
        let normalized = match entry {
            Value::String(text) => {
                let normalized = text.trim().to_string();
                (!normalized.is_empty()).then_some(normalized)
            }
            Value::Object(object) => object
                .get("key")
                .or_else(|| object.get("track_key"))
                .or_else(|| object.get("trackKey"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned),
            _ => None,
        };
        let Some(normalized) = normalized else {
            continue;
        };
        if seen.insert(normalized.clone()) {
            result.push(normalized);
        }
    }
    result
}

fn parse_claimed_thresholds(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| parse_threshold_value(Some(&entry)))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .tap_mut(|values| values.sort_unstable())
}

fn parse_positive_i64(value: Option<&str>) -> Option<i64> {
    let parsed = value?.trim().parse::<i64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn parse_threshold_value(value: Option<&Value>) -> Option<i64> {
    let raw = value?;
    match raw {
        Value::Number(number) => number.as_i64().filter(|value| *value >= 0),
        Value::String(text) => text.trim().parse::<i64>().ok().filter(|value| *value >= 0),
        _ => None,
    }
}

fn parse_required_layer(track_key: &str) -> Option<i64> {
    track_key
        .strip_prefix("skill:level:layer:")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn apply_points_delta(
    target: &mut AchievementPointsByCategoryView,
    category: &str,
    points: i64,
) {
    match category.trim().to_ascii_lowercase().as_str() {
        "combat" => target.combat += points,
        "cultivation" | "skill" | "technique" => target.cultivation += points,
        "exploration" | "dungeon" => target.exploration += points,
        "social" => target.social += points,
        "collection" | "equipment" | "life" => target.collection += points,
        _ => {}
    }
}

fn build_points_info_view(state: &AchievementPointState) -> AchievementPointsInfoView {
    AchievementPointsInfoView {
        total: state.total_points,
        by_category: AchievementPointsByCategoryView {
            combat: state.combat_points,
            cultivation: state.cultivation_points,
            exploration: state.exploration_points,
            social: state.social_points,
            collection: state.collection_points,
        },
    }
}

fn realm_rank(realm: Option<&str>, sub_realm: Option<&str>) -> i32 {
    const ORDER: [&str; 10] = [
        "凡人",
        "炼精化炁·养气期",
        "炼精化炁·练气期",
        "炼精化炁·筑基期",
        "炼气化神·结丹期",
        "炼气化神·元婴期",
        "炼神还虚·化神期",
        "炼神还虚·炼虚期",
        "炼虚合道·合体期",
        "炼虚合道·渡劫期",
    ];
    let normalized_realm = realm.unwrap_or_default().trim();
    if normalized_realm.is_empty() {
        return -1;
    }
    if let Some(index) = ORDER.iter().position(|value| *value == normalized_realm) {
        return index as i32;
    }
    match sub_realm.unwrap_or_default().trim() {
        "养气期" => 1,
        "练气期" => 2,
        "筑基期" => 3,
        "结丹期" => 4,
        "元婴期" => 5,
        "化神期" => 6,
        "炼虚期" => 7,
        "合体期" => 8,
        "渡劫期" => 9,
        _ => -1,
    }
}

fn normalize_item_bind_type(value: Option<String>) -> String {
    match value
        .unwrap_or_else(|| "none".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "bound" => "bound".to_string(),
        "bind_on_equip" => "bind_on_equip".to_string(),
        _ => "none".to_string(),
    }
}

fn action_failure<T>(message: &str) -> AchievementActionResult<T> {
    AchievementActionResult {
        success: false,
        message: message.to_string(),
        data: None,
    }
}

fn internal_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status(
        "服务器错误",
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn internal_seed_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status(
        "服务器错误",
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn internal_logic_business_error(_message: impl AsRef<str>) -> BusinessError {
    BusinessError::with_status(
        "服务器错误",
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    )
}

trait TapMut: Sized {
    fn tap_mut(self, f: impl FnOnce(&mut Self)) -> Self;
}

impl<T> TapMut for T {
    fn tap_mut(mut self, f: impl FnOnce(&mut Self)) -> Self {
        f(&mut self);
        self
    }
}
