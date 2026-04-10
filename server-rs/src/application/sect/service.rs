use std::{future::Future, pin::Pin};

use axum::http::StatusCode;
use chrono::{FixedOffset, Utc};
use sqlx::Row;

use crate::application::month_card::benefits::load_month_card_active_map;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::sect::{
    MySectInfoView, SectBlessingStatusView, SectBuildingRequirementView, SectBuildingView,
    SectDefView, SectInfoResponse, SectInfoView, SectMemberView, SectMyResponse,
    SectRouteServices, SectSearchItemView, SectSearchResponse,
};

const DEFAULT_PAGE: i64 = 1;
const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;
const SHANGHAI_OFFSET_SECONDS: i32 = 8 * 60 * 60;
const SECT_BUILDING_MAX_LEVEL: i32 = 50;
const HALL_BUILDING_TYPE: &str = "hall";
const FORGE_HOUSE_BUILDING_TYPE: &str = "forge_house";
const BLESSING_HALL_BUILDING_TYPE: &str = "blessing_hall";
const GLOBAL_BUFF_KEY_FUYUAN_FLAT: &str = "fuyuan_flat";
const SECT_BLESSING_SOURCE_TYPE: &str = "sect_blessing";
const FULLY_UPGRADED_MESSAGE: &str = "建筑已满级";
const UPGRADE_CLOSED_MESSAGE: &str = "暂未开放";
const SECT_BLESSING_DURATION_HOURS: i32 = 3;
const DEFAULT_SECT_BUILDING_TYPES: [&str; 8] = [
    HALL_BUILDING_TYPE,
    "library",
    "training_hall",
    "alchemy_room",
    FORGE_HOUSE_BUILDING_TYPE,
    "spirit_array",
    "defense_array",
    BLESSING_HALL_BUILDING_TYPE,
];

/**
 * 宗门只读服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `sect/core.ts + sect/cache.ts + sect/blessing.ts` 的只读子集，提供 `/api/sect/me`、`/api/sect/search`、`/api/sect/:sectId` 所需的单一读取入口。
 * 2. 做什么：把默认建筑补齐、建筑升级需求计算、月卡激活态批量补查、祈福状态读取收敛到服务层，避免路由和后续宗门接口重复写 SQL。
 * 3. 不做什么：不迁移宗门写操作、申请列表、建筑升级和日志读取，也不在这里做缓存层。
 *
 * 输入 / 输出：
 * - 输入：`character_id / sect_id / keyword / page / limit`。
 * - 输出：Node 兼容的宗门详情、我的宗门包体和搜索响应。
 *
 * 数据流 / 状态流：
 * - `/me`：character_id -> `sect_member` 找 `sect_id` -> `sect_def/sect_building/characters` 组装详情 -> `character_global_buff` 补祈福状态。
 * - `/search`：keyword/page/limit -> `sect_def` 分页查询 + count -> 输出列表。
 * - `/:sectId`：sect_id -> 详情装配，不额外依赖角色私有状态。
 *
 * 复用设计说明：
 * - 详情装配集中成 `load_sect_info_view` 后，后续建筑列表、宗门加成、宗门首页都可以复用同一份成员/建筑聚合结果，避免再次散落出多套 `sect_def + sect_member + sect_building` 查询。
 * - 默认建筑补齐、升级需求和祈福状态都是宗门高频变化点，统一落在这里后，只需要维护一份规则。
 *
 * 关键边界条件与坑点：
 * 1. 默认建筑补齐必须走单条 `INSERT .. SELECT UNNEST .. ON CONFLICT DO NOTHING`，否则详情读取会产生多次串行写库，首屏开销会被固定建筑数量放大。
 * 2. 祈福状态的“今日”必须按上海自然日计算，不能直接用 UTC 日期，否则跨日边界会和 Node 产生可见偏差。
 */
#[derive(Debug, Clone)]
pub struct RustSectRouteService {
    pool: sqlx::PgPool,
}

impl RustSectRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_my_sect_impl(&self, character_id: i64) -> Result<SectMyResponse, BusinessError> {
        let sect_id = sqlx::query_scalar::<_, String>(
            r#"
            SELECT sect_id
            FROM sect_member
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(sect_id) = sect_id else {
            return Ok(SectMyResponse {
                success: true,
                message: "ok".to_string(),
                data: None,
            });
        };

        let Some(info) = self.load_sect_info_view(sect_id.as_str()).await? else {
            return Ok(SectMyResponse {
                success: false,
                message: "宗门不存在".to_string(),
                data: None,
            });
        };
        let blessing_status = self.load_blessing_status(character_id).await?;

        Ok(SectMyResponse {
            success: true,
            message: "ok".to_string(),
            data: Some(MySectInfoView {
                info,
                blessing_status,
            }),
        })
    }

    async fn search_sects_impl(
        &self,
        keyword: Option<String>,
        page: Option<i64>,
        limit: Option<i64>,
    ) -> Result<SectSearchResponse, BusinessError> {
        let safe_page = page.filter(|value| *value > 0).unwrap_or(DEFAULT_PAGE);
        let safe_limit = limit
            .filter(|value| *value > 0)
            .map(|value| value.min(MAX_LIMIT))
            .unwrap_or(DEFAULT_LIMIT);
        let offset = (safe_page - 1) * safe_limit;
        let normalized_keyword = keyword
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let ilike_keyword = normalized_keyword
            .as_ref()
            .map(|value| format!("%{value}%"));

        let list_rows = if let Some(keyword) = ilike_keyword.as_deref() {
            sqlx::query(
                r#"
                SELECT
                  id,
                  name,
                  level::int AS level,
                  member_count::int AS member_count,
                  max_members::int AS max_members,
                  join_type,
                  join_min_realm,
                  announcement
                FROM sect_def
                WHERE name ILIKE $1
                ORDER BY level DESC, member_count DESC, created_at DESC
                LIMIT $2 OFFSET $3
                "#,
            )
            .bind(keyword)
            .bind(safe_limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?
        } else {
            sqlx::query(
                r#"
                SELECT
                  id,
                  name,
                  level::int AS level,
                  member_count::int AS member_count,
                  max_members::int AS max_members,
                  join_type,
                  join_min_realm,
                  announcement
                FROM sect_def
                ORDER BY level DESC, member_count DESC, created_at DESC
                LIMIT $1 OFFSET $2
                "#,
            )
            .bind(safe_limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?
        };

        let total = if let Some(keyword) = ilike_keyword.as_deref() {
            sqlx::query_scalar::<_, i64>(
                r#"
                SELECT COUNT(*)::bigint
                FROM sect_def
                WHERE name ILIKE $1
                "#,
            )
            .bind(keyword)
            .fetch_one(&self.pool)
            .await
            .map_err(internal_business_error)?
        } else {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM sect_def")
                .fetch_one(&self.pool)
                .await
                .map_err(internal_business_error)?
        };

        let list = list_rows
            .into_iter()
            .map(|row| SectSearchItemView {
                id: row.get::<String, _>("id"),
                name: row.get::<String, _>("name"),
                level: row.get::<i32, _>("level"),
                member_count: row.get::<i32, _>("member_count"),
                max_members: row.get::<i32, _>("max_members"),
                join_type: row.get::<String, _>("join_type"),
                join_min_realm: row.get::<String, _>("join_min_realm"),
                announcement: normalize_optional_text(
                    row.try_get::<Option<String>, _>("announcement").ok().flatten(),
                ),
            })
            .collect::<Vec<_>>();

        Ok(SectSearchResponse {
            success: true,
            message: "ok".to_string(),
            list: Some(list),
            page: Some(safe_page as i32),
            limit: Some(safe_limit as i32),
            total: Some(total as i32),
        })
    }

    async fn get_sect_info_impl(&self, sect_id: String) -> Result<SectInfoResponse, BusinessError> {
        let Some(info) = self.load_sect_info_view(sect_id.as_str()).await? else {
            return Ok(SectInfoResponse {
                success: false,
                message: "宗门不存在".to_string(),
                data: None,
            });
        };

        Ok(SectInfoResponse {
            success: true,
            message: "ok".to_string(),
            data: Some(info),
        })
    }

    async fn load_sect_info_view(
        &self,
        sect_id: &str,
    ) -> Result<Option<SectInfoView>, BusinessError> {
        let normalized_sect_id = sect_id.trim();
        if normalized_sect_id.is_empty() {
            return Ok(None);
        }

        let sect_row = sqlx::query(
            r#"
            SELECT
              id,
              leader_id::bigint AS leader_id,
              name,
              level::int AS level,
              COALESCE(exp, 0)::bigint AS exp,
              COALESCE(funds, 0)::bigint AS funds,
              COALESCE(reputation, 0)::bigint AS reputation,
              COALESCE(build_points, 0)::int AS build_points,
              announcement,
              description,
              icon,
              join_type,
              join_min_realm,
              member_count::int AS member_count,
              max_members::int AS max_members,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
            FROM sect_def
            WHERE id = $1
            LIMIT 1
            "#,
        )
        .bind(normalized_sect_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(sect_row) = sect_row else {
            return Ok(None);
        };

        self.ensure_default_buildings(normalized_sect_id).await?;

        let member_rows = sqlx::query(
            r#"
            SELECT
              sm.character_id::bigint AS character_id,
              sm.position,
              COALESCE(sm.contribution, 0)::bigint AS contribution,
              COALESCE(sm.weekly_contribution, 0)::bigint AS weekly_contribution,
              to_char(sm.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS joined_at,
              c.nickname,
              c.realm,
              CASE
                WHEN c.last_offline_at IS NULL THEN NULL
                ELSE to_char(c.last_offline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
              END AS last_offline_at
            FROM sect_member sm
            JOIN characters c ON c.id = sm.character_id
            WHERE sm.sect_id = $1
            ORDER BY
              CASE sm.position
                WHEN 'leader' THEN 5
                WHEN 'vice_leader' THEN 4
                WHEN 'elder' THEN 3
                WHEN 'elite' THEN 2
                ELSE 1
              END DESC,
              sm.joined_at ASC
            "#,
        )
        .bind(normalized_sect_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let month_card_active_map = load_month_card_active_map(
            &self.pool,
            &member_rows
                .iter()
                .map(|row| row.get::<i64, _>("character_id"))
                .collect::<Vec<_>>(),
        )
        .await?;

        let members = member_rows
            .into_iter()
            .map(|row| {
                let character_id = row.get::<i64, _>("character_id");
                SectMemberView {
                    character_id,
                    nickname: row.get::<String, _>("nickname"),
                    month_card_active: month_card_active_map
                        .get(&character_id)
                        .copied()
                        .unwrap_or(false),
                    realm: row.get::<String, _>("realm"),
                    position: row.get::<String, _>("position"),
                    contribution: row.get::<i64, _>("contribution"),
                    weekly_contribution: row.get::<i64, _>("weekly_contribution"),
                    joined_at: row.get::<String, _>("joined_at"),
                    last_offline_at: normalize_optional_text(
                        row.try_get::<Option<String>, _>("last_offline_at")
                            .ok()
                            .flatten(),
                    ),
                }
            })
            .collect::<Vec<_>>();

        let building_rows = sqlx::query(
            r#"
            SELECT
              id::bigint AS id,
              sect_id,
              building_type,
              level::int AS level,
              status,
              CASE
                WHEN upgrade_start_at IS NULL THEN NULL
                ELSE to_char(upgrade_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
              END AS upgrade_start_at,
              CASE
                WHEN upgrade_end_at IS NULL THEN NULL
                ELSE to_char(upgrade_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
              END AS upgrade_end_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
            FROM sect_building
            WHERE sect_id = $1
            ORDER BY building_type ASC
            "#,
        )
        .bind(normalized_sect_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let buildings = building_rows
            .into_iter()
            .map(|row| {
                let building_type = row.get::<String, _>("building_type");
                let level = row.get::<i32, _>("level");
                SectBuildingView {
                    id: row.get::<i64, _>("id"),
                    sect_id: row.get::<String, _>("sect_id"),
                    building_type: building_type.clone(),
                    level,
                    status: row.get::<String, _>("status"),
                    upgrade_start_at: normalize_optional_text(
                        row.try_get::<Option<String>, _>("upgrade_start_at")
                            .ok()
                            .flatten(),
                    ),
                    upgrade_end_at: normalize_optional_text(
                        row.try_get::<Option<String>, _>("upgrade_end_at")
                            .ok()
                            .flatten(),
                    ),
                    created_at: row.get::<String, _>("created_at"),
                    updated_at: row.get::<String, _>("updated_at"),
                    requirement: building_requirement_view(building_type.as_str(), level),
                }
            })
            .collect::<Vec<_>>();

        Ok(Some(SectInfoView {
            sect: SectDefView {
                id: sect_row.get::<String, _>("id"),
                leader_id: sect_row.get::<i64, _>("leader_id"),
                name: sect_row.get::<String, _>("name"),
                level: sect_row.get::<i32, _>("level"),
                exp: sect_row.get::<i64, _>("exp"),
                funds: sect_row.get::<i64, _>("funds"),
                reputation: sect_row.get::<i64, _>("reputation"),
                build_points: sect_row.get::<i32, _>("build_points"),
                announcement: normalize_optional_text(
                    sect_row
                        .try_get::<Option<String>, _>("announcement")
                        .ok()
                        .flatten(),
                ),
                description: normalize_optional_text(
                    sect_row
                        .try_get::<Option<String>, _>("description")
                        .ok()
                        .flatten(),
                ),
                icon: normalize_optional_text(
                    sect_row.try_get::<Option<String>, _>("icon").ok().flatten(),
                ),
                join_type: sect_row.get::<String, _>("join_type"),
                join_min_realm: sect_row.get::<String, _>("join_min_realm"),
                member_count: sect_row.get::<i32, _>("member_count"),
                max_members: sect_row.get::<i32, _>("max_members"),
                created_at: sect_row.get::<String, _>("created_at"),
                updated_at: sect_row.get::<String, _>("updated_at"),
            },
            members,
            buildings,
        }))
    }

    async fn ensure_default_buildings(&self, sect_id: &str) -> Result<(), BusinessError> {
        let building_types = DEFAULT_SECT_BUILDING_TYPES
            .iter()
            .map(|entry| (*entry).to_string())
            .collect::<Vec<_>>();
        sqlx::query(
            r#"
            INSERT INTO sect_building (sect_id, building_type, level, status)
            SELECT $1, building_type, 1, 'normal'
            FROM UNNEST($2::text[]) AS building_type
            ON CONFLICT (sect_id, building_type) DO NOTHING
            "#,
        )
        .bind(sect_id)
        .bind(&building_types)
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(())
    }

    async fn load_blessing_status(
        &self,
        character_id: i64,
    ) -> Result<SectBlessingStatusView, BusinessError> {
        let today = current_shanghai_day_key();
        let row = sqlx::query(
            r#"
            SELECT
              to_char(grant_day_key, 'YYYY-MM-DD') AS grant_day_key,
              (expire_at > NOW()) AS active,
              CASE
                WHEN expire_at > NOW() THEN to_char(expire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                ELSE NULL
              END AS expire_at,
              COALESCE(buff_value, 0)::double precision AS buff_value
            FROM character_global_buff
            WHERE character_id = $1
              AND buff_key = $2
              AND source_type = $3
              AND source_id = $4
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .bind(GLOBAL_BUFF_KEY_FUYUAN_FLAT)
        .bind(SECT_BLESSING_SOURCE_TYPE)
        .bind(BLESSING_HALL_BUILDING_TYPE)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let blessed_today = row
            .as_ref()
            .and_then(|entry| entry.try_get::<Option<String>, _>("grant_day_key").ok().flatten())
            .map(|value| value == today)
            .unwrap_or(false);
        let active = row
            .as_ref()
            .and_then(|entry| entry.try_get::<Option<bool>, _>("active").ok().flatten())
            .unwrap_or(false);
        let expire_at = row
            .as_ref()
            .and_then(|entry| entry.try_get::<Option<String>, _>("expire_at").ok().flatten())
            .filter(|_| active);
        let fuyuan_bonus = if active {
            row.as_ref()
                .and_then(|entry| entry.try_get::<Option<f64>, _>("buff_value").ok().flatten())
                .unwrap_or(0.0)
        } else {
            0.0
        };

        Ok(SectBlessingStatusView {
            today,
            blessed_today,
            can_bless: !blessed_today,
            active,
            expire_at,
            fuyuan_bonus: round_f64(fuyuan_bonus),
            duration_hours: SECT_BLESSING_DURATION_HOURS,
        })
    }
}

impl SectRouteServices for RustSectRouteService {
    fn get_my_sect<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<SectMyResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.get_my_sect_impl(character_id).await })
    }

    fn search_sects<'a>(
        &'a self,
        keyword: Option<String>,
        page: Option<i64>,
        limit: Option<i64>,
    ) -> Pin<Box<dyn Future<Output = Result<SectSearchResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.search_sects_impl(keyword, page, limit).await })
    }

    fn get_sect_info<'a>(
        &'a self,
        sect_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<SectInfoResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.get_sect_info_impl(sect_id).await })
    }
}

fn current_shanghai_day_key() -> String {
    let offset = FixedOffset::east_opt(SHANGHAI_OFFSET_SECONDS)
        .expect("valid Asia/Shanghai fixed offset");
    Utc::now()
        .with_timezone(&offset)
        .format("%Y-%m-%d")
        .to_string()
}

fn building_requirement_view(building_type: &str, current_level: i32) -> SectBuildingRequirementView {
    let normalized_level = clamp_building_level(current_level);
    let Some(max_level) = max_level_for_building(building_type) else {
        return SectBuildingRequirementView {
            upgradable: false,
            max_level: SECT_BUILDING_MAX_LEVEL,
            next_level: None,
            funds: None,
            build_points: None,
            reason: Some(UPGRADE_CLOSED_MESSAGE.to_string()),
        };
    };

    if normalized_level >= max_level {
        return SectBuildingRequirementView {
            upgradable: false,
            max_level,
            next_level: None,
            funds: None,
            build_points: None,
            reason: Some(FULLY_UPGRADED_MESSAGE.to_string()),
        };
    }

    let next_level = normalized_level + 1;
    SectBuildingRequirementView {
        upgradable: true,
        max_level,
        next_level: Some(next_level),
        funds: Some(1200_i64 * i64::from(next_level) * i64::from(next_level)),
        build_points: Some(10_i64 * i64::from(next_level)),
        reason: None,
    }
}

fn max_level_for_building(building_type: &str) -> Option<i32> {
    matches!(
        building_type,
        HALL_BUILDING_TYPE | FORGE_HOUSE_BUILDING_TYPE | BLESSING_HALL_BUILDING_TYPE
    )
    .then_some(SECT_BUILDING_MAX_LEVEL)
}

fn clamp_building_level(level: i32) -> i32 {
    level.clamp(0, SECT_BUILDING_MAX_LEVEL)
}

fn round_f64(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
