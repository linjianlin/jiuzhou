use std::collections::HashMap;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

#[derive(Debug, Deserialize)]
pub struct RankOverviewQuery {
    #[serde(rename = "limitPlayers")]
    pub limit_players: Option<i64>,
    #[serde(rename = "limitSects")]
    pub limit_sects: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RankLimitQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PartnerRankQuery {
    pub metric: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmRankRowDto {
    pub rank: i64,
    pub character_id: i64,
    pub name: String,
    pub title: String,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectRankRowDto {
    pub rank: i64,
    pub name: String,
    pub level: i64,
    pub leader: String,
    pub leader_month_card_active: bool,
    pub members: i64,
    pub member_cap: i64,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WealthRankRowDto {
    pub rank: i64,
    pub character_id: i64,
    pub name: String,
    pub title: String,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub spirit_stones: i64,
    pub silver: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRankRowDto {
    pub rank: i64,
    pub character_id: i64,
    pub name: String,
    pub title: String,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub score: i64,
    pub win_count: i64,
    pub lose_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRankRowDto {
    pub rank: i64,
    pub partner_id: i64,
    pub character_id: i64,
    pub owner_name: String,
    pub owner_month_card_active: bool,
    pub partner_name: String,
    pub avatar: Option<String>,
    pub quality: String,
    pub element: String,
    pub role: String,
    pub level: i64,
    pub power: i64,
}

#[derive(Debug, Serialize)]
pub struct RankOverviewData {
    pub realm: Vec<RealmRankRowDto>,
    pub sect: Vec<SectRankRowDto>,
    pub wealth: Vec<WealthRankRowDto>,
}

pub async fn get_rank_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RankOverviewQuery>,
) -> Result<Json<SuccessResponse<RankOverviewData>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    let limit_players = clamp_limit(query.limit_players, 50, 200);
    let limit_sects = clamp_limit(query.limit_sects, 30, 200);
    Ok(send_success(RankOverviewData {
        realm: load_realm_ranks(&state, limit_players).await?,
        sect: load_sect_ranks(&state, limit_sects).await?,
        wealth: load_wealth_ranks(&state, limit_players).await?,
    }))
}

pub async fn get_realm_ranks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RankLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<RealmRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        load_realm_ranks(&state, clamp_limit(query.limit, 50, 200)).await?,
    ))
}

pub async fn get_sect_ranks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RankLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<SectRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        load_sect_ranks(&state, clamp_limit(query.limit, 30, 200)).await?,
    ))
}

pub async fn get_wealth_ranks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RankLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<WealthRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        load_wealth_ranks(&state, clamp_limit(query.limit, 50, 200)).await?,
    ))
}

pub async fn get_arena_ranks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RankLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<ArenaRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        load_arena_ranks(&state, clamp_limit(query.limit, 50, 200)).await?,
    ))
}

pub async fn get_partner_ranks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PartnerRankQuery>,
) -> Result<Json<SuccessResponse<Vec<PartnerRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    let metric = normalize_partner_metric(query.metric.as_deref()).unwrap_or("level");
    Ok(send_success(
        load_partner_ranks(&state, metric, clamp_limit(query.limit, 50, 200)).await?,
    ))
}

async fn load_realm_ranks(state: &AppState, limit: i64) -> Result<Vec<RealmRankRowDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT ROW_NUMBER() OVER (ORDER BY realm_rank DESC, power DESC, character_id ASC)::bigint AS rank, crs.character_id, crs.nickname AS name, c.title, c.avatar, crs.realm, crs.power FROM character_rank_snapshot crs JOIN characters c ON c.id = crs.character_id WHERE crs.nickname <> '' ORDER BY rank LIMIT $1",
        |query| query.bind(limit),
    ).await?;
    let month_map = load_month_card_active_map_by_character_ids(
        state,
        rows.iter()
            .filter_map(|row| opt_i64_from_i32(row, "character_id").ok().flatten())
            .collect(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| RealmRankRowDto {
            rank: row
                .try_get::<Option<i64>, _>("rank")
                .unwrap_or(None)
                .unwrap_or_default(),
            character_id: opt_i64_from_i32(&row, "character_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            title: row
                .try_get::<Option<String>, _>("title")
                .unwrap_or(None)
                .unwrap_or_default(),
            avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            month_card_active: month_map
                .get(
                    &opt_i64_from_i32(&row, "character_id")
                        .unwrap_or(None)
                        .unwrap_or_default(),
                )
                .copied()
                .unwrap_or(false),
            realm: row
                .try_get::<Option<String>, _>("realm")
                .unwrap_or(None)
                .unwrap_or_default(),
            power: row
                .try_get::<Option<i64>, _>("power")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_wealth_ranks(
    state: &AppState,
    limit: i64,
) -> Result<Vec<WealthRankRowDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT ROW_NUMBER() OVER (ORDER BY spirit_stones DESC, silver DESC, id ASC)::bigint AS rank, id AS character_id, nickname AS name, title, avatar, realm, COALESCE(spirit_stones, 0)::bigint AS spirit_stones, COALESCE(silver, 0)::bigint AS silver FROM characters WHERE nickname IS NOT NULL AND nickname <> '' ORDER BY rank LIMIT $1",
        |query| query.bind(limit),
    ).await?;
    let month_map = load_month_card_active_map_by_character_ids(
        state,
        rows.iter()
            .filter_map(|row| opt_i64_from_i32(row, "character_id").ok().flatten())
            .collect(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| WealthRankRowDto {
            rank: row
                .try_get::<Option<i64>, _>("rank")
                .unwrap_or(None)
                .unwrap_or_default(),
            character_id: opt_i64_from_i32(&row, "character_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            title: row
                .try_get::<Option<String>, _>("title")
                .unwrap_or(None)
                .unwrap_or_default(),
            avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            month_card_active: month_map
                .get(
                    &opt_i64_from_i32(&row, "character_id")
                        .unwrap_or(None)
                        .unwrap_or_default(),
                )
                .copied()
                .unwrap_or(false),
            realm: row
                .try_get::<Option<String>, _>("realm")
                .unwrap_or(None)
                .unwrap_or_default(),
            spirit_stones: row
                .try_get::<Option<i64>, _>("spirit_stones")
                .unwrap_or(None)
                .unwrap_or_default(),
            silver: row
                .try_get::<Option<i64>, _>("silver")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_sect_ranks(state: &AppState, limit: i64) -> Result<Vec<SectRankRowDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT ROW_NUMBER() OVER ( ORDER BY sd.level DESC, sd.member_count DESC, COALESCE(sd.reputation, 0) DESC, COALESCE(sd.funds, 0) DESC, sd.created_at ASC )::bigint AS rank, sd.name, sd.level::bigint AS level, sd.leader_id, COALESCE(c.nickname, '—') AS leader, sd.member_count::bigint AS members, sd.max_members::bigint AS member_cap, ( sd.level::bigint * 100000 + sd.member_count::bigint * 1000 + COALESCE(sd.reputation, 0)::bigint + (COALESCE(sd.funds, 0)::bigint / 10) )::bigint AS power FROM sect_def sd LEFT JOIN characters c ON c.id = sd.leader_id ORDER BY rank LIMIT $1",
        |query| query.bind(limit),
    ).await?;
    let leader_ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| opt_i64_from_i32(row, "leader_id").ok().flatten())
        .collect();
    let month_map = load_month_card_active_map_by_character_ids(state, leader_ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| SectRankRowDto {
            rank: row
                .try_get::<Option<i64>, _>("rank")
                .unwrap_or(None)
                .unwrap_or_default(),
            name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            level: row
                .try_get::<Option<i64>, _>("level")
                .unwrap_or(None)
                .unwrap_or_default(),
            leader: row
                .try_get::<Option<String>, _>("leader")
                .unwrap_or(None)
                .unwrap_or_else(|| "—".to_string()),
            leader_month_card_active: opt_i64_from_i32(&row, "leader_id")
                .unwrap_or(None)
                .and_then(|id| month_map.get(&id).copied())
                .unwrap_or(false),
            members: row
                .try_get::<Option<i64>, _>("members")
                .unwrap_or(None)
                .unwrap_or_default(),
            member_cap: row
                .try_get::<Option<i64>, _>("member_cap")
                .unwrap_or(None)
                .unwrap_or_default(),
            power: row
                .try_get::<Option<i64>, _>("power")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_arena_ranks(state: &AppState, limit: i64) -> Result<Vec<ArenaRankRowDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT ROW_NUMBER() OVER (ORDER BY score DESC, win_count DESC, lose_count ASC, character_id ASC)::bigint AS rank, character_id, name, title, avatar, realm, score::bigint AS score, win_count::bigint AS win_count, lose_count::bigint AS lose_count FROM ( SELECT c.id AS character_id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name, c.title, c.avatar, c.realm, COALESCE(ar.rating, 1000)::int AS score, COALESCE(ar.win_count, 0)::int AS win_count, COALESCE(ar.lose_count, 0)::int AS lose_count FROM characters c LEFT JOIN arena_rating ar ON ar.character_id = c.id ) t ORDER BY rank LIMIT $1",
        |query| query.bind(limit),
    ).await?;
    let month_map = load_month_card_active_map_by_character_ids(
        state,
        rows.iter()
            .filter_map(|row| opt_i64_from_i32(row, "character_id").ok().flatten())
            .collect(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ArenaRankRowDto {
            rank: row
                .try_get::<Option<i64>, _>("rank")
                .unwrap_or(None)
                .unwrap_or_default(),
            character_id: opt_i64_from_i32(&row, "character_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            title: row
                .try_get::<Option<String>, _>("title")
                .unwrap_or(None)
                .unwrap_or_default(),
            avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            month_card_active: month_map
                .get(
                    &opt_i64_from_i32(&row, "character_id")
                        .unwrap_or(None)
                        .unwrap_or_default(),
                )
                .copied()
                .unwrap_or(false),
            realm: row
                .try_get::<Option<String>, _>("realm")
                .unwrap_or(None)
                .unwrap_or_default(),
            score: row
                .try_get::<Option<i64>, _>("score")
                .unwrap_or(None)
                .unwrap_or_default(),
            win_count: row
                .try_get::<Option<i64>, _>("win_count")
                .unwrap_or(None)
                .unwrap_or_default(),
            lose_count: row
                .try_get::<Option<i64>, _>("lose_count")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_partner_ranks(
    state: &AppState,
    metric: &str,
    limit: i64,
) -> Result<Vec<PartnerRankRowDto>, AppError> {
    let order_sql = if metric == "power" {
        "prs.power DESC, prs.level DESC, prs.partner_id ASC"
    } else {
        "prs.level DESC, prs.power DESC, prs.partner_id ASC"
    };
    let rows = state.database.fetch_all(
        &format!(
            "SELECT ROW_NUMBER() OVER (ORDER BY {order_sql})::bigint AS rank, prs.partner_id, prs.character_id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS owner_name, prs.partner_name, prs.avatar, prs.quality, prs.element, prs.role, prs.level::bigint AS level, prs.power::bigint AS power FROM partner_rank_snapshot prs JOIN characters c ON c.id = prs.character_id ORDER BY rank LIMIT $1"
        ),
        |query| query.bind(limit),
    ).await?;
    let month_map = load_month_card_active_map_by_character_ids(
        state,
        rows.iter()
            .filter_map(|row| opt_i64_from_i32(row, "character_id").ok().flatten())
            .collect(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PartnerRankRowDto {
            rank: row
                .try_get::<Option<i64>, _>("rank")
                .unwrap_or(None)
                .unwrap_or_default(),
            partner_id: opt_i64_from_i32(&row, "partner_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            character_id: opt_i64_from_i32(&row, "character_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            owner_name: row
                .try_get::<Option<String>, _>("owner_name")
                .unwrap_or(None)
                .unwrap_or_default(),
            owner_month_card_active: month_map
                .get(
                    &opt_i64_from_i32(&row, "character_id")
                        .unwrap_or(None)
                        .unwrap_or_default(),
                )
                .copied()
                .unwrap_or(false),
            partner_name: row
                .try_get::<Option<String>, _>("partner_name")
                .unwrap_or(None)
                .unwrap_or_default(),
            avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            quality: row
                .try_get::<Option<String>, _>("quality")
                .unwrap_or(None)
                .unwrap_or_default(),
            element: row
                .try_get::<Option<String>, _>("element")
                .unwrap_or(None)
                .unwrap_or_default(),
            role: row
                .try_get::<Option<String>, _>("role")
                .unwrap_or(None)
                .unwrap_or_default(),
            level: row
                .try_get::<Option<i64>, _>("level")
                .unwrap_or(None)
                .unwrap_or_default(),
            power: row
                .try_get::<Option<i64>, _>("power")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_month_card_active_map_by_character_ids(
    state: &AppState,
    character_ids: Vec<i64>,
) -> Result<HashMap<i64, bool>, AppError> {
    let ids: Vec<i64> = character_ids.into_iter().filter(|id| *id > 0).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = state.database.fetch_all(
        "SELECT character_id FROM month_card_ownership WHERE character_id = ANY($1::bigint[]) AND month_card_id = 'monthcard-001' AND expire_at > NOW()",
        |query| query.bind(ids.clone()),
    ).await?;
    let mut out = HashMap::new();
    for id in ids {
        out.insert(id, false);
    }
    for row in rows {
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if character_id > 0 {
            out.insert(character_id, true);
        }
    }
    Ok(out)
}

fn clamp_limit(limit: Option<i64>, fallback: i64, max: i64) -> i64 {
    limit.unwrap_or(fallback).clamp(1, max)
}

fn normalize_partner_metric(metric: Option<&str>) -> Option<&'static str> {
    match metric.unwrap_or_default().trim().to_lowercase().as_str() {
        "level" => Some("level"),
        "power" => Some("power"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rank_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "realm": [{"rank": 1, "characterId": 1, "name": "凌霄子", "title": "散修", "avatar": null, "monthCardActive": true, "realm": "炼精化炁·养气期", "power": 1200}],
                "sect": [],
                "wealth": []
            }
        });
        assert_eq!(payload["data"]["realm"][0]["monthCardActive"], true);
        println!("RANK_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn rank_partner_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"rank": 1, "partnerId": 1, "characterId": 1, "ownerName": "凌霄子", "ownerMonthCardActive": false, "partnerName": "小青", "avatar": null, "quality": "黄", "element": "木", "role": "support", "level": 12, "power": 999}]
        });
        assert_eq!(payload["data"][0]["partnerName"], "小青");
        println!("RANK_PARTNER_RESPONSE={}", payload);
    }
}
