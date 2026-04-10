use std::collections::HashMap;
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use chrono::{Datelike, Local, NaiveDate};
use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;

use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::battle_pass::{
    BattlePassRewardItemView, BattlePassRewardView, BattlePassRouteServices,
    BattlePassStatusView, BattlePassTaskView, BattlePassTasksOverviewView,
    CompleteBattlePassTaskDataView,
};
use crate::shared::error::AppError;

static BATTLE_PASS_STATIC_CONFIG: OnceLock<Result<BattlePassStaticConfig, String>> =
    OnceLock::new();
static BATTLE_PASS_ITEM_META: OnceLock<Result<HashMap<String, ItemDisplayMeta>, String>> =
    OnceLock::new();

const DEFAULT_MAX_LEVEL: i64 = 30;
const DEFAULT_EXP_PER_LEVEL: i64 = 1_000;

/**
 * 战令应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `battlePassService` 的战令任务概览、任务完成、赛季状态与奖励列表逻辑。
 * 2. 做什么：把赛季回退、周期判断、静态奖励展示映射和进度写库收敛到单一入口，避免路由层重复维护规则。
 * 3. 不做什么：不在这里实现奖励领取入包、特权解锁购买和事件驱动进度累加；这些属于后续战令剩余链路。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、可选 `season_id`、`task_id`。
 * - 输出：Node 兼容的任务概览 / 状态 / 奖励 DTO，以及 `sendResult` 风格的任务完成结果。
 *
 * 数据流 / 状态流：
 * - 任务概览：HTTP -> 本服务 -> 解析静态任务配置 -> 读取 `battle_pass_task_progress` -> 周期化归并 -> 返回 DTO。
 * - 状态：HTTP -> 本服务 -> 读取 `battle_pass_progress` + `battle_pass_claim_record` -> 返回赛季状态。
 * - 任务完成：HTTP -> 本服务 -> 事务锁定目标进度 -> 校验周期状态 -> 写入进度与经验 -> 返回完成结果。
 *
 * 复用设计说明：
 * - 静态配置、奖励展示元数据、角色 ID 查询和周期判定都集中在这里，后续如果首页聚合要展示战令红点，可以直接复用本模块。
 * - 任务完成与概览共用同一套赛季解析和任务定义索引，避免两条链路各自维护启用态和目标值。
 *
 * 关键边界条件与坑点：
 * 1. `completed/claimed/progressValue` 必须继续按 daily/weekly 周期衰减，不能把旧赛季或上周数据直接透传给当前视图。
 * 2. 配置读取失败必须直接报 500，不能默默返回空任务列表，否则会掩盖 Node 权威种子与 Rust 实现漂移。
 */
#[derive(Debug, Clone)]
pub struct RustBattlePassRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassRewardFile {
    season: BattlePassSeasonSeed,
    rewards: Vec<BattlePassRewardSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassTaskFile {
    season_id: String,
    tasks: Vec<BattlePassTaskSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassSeasonSeed {
    id: String,
    name: String,
    start_at: String,
    end_at: String,
    max_level: Option<i64>,
    exp_per_level: Option<i64>,
    enabled: Option<bool>,
    sort_weight: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassRewardSeed {
    level: i64,
    free: Option<Vec<BattlePassRewardEntry>>,
    premium: Option<Vec<BattlePassRewardEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassTaskSeed {
    id: String,
    code: String,
    name: String,
    description: Option<String>,
    task_type: String,
    condition: Value,
    target_value: i64,
    reward_exp: i64,
    reward_extra: Option<Vec<Value>>,
    enabled: Option<bool>,
    sort_weight: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum BattlePassRewardEntry {
    #[serde(rename = "currency")]
    Currency { currency: String, amount: i64 },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        qty: i64,
    },
}

#[derive(Debug, Clone)]
struct BattlePassStaticConfig {
    season: BattlePassSeasonConfig,
    tasks_season_id: String,
    rewards: Vec<BattlePassRewardSeed>,
    tasks: Vec<BattlePassTaskSeed>,
}

#[derive(Debug, Clone)]
struct BattlePassSeasonConfig {
    id: String,
    name: String,
    start_at: String,
    end_at: String,
    max_level: i64,
    exp_per_level: i64,
    enabled: bool,
    sort_weight: i64,
}

#[derive(Debug, Clone)]
struct ItemDisplayMeta {
    name: String,
    icon: Option<String>,
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
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct TaskProgressSnapshot {
    progress_value: i64,
    completed: bool,
    completed_day: Option<String>,
    claimed: bool,
    claimed_day: Option<String>,
    updated_day: Option<String>,
}

impl RustBattlePassRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_tasks_overview_impl(
        &self,
        user_id: i64,
        season_id: Option<String>,
    ) -> Result<BattlePassTasksOverviewView, BusinessError> {
        let config = battle_pass_static_config().map_err(internal_business_error)?;
        let resolved_season_id =
            resolve_requested_or_default_season_id(config, season_id.as_deref());
        if resolved_season_id.is_empty() {
            return Ok(empty_tasks_overview(String::new()));
        }

        let Some(character_id) = load_character_id(&self.pool, user_id).await? else {
            return Ok(empty_tasks_overview(resolved_season_id));
        };

        let progress_rows = sqlx::query(
            r#"
            SELECT
              task_id,
              COALESCE(progress_value, 0)::bigint AS progress_value,
              COALESCE(completed, FALSE) AS completed,
              COALESCE(claimed, FALSE) AS claimed,
              to_char(completed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS completed_day,
              to_char(claimed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS claimed_day,
              to_char(updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS updated_day
            FROM battle_pass_task_progress
            WHERE season_id = $1 AND character_id = $2
            "#,
        )
        .bind(&resolved_season_id)
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut progress_by_task_id = HashMap::with_capacity(progress_rows.len());
        for row in progress_rows {
            let task_id = row.get::<String, _>("task_id");
            if task_id.trim().is_empty() {
                continue;
            }
            progress_by_task_id.insert(
                task_id,
                TaskProgressSnapshot {
                    progress_value: row.get::<i64, _>("progress_value"),
                    completed: row.get::<bool, _>("completed"),
                    completed_day: trim_optional_string(row.try_get("completed_day").ok().flatten()),
                    claimed: row.get::<bool, _>("claimed"),
                    claimed_day: trim_optional_string(row.try_get("claimed_day").ok().flatten()),
                    updated_day: trim_optional_string(row.try_get("updated_day").ok().flatten()),
                },
            );
        }

        let today = Local::now().date_naive();
        let mut daily = Vec::new();
        let mut weekly = Vec::new();
        let mut season = Vec::new();

        for task in config
            .tasks
            .iter()
            .filter(|task| task.enabled.unwrap_or(true))
            .filter(|_| resolved_season_id == config.tasks_season_id)
        {
            let progress = progress_by_task_id.get(task.id.as_str());
            let completed = progress
                .filter(|value| value.completed)
                .and_then(|value| value.completed_day.as_deref())
                .map(|day| is_in_current_cycle(task.task_type.as_str(), Some(day), today))
                .unwrap_or(false);
            let claimed = progress
                .filter(|value| value.claimed)
                .and_then(|value| value.claimed_day.as_deref())
                .map(|day| is_in_current_cycle(task.task_type.as_str(), Some(day), today))
                .unwrap_or(false);
            let progress_value = progress
                .and_then(|value| value.updated_day.as_deref().map(|day| (value, day)))
                .filter(|(_, day)| is_in_current_cycle(task.task_type.as_str(), Some(day), today))
                .map(|(value, _)| value.progress_value.max(0))
                .unwrap_or(0);
            let view = BattlePassTaskView {
                id: task.id.clone(),
                code: task.code.clone(),
                name: task.name.clone(),
                description: task.description.clone().unwrap_or_default(),
                task_type: task.task_type.clone(),
                condition: task.condition.clone(),
                target_value: task.target_value.max(1),
                reward_exp: task.reward_exp.max(0),
                reward_extra: task.reward_extra.clone().unwrap_or_default(),
                enabled: task.enabled.unwrap_or(true),
                sort_weight: task.sort_weight.unwrap_or(0),
                progress_value,
                completed,
                claimed,
            };
            match task.task_type.as_str() {
                "daily" => daily.push(view),
                "weekly" => weekly.push(view),
                _ => season.push(view),
            }
        }

        sort_task_views(&mut daily);
        sort_task_views(&mut weekly);
        sort_task_views(&mut season);

        Ok(BattlePassTasksOverviewView {
            season_id: resolved_season_id,
            daily,
            weekly,
            season,
        })
    }

    async fn complete_task_impl(
        &self,
        user_id: i64,
        task_id: String,
    ) -> Result<ServiceResultResponse<CompleteBattlePassTaskDataView>, BusinessError> {
        let normalized_task_id = task_id.trim().to_string();
        if normalized_task_id.is_empty() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("任务ID无效".to_string()),
                None,
            ));
        }

        let Some(character_id) = load_character_id(&self.pool, user_id).await? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };

        let config = battle_pass_static_config().map_err(internal_business_error)?;
        let Some(season_id) = resolve_active_or_default_season_id(config) else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("当前没有进行中的赛季".to_string()),
                None,
            ));
        };
        if config.season.id != season_id {
            return Ok(ServiceResultResponse::new(
                false,
                Some("赛季配置不存在".to_string()),
                None,
            ));
        }

        let Some(task) = config
            .tasks
            .iter()
            .find(|entry| entry.id == normalized_task_id && entry.enabled.unwrap_or(true))
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("任务不存在或未启用".to_string()),
                None,
            ));
        };

        let task_type = normalize_task_type(task.task_type.as_str()).ok_or_else(|| {
            BusinessError::new("任务类型不支持")
        })?;
        let target_value = task.target_value.max(1);
        let reward_exp = task.reward_exp.max(0);
        let max_level = config.season.max_level.max(1);
        let exp_per_level = config.season.exp_per_level.max(1);
        let max_exp = max_level.saturating_mul(exp_per_level);
        let today = Local::now().date_naive();

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let progress_row = sqlx::query(
            r#"
            SELECT
              COALESCE(progress_value, 0)::bigint AS progress_value,
              COALESCE(completed, FALSE) AS completed,
              to_char(completed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS completed_day,
              to_char(updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS updated_day
            FROM battle_pass_task_progress
            WHERE character_id = $1
              AND season_id = $2
              AND task_id = $3
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .bind(&season_id)
        .bind(&normalized_task_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        let completed_in_cycle = progress_row
            .as_ref()
            .filter(|row| row.get::<bool, _>("completed"))
            .and_then(|row| row.try_get::<Option<String>, _>("completed_day").ok().flatten())
            .map(|day| is_in_current_cycle(task_type, Some(day.as_str()), today))
            .unwrap_or(false);
        if completed_in_cycle {
            return Ok(ServiceResultResponse::new(
                false,
                Some("任务已完成".to_string()),
                None,
            ));
        }

        let current_progress_value = progress_row
            .as_ref()
            .and_then(|row| row.try_get::<Option<String>, _>("updated_day").ok().flatten().map(|day| (row, day)))
            .filter(|(_, day)| is_in_current_cycle(task_type, Some(day.as_str()), today))
            .map(|(row, _)| row.get::<i64, _>("progress_value").max(0))
            .unwrap_or(0);
        if current_progress_value < target_value {
            return Ok(ServiceResultResponse::new(
                false,
                Some("任务目标未达成，无法完成".to_string()),
                None,
            ));
        }

        sqlx::query(
            r#"
            INSERT INTO battle_pass_task_progress (
              character_id,
              season_id,
              task_id,
              progress_value,
              completed,
              completed_at,
              claimed,
              claimed_at,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, TRUE, NOW(), TRUE, NOW(), NOW(), NOW())
            ON CONFLICT (character_id, season_id, task_id)
            DO UPDATE SET
              progress_value = EXCLUDED.progress_value,
              completed = TRUE,
              completed_at = NOW(),
              claimed = TRUE,
              claimed_at = NOW(),
              updated_at = NOW()
            "#,
        )
        .bind(character_id)
        .bind(&season_id)
        .bind(&normalized_task_id)
        .bind(target_value)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        let exp = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO battle_pass_progress (character_id, season_id, exp, created_at, updated_at)
            VALUES ($1, $2, LEAST($3::bigint, $4::bigint), NOW(), NOW())
            ON CONFLICT (character_id, season_id)
            DO UPDATE SET
              exp = LEAST($4::bigint, battle_pass_progress.exp + $3::bigint),
              updated_at = NOW()
            RETURNING exp
            "#,
        )
        .bind(character_id)
        .bind(&season_id)
        .bind(reward_exp)
        .bind(max_exp)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction.commit().await.map_err(internal_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some("任务完成".to_string()),
            Some(CompleteBattlePassTaskDataView {
                task_id: normalized_task_id,
                task_type: task_type.to_string(),
                gained_exp: reward_exp,
                exp,
                level: calculate_level(exp, exp_per_level, max_level),
                max_level,
                exp_per_level,
            }),
        ))
    }

    async fn get_status_impl(
        &self,
        user_id: i64,
    ) -> Result<Option<BattlePassStatusView>, BusinessError> {
        let Some(character_id) = load_character_id(&self.pool, user_id).await? else {
            return Ok(None);
        };
        let config = battle_pass_static_config().map_err(internal_business_error)?;
        let Some(season_id) = resolve_active_or_default_season_id(config) else {
            return Ok(None);
        };
        if config.season.id != season_id {
            return Ok(None);
        }

        let progress_row = sqlx::query(
            r#"
            SELECT COALESCE(exp, 0)::bigint AS exp, COALESCE(premium_unlocked, FALSE) AS premium_unlocked
            FROM battle_pass_progress
            WHERE character_id = $1 AND season_id = $2
            "#,
        )
        .bind(character_id)
        .bind(&season_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;
        let exp = progress_row
            .as_ref()
            .map(|row| row.get::<i64, _>("exp"))
            .unwrap_or(0);
        let premium_unlocked = progress_row
            .as_ref()
            .map(|row| row.get::<bool, _>("premium_unlocked"))
            .unwrap_or(false);

        let claim_rows = sqlx::query(
            r#"
            SELECT level, track
            FROM battle_pass_claim_record
            WHERE character_id = $1 AND season_id = $2
            "#,
        )
        .bind(character_id)
        .bind(&season_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut claimed_free_levels = Vec::new();
        let mut claimed_premium_levels = Vec::new();
        for row in claim_rows {
            let level = row.get::<i32, _>("level") as i64;
            let track = row.get::<String, _>("track");
            if track == "free" {
                claimed_free_levels.push(level);
            } else if track == "premium" {
                claimed_premium_levels.push(level);
            }
        }
        claimed_free_levels.sort_unstable();
        claimed_premium_levels.sort_unstable();

        Ok(Some(BattlePassStatusView {
            season_id,
            season_name: config.season.name.clone(),
            exp,
            level: calculate_level(exp, config.season.exp_per_level, config.season.max_level),
            max_level: config.season.max_level,
            exp_per_level: config.season.exp_per_level,
            premium_unlocked,
            claimed_free_levels,
            claimed_premium_levels,
        }))
    }

    async fn get_rewards_impl(
        &self,
        season_id: Option<String>,
    ) -> Result<Vec<BattlePassRewardView>, BusinessError> {
        let config = battle_pass_static_config().map_err(internal_business_error)?;
        let resolved_season_id =
            resolve_requested_or_default_season_id(config, season_id.as_deref());
        if resolved_season_id.is_empty() || config.season.id != resolved_season_id {
            return Ok(Vec::new());
        }
        let item_meta = battle_pass_item_meta().map_err(internal_business_error)?;

        Ok(config
            .rewards
            .iter()
            .map(|entry| BattlePassRewardView {
                level: entry.level,
                free_rewards: build_reward_item_views(entry.free.as_deref(), item_meta),
                premium_rewards: build_reward_item_views(entry.premium.as_deref(), item_meta),
            })
            .collect())
    }
}

impl BattlePassRouteServices for RustBattlePassRouteService {
    fn get_tasks_overview<'a>(
        &'a self,
        user_id: i64,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<BattlePassTasksOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_tasks_overview_impl(user_id, season_id).await })
    }

    fn complete_task<'a>(
        &'a self,
        user_id: i64,
        task_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<CompleteBattlePassTaskDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.complete_task_impl(user_id, task_id).await })
    }

    fn get_status<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<BattlePassStatusView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_status_impl(user_id).await })
    }

    fn get_rewards<'a>(
        &'a self,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<BattlePassRewardView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_rewards_impl(season_id).await })
    }
}

fn battle_pass_static_config() -> Result<&'static BattlePassStaticConfig, AppError> {
    match BATTLE_PASS_STATIC_CONFIG.get_or_init(|| {
        load_battle_pass_static_config().map_err(|error| error.to_string())
    }) {
        Ok(config) => Ok(config),
        Err(message) => Err(AppError::Config(message.clone())),
    }
}

fn battle_pass_item_meta() -> Result<&'static HashMap<String, ItemDisplayMeta>, AppError> {
    match BATTLE_PASS_ITEM_META.get_or_init(|| {
        load_item_meta().map_err(|error| error.to_string())
    }) {
        Ok(index) => Ok(index),
        Err(message) => Err(AppError::Config(message.clone())),
    }
}

fn load_battle_pass_static_config() -> Result<BattlePassStaticConfig, AppError> {
    let reward_file = read_seed_json::<BattlePassRewardFile>("battle_pass_rewards.json")?;
    let task_file = read_seed_json::<BattlePassTaskFile>("battle_pass_tasks.json")?;
    Ok(BattlePassStaticConfig {
        season: BattlePassSeasonConfig {
            id: reward_file.season.id,
            name: reward_file.season.name,
            start_at: reward_file.season.start_at,
            end_at: reward_file.season.end_at,
            max_level: reward_file
                .season
                .max_level
                .unwrap_or(DEFAULT_MAX_LEVEL)
                .max(1),
            exp_per_level: reward_file
                .season
                .exp_per_level
                .unwrap_or(DEFAULT_EXP_PER_LEVEL)
                .max(1),
            enabled: reward_file.season.enabled.unwrap_or(true),
            sort_weight: reward_file.season.sort_weight.unwrap_or(0),
        },
        tasks_season_id: task_file.season_id,
        rewards: reward_file.rewards,
        tasks: task_file.tasks,
    })
}

fn load_item_meta() -> Result<HashMap<String, ItemDisplayMeta>, AppError> {
    let file = read_seed_json::<ItemSeedFile>("item_def.json")?;
    Ok(file
        .items
        .into_iter()
        .filter(|item| item.enabled.unwrap_or(true))
        .filter_map(|item| {
            let id = item.id.trim().to_string();
            let name = item.name.trim().to_string();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some((
                id,
                ItemDisplayMeta {
                    name,
                    icon: trim_optional_string(item.icon),
                },
            ))
        })
        .collect())
}

async fn load_character_id(
    pool: &sqlx::PgPool,
    user_id: i64,
) -> Result<Option<i64>, BusinessError> {
    sqlx::query_scalar::<_, i64>("SELECT id FROM characters WHERE user_id = $1 LIMIT 1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(internal_business_error)
}

fn resolve_requested_or_default_season_id(
    config: &BattlePassStaticConfig,
    season_id: Option<&str>,
) -> String {
    if let Some(value) = season_id.map(str::trim).filter(|value| !value.is_empty()) {
        return if config.season.id == value {
            value.to_string()
        } else {
            String::new()
        };
    }
    resolve_active_or_default_season_id(config).unwrap_or_default()
}

fn resolve_active_or_default_season_id(config: &BattlePassStaticConfig) -> Option<String> {
    if !config.season.enabled {
        return None;
    }
    if season_is_active(config) {
        return Some(config.season.id.clone());
    }
    Some(config.season.id.clone())
}

fn season_is_active(config: &BattlePassStaticConfig) -> bool {
    let start_at = chrono::DateTime::parse_from_rfc3339(config.season.start_at.as_str()).ok();
    let end_at = chrono::DateTime::parse_from_rfc3339(config.season.end_at.as_str()).ok();
    let now = chrono::Utc::now();
    match (start_at, end_at) {
        (Some(start), Some(end)) => start.with_timezone(&chrono::Utc) <= now && end.with_timezone(&chrono::Utc) > now,
        _ => false,
    }
}

fn empty_tasks_overview(season_id: String) -> BattlePassTasksOverviewView {
    BattlePassTasksOverviewView {
        season_id,
        daily: Vec::new(),
        weekly: Vec::new(),
        season: Vec::new(),
    }
}

fn sort_task_views(items: &mut [BattlePassTaskView]) {
    items.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn normalize_task_type(task_type: &str) -> Option<&str> {
    match task_type {
        "daily" => Some("daily"),
        "weekly" => Some("weekly"),
        "season" => Some("season"),
        _ => None,
    }
}

fn is_in_current_cycle(task_type: &str, day: Option<&str>, today: NaiveDate) -> bool {
    let Some(day) = day else {
        return false;
    };
    if task_type == "season" {
        return true;
    }
    let Ok(date) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
        return false;
    };
    if task_type == "daily" {
        return date == today;
    }
    if task_type == "weekly" {
        let weekday = today.weekday().num_days_from_monday() as i64;
        let week_start = today - chrono::Duration::days(weekday);
        return date >= week_start;
    }
    false
}

fn build_reward_item_views(
    entries: Option<&[BattlePassRewardEntry]>,
    item_meta: &HashMap<String, ItemDisplayMeta>,
) -> Vec<BattlePassRewardItemView> {
    entries
        .unwrap_or(&[])
        .iter()
        .filter_map(|entry| match entry {
            BattlePassRewardEntry::Currency { currency, amount } => {
                let normalized_amount = (*amount).max(0);
                if normalized_amount <= 0 {
                    return None;
                }
                let currency_key = currency.trim();
                if currency_key != "silver" && currency_key != "spirit_stones" {
                    return None;
                }
                Some(BattlePassRewardItemView {
                    reward_type: "currency".to_string(),
                    currency: Some(currency_key.to_string()),
                    amount: Some(normalized_amount),
                    item_def_id: None,
                    qty: None,
                    name: reward_currency_display_name(currency_key).to_string(),
                    icon: None,
                })
            }
            BattlePassRewardEntry::Item { item_def_id, qty } => {
                let normalized_item_def_id = item_def_id.trim().to_string();
                let normalized_qty = (*qty).max(1);
                if normalized_item_def_id.is_empty() {
                    return None;
                }
                let display = item_meta.get(normalized_item_def_id.as_str());
                Some(BattlePassRewardItemView {
                    reward_type: "item".to_string(),
                    currency: None,
                    amount: None,
                    item_def_id: Some(normalized_item_def_id.clone()),
                    qty: Some(normalized_qty),
                    name: display
                        .map(|item| item.name.clone())
                        .unwrap_or_else(|| normalized_item_def_id.clone()),
                    icon: display.and_then(|item| item.icon.clone()),
                })
            }
        })
        .collect()
}

fn reward_currency_display_name(currency: &str) -> &'static str {
    if currency == "silver" {
        "银两"
    } else {
        "灵石"
    }
}

fn calculate_level(exp: i64, exp_per_level: i64, max_level: i64) -> i64 {
    ((exp.max(0) / exp_per_level.max(1)) + 1).min(max_level.max(1))
}

fn trim_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status(
        "服务器错误",
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    )
}
