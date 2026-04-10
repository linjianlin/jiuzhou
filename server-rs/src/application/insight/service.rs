use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::{Postgres, Row, Transaction};

use crate::application::static_data::realm::{
    get_realm_rank_zero_based, normalize_realm_keeping_unknown,
};
use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::insight::{
    InsightInjectResultView, InsightOverviewView, InsightRouteServices,
};

static INSIGHT_GROWTH_CONFIG: OnceLock<Result<InsightGrowthConfig, String>> = OnceLock::new();

/**
 * insight 悟道应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `insightService` 的总览读取与经验注入逻辑，输出 `/api/insight/overview|inject` 需要的统一业务结果。
 * 2. 做什么：把悟道配置读取、升级成本公式、部分经验注入结算与写库事务集中到单一服务，避免路由或后续模块重复实现规则。
 * 3. 不做什么：不做 HTTP 参数解析、不推送角色事件，也不在这里扩展体力缓存或其他尚未迁移的运行态副作用。
 *
 * 输入 / 输出：
 * - 输入：`user_id`，以及注入接口额外接收的 `exp` 正整数预算。
 * - 输出：Node 兼容的 `ServiceResultResponse<InsightOverviewView | InsightInjectResultView>`。
 *
 * 数据流 / 状态流：
 * - 路由完成鉴权 -> 本服务读取 `characters` / `character_insight_progress`
 * - 纯公式先计算升级结果 -> 成功时事务写回角色经验与悟道进度 -> 返回固定响应协议。
 *
 * 复用设计说明：
 * - 悟道配置缓存、境界解锁判断和注入结算都收敛在这里，后续角色面板、排行或属性重算接入悟道数据时可直接复用同一套规则。
 * - 只把稳定的 HTTP DTO 暴露给路由层，避免不同入口各自维护 “unlockRealm/currentLevel/currentBonusPct” 字段映射。
 *
 * 关键边界条件与坑点：
 * 1. 配置读取必须严格校验，任何字段非法都要明确返回失败，不能偷偷补默认值。
 * 2. 注入逻辑允许“经验不足但仍可累积到当前等级进度”的部分注入；不能误实现成只能整级升级。
 */
#[derive(Debug, Clone)]
pub struct RustInsightRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize)]
struct InsightGrowthFile {
    unlock_realm: String,
    cost_stage_levels: i64,
    cost_stage_base_exp: i64,
    bonus_pct_per_level: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct InsightGrowthConfig {
    unlock_realm: String,
    cost_stage_levels: i64,
    cost_stage_base_exp: i64,
    bonus_pct_per_level: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CharacterInsightRow {
    character_id: i64,
    realm: String,
    sub_realm: Option<String>,
    exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InsightProgressRow {
    level: i64,
    progress_exp: i64,
}

#[derive(Debug, Clone, PartialEq)]
struct InsightInjectResolution {
    actual_injected_levels: i64,
    spent_exp: i64,
    remaining_exp: i64,
    after_level: i64,
    after_progress_exp: i64,
    before_bonus_pct: f64,
    after_bonus_pct: f64,
}

impl RustInsightRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_overview_impl(
        &self,
        user_id: i64,
    ) -> Result<ServiceResultResponse<InsightOverviewView>, BusinessError> {
        let config = load_insight_growth_config()?;
        let Some(character) = load_character_insight_row(&self.pool, user_id).await.map_err(internal_business_error)? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };
        let progress = load_insight_progress(&self.pool, character.character_id)
            .await
            .map_err(internal_business_error)?;
        let unlocked = is_insight_unlocked(
            character.realm.as_str(),
            character.sub_realm.as_deref(),
            config.unlock_realm.as_str(),
        );

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(InsightOverviewView {
                unlocked,
                unlock_realm: config.unlock_realm.clone(),
                current_level: progress.level,
                current_progress_exp: progress.progress_exp,
                current_bonus_pct: build_insight_pct_bonus_by_level(progress.level, config),
                next_level_cost_exp: calc_insight_cost_by_level(progress.level + 1, config),
                character_exp: character.exp,
                cost_stage_levels: config.cost_stage_levels,
                cost_stage_base_exp: config.cost_stage_base_exp,
                bonus_pct_per_level: config.bonus_pct_per_level,
            }),
        ))
    }

    async fn inject_exp_impl(
        &self,
        user_id: i64,
        exp: i64,
    ) -> Result<ServiceResultResponse<InsightInjectResultView>, BusinessError> {
        let config = load_insight_growth_config()?;
        let inject_exp_budget = normalize_integer(exp);
        if inject_exp_budget <= 0 {
            return Ok(ServiceResultResponse::new(
                false,
                Some("注入经验无效，需大于 0".to_string()),
                None,
            ));
        }

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let Some(character) =
            load_character_insight_row_for_update(&mut transaction, user_id)
                .await
                .map_err(internal_business_error)?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };

        if !is_insight_unlocked(
            character.realm.as_str(),
            character.sub_realm.as_deref(),
            config.unlock_realm.as_str(),
        ) {
            return Ok(ServiceResultResponse::new(
                false,
                Some(format!("未达到{}，无法悟道", config.unlock_realm)),
                None,
            ));
        }

        let progress = ensure_insight_progress_for_update(&mut transaction, character.character_id)
            .await
            .map_err(internal_business_error)?;
        let inject_plan = resolve_insight_inject_plan(
            progress.level,
            progress.progress_exp,
            character.exp,
            inject_exp_budget,
            config,
        )
        .map_err(BusinessError::new)?;
        if inject_plan.spent_exp <= 0 {
            return Ok(ServiceResultResponse::new(
                false,
                Some("经验不足，无法悟道".to_string()),
                None,
            ));
        }

        sqlx::query(
            r#"
            UPDATE characters
            SET exp = $2,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(character.character_id)
        .bind(inject_plan.remaining_exp)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        sqlx::query(
            r#"
            UPDATE character_insight_progress
            SET level = $2,
                progress_exp = $3,
                total_exp_spent = total_exp_spent + $4,
                updated_at = NOW()
            WHERE character_id = $1
            "#,
        )
        .bind(character.character_id)
        .bind(inject_plan.after_level)
        .bind(inject_plan.after_progress_exp)
        .bind(inject_plan.spent_exp)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction.commit().await.map_err(internal_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some("悟道成功".to_string()),
            Some(InsightInjectResultView {
                before_level: progress.level,
                after_level: inject_plan.after_level,
                after_progress_exp: inject_plan.after_progress_exp,
                actual_injected_levels: inject_plan.actual_injected_levels,
                spent_exp: inject_plan.spent_exp,
                remaining_exp: inject_plan.remaining_exp,
                gained_bonus_pct: inject_plan.after_bonus_pct - inject_plan.before_bonus_pct,
                current_bonus_pct: inject_plan.after_bonus_pct,
            }),
        ))
    }
}

impl InsightRouteServices for RustInsightRouteService {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightOverviewView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_overview_impl(user_id).await })
    }

    fn inject_exp<'a>(
        &'a self,
        user_id: i64,
        exp: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightInjectResultView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.inject_exp_impl(user_id, exp).await })
    }
}

async fn load_character_insight_row(
    pool: &sqlx::PgPool,
    user_id: i64,
) -> Result<Option<CharacterInsightRow>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT id, realm, sub_realm, exp
        FROM characters
        WHERE user_id = $1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(map_character_insight_row))
}

async fn load_character_insight_row_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<Option<CharacterInsightRow>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT id, realm, sub_realm, exp
        FROM characters
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await?;

    Ok(row.map(map_character_insight_row))
}

async fn load_insight_progress(
    pool: &sqlx::PgPool,
    character_id: i64,
) -> Result<InsightProgressRow, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT level, progress_exp
        FROM character_insight_progress
        WHERE character_id = $1
        LIMIT 1
        "#,
    )
    .bind(character_id)
    .fetch_optional(pool)
    .await?;

    Ok(row
        .map(map_insight_progress_row)
        .unwrap_or(InsightProgressRow {
            level: 0,
            progress_exp: 0,
        }))
}

async fn ensure_insight_progress_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
) -> Result<InsightProgressRow, sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO character_insight_progress (
          character_id,
          level,
          progress_exp,
          total_exp_spent,
          created_at,
          updated_at
        )
        VALUES ($1, 0, 0, 0, NOW(), NOW())
        ON CONFLICT (character_id) DO NOTHING
        "#,
    )
    .bind(character_id)
    .execute(&mut **transaction)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT level, progress_exp
        FROM character_insight_progress
        WHERE character_id = $1
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(character_id)
    .fetch_optional(&mut **transaction)
    .await?;

    Ok(row
        .map(map_insight_progress_row)
        .unwrap_or(InsightProgressRow {
            level: 0,
            progress_exp: 0,
        }))
}

fn map_character_insight_row(row: sqlx::postgres::PgRow) -> CharacterInsightRow {
    CharacterInsightRow {
        character_id: normalize_integer(row.try_get::<i64, _>("id").unwrap_or(0)),
        realm: row
            .try_get::<String, _>("realm")
            .ok()
            .unwrap_or_else(|| "凡人".to_string()),
        sub_realm: row.try_get::<Option<String>, _>("sub_realm").ok().flatten(),
        exp: normalize_integer(row.try_get::<i64, _>("exp").unwrap_or(0)),
    }
}

fn map_insight_progress_row(row: sqlx::postgres::PgRow) -> InsightProgressRow {
    InsightProgressRow {
        level: normalize_integer(row.try_get::<i64, _>("level").unwrap_or(0)),
        progress_exp: normalize_integer(row.try_get::<i64, _>("progress_exp").unwrap_or(0)),
    }
}

fn load_insight_growth_config() -> Result<&'static InsightGrowthConfig, BusinessError> {
    let result = INSIGHT_GROWTH_CONFIG.get_or_init(|| {
        read_seed_json::<InsightGrowthFile>("insight_growth.json")
            .map_err(|error| error.to_string())
            .and_then(validate_insight_growth_config)
    });
    match result {
        Ok(config) => Ok(config),
        Err(message) => Err(BusinessError::with_status(
            format!("悟道配置异常：{message}"),
            StatusCode::BAD_REQUEST,
        )),
    }
}

fn validate_insight_growth_config(
    parsed: InsightGrowthFile,
) -> Result<InsightGrowthConfig, String> {
    let unlock_realm = parsed.unlock_realm.trim().to_string();
    if unlock_realm.is_empty() {
        return Err("insight_growth.unlock_realm 非法".to_string());
    }
    if parsed.cost_stage_levels <= 0 {
        return Err("insight_growth.cost_stage_levels 非法".to_string());
    }
    if parsed.cost_stage_base_exp <= 0 {
        return Err("insight_growth.cost_stage_base_exp 非法".to_string());
    }
    if !parsed.bonus_pct_per_level.is_finite()
        || parsed.bonus_pct_per_level <= 0.0
        || parsed.bonus_pct_per_level >= 1.0
    {
        return Err("insight_growth.bonus_pct_per_level 非法".to_string());
    }

    Ok(InsightGrowthConfig {
        unlock_realm,
        cost_stage_levels: parsed.cost_stage_levels,
        cost_stage_base_exp: parsed.cost_stage_base_exp,
        bonus_pct_per_level: parsed.bonus_pct_per_level,
    })
}

fn is_insight_unlocked(realm: &str, sub_realm: Option<&str>, unlock_realm: &str) -> bool {
    let current_realm = normalize_realm_keeping_unknown(Some(realm), sub_realm);
    get_realm_rank_zero_based(Some(current_realm.as_str()), None)
        >= get_realm_rank_zero_based(Some(unlock_realm), None)
}

fn calc_insight_cost_by_level(level: i64, config: &InsightGrowthConfig) -> i64 {
    let safe_level = level.max(1);
    let stage_index = ((safe_level - 1) / config.cost_stage_levels) + 1;
    normalize_integer(config.cost_stage_base_exp * stage_index)
}

fn build_insight_pct_bonus_by_level(level: i64, config: &InsightGrowthConfig) -> f64 {
    normalize_integer(level) as f64 * config.bonus_pct_per_level
}

fn resolve_insight_inject_plan(
    before_level: i64,
    before_progress_exp: i64,
    character_exp: i64,
    inject_exp_budget: i64,
    config: &InsightGrowthConfig,
) -> Result<InsightInjectResolution, String> {
    let safe_before_level = normalize_integer(before_level);
    let safe_character_exp = normalize_integer(character_exp);
    let safe_inject_exp_budget = normalize_integer(inject_exp_budget).min(safe_character_exp);
    let mut remaining_budget_exp = safe_inject_exp_budget;
    let mut current_level = safe_before_level;
    let mut current_progress_exp = normalize_integer(before_progress_exp);
    let mut gained_levels = 0;

    let before_level_cost = calc_insight_cost_by_level(safe_before_level + 1, config);
    if current_progress_exp >= before_level_cost {
        return Err("悟道进度异常：当前等级进度已超过升级需求".to_string());
    }

    while remaining_budget_exp > 0 {
        let next_level_cost = calc_insight_cost_by_level(current_level + 1, config);
        let required_exp = (next_level_cost - current_progress_exp).max(0);
        if required_exp <= 0 {
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }

        if remaining_budget_exp >= required_exp {
            remaining_budget_exp -= required_exp;
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }

        current_progress_exp += remaining_budget_exp;
        remaining_budget_exp = 0;
    }

    let before_bonus_pct = build_insight_pct_bonus_by_level(safe_before_level, config);
    let after_bonus_pct = build_insight_pct_bonus_by_level(current_level, config);
    let spent_exp = safe_inject_exp_budget - remaining_budget_exp;
    Ok(InsightInjectResolution {
        actual_injected_levels: gained_levels,
        spent_exp,
        remaining_exp: (safe_character_exp - spent_exp).max(0),
        after_level: current_level,
        after_progress_exp: current_progress_exp,
        before_bonus_pct,
        after_bonus_pct,
    })
}

fn normalize_integer(value: i64) -> i64 {
    value.max(0)
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::{
        build_insight_pct_bonus_by_level, calc_insight_cost_by_level,
        resolve_insight_inject_plan, InsightGrowthConfig,
    };

    fn mock_config() -> InsightGrowthConfig {
        InsightGrowthConfig {
            unlock_realm: "凡人".to_string(),
            cost_stage_levels: 50,
            cost_stage_base_exp: 500_000,
            bonus_pct_per_level: 0.0005,
        }
    }

    #[test]
    fn insight_cost_uses_stage_growth() {
        let config = mock_config();
        assert_eq!(calc_insight_cost_by_level(1, &config), 500_000);
        assert_eq!(calc_insight_cost_by_level(50, &config), 500_000);
        assert_eq!(calc_insight_cost_by_level(51, &config), 1_000_000);
        assert_eq!(calc_insight_cost_by_level(101, &config), 1_500_000);
    }

    #[test]
    fn insight_inject_plan_supports_partial_progress_accumulation() {
        let config = mock_config();
        let plan = resolve_insight_inject_plan(0, 100_000, 350_000, 350_000, &config)
            .expect("inject plan");
        assert_eq!(plan.actual_injected_levels, 0);
        assert_eq!(plan.spent_exp, 350_000);
        assert_eq!(plan.remaining_exp, 0);
        assert_eq!(plan.after_level, 0);
        assert_eq!(plan.after_progress_exp, 450_000);
    }

    #[test]
    fn insight_inject_plan_rejects_overflowed_progress() {
        let config = mock_config();
        let error = resolve_insight_inject_plan(0, 500_000, 500_000, 1, &config)
            .expect_err("invalid progress should fail");
        assert_eq!(error, "悟道进度异常：当前等级进度已超过升级需求");
    }

    #[test]
    fn insight_bonus_pct_scales_linearly_by_level() {
        let config = mock_config();
        assert!((build_insight_pct_bonus_by_level(200, &config) - 0.1).abs() < 1e-9);
    }
}
