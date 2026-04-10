use std::collections::HashMap;
use std::{future::Future, pin::Pin};

use sqlx::{postgres::PgRow, QueryBuilder, Row};

use crate::application::month_card::benefits::load_month_card_active_map;
use crate::application::static_data::realm::{
    get_realm_rank_zero_based, normalize_realm_keeping_unknown,
};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::game::{
    GameHomeTeamApplicationView, GameHomeTeamInfoView, GameHomeTeamMemberView,
    GameHomeTeamOverviewView,
};
use crate::edge::http::routes::team::{
    TeamBrowseEntryView, TeamCreateDataView, TeamInvitationView, TeamMutationResponse,
    TeamMyTeamResponse, TeamRouteServices, TeamSettingsUpdateInput,
};
use crate::runtime::connection::session_registry::SharedSessionRegistry;

const DEFAULT_TEAM_GOAL: &str = "组队冒险";
const DEFAULT_TEAM_MAX_MEMBERS: i32 = 5;

/**
 * team 应用服务。
 *
 * 作用：
 * 1. 做什么：复刻 Node `teamService` 的读写协议，覆盖当前队伍、队伍详情、申请列表、附近/大厅列表、邀请列表与建队/退队/审批/邀请等写链路。
 * 2. 做什么：把成员月卡标记、在线态、境界判断、组队写校验与队伍 DTO 映射集中在一个模块，供首页聚合和 `/api/team` 直接复用。
 * 3. 不做什么：不在这里发 socket 推送、不维护 battle 投影同步，也不引入额外缓存层或兼容分支。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、队伍 ID、写接口 body 字段，以及大厅/附近查询参数。
 * - 输出：Node 兼容的 `TeamMyTeamResponse`、`ServiceResultResponse<T>`、`TeamMutationResponse` 与首页复用的 `GameHomeTeamOverviewView`。
 *
 * 数据流 / 状态流：
 * - 路由或首页聚合 -> 本服务读写 PostgreSQL `teams/team_members/team_applications/team_invitations/characters/idle_sessions`
 * - -> 批量补齐月卡激活态与在线状态 -> 返回队伍 DTO 或写操作结果。
 *
 * 复用设计说明：
 * - 首页队伍块与独立 `team` 路由都依赖同一套成员、申请、邀请与写校验规则；集中在这里后，读写口径不会再分叉。
 * - 境界比较、挂机互斥校验、申请/邀请状态更新等高频业务变化点统一收敛到 helper，避免 create/apply/approve/invite 四处复制同一判断。
 *
 * 关键边界条件与坑点：
 * 1. `get_my_team` 在未入队时必须继续返回 `success:true + data:null + message:'未加入队伍'`，不能改成 404。
 * 2. 入队写操作必须与活跃挂机互斥，命中 `idle_sessions.status IN ('active', 'stopping')` 时要保持 `离线挂机中，无法进行组队操作` 文案。
 */
#[derive(Clone)]
pub struct RustTeamRouteService {
    pool: sqlx::PgPool,
    session_registry: SharedSessionRegistry,
}

#[derive(Debug, Clone)]
struct CharacterTeamProfile {
    nickname: String,
    current_map_id: Option<String>,
    realm: String,
    sub_realm: Option<String>,
}

#[derive(Debug, Clone)]
struct TeamWriteContext {
    team_id: String,
    max_members: i32,
    member_count: i32,
    join_min_realm: String,
    auto_join_enabled: bool,
    auto_join_min_realm: String,
}

#[derive(Debug, Clone)]
struct TeamMembershipContext {
    team_id: String,
    role: String,
    leader_id: i64,
}

#[derive(Debug, Clone)]
struct PendingTeamApplicationContext {
    application_id: String,
    team_id: String,
    applicant_id: i64,
    leader_id: i64,
    max_members: i32,
    member_count: i32,
}

#[derive(Debug, Clone)]
struct PendingTeamInvitationContext {
    invitation_id: String,
    team_id: String,
    invitee_id: i64,
    max_members: i32,
    member_count: i32,
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

    async fn create_team_impl(
        &self,
        character_id: i64,
        name: Option<String>,
        goal: Option<String>,
    ) -> Result<TeamMutationResponse, BusinessError> {
        if let Some(conflict) = self.assert_character_can_join_team(character_id).await? {
            return Ok(conflict);
        }

        if self.is_character_in_team(character_id).await? {
            return Ok(TeamMutationResponse::failure(
                "你已在队伍中，请先退出当前队伍",
            ));
        }

        let Some(profile) = self.load_character_profile(character_id).await? else {
            return Ok(TeamMutationResponse::failure("角色不存在"));
        };

        let team_id = self.generate_uuid().await?;
        let team_name = normalize_optional_text(name.as_deref())
            .unwrap_or_else(|| format!("{}的小队", profile.nickname));
        let team_goal = normalize_optional_text(goal.as_deref())
            .unwrap_or_else(|| DEFAULT_TEAM_GOAL.to_string());

        let mut transaction = self.pool.begin().await.map_err(internal_sql_business_error)?;
        sqlx::query(
            r#"
            INSERT INTO teams (id, name, leader_id, goal, current_map_id)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&team_id)
        .bind(&team_name)
        .bind(character_id)
        .bind(&team_goal)
        .bind(profile.current_map_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_sql_business_error)?;
        sqlx::query(
            "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader')",
        )
        .bind(&team_id)
        .bind(character_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_sql_business_error)?;
        transaction
            .commit()
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("队伍创建成功").with_data(TeamCreateDataView {
            team_id,
            name: team_name,
        }))
    }

    async fn disband_team_impl(
        &self,
        character_id: i64,
        team_id: String,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let leader_id =
            sqlx::query_scalar::<_, i64>("SELECT leader_id FROM teams WHERE id = $1 LIMIT 1")
                .bind(&team_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;

        let Some(leader_id) = leader_id else {
            return Ok(TeamMutationResponse::failure("队伍不存在"));
        };

        if leader_id != character_id {
            return Ok(TeamMutationResponse::failure("只有队长才能解散队伍"));
        }

        sqlx::query("DELETE FROM teams WHERE id = $1")
            .bind(&team_id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("队伍已解散"))
    }

    async fn leave_team_impl(&self, character_id: i64) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self.load_team_membership_context(character_id).await? else {
            return Ok(TeamMutationResponse::failure("你不在任何队伍中"));
        };

        if context.role == "leader" {
            let next_leader_id = sqlx::query_scalar::<_, i64>(
                r#"
                SELECT character_id
                FROM team_members
                WHERE team_id = $1
                  AND character_id != $2
                ORDER BY joined_at ASC NULLS LAST, id ASC
                LIMIT 1
                "#,
            )
            .bind(&context.team_id)
            .bind(character_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

            if let Some(next_leader_id) = next_leader_id {
                let mut transaction = self.pool.begin().await.map_err(internal_sql_business_error)?;
                sqlx::query("UPDATE teams SET leader_id = $1 WHERE id = $2")
                    .bind(next_leader_id)
                    .bind(&context.team_id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(internal_sql_business_error)?;
                sqlx::query(
                    "UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2",
                )
                .bind(&context.team_id)
                .bind(next_leader_id)
                .execute(&mut *transaction)
                .await
                .map_err(internal_sql_business_error)?;
                sqlx::query("DELETE FROM team_members WHERE character_id = $1")
                    .bind(character_id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(internal_sql_business_error)?;
                transaction
                    .commit()
                    .await
                    .map_err(internal_sql_business_error)?;
                return Ok(TeamMutationResponse::success("已离开队伍"));
            }

            sqlx::query("DELETE FROM teams WHERE id = $1")
                .bind(&context.team_id)
                .execute(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;
            return Ok(TeamMutationResponse::success("队伍已解散（无其他成员）"));
        }

        sqlx::query("DELETE FROM team_members WHERE character_id = $1")
            .bind(character_id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("已离开队伍"))
    }

    async fn apply_to_team_impl(
        &self,
        character_id: i64,
        team_id: String,
        message: Option<String>,
    ) -> Result<TeamMutationResponse, BusinessError> {
        if self.is_character_in_team(character_id).await? {
            return Ok(TeamMutationResponse::failure("你已在队伍中"));
        }

        let Some(team_context) = self.load_team_write_context(&team_id).await? else {
            return Ok(TeamMutationResponse::failure("队伍不存在"));
        };

        if team_context.member_count >= team_context.max_members {
            return Ok(TeamMutationResponse::failure("队伍已满"));
        }

        let Some(profile) = self.load_character_profile(character_id).await? else {
            return Ok(TeamMutationResponse::failure("角色不存在"));
        };

        let character_rank = get_realm_rank_zero_based(
            Some(profile.realm.as_str()),
            profile.sub_realm.as_deref(),
        );
        let min_join_rank =
            get_realm_rank_zero_based(Some(team_context.join_min_realm.as_str()), None);
        if character_rank < min_join_rank {
            return Ok(TeamMutationResponse::failure(format!(
                "境界不足，需要{}以上",
                team_context.join_min_realm
            )));
        }

        let existing_application = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM team_applications
            WHERE team_id = $1
              AND applicant_id = $2
              AND COALESCE(status, 'pending') = 'pending'
            LIMIT 1
            "#,
        )
        .bind(&team_context.team_id)
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if existing_application.is_some() {
            return Ok(TeamMutationResponse::failure("已有待处理的申请"));
        }

        let auto_join_rank =
            get_realm_rank_zero_based(Some(team_context.auto_join_min_realm.as_str()), None);
        if team_context.auto_join_enabled && character_rank >= auto_join_rank {
            if let Some(conflict) = self.assert_character_can_join_team(character_id).await? {
                return Ok(conflict);
            }

            sqlx::query(
                "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')",
            )
            .bind(&team_context.team_id)
            .bind(character_id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

            return Ok(TeamMutationResponse::success("已自动加入队伍").with_auto_joined(true));
        }

        let application_id = self.generate_uuid().await?;
        sqlx::query(
            r#"
            INSERT INTO team_applications (id, team_id, applicant_id, message)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&application_id)
        .bind(&team_context.team_id)
        .bind(character_id)
        .bind(normalize_optional_text(message.as_deref()))
        .execute(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("申请已提交").with_application_id(application_id))
    }

    async fn get_team_applications_impl(
        &self,
        team_id: String,
        character_id: i64,
    ) -> Result<ServiceResultResponse<Vec<GameHomeTeamApplicationView>>, BusinessError> {
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

    async fn handle_application_impl(
        &self,
        character_id: i64,
        application_id: String,
        approve: bool,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self.load_pending_team_application(&application_id).await? else {
            return Ok(TeamMutationResponse::failure("申请不存在或已处理"));
        };

        if context.leader_id != character_id {
            return Ok(TeamMutationResponse::failure("只有队长才能处理申请"));
        }

        if approve {
            if context.member_count >= context.max_members {
                self.update_team_application_status(
                    &context.application_id,
                    &context.team_id,
                    context.applicant_id,
                    "rejected",
                )
                .await?;
                return Ok(TeamMutationResponse::failure("队伍已满"));
            }

            if self.is_character_in_team(context.applicant_id).await? {
                self.update_team_application_status(
                    &context.application_id,
                    &context.team_id,
                    context.applicant_id,
                    "rejected",
                )
                .await?;
                return Ok(TeamMutationResponse::failure("该玩家已加入其他队伍"));
            }

            if let Some(conflict) = self.assert_character_can_join_team(context.applicant_id).await?
            {
                return Ok(conflict);
            }

            let mut transaction = self.pool.begin().await.map_err(internal_sql_business_error)?;
            sqlx::query(
                "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')",
            )
            .bind(&context.team_id)
            .bind(context.applicant_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            sqlx::query(
                r#"
                DELETE FROM team_applications
                WHERE team_id = $1 AND applicant_id = $2 AND status = $3 AND id != $4
                "#,
            )
            .bind(&context.team_id)
            .bind(context.applicant_id)
            .bind("approved")
            .bind(&context.application_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            sqlx::query(
                "UPDATE team_applications SET status = $2, handled_at = NOW() WHERE id = $1",
            )
            .bind(&context.application_id)
            .bind("approved")
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            transaction
                .commit()
                .await
                .map_err(internal_sql_business_error)?;

            return Ok(TeamMutationResponse::success("已通过申请"));
        }

        self.update_team_application_status(
            &context.application_id,
            &context.team_id,
            context.applicant_id,
            "rejected",
        )
        .await?;
        Ok(TeamMutationResponse::success("已拒绝申请"))
    }

    async fn kick_member_impl(
        &self,
        leader_id: i64,
        target_character_id: i64,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self.load_team_membership_context(leader_id).await? else {
            return Ok(TeamMutationResponse::failure("你不在任何队伍中"));
        };

        if context.leader_id != leader_id {
            return Ok(TeamMutationResponse::failure("只有队长才能踢人"));
        }

        if leader_id == target_character_id {
            return Ok(TeamMutationResponse::failure("不能踢出自己"));
        }

        let target_exists = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT 1
            FROM team_members
            WHERE team_id = $1 AND character_id = $2
            LIMIT 1
            "#,
        )
        .bind(&context.team_id)
        .bind(target_character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if target_exists.is_none() {
            return Ok(TeamMutationResponse::failure("该玩家不在队伍中"));
        }

        sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND character_id = $2")
            .bind(&context.team_id)
            .bind(target_character_id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("已踢出成员"))
    }

    async fn transfer_leader_impl(
        &self,
        current_leader_id: i64,
        new_leader_id: i64,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self.load_team_membership_context(current_leader_id).await? else {
            return Ok(TeamMutationResponse::failure("你不在任何队伍中"));
        };

        if context.leader_id != current_leader_id {
            return Ok(TeamMutationResponse::failure("只有队长才能转让"));
        }

        let new_leader_exists = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT 1
            FROM team_members
            WHERE team_id = $1 AND character_id = $2
            LIMIT 1
            "#,
        )
        .bind(&context.team_id)
        .bind(new_leader_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if new_leader_exists.is_none() {
            return Ok(TeamMutationResponse::failure("该玩家不在队伍中"));
        }

        let mut transaction = self.pool.begin().await.map_err(internal_sql_business_error)?;
        sqlx::query("UPDATE teams SET leader_id = $1, updated_at = NOW() WHERE id = $2")
            .bind(new_leader_id)
            .bind(&context.team_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
        sqlx::query("UPDATE team_members SET role = 'member' WHERE team_id = $1 AND character_id = $2")
            .bind(&context.team_id)
            .bind(current_leader_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
        sqlx::query("UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2")
            .bind(&context.team_id)
            .bind(new_leader_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
        transaction
            .commit()
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("队长已转让"))
    }

    async fn update_team_settings_impl(
        &self,
        character_id: i64,
        team_id: String,
        settings: TeamSettingsUpdateInput,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let leader_id =
            sqlx::query_scalar::<_, i64>("SELECT leader_id FROM teams WHERE id = $1 LIMIT 1")
                .bind(&team_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;

        let Some(leader_id) = leader_id else {
            return Ok(TeamMutationResponse::failure("队伍不存在"));
        };

        if leader_id != character_id {
            return Ok(TeamMutationResponse::failure("只有队长才能修改设置"));
        }

        let TeamSettingsUpdateInput {
            name,
            goal,
            join_min_realm,
            auto_join_enabled,
            auto_join_min_realm,
            is_public,
        } = settings;

        if name.is_none()
            && goal.is_none()
            && join_min_realm.is_none()
            && auto_join_enabled.is_none()
            && auto_join_min_realm.is_none()
            && is_public.is_none()
        {
            return Ok(TeamMutationResponse::success("无需更新"));
        }

        let mut builder = QueryBuilder::<sqlx::Postgres>::new("UPDATE teams SET ");
        let mut separated = builder.separated(", ");

        if let Some(value) = name {
            separated.push("name = ").push_bind(value);
        }
        if let Some(value) = goal {
            separated.push("goal = ").push_bind(value);
        }
        if let Some(value) = join_min_realm {
            separated.push("join_min_realm = ").push_bind(value);
        }
        if let Some(value) = auto_join_enabled {
            separated.push("auto_join_enabled = ").push_bind(value);
        }
        if let Some(value) = auto_join_min_realm {
            separated.push("auto_join_min_realm = ").push_bind(value);
        }
        if let Some(value) = is_public {
            separated.push("is_public = ").push_bind(value);
        }
        separated.push("updated_at = NOW()");
        drop(separated);

        builder.push(" WHERE id = ");
        builder.push_bind(team_id);
        builder
            .build()
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("设置已更新"))
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

    async fn invite_to_team_impl(
        &self,
        inviter_id: i64,
        invitee_id: i64,
        message: Option<String>,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self.load_team_membership_context(inviter_id).await? else {
            return Ok(TeamMutationResponse::failure("你不在任何队伍中"));
        };

        if context.leader_id != inviter_id {
            return Ok(TeamMutationResponse::failure("只有队长才能邀请"));
        }

        let member_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM team_members WHERE team_id = $1")
                .bind(&context.team_id)
                .fetch_one(&self.pool)
                .await
                .map_err(internal_sql_business_error)? as i32;
        let max_members = sqlx::query_scalar::<_, i32>(
            "SELECT COALESCE(max_members, 5)::int FROM teams WHERE id = $1 LIMIT 1",
        )
        .bind(&context.team_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if member_count >= max_members {
            return Ok(TeamMutationResponse::failure("队伍已满"));
        }

        if self.is_character_in_team(invitee_id).await? {
            return Ok(TeamMutationResponse::failure("该玩家已在队伍中"));
        }

        let existing_invitation = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM team_invitations
            WHERE team_id = $1
              AND invitee_id = $2
              AND COALESCE(status, 'pending') = 'pending'
            LIMIT 1
            "#,
        )
        .bind(&context.team_id)
        .bind(invitee_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if existing_invitation.is_some() {
            return Ok(TeamMutationResponse::failure("已有待处理的邀请"));
        }

        let invitation_id = self.generate_uuid().await?;
        sqlx::query(
            r#"
            INSERT INTO team_invitations (id, team_id, inviter_id, invitee_id, message)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(&invitation_id)
        .bind(&context.team_id)
        .bind(inviter_id)
        .bind(invitee_id)
        .bind(normalize_optional_text(message.as_deref()))
        .execute(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(TeamMutationResponse::success("邀请已发送").with_invitation_id(invitation_id))
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

    async fn handle_invitation_impl(
        &self,
        character_id: i64,
        invitation_id: String,
        accept: bool,
    ) -> Result<TeamMutationResponse, BusinessError> {
        let Some(context) = self
            .load_pending_team_invitation(&invitation_id, character_id)
            .await?
        else {
            return Ok(TeamMutationResponse::failure("邀请不存在或已处理"));
        };

        if accept {
            if self.is_character_in_team(character_id).await? {
                sqlx::query(
                    "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                )
                .bind(&context.invitation_id)
                .execute(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;
                return Ok(TeamMutationResponse::failure("你已在其他队伍中"));
            }

            if context.member_count >= context.max_members {
                sqlx::query(
                    "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                )
                .bind(&context.invitation_id)
                .execute(&self.pool)
                .await
                .map_err(internal_sql_business_error)?;
                return Ok(TeamMutationResponse::failure("队伍已满"));
            }

            if let Some(conflict) = self.assert_character_can_join_team(character_id).await? {
                return Ok(conflict);
            }

            let mut transaction = self.pool.begin().await.map_err(internal_sql_business_error)?;
            sqlx::query(
                "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')",
            )
            .bind(&context.team_id)
            .bind(character_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            sqlx::query(
                "UPDATE team_invitations SET status = 'accepted', handled_at = NOW() WHERE id = $1",
            )
            .bind(&context.invitation_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            sqlx::query(
                r#"
                UPDATE team_invitations
                SET status = 'rejected', handled_at = NOW()
                WHERE invitee_id = $1
                  AND COALESCE(status, 'pending') = 'pending'
                  AND id != $2
                "#,
            )
            .bind(context.invitee_id)
            .bind(&context.invitation_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal_sql_business_error)?;
            transaction
                .commit()
                .await
                .map_err(internal_sql_business_error)?;

            return Ok(TeamMutationResponse::success("已加入队伍"));
        }

        sqlx::query("UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1")
            .bind(&context.invitation_id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;
        Ok(TeamMutationResponse::success("已拒绝邀请"))
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
        rows: Vec<PgRow>,
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
                    cap: row
                        .try_get::<i32, _>("max_members")
                        .ok()
                        .unwrap_or(DEFAULT_TEAM_MAX_MEMBERS),
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

    async fn assert_character_can_join_team(
        &self,
        character_id: i64,
    ) -> Result<Option<TeamMutationResponse>, BusinessError> {
        let blocked = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT 1
            FROM idle_sessions
            WHERE character_id = $1
              AND status IN ('active', 'stopping')
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(blocked.map(|_| TeamMutationResponse::failure("离线挂机中，无法进行组队操作")))
    }

    async fn is_character_in_team(&self, character_id: i64) -> Result<bool, BusinessError> {
        let existing = sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM team_members WHERE character_id = $1 LIMIT 1",
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;
        Ok(existing.is_some())
    }

    async fn load_character_profile(
        &self,
        character_id: i64,
    ) -> Result<Option<CharacterTeamProfile>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT nickname, current_map_id, realm, sub_realm
            FROM characters
            WHERE id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| CharacterTeamProfile {
            nickname: row.try_get::<String, _>("nickname").ok().unwrap_or_default(),
            current_map_id: row
                .try_get::<Option<String>, _>("current_map_id")
                .ok()
                .flatten(),
            realm: row.try_get::<String, _>("realm").ok().unwrap_or_default(),
            sub_realm: row.try_get::<Option<String>, _>("sub_realm").ok().flatten(),
        }))
    }

    async fn load_team_write_context(
        &self,
        team_id: &str,
    ) -> Result<Option<TeamWriteContext>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              t.id,
              COALESCE(t.max_members, 5)::int AS max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::int AS member_count,
              COALESCE(t.join_min_realm, '凡人') AS join_min_realm,
              COALESCE(t.auto_join_enabled, FALSE) AS auto_join_enabled,
              COALESCE(t.auto_join_min_realm, '凡人') AS auto_join_min_realm
            FROM teams t
            WHERE t.id = $1
            LIMIT 1
            "#,
        )
        .bind(team_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| TeamWriteContext {
            team_id: row.get::<String, _>("id"),
            max_members: row.get::<i32, _>("max_members"),
            member_count: row.get::<i32, _>("member_count"),
            join_min_realm: row.get::<String, _>("join_min_realm"),
            auto_join_enabled: row.get::<bool, _>("auto_join_enabled"),
            auto_join_min_realm: row.get::<String, _>("auto_join_min_realm"),
        }))
    }

    async fn load_team_membership_context(
        &self,
        character_id: i64,
    ) -> Result<Option<TeamMembershipContext>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT tm.team_id, COALESCE(tm.role, 'member') AS role, t.leader_id
            FROM team_members tm
            JOIN teams t ON t.id = tm.team_id
            WHERE tm.character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| TeamMembershipContext {
            team_id: row.get::<String, _>("team_id"),
            role: row.get::<String, _>("role"),
            leader_id: row.get::<i64, _>("leader_id"),
        }))
    }

    async fn load_pending_team_application(
        &self,
        application_id: &str,
    ) -> Result<Option<PendingTeamApplicationContext>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              ta.id,
              ta.team_id,
              ta.applicant_id,
              t.leader_id,
              COALESCE(t.max_members, 5)::int AS max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = ta.team_id)::int AS member_count
            FROM team_applications ta
            JOIN teams t ON t.id = ta.team_id
            WHERE ta.id = $1
              AND COALESCE(ta.status, 'pending') = 'pending'
            LIMIT 1
            "#,
        )
        .bind(application_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| PendingTeamApplicationContext {
            application_id: row.get::<String, _>("id"),
            team_id: row.get::<String, _>("team_id"),
            applicant_id: row.get::<i64, _>("applicant_id"),
            leader_id: row.get::<i64, _>("leader_id"),
            max_members: row.get::<i32, _>("max_members"),
            member_count: row.get::<i32, _>("member_count"),
        }))
    }

    async fn load_pending_team_invitation(
        &self,
        invitation_id: &str,
        invitee_id: i64,
    ) -> Result<Option<PendingTeamInvitationContext>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              ti.id,
              ti.team_id,
              ti.invitee_id,
              COALESCE(t.max_members, 5)::int AS max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = ti.team_id)::int AS member_count
            FROM team_invitations ti
            JOIN teams t ON t.id = ti.team_id
            WHERE ti.id = $1
              AND ti.invitee_id = $2
              AND COALESCE(ti.status, 'pending') = 'pending'
            LIMIT 1
            "#,
        )
        .bind(invitation_id)
        .bind(invitee_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| PendingTeamInvitationContext {
            invitation_id: row.get::<String, _>("id"),
            team_id: row.get::<String, _>("team_id"),
            invitee_id: row.get::<i64, _>("invitee_id"),
            max_members: row.get::<i32, _>("max_members"),
            member_count: row.get::<i32, _>("member_count"),
        }))
    }

    async fn update_team_application_status(
        &self,
        application_id: &str,
        team_id: &str,
        applicant_id: i64,
        status: &str,
    ) -> Result<(), BusinessError> {
        sqlx::query(
            r#"
            DELETE FROM team_applications
            WHERE team_id = $1
              AND applicant_id = $2
              AND status = $3
              AND id != $4
            "#,
        )
        .bind(team_id)
        .bind(applicant_id)
        .bind(status)
        .bind(application_id)
        .execute(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;
        sqlx::query("UPDATE team_applications SET status = $2, handled_at = NOW() WHERE id = $1")
            .bind(application_id)
            .bind(status)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;
        Ok(())
    }

    async fn generate_uuid(&self) -> Result<String, BusinessError> {
        sqlx::query_scalar::<_, String>("SELECT gen_random_uuid()::text")
            .fetch_one(&self.pool)
            .await
            .map_err(internal_sql_business_error)
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

    fn create_team<'a>(
        &'a self,
        character_id: i64,
        name: Option<String>,
        goal: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.create_team_impl(character_id, name, goal).await })
    }

    fn disband_team<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.disband_team_impl(character_id, team_id).await })
    }

    fn leave_team<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.leave_team_impl(character_id).await })
    }

    fn apply_to_team<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
        message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.apply_to_team_impl(character_id, team_id, message).await })
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

    fn handle_application<'a>(
        &'a self,
        character_id: i64,
        application_id: String,
        approve: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.handle_application_impl(character_id, application_id, approve)
                .await
        })
    }

    fn kick_member<'a>(
        &'a self,
        leader_id: i64,
        target_character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.kick_member_impl(leader_id, target_character_id).await })
    }

    fn transfer_leader<'a>(
        &'a self,
        current_leader_id: i64,
        new_leader_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.transfer_leader_impl(current_leader_id, new_leader_id)
                .await
        })
    }

    fn update_team_settings<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
        settings: TeamSettingsUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.update_team_settings_impl(character_id, team_id, settings)
                .await
        })
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

    fn invite_to_team<'a>(
        &'a self,
        inviter_id: i64,
        invitee_id: i64,
        message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.invite_to_team_impl(inviter_id, invitee_id, message).await })
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

    fn handle_invitation<'a>(
        &'a self,
        character_id: i64,
        invitation_id: String,
        accept: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.handle_invitation_impl(character_id, invitation_id, accept)
                .await
        })
    }
}

fn build_team_member_view(
    row: PgRow,
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
