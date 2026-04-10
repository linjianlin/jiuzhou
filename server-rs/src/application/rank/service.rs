use std::{future::Future, pin::Pin};

use axum::http::StatusCode;
use sqlx::Row;

use crate::application::month_card::benefits::load_month_card_active_map;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::rank::{
    ArenaRankRow, PartnerRankRow, RankOverviewView, RankRouteServices, RealmRankRow, SectRankRow,
    WealthRankRow,
};

/**
 * rank 排行应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `rankService` 的 6 组只读排行接口，统一提供总览、境界、宗门、财富、竞技场、伙伴排行数据。
 * 2. 做什么：把“月卡激活态批量补全”“limit 归一化”“伙伴排行维度校验”集中到单一入口，避免各 handler 重复拼 SQL 和重复扫表。
 * 3. 不做什么：不在这里处理排行快照刷新调度、不补写后台缓存刷新任务，也不扩展排行榜之外的业务聚合。
 *
 * 输入 / 输出：
 * - 输入：可选 `limitPlayers`、`limitSects`、`limit` 与伙伴排行 `metric`。
 * - 输出：统一 `ServiceResultResponse<T>`，保持 Node `sendResult` 协议不变。
 *
 * 数据流 / 状态流：
 * - HTTP 路由完成鉴权与 query 解析 -> 本服务批量查询 PostgreSQL -> 单次补查月卡激活态 -> 输出 Node 兼容 DTO。
 *
 * 复用设计说明：
 * - 月卡激活态查询抽成批量 helper，`realm/wealth/sect/arena/partner` 五类榜单共用一套 `character_ids -> active map` 逻辑，避免重复 SQL。
 * - limit 裁剪、metric 校验与 overview 聚合都集中在这里，后续若首页、活动页或导出接口复用排行，不需要再复制一套边界规则。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴排行的 `metric` 只接受 `level/power`，非法值必须继续返回 `success:false + 伙伴排行维度不合法`，不能偷转默认值。
 * 2. 月卡激活态只认 `expire_at > CURRENT_TIMESTAMP` 的有效记录，不能把过期但未清理的数据继续算成激活。
 */
#[derive(Debug, Clone)]
pub struct RustRankRouteService {
    pool: sqlx::PgPool,
}

impl RustRankRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_rank_overview_impl(
        &self,
        limit_players: Option<i64>,
        limit_sects: Option<i64>,
    ) -> Result<ServiceResultResponse<RankOverviewView>, BusinessError> {
        let (realm, sect, wealth) = tokio::try_join!(
            self.load_realm_ranks(clamp_limit(limit_players, 50)),
            self.load_sect_ranks(clamp_limit(limit_sects, 30)),
            self.load_wealth_ranks(clamp_limit(limit_players, 50)),
        )?;

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(RankOverviewView {
                realm,
                sect,
                wealth,
            }),
        ))
    }

    async fn get_realm_ranks_impl(
        &self,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<RealmRankRow>>, BusinessError> {
        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(self.load_realm_ranks(clamp_limit(limit, 50)).await?),
        ))
    }

    async fn get_sect_ranks_impl(
        &self,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<SectRankRow>>, BusinessError> {
        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(self.load_sect_ranks(clamp_limit(limit, 30)).await?),
        ))
    }

    async fn get_wealth_ranks_impl(
        &self,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<WealthRankRow>>, BusinessError> {
        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(self.load_wealth_ranks(clamp_limit(limit, 50)).await?),
        ))
    }

    async fn get_arena_ranks_impl(
        &self,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<ArenaRankRow>>, BusinessError> {
        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(self.load_arena_ranks(clamp_limit(limit, 50)).await?),
        ))
    }

    async fn get_partner_ranks_impl(
        &self,
        metric: Option<String>,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<PartnerRankRow>>, BusinessError> {
        let Some(metric) = normalize_partner_rank_metric(metric.as_deref()) else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("伙伴排行维度不合法".to_string()),
                None,
            ));
        };

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(
                self.load_partner_ranks(metric, clamp_limit(limit, 50))
                    .await?,
            ),
        ))
    }

    async fn load_realm_ranks(&self, limit: i64) -> Result<Vec<RealmRankRow>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ROW_NUMBER() OVER (ORDER BY realm_rank DESC, power DESC, character_id ASC)::int AS rank,
              crs.character_id,
              crs.nickname AS name,
              c.title,
              c.avatar,
              crs.realm,
              crs.power
            FROM character_rank_snapshot crs
            JOIN characters c ON c.id = crs.character_id
            WHERE crs.nickname <> ''
            ORDER BY rank
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let month_card_active_map = self
            .load_month_card_active_map(extract_character_ids(&rows, "character_id"))
            .await?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let character_id = row.get::<i64, _>("character_id");
            result.push(RealmRankRow {
                rank: row.get::<i32, _>("rank"),
                character_id,
                name: row.get::<String, _>("name"),
                title: normalize_optional_text(
                    row.try_get::<Option<String>, _>("title").ok().flatten(),
                ),
                avatar: normalize_optional_text(
                    row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                ),
                month_card_active: month_card_active_map
                    .get(&character_id)
                    .copied()
                    .unwrap_or(false),
                realm: row.get::<String, _>("realm"),
                power: row.get::<i64, _>("power"),
            });
        }

        Ok(result)
    }

    async fn load_wealth_ranks(&self, limit: i64) -> Result<Vec<WealthRankRow>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ROW_NUMBER() OVER (ORDER BY spirit_stones DESC, silver DESC, id ASC)::int AS rank,
              id AS character_id,
              nickname AS name,
              title,
              avatar,
              realm,
              COALESCE(spirit_stones, 0)::int AS spirit_stones,
              COALESCE(silver, 0)::int AS silver
            FROM characters
            WHERE nickname IS NOT NULL AND nickname <> ''
            ORDER BY rank
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let month_card_active_map = self
            .load_month_card_active_map(extract_character_ids(&rows, "character_id"))
            .await?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let character_id = row.get::<i64, _>("character_id");
            result.push(WealthRankRow {
                rank: row.get::<i32, _>("rank"),
                character_id,
                name: row.get::<String, _>("name"),
                title: normalize_optional_text(
                    row.try_get::<Option<String>, _>("title").ok().flatten(),
                ),
                avatar: normalize_optional_text(
                    row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                ),
                month_card_active: month_card_active_map
                    .get(&character_id)
                    .copied()
                    .unwrap_or(false),
                realm: row.get::<String, _>("realm"),
                spirit_stones: row.get::<i32, _>("spirit_stones"),
                silver: row.get::<i32, _>("silver"),
            });
        }

        Ok(result)
    }

    async fn load_sect_ranks(&self, limit: i64) -> Result<Vec<SectRankRow>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ROW_NUMBER() OVER (
                ORDER BY sd.level DESC, sd.member_count DESC, COALESCE(sd.reputation, 0) DESC, COALESCE(sd.funds, 0) DESC, sd.created_at ASC
              )::int AS rank,
              sd.name AS name,
              sd.level::int AS level,
              sd.leader_id,
              COALESCE(c.nickname, '—') AS leader,
              sd.member_count::int AS members,
              sd.max_members::int AS member_cap,
              (
                sd.level::bigint * 100000
                + sd.member_count::bigint * 1000
                + COALESCE(sd.reputation, 0)::bigint
                + (COALESCE(sd.funds, 0)::bigint / 10)
              )::bigint AS power
            FROM sect_def sd
            LEFT JOIN characters c ON c.id = sd.leader_id
            ORDER BY rank
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let leader_ids = rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("leader_id").ok().flatten())
            .collect::<Vec<_>>();
        let leader_month_card_active_map = self.load_month_card_active_map(leader_ids).await?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let leader_id = row.try_get::<Option<i64>, _>("leader_id").ok().flatten();
            result.push(SectRankRow {
                rank: row.get::<i32, _>("rank"),
                name: row.get::<String, _>("name"),
                level: row.get::<i32, _>("level"),
                leader: row.get::<String, _>("leader"),
                leader_month_card_active: leader_id
                    .and_then(|value| leader_month_card_active_map.get(&value).copied())
                    .unwrap_or(false),
                members: row.get::<i32, _>("members"),
                member_cap: row.get::<i32, _>("member_cap"),
                power: row.get::<i64, _>("power"),
            });
        }

        Ok(result)
    }

    async fn load_arena_ranks(&self, limit: i64) -> Result<Vec<ArenaRankRow>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ROW_NUMBER() OVER (ORDER BY score DESC, win_count DESC, lose_count ASC, character_id ASC)::int AS rank,
              character_id,
              name,
              title,
              avatar,
              realm,
              score::int AS score,
              win_count::int AS win_count,
              lose_count::int AS lose_count
            FROM (
              SELECT
                c.id AS character_id,
                COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name,
                c.title,
                c.avatar,
                c.realm,
                COALESCE(ar.rating, 1000)::int AS score,
                COALESCE(ar.win_count, 0)::int AS win_count,
                COALESCE(ar.lose_count, 0)::int AS lose_count
              FROM characters c
              LEFT JOIN arena_rating ar ON ar.character_id = c.id
            ) ranked
            ORDER BY rank
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let month_card_active_map = self
            .load_month_card_active_map(extract_character_ids(&rows, "character_id"))
            .await?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let character_id = row.get::<i64, _>("character_id");
            result.push(ArenaRankRow {
                rank: row.get::<i32, _>("rank"),
                character_id,
                name: row.get::<String, _>("name"),
                title: normalize_optional_text(
                    row.try_get::<Option<String>, _>("title").ok().flatten(),
                ),
                avatar: normalize_optional_text(
                    row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                ),
                month_card_active: month_card_active_map
                    .get(&character_id)
                    .copied()
                    .unwrap_or(false),
                realm: row.get::<String, _>("realm"),
                score: row.get::<i32, _>("score"),
                win_count: row.get::<i32, _>("win_count"),
                lose_count: row.get::<i32, _>("lose_count"),
            });
        }

        Ok(result)
    }

    async fn load_partner_ranks(
        &self,
        metric: PartnerRankMetric,
        limit: i64,
    ) -> Result<Vec<PartnerRankRow>, BusinessError> {
        let order_sql = match metric {
            PartnerRankMetric::Level => "prs.level DESC, prs.power DESC, prs.partner_id ASC",
            PartnerRankMetric::Power => "prs.power DESC, prs.level DESC, prs.partner_id ASC",
        };
        let sql = format!(
            r#"
            SELECT
              ROW_NUMBER() OVER (ORDER BY {order_sql})::int AS rank,
              prs.partner_id,
              prs.character_id,
              COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS owner_name,
              prs.partner_name,
              prs.avatar,
              prs.quality,
              prs.element,
              prs.role,
              prs.level::int AS level,
              prs.power::bigint AS power
            FROM partner_rank_snapshot prs
            JOIN characters c ON c.id = prs.character_id
            ORDER BY rank
            LIMIT $1
            "#
        );
        let rows = sqlx::query(&sql)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?;

        let owner_month_card_active_map = self
            .load_month_card_active_map(extract_character_ids(&rows, "character_id"))
            .await?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let character_id = row.get::<i64, _>("character_id");
            result.push(PartnerRankRow {
                rank: row.get::<i32, _>("rank"),
                partner_id: row.get::<i64, _>("partner_id"),
                character_id,
                owner_name: row.get::<String, _>("owner_name"),
                owner_month_card_active: owner_month_card_active_map
                    .get(&character_id)
                    .copied()
                    .unwrap_or(false),
                partner_name: row.get::<String, _>("partner_name"),
                avatar: normalize_optional_text(
                    row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                ),
                quality: row.get::<String, _>("quality"),
                element: row.get::<String, _>("element"),
                role: row.get::<String, _>("role"),
                level: row.get::<i32, _>("level"),
                power: row.get::<i64, _>("power"),
            });
        }

        Ok(result)
    }

    async fn load_month_card_active_map(
        &self,
        character_ids: Vec<i64>,
    ) -> Result<std::collections::HashMap<i64, bool>, BusinessError> {
        load_month_card_active_map(&self.pool, &character_ids).await
    }
}

impl RankRouteServices for RustRankRouteService {
    fn get_rank_overview<'a>(
        &'a self,
        limit_players: Option<i64>,
        limit_sects: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RankOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.get_rank_overview_impl(limit_players, limit_sects)
                .await
        })
    }

    fn get_realm_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<RealmRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_realm_ranks_impl(limit).await })
    }

    fn get_sect_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<SectRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_sect_ranks_impl(limit).await })
    }

    fn get_wealth_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<WealthRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_wealth_ranks_impl(limit).await })
    }

    fn get_arena_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<ArenaRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_arena_ranks_impl(limit).await })
    }

    fn get_partner_ranks<'a>(
        &'a self,
        metric: Option<String>,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<PartnerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_partner_ranks_impl(metric, limit).await })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartnerRankMetric {
    Level,
    Power,
}

fn normalize_partner_rank_metric(value: Option<&str>) -> Option<PartnerRankMetric> {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("level") => Some(PartnerRankMetric::Level),
        Some("power") => Some(PartnerRankMetric::Power),
        _ => None,
    }
}

fn clamp_limit(limit: Option<i64>, fallback: i64) -> i64 {
    let value = limit.unwrap_or(fallback);
    value.clamp(1, 200)
}

fn normalize_character_ids(character_ids: Vec<i64>) -> Vec<i64> {
    let mut ids = character_ids
        .into_iter()
        .filter(|value| *value > 0)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn extract_character_ids(rows: &[sqlx::postgres::PgRow], column: &str) -> Vec<i64> {
    rows.iter()
        .filter_map(|row| row.try_get::<i64, _>(column).ok())
        .collect::<Vec<_>>()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
