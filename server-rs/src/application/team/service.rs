use std::collections::HashMap;
use std::{future::Future, pin::Pin};

use sqlx::Row;

use crate::application::month_card::benefits::load_month_card_active_map;
use crate::application::static_data::realm::normalize_realm_keeping_unknown;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::game::{
    GameHomeTeamApplicationView, GameHomeTeamInfoView, GameHomeTeamMemberView,
    GameHomeTeamOverviewView,
};
use crate::edge::http::routes::team::{
    TeamBrowseEntryView, TeamInvitationView, TeamMyTeamResponse, TeamRouteServices,
};
use crate::runtime::connection::session_registry::SharedSessionRegistry;

/**
 * team 只读应用服务。
 *
 * 作用：
 * 1. 做什么：复刻 Node `teamService` 的核心只读查询，把当前队伍、队伍详情、申请列表、附近队伍、大厅列表与收到的邀请统一收口。
 * 2. 做什么：把成员月卡标记、在线态与申请/邀请时间转换集中在一个模块，供首页聚合和 `/api/team` 直接复用。
 * 3. 不做什么：不处理建队、申请、审批、邀请等写路径，不在这里发 socket 推送，也不引入缓存层。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、队伍 ID，以及附近/大厅查询参数。
 * - 输出：Node 兼容的 `TeamMyTeamResponse`、`ServiceResultResponse<T>` 与首页复用的 `GameHomeTeamOverviewView`。
 *
 * 数据流 / 状态流：
 * - 路由或首页聚合 -> 本服务读 `teams/team_members/team_applications/team_invitations/characters`
 * - -> 批量补齐月卡激活态与在线状态 -> 返回队伍 DTO。
 *
 * 复用设计说明：
 * - 首页队伍块与独立 `team` 路由都需要同一套成员、申请与邀请视图；集中在这里后，后续任何一侧加字段都只改一个入口。
 * - 月卡激活态复用 `month_card::benefits` 的共享查询，避免 `game/rank/team` 三处继续维护同一 SQL。
 *
 * 关键边界条件与坑点：
 * 1. `get_my_team` 在未入队时必须继续返回 `success:true + data:null + message:'未加入队伍'`，不能改成 404。
 * 2. 申请列表只有队长可见；即便队伍存在，也必须保留 `只有队长才能查看申请` 的 Node 文案。
 */
#[derive(Clone)]
pub struct RustTeamRouteService {
    pool: sqlx::PgPool,
    session_registry: SharedSessionRegistry,
}

impl RustTeamRouteService {
    pub fn new(pool: sqlx::PgPool, session_registry: SharedSessionRegistry) -> Self {
        Self {
            pool,
            session_registry,
        }
    }

    pub async fn get_team_overview_for_home(
        &self,
        character_id: i64,
    ) -> Result<GameHomeTeamOverviewView, BusinessError> {
        let response = self.get_my_team_impl(character_id).await?;
        Ok(match (response.data, response.role) {
            (Some(info), role) => {
                let applications = if role.as_deref() == Some("leader") {
                    self.load_team_applications(&info.id).await?
                } else {
                    Vec::new()
                };
                GameHomeTeamOverviewView {
                    info: Some(info),
                    role,
                    applications,
                }
            }
            (None, _) => empty_team_overview(),
        })
    }

    async fn get_my_team_impl(
        &self,
        character_id: i64,
    ) -> Result<TeamMyTeamResponse, BusinessError> {
        let team_id = sqlx::query_scalar::<_, String>(
            "SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1",
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let Some(team_id) = team_id else {
            return Ok(TeamMyTeamResponse::not_joined());
        };

        let Some(info) = self.load_team_info(&team_id).await? else {
            return Ok(TeamMyTeamResponse::not_joined());
        };

        let role = if info.leader_id == character_id {
            Some("leader".to_string())
        } else if info
            .members
            .iter()
            .any(|member| member.character_id == character_id)
        {
            Some("member".to_string())
        } else {
            None
        };

        if role.is_none() {
            return Ok(TeamMyTeamResponse::not_joined());
        }

        Ok(TeamMyTeamResponse {
            success: true,
            message: None,
            data: Some(info),
            role,
        })
    }

    async fn get_team_by_id_impl(
        &self,
        team_id: String,
    ) -> Result<ServiceResultResponse<GameHomeTeamInfoView>, BusinessError> {
        let Some(info) = self.load_team_info(team_id.trim()).await? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("队伍不存在".to_string()),
                None,
            ));
        };

        Ok(ServiceResultResponse::new(true, None, Some(info)))
    }

    async fn get_team_applications_impl(
        &self,
        team_id: String,
        character_id: i64,
    ) -> Result<ServiceResultResponse<Vec<GameHomeTeamApplicationView>>, BusinessError> {
        let team_id = team_id.trim().to_string();
        let leader_id =
            sqlx::query_scalar::<_, i64>("SELECT leader_id FROM teams WHERE id = $1 LIMIT 1")
                .bind(&team_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;

        let Some(leader_id) = leader_id else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("队伍不存在".to_string()),
                None,
            ));
        };

        if leader_id != character_id {
            return Ok(ServiceResultResponse::new(
                false,
                Some("只有队长才能查看申请".to_string()),
                None,
            ));
        }

        Ok(ServiceResultResponse::new(
            true,
            None,
            Some(self.load_team_applications(&team_id).await?),
        ))
    }

    async fn get_nearby_teams_impl(
        &self,
        character_id: i64,
        map_id: Option<String>,
    ) -> Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError> {
        let current_map_id = if let Some(value) = normalize_optional_text(map_id.as_deref()) {
            value
        } else {
            let row = sqlx::query("SELECT current_map_id FROM characters WHERE id = $1 LIMIT 1")
                .bind(character_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;
            let Some(row) = row else {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("角色不存在".to_string()),
                    None,
                ));
            };
            normalize_optional_text(
                row.try_get::<Option<String>, _>("current_map_id")
                    .ok()
                    .flatten()
                    .as_deref(),
            )
            .unwrap_or_default()
        };

        let rows = sqlx::query(
            r#"
            SELECT
              t.id,
              t.name,
              t.goal,
              t.join_min_realm,
              COALESCE(t.max_members, 5)::int AS max_members,
              t.leader_id,
              c.nickname AS leader_name,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::int AS member_count
            FROM teams t
            JOIN characters c ON c.id = t.leader_id
            WHERE t.current_map_id = $1
              AND COALESCE(t.is_public, TRUE) = TRUE
              AND t.id NOT IN (
                SELECT team_id FROM team_members WHERE character_id = $2
              )
            ORDER BY t.created_at DESC NULLS LAST, t.id DESC
            LIMIT 20
            "#,
        )
        .bind(&current_map_id)
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            None,
            Some(self.build_team_browse_entries(rows, true).await?),
        ))
    }

    async fn get_lobby_teams_impl(
        &self,
        character_id: i64,
        search: Option<String>,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError> {
        let limit = normalize_positive_i64(limit).unwrap_or(50);
        let search = normalize_optional_text(search.as_deref());

        let rows = if let Some(search) = search {
            sqlx::query(
                r#"
                SELECT
                  t.id,
                  t.name,
                  t.goal,
                  t.join_min_realm,
                  COALESCE(t.max_members, 5)::int AS max_members,
                  t.leader_id,
                  c.nickname AS leader_name,
                  (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::int AS member_count
                FROM teams t
                JOIN characters c ON c.id = t.leader_id
                WHERE COALESCE(t.is_public, TRUE) = TRUE
                  AND t.id NOT IN (
                    SELECT team_id FROM team_members WHERE character_id = $1
                  )
                  AND (
                    t.name ILIKE $2
                    OR c.nickname ILIKE $2
                    OR COALESCE(t.goal, '') ILIKE $2
                  )
                ORDER BY t.created_at DESC NULLS LAST, t.id DESC
                LIMIT $3
                "#,
            )
            .bind(character_id)
            .bind(format!("%{search}%"))
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_sql_business_error)?
        } else {
            sqlx::query(
                r#"
                SELECT
                  t.id,
                  t.name,
                  t.goal,
                  t.join_min_realm,
                  COALESCE(t.max_members, 5)::int AS max_members,
                  t.leader_id,
                  c.nickname AS leader_name,
                  (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::int AS member_count
                FROM teams t
                JOIN characters c ON c.id = t.leader_id
                WHERE COALESCE(t.is_public, TRUE) = TRUE
                  AND t.id NOT IN (
                    SELECT team_id FROM team_members WHERE character_id = $1
                  )
                ORDER BY t.created_at DESC NULLS LAST, t.id DESC
                LIMIT $2
                "#,
            )
            .bind(character_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_sql_business_error)?
        };

        Ok(ServiceResultResponse::new(
            true,
            None,
            Some(self.build_team_browse_entries(rows, false).await?),
        ))
    }

    async fn get_received_invitations_impl(
        &self,
        character_id: i64,
    ) -> Result<ServiceResultResponse<Vec<TeamInvitationView>>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ti.id,
              ti.message,
              ti.created_at,
              ti.inviter_id,
              t.id AS team_id,
              t.name AS team_name,
              COALESCE(t.goal, '组队冒险') AS goal,
              c.nickname AS inviter_name
            FROM team_invitations ti
            JOIN teams t ON t.id = ti.team_id
            JOIN characters c ON c.id = ti.inviter_id
            WHERE ti.invitee_id = $1
              AND COALESCE(ti.status, 'pending') = 'pending'
            ORDER BY ti.created_at DESC NULLS LAST, ti.id DESC
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let inviter_ids = rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("inviter_id").ok().flatten())
            .collect::<Vec<_>>();
        let inviter_month_card_active_map =
            load_month_card_active_map(&self.pool, &inviter_ids).await?;

        let invitations = rows
            .into_iter()
            .filter_map(|row| {
                let inviter_id = row.try_get::<i64, _>("inviter_id").ok()?;
                let created_at = row
                    .try_get::<Option<chrono::NaiveDateTime>, _>("created_at")
                    .ok()
                    .flatten()
                    .map(|value| value.and_utc().timestamp_millis())
                    .unwrap_or(0);

                Some(TeamInvitationView {
                    id: row.try_get::<String, _>("id").ok().unwrap_or_default(),
                    team_id: row.try_get::<String, _>("team_id").ok().unwrap_or_default(),
                    team_name: row
                        .try_get::<String, _>("team_name")
                        .ok()
                        .unwrap_or_default(),
                    goal: row.try_get::<String, _>("goal").ok().unwrap_or_default(),
                    inviter_name: row
                        .try_get::<String, _>("inviter_name")
                        .ok()
                        .unwrap_or_default(),
                    inviter_month_card_active: inviter_month_card_active_map
                        .get(&inviter_id)
                        .copied()
                        .unwrap_or(false),
                    message: row.try_get::<Option<String>, _>("message").ok().flatten(),
                    time: created_at,
                })
            })
            .collect::<Vec<_>>();

        Ok(ServiceResultResponse::new(true, None, Some(invitations)))
    }

    async fn load_team_info(
        &self,
        team_id: &str,
    ) -> Result<Option<GameHomeTeamInfoView>, BusinessError> {
        let team_row = sqlx::query(
            r#"
            SELECT
              t.id,
              t.name,
              t.leader_id,
              leader.nickname AS leader_name,
              COALESCE(t.max_members, 5)::int AS max_members,
              COALESCE(t.goal, '组队冒险') AS goal,
              COALESCE(t.join_min_realm, '凡人') AS join_min_realm,
              COALESCE(t.auto_join_enabled, FALSE) AS auto_join_enabled,
              COALESCE(t.auto_join_min_realm, '凡人') AS auto_join_min_realm,
              t.current_map_id,
              COALESCE(t.is_public, TRUE) AS is_public
            FROM teams t
            JOIN characters leader ON leader.id = t.leader_id
            WHERE t.id = $1
            LIMIT 1
            "#,
        )
        .bind(team_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let Some(team_row) = team_row else {
            return Ok(None);
        };

        let member_rows = sqlx::query(
            r#"
            SELECT
              tm.character_id,
              c.user_id,
              COALESCE(tm.role, 'member') AS role,
              c.nickname,
              c.realm,
              c.sub_realm,
              c.avatar
            FROM team_members tm
            JOIN characters c ON c.id = tm.character_id
            WHERE tm.team_id = $1
            ORDER BY CASE WHEN COALESCE(tm.role, 'member') = 'leader' THEN 0 ELSE 1 END,
                     tm.joined_at ASC NULLS LAST,
                     tm.id ASC
            "#,
        )
        .bind(team_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let character_ids = member_rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("character_id").ok().flatten())
            .collect::<Vec<_>>();
        let month_card_active_map = load_month_card_active_map(&self.pool, &character_ids).await?;
        let online_user_map = self
            .load_online_user_map(
                member_rows
                    .iter()
                    .filter_map(|row| row.try_get::<Option<i64>, _>("user_id").ok().flatten())
                    .collect(),
            )
            .await;

        let members = member_rows
            .into_iter()
            .filter_map(|row| build_team_member_view(row, &month_card_active_map, &online_user_map))
            .collect::<Vec<_>>();
        let member_count = members.len() as i32;

        let leader_id = team_row.get::<i64, _>("leader_id");
        Ok(Some(GameHomeTeamInfoView {
            id: team_row.get::<String, _>("id"),
            name: team_row.get::<String, _>("name"),
            leader: team_row.get::<String, _>("leader_name"),
            leader_id,
            leader_month_card_active: month_card_active_map
                .get(&leader_id)
                .copied()
                .unwrap_or(false),
            members,
            member_count,
            max_members: team_row.get::<i32, _>("max_members"),
            goal: team_row.get::<String, _>("goal"),
            join_min_realm: team_row.get::<String, _>("join_min_realm"),
            auto_join_enabled: team_row.get::<bool, _>("auto_join_enabled"),
            auto_join_min_realm: team_row.get::<String, _>("auto_join_min_realm"),
            current_map_id: team_row
                .try_get::<Option<String>, _>("current_map_id")
                .ok()
                .flatten(),
            is_public: team_row.get::<bool, _>("is_public"),
        }))
    }

    async fn load_team_applications(
        &self,
        team_id: &str,
    ) -> Result<Vec<GameHomeTeamApplicationView>, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              ta.id,
              ta.message,
              ta.created_at,
              c.id AS character_id,
              c.nickname,
              c.realm,
              c.sub_realm,
              c.avatar
            FROM team_applications ta
            JOIN characters c ON c.id = ta.applicant_id
            WHERE ta.team_id = $1
              AND COALESCE(ta.status, 'pending') = 'pending'
            ORDER BY ta.created_at DESC NULLS LAST, ta.id DESC
            "#,
        )
        .bind(team_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let character_ids = rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("character_id").ok().flatten())
            .collect::<Vec<_>>();
        let month_card_active_map = load_month_card_active_map(&self.pool, &character_ids).await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let character_id = row.try_get::<i64, _>("character_id").ok()?;
                let created_at = row
                    .try_get::<Option<chrono::NaiveDateTime>, _>("created_at")
                    .ok()
                    .flatten()
                    .map(|value| value.and_utc().timestamp_millis())
                    .unwrap_or(0);
                Some(GameHomeTeamApplicationView {
                    id: row.try_get::<String, _>("id").ok().unwrap_or_default(),
                    character_id,
                    name: row
                        .try_get::<String, _>("nickname")
                        .ok()
                        .unwrap_or_default(),
                    month_card_active: month_card_active_map
                        .get(&character_id)
                        .copied()
                        .unwrap_or(false),
                    realm: normalize_realm_keeping_unknown(
                        row.try_get::<Option<String>, _>("realm")
                            .ok()
                            .flatten()
                            .as_deref(),
                        row.try_get::<Option<String>, _>("sub_realm")
                            .ok()
                            .flatten()
                            .as_deref(),
                    ),
                    avatar: row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                    message: row.try_get::<Option<String>, _>("message").ok().flatten(),
                    time: created_at,
                })
            })
            .collect())
    }

    async fn build_team_browse_entries(
        &self,
        rows: Vec<sqlx::postgres::PgRow>,
        include_distance: bool,
    ) -> Result<Vec<TeamBrowseEntryView>, BusinessError> {
        let leader_ids = rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("leader_id").ok().flatten())
            .collect::<Vec<_>>();
        let leader_month_card_active_map =
            load_month_card_active_map(&self.pool, &leader_ids).await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let leader_character_id = row.try_get::<i64, _>("leader_id").ok()?;
                let id = row.try_get::<String, _>("id").ok().unwrap_or_default();
                Some(TeamBrowseEntryView {
                    id: id.clone(),
                    name: row.try_get::<String, _>("name").ok().unwrap_or_default(),
                    leader: row
                        .try_get::<String, _>("leader_name")
                        .ok()
                        .unwrap_or_default(),
                    leader_month_card_active: leader_month_card_active_map
                        .get(&leader_character_id)
                        .copied()
                        .unwrap_or(false),
                    members: row.try_get::<i32, _>("member_count").ok().unwrap_or(0),
                    cap: row.try_get::<i32, _>("max_members").ok().unwrap_or(5),
                    goal: row.try_get::<String, _>("goal").ok().unwrap_or_default(),
                    min_realm: row
                        .try_get::<String, _>("join_min_realm")
                        .ok()
                        .unwrap_or_else(|| "凡人".to_string()),
                    distance: if include_distance {
                        Some(build_nearby_distance_text(&id))
                    } else {
                        None
                    },
                })
            })
            .collect())
    }

    async fn load_online_user_map(&self, user_ids: Vec<i64>) -> HashMap<i64, bool> {
        let normalized_user_ids = normalize_positive_ids(user_ids);
        let mut result = HashMap::with_capacity(normalized_user_ids.len());
        for user_id in &normalized_user_ids {
            result.insert(*user_id, false);
        }
        if normalized_user_ids.is_empty() {
            return result;
        }

        let guard = self.session_registry.lock().await;
        for user_id in normalized_user_ids {
            result.insert(user_id, guard.socket_id_by_user(user_id).is_some());
        }
        result
    }
}

impl TeamRouteServices for RustTeamRouteService {
    fn get_my_team<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMyTeamResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.get_my_team_impl(character_id).await })
    }

    fn get_team_by_id<'a>(
        &'a self,
        team_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<GameHomeTeamInfoView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_team_by_id_impl(team_id).await })
    }

    fn get_team_applications<'a>(
        &'a self,
        team_id: String,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<Vec<GameHomeTeamApplicationView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_team_applications_impl(team_id, character_id).await })
    }

    fn get_nearby_teams<'a>(
        &'a self,
        character_id: i64,
        map_id: Option<String>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_nearby_teams_impl(character_id, map_id).await })
    }

    fn get_lobby_teams<'a>(
        &'a self,
        character_id: i64,
        search: Option<String>,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_lobby_teams_impl(character_id, search, limit).await })
    }

    fn get_received_invitations<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamInvitationView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_received_invitations_impl(character_id).await })
    }
}

fn build_team_member_view(
    row: sqlx::postgres::PgRow,
    month_card_active_map: &HashMap<i64, bool>,
    online_user_map: &HashMap<i64, bool>,
) -> Option<GameHomeTeamMemberView> {
    let character_id = row.try_get::<i64, _>("character_id").ok()?;
    let user_id = row.try_get::<Option<i64>, _>("user_id").ok().flatten();
    let role = row
        .try_get::<String, _>("role")
        .ok()
        .unwrap_or_else(|| "member".to_string());

    Some(GameHomeTeamMemberView {
        id: format!("tm-{character_id}"),
        character_id,
        name: row
            .try_get::<String, _>("nickname")
            .ok()
            .unwrap_or_default(),
        month_card_active: month_card_active_map
            .get(&character_id)
            .copied()
            .unwrap_or(false),
        role: if role == "leader" {
            "leader".to_string()
        } else {
            "member".to_string()
        },
        realm: normalize_realm_keeping_unknown(
            row.try_get::<Option<String>, _>("realm")
                .ok()
                .flatten()
                .as_deref(),
            row.try_get::<Option<String>, _>("sub_realm")
                .ok()
                .flatten()
                .as_deref(),
        ),
        online: user_id
            .and_then(|value| online_user_map.get(&value).copied())
            .unwrap_or(false),
        avatar: row.try_get::<Option<String>, _>("avatar").ok().flatten(),
    })
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_positive_ids(ids: Vec<i64>) -> Vec<i64> {
    let mut normalized_ids = ids.into_iter().filter(|id| *id > 0).collect::<Vec<_>>();
    normalized_ids.sort_unstable();
    normalized_ids.dedup();
    normalized_ids
}

fn normalize_positive_i64(value: Option<i64>) -> Option<i64> {
    value.filter(|item| *item > 0)
}

fn build_nearby_distance_text(team_id: &str) -> String {
    let hash = team_id.bytes().fold(0_u32, |acc, byte| {
        acc.wrapping_mul(33).wrapping_add(u32::from(byte))
    });
    format!("{}米", 50 + (hash % 500))
}

fn empty_team_overview() -> GameHomeTeamOverviewView {
    GameHomeTeamOverviewView {
        info: None,
        role: None,
        applications: Vec::new(),
    }
}

fn internal_sql_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
