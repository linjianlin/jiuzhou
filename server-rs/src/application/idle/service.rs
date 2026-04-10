use std::{future::Future, pin::Pin};

use redis::AsyncCommands;
use sqlx::Row;

use crate::bootstrap::app::SharedRuntimeServices;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::idle::{
    IdleAutoSkillPolicy, IdleConfigResponseData, IdleConfigUpdateInput, IdleConfigView,
    IdleDurationLimit, IdleRouteServices, IdleSessionView, IdleStartInput, IdleStartServiceResult,
    IdleStopServiceResult,
};

const IDLE_LOCK_TTL_BUFFER_MS: i64 = 5 * 60 * 1000;
const IDLE_LOCK_TTL_MIN_SECONDS: u64 = 60;
const IDLE_LOCK_TTL_MAX_SECONDS: u64 = (12 * 60 * 60) + (5 * 60);
const DEFAULT_IDLE_CONFIG_DURATION_MS: i64 = 3_600_000;
const MIN_IDLE_DURATION_MS: i64 = 60_000;
const BASE_IDLE_MAX_DURATION_MS: i64 = 28_800_000;
const MONTH_CARD_IDLE_MAX_DURATION_MS: i64 = 43_200_000;
const DEFAULT_MONTH_CARD_ID: &str = "monthcard-001";

/**
 * idle 最小应用服务。
 *
 * 作用：
 * 1. 做什么：为 `/api/idle/start|status|stop|history|progress|config` 提供最小真实会话与配置读写，保持 Node 兼容所需数据。
 * 2. 做什么：复用 PostgreSQL `idle_sessions`、`idle_configs` 与 Redis `idle:lock:{characterId}`，并把 lock 变化同步回已挂到 AppState 的 runtime idle 服务。
 * 3. 不做什么：不启动挂机执行循环、不推进战斗批次，也不补 viewed 标记。
 *
 * 输入 / 输出：
 * - 输入：characterId、userId、start/config 请求参数。
 * - 输出：start/status/history/progress/config 所需的最小协议结果，其中 session/config 视图只包含当前前端已使用字段。
 *
 * 数据流 / 状态流：
 * - HTTP idle 路由 -> 本服务 -> PostgreSQL `idle_sessions` / Redis lock。
 * - 成功 start/stop 后 -> 同步更新 `runtime_services.idle_runtime_service`，让恢复态与运行中新增/释放锁共享同一入口。
 *
 * 复用设计说明：
 * - 把 DB 查询、Redis 锁、月卡上限与 session/config 视图映射集中在这里，避免路由层重复写 characterId -> active session/config -> DTO 转换逻辑。
 * - 当前只产出最小 `IdleSessionView` / `IdleConfigView`，后续补执行引擎时仍可继续复用同一条查询链，不需要再改 HTTP 合同。
 *
 * 关键边界条件与坑点：
 * 1. `existingSessionId` 必须来自真实 active/stopping session 行，不能拿 Redis token 直接冒充；但 Rust 新建锁会把 sessionId 放进 token，便于未来无 DB 快速路径复用。
 * 2. stop 在当前最小实现里会直接把活跃会话收敛为 `interrupted` 并释放锁，避免无执行器时卡死在 `stopping`。
 * 3. 配置读取必须只裁剪返回值、不覆写原始时长偏好，避免月卡到期后永久丢失 12 小时配置。
 */
#[derive(Clone)]
pub struct RustIdleRouteService {
    pool: sqlx::PgPool,
    redis: redis::Client,
    runtime_services: SharedRuntimeServices,
}

impl RustIdleRouteService {
    pub fn new(
        pool: sqlx::PgPool,
        redis: redis::Client,
        runtime_services: SharedRuntimeServices,
    ) -> Self {
        Self {
            pool,
            redis,
            runtime_services,
        }
    }

    pub async fn start_idle_session(
        &self,
        character_id: i64,
        _user_id: i64,
        input: IdleStartInput,
    ) -> Result<IdleStartServiceResult, BusinessError> {
        if let Some(existing_session_id) = self.find_active_session_id(character_id).await? {
            return Ok(IdleStartServiceResult::Conflict {
                message: "已有活跃挂机会话".to_string(),
                existing_session_id,
            });
        }

        let session_id: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
            .fetch_one(&self.pool)
            .await
            .map_err(internal_business_error)?;
        let lock_key = idle_lock_key(character_id);
        let lock_token = format!("idle-start:{session_id}");
        let lock_ttl_seconds = idle_lock_ttl_seconds(input.max_duration_ms);

        if !self
            .try_acquire_start_lock(&lock_key, &lock_token, lock_ttl_seconds)
            .await?
        {
            if let Some(existing_session_id) = self.find_active_session_id(character_id).await? {
                return Ok(IdleStartServiceResult::Conflict {
                    message: "已有活跃挂机会话".to_string(),
                    existing_session_id,
                });
            }

            return Ok(IdleStartServiceResult::Failure {
                message: "挂机会话正在初始化，请稍后重试".to_string(),
            });
        }

        let session_snapshot = serde_json::json!({
            "characterId": character_id,
            "targetMonsterDefId": input.target_monster_def_id,
            "includePartnerInBattle": input.include_partner_in_battle,
            "autoSkillPolicy": input.auto_skill_policy,
        });

        let insert_result = sqlx::query(
            r#"
            INSERT INTO idle_sessions (
              id,
              character_id,
              status,
              map_id,
              room_id,
              max_duration_ms,
              session_snapshot,
              total_battles,
              win_count,
              lose_count,
              total_exp,
              total_silver,
              bag_full_flag,
              started_at,
              ended_at,
              viewed_at,
              created_at,
              updated_at
            ) VALUES (
              $1,
              $2,
              'active',
              $3,
              $4,
              $5,
              $6,
              0,
              0,
              0,
              0,
              0,
              false,
              CURRENT_TIMESTAMP,
              NULL,
              NULL,
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            )
            "#,
        )
        .bind(&session_id)
        .bind(character_id)
        .bind(&input.map_id)
        .bind(&input.room_id)
        .bind(input.max_duration_ms)
        .bind(session_snapshot)
        .execute(&self.pool)
        .await;

        if let Err(error) = insert_result {
            self.release_idle_lock(character_id).await?;
            return Err(internal_business_error(error));
        }

        self.register_runtime_lock(character_id, &lock_token)
            .await?;
        Ok(IdleStartServiceResult::Started { session_id })
    }

    pub async fn get_active_idle_session(
        &self,
        character_id: i64,
    ) -> Result<Option<IdleSessionView>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              id,
              character_id,
              status,
              map_id,
              room_id,
              max_duration_ms,
              total_battles,
              win_count,
              lose_count,
              total_exp,
              total_silver,
              bag_full_flag,
              started_at::text AS started_at,
              ended_at::text AS ended_at,
              viewed_at::text AS viewed_at,
              session_snapshot
            FROM idle_sessions
            WHERE character_id = $1
              AND status IN ('active', 'stopping')
            ORDER BY started_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        row.map(map_idle_session_view).transpose()
    }

    pub async fn stop_idle_session(
        &self,
        character_id: i64,
    ) -> Result<IdleStopServiceResult, BusinessError> {
        let rows = sqlx::query(
            r#"
            UPDATE idle_sessions
            SET status = 'interrupted',
                ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP
            WHERE character_id = $1
              AND status IN ('active', 'stopping')
            RETURNING id
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        if rows.is_empty() {
            return Ok(IdleStopServiceResult::Failure {
                message: "没有活跃的挂机会话".to_string(),
            });
        }

        self.release_idle_lock(character_id).await?;
        Ok(IdleStopServiceResult::Stopped)
    }

    pub async fn get_idle_history(
        &self,
        character_id: i64,
    ) -> Result<Vec<IdleSessionView>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              id,
              character_id,
              status,
              map_id,
              room_id,
              max_duration_ms,
              total_battles,
              win_count,
              lose_count,
              total_exp,
              total_silver,
              bag_full_flag,
              started_at::text AS started_at,
              ended_at::text AS ended_at,
              viewed_at::text AS viewed_at,
              session_snapshot
            FROM idle_sessions
            WHERE character_id = $1
            ORDER BY started_at DESC, id DESC
            LIMIT 3
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        rows.into_iter().map(map_idle_session_view).collect()
    }

    pub async fn get_idle_progress(
        &self,
        character_id: i64,
    ) -> Result<Option<IdleSessionView>, BusinessError> {
        self.get_active_idle_session(character_id).await
    }

    pub async fn get_idle_config(
        &self,
        character_id: i64,
    ) -> Result<IdleConfigResponseData, BusinessError> {
        let duration_limit = self.resolve_idle_duration_limit(character_id).await?;
        let row = sqlx::query(
            r#"
            SELECT
              map_id,
              room_id,
              max_duration_ms,
              auto_skill_policy,
              target_monster_def_id,
              include_partner_in_battle
            FROM idle_configs
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Ok(default_idle_config_response(duration_limit));
        };

        let persisted_duration = row
            .try_get::<i64, _>("max_duration_ms")
            .map_err(internal_business_error)?;
        let normalized_duration = persisted_duration.min(duration_limit.max_duration_ms);
        let auto_skill_policy = parse_idle_auto_skill_policy(
            row.try_get::<serde_json::Value, _>("auto_skill_policy")
                .map_err(internal_business_error)?,
        )?;

        Ok(IdleConfigResponseData {
            config: IdleConfigView {
                map_id: row.try_get("map_id").map_err(internal_business_error)?,
                room_id: row.try_get("room_id").map_err(internal_business_error)?,
                max_duration_ms: normalized_duration,
                auto_skill_policy,
                target_monster_def_id: row
                    .try_get("target_monster_def_id")
                    .map_err(internal_business_error)?,
                include_partner_in_battle: row
                    .try_get("include_partner_in_battle")
                    .map_err(internal_business_error)?,
            },
            max_duration_limit_ms: duration_limit.max_duration_ms,
            month_card_active: duration_limit.month_card_active,
        })
    }

    pub async fn update_idle_config(
        &self,
        character_id: i64,
        input: IdleConfigUpdateInput,
    ) -> Result<(), BusinessError> {
        let duration_limit = self.resolve_idle_duration_limit(character_id).await?;
        let auto_skill_policy = input
            .auto_skill_policy
            .ok_or_else(|| BusinessError::new("技能策略非法"))?;
        let max_duration_ms = input
            .max_duration_ms
            .unwrap_or(DEFAULT_IDLE_CONFIG_DURATION_MS);
        if !is_idle_duration_within_limit(max_duration_ms, duration_limit.max_duration_ms) {
            return Err(BusinessError::new(format!(
                "maxDurationMs 必须在 {MIN_IDLE_DURATION_MS} ~ {} 之间",
                duration_limit.max_duration_ms
            )));
        }

        sqlx::query(
            r#"
            INSERT INTO idle_configs (
              character_id,
              map_id,
              room_id,
              max_duration_ms,
              auto_skill_policy,
              target_monster_def_id,
              include_partner_in_battle,
              updated_at
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              CURRENT_TIMESTAMP
            )
            ON CONFLICT (character_id) DO UPDATE SET
              map_id = EXCLUDED.map_id,
              room_id = EXCLUDED.room_id,
              max_duration_ms = EXCLUDED.max_duration_ms,
              auto_skill_policy = EXCLUDED.auto_skill_policy,
              target_monster_def_id = EXCLUDED.target_monster_def_id,
              include_partner_in_battle = EXCLUDED.include_partner_in_battle,
              updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(character_id)
        .bind(input.map_id)
        .bind(input.room_id)
        .bind(max_duration_ms)
        .bind(serde_json::to_value(auto_skill_policy).map_err(internal_business_error)?)
        .bind(input.target_monster_def_id)
        .bind(input.include_partner_in_battle.unwrap_or(false))
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;

        Ok(())
    }

    async fn find_active_session_id(
        &self,
        character_id: i64,
    ) -> Result<Option<String>, BusinessError> {
        sqlx::query_scalar(
            r#"
            SELECT id::text
            FROM idle_sessions
            WHERE character_id = $1
              AND status IN ('active', 'stopping')
            ORDER BY started_at DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)
    }

    async fn try_acquire_start_lock(
        &self,
        lock_key: &str,
        lock_token: &str,
        ttl_seconds: u64,
    ) -> Result<bool, BusinessError> {
        let mut redis = self.redis_connection().await?;
        let response = redis::cmd("SET")
            .arg(lock_key)
            .arg(lock_token)
            .arg("NX")
            .arg("EX")
            .arg(ttl_seconds)
            .query_async::<Option<String>>(&mut redis)
            .await
            .map_err(internal_business_error)?;
        Ok(matches!(response.as_deref(), Some("OK")))
    }

    async fn release_idle_lock(&self, character_id: i64) -> Result<(), BusinessError> {
        let mut redis = self.redis_connection().await?;
        let _: i64 = redis
            .del(idle_lock_key(character_id))
            .await
            .map_err(internal_business_error)?;
        self.remove_runtime_lock(character_id).await
    }

    async fn register_runtime_lock(
        &self,
        character_id: i64,
        lock_token: &str,
    ) -> Result<(), BusinessError> {
        let mut runtime_services = self.runtime_services.write().await;
        runtime_services
            .idle_runtime_service
            .upsert_lock(character_id, lock_token)
            .map_err(internal_business_error)
    }

    async fn remove_runtime_lock(&self, character_id: i64) -> Result<(), BusinessError> {
        let mut runtime_services = self.runtime_services.write().await;
        runtime_services
            .idle_runtime_service
            .remove_lock(character_id);
        Ok(())
    }

    async fn redis_connection(&self) -> Result<redis::aio::MultiplexedConnection, BusinessError> {
        self.redis
            .get_multiplexed_async_connection()
            .await
            .map_err(internal_business_error)
    }

    async fn resolve_idle_duration_limit(
        &self,
        character_id: i64,
    ) -> Result<IdleDurationLimit, BusinessError> {
        let month_card_active = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT 1
            FROM month_card_ownership
            WHERE character_id = $1
              AND month_card_id = $2
              AND expire_at > CURRENT_TIMESTAMP
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .bind(DEFAULT_MONTH_CARD_ID)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?
        .is_some();

        Ok(IdleDurationLimit {
            max_duration_ms: if month_card_active {
                MONTH_CARD_IDLE_MAX_DURATION_MS
            } else {
                BASE_IDLE_MAX_DURATION_MS
            },
            month_card_active,
        })
    }
}

impl IdleRouteServices for RustIdleRouteService {
    fn start_idle_session<'a>(
        &'a self,
        character_id: i64,
        user_id: i64,
        input: IdleStartInput,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStartServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.start_idle_session(character_id, user_id, input).await })
    }

    fn get_active_idle_session<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_active_idle_session(character_id).await })
    }

    fn stop_idle_session<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStopServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.stop_idle_session(character_id).await })
    }

    fn get_idle_history<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_idle_history(character_id).await })
    }

    fn get_idle_progress<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_idle_progress(character_id).await })
    }

    fn get_idle_config<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleConfigResponseData, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_idle_config(character_id).await })
    }

    fn update_idle_config<'a>(
        &'a self,
        character_id: i64,
        input: IdleConfigUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.update_idle_config(character_id, input).await })
    }
}

fn idle_lock_key(character_id: i64) -> String {
    format!("idle:lock:{character_id}")
}

fn idle_lock_ttl_seconds(max_duration_ms: i64) -> u64 {
    let ttl_seconds = ((max_duration_ms + IDLE_LOCK_TTL_BUFFER_MS) as f64 / 1000_f64).ceil() as u64;
    ttl_seconds.clamp(IDLE_LOCK_TTL_MIN_SECONDS, IDLE_LOCK_TTL_MAX_SECONDS)
}

fn is_idle_duration_within_limit(duration_ms: i64, max_duration_ms: i64) -> bool {
    duration_ms >= MIN_IDLE_DURATION_MS && duration_ms <= max_duration_ms
}

fn map_idle_session_view(row: sqlx::postgres::PgRow) -> Result<IdleSessionView, BusinessError> {
    let session_snapshot = row
        .try_get::<serde_json::Value, _>("session_snapshot")
        .map_err(internal_business_error)?;
    let target_monster_def_id = session_snapshot
        .get("targetMonsterDefId")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let target_monster_name = target_monster_def_id.clone();

    Ok(IdleSessionView {
        id: row.try_get("id").map_err(internal_business_error)?,
        character_id: row
            .try_get::<i64, _>("character_id")
            .map_err(internal_business_error)?,
        status: row.try_get("status").map_err(internal_business_error)?,
        map_id: row.try_get("map_id").map_err(internal_business_error)?,
        room_id: row.try_get("room_id").map_err(internal_business_error)?,
        max_duration_ms: row
            .try_get::<i64, _>("max_duration_ms")
            .map_err(internal_business_error)?,
        total_battles: row
            .try_get::<i32, _>("total_battles")
            .map_err(internal_business_error)?,
        win_count: row.try_get("win_count").map_err(internal_business_error)?,
        lose_count: row.try_get("lose_count").map_err(internal_business_error)?,
        total_exp: row.try_get("total_exp").map_err(internal_business_error)?,
        total_silver: row
            .try_get("total_silver")
            .map_err(internal_business_error)?,
        bag_full_flag: row
            .try_get("bag_full_flag")
            .map_err(internal_business_error)?,
        started_at: row.try_get("started_at").map_err(internal_business_error)?,
        ended_at: row.try_get("ended_at").map_err(internal_business_error)?,
        viewed_at: row.try_get("viewed_at").map_err(internal_business_error)?,
        target_monster_def_id,
        target_monster_name,
    })
}

fn parse_idle_auto_skill_policy(
    value: serde_json::Value,
) -> Result<IdleAutoSkillPolicy, BusinessError> {
    serde_json::from_value::<IdleAutoSkillPolicy>(value).map_err(internal_business_error)
}

fn default_idle_config_response(duration_limit: IdleDurationLimit) -> IdleConfigResponseData {
    IdleConfigResponseData {
        config: IdleConfigView {
            map_id: None,
            room_id: None,
            max_duration_ms: DEFAULT_IDLE_CONFIG_DURATION_MS,
            auto_skill_policy: IdleAutoSkillPolicy { slots: Vec::new() },
            target_monster_def_id: None,
            include_partner_in_battle: true,
        },
        max_duration_limit_ms: duration_limit.max_duration_ms,
        month_card_active: duration_limit.month_card_active,
    }
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
