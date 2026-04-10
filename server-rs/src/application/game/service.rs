use std::collections::HashMap;
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use chrono::{Datelike, Local};
use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;

use crate::application::account::service::RustAccountService;
use crate::application::idle::service::RustIdleRouteService;
use crate::application::inventory::service::{InventoryLocation, RustInventoryReadService};
use crate::application::month_card::service::default_month_card_id;
use crate::application::realm::service::RustRealmRouteService;
use crate::application::sign_in::service::RustSignInService;
use crate::application::static_data::catalog::get_static_data_catalog;
use crate::application::static_data::dungeon::{get_dungeon_static_catalog, DungeonListFilter};
use crate::application::static_data::realm::{
    get_realm_rank_zero_based, normalize_realm_keeping_unknown,
};
use crate::application::static_data::seed::{list_seed_files_with_prefix, read_seed_json};
use crate::bootstrap::app::SharedRuntimeServices;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::game::{
    GameActionResult, GameHomeAchievementView, GameHomeDialogueStateView,
    GameHomeMainQuestChapterView, GameHomeMainQuestProgressView,
    GameHomeMainQuestSectionObjectiveView, GameHomeMainQuestSectionView, GameHomeOverviewView,
    GameHomeSignInView, GameHomeTaskSummaryItemView, GameHomeTaskSummaryView,
    GameTaskObjectiveView, GameTaskOverviewItemView, GameTaskOverviewView, GameTaskRewardView,
    GameHomeTeamApplicationView, GameHomeTeamInfoView, GameHomeTeamMemberView,
    GameHomeTeamOverviewView, GameMainQuestTrackDataView, GameRouteServices,
    GameTaskTrackDataView,
};
use crate::edge::http::routes::inventory::InventoryRouteServices;
use crate::edge::http::routes::realm::RealmRouteServices;
use crate::runtime::connection::session_registry::SharedSessionRegistry;

static TASK_SEED_CATALOG: OnceLock<Result<Vec<GameTaskSeed>, String>> = OnceLock::new();
static MAIN_QUEST_CATALOG: OnceLock<Result<MainQuestCatalog, String>> = OnceLock::new();
static TASK_AUXILIARY_CATALOG: OnceLock<Result<TaskAuxiliaryCatalog, String>> = OnceLock::new();

/**
 * 首页聚合应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `gameHomeOverviewService` 的首页首屏聚合读取，把签到、成就、账号安全、境界、装备、挂机、队伍、任务、主线收敛到单一入口。
 * 2. 做什么：优先复用现有 sign_in/account/realm/inventory/idle 应用服务，把未迁移领域只保留为首页所需的最小摘要查询，避免重复实现整套路由。
 * 3. 不做什么：不承担任务/主线/队伍的写操作，也不伪造尚未迁移的完整副作用链。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、`character_id`。
 * - 输出：`GameHomeOverviewView`，字段名与 Node 当前首页接口保持兼容。
 *
 * 数据流 / 状态流：
 * - 首页请求 -> 本服务并发调用已迁移服务 + PostgreSQL/seed 摘要查询 -> 聚合为首页快照 -> HTTP 路由直接返回。
 *
 * 复用设计说明：
 * - 签到、手机号、境界、背包、挂机都直接复用现有服务，避免首页聚合复制领域规则；未迁移的任务/主线/队伍只在这里维护最小只读查询，等完整路由迁移后仍可继续复用。
 * - 任务种子与主线种子通过模块级 `OnceLock` 缓存，首页高频打开时不会重复扫描大 JSON 文件。
 *
 * 关键边界条件与坑点：
 * 1. 签到概览是首页红点真值来源，若读取失败必须直接报错，不能静默回退成“未签到”，否则会把真实异常伪装成业务状态。
 * 2. 主线快照当前只对齐首页追踪所需的最小字段；`dialogue.currentNode` 与奖励富化不在这一轮扩展，避免为了首页读接口把未迁移详情逻辑硬塞进来。
 */
#[derive(Clone)]
pub struct RustGameRouteService {
    pool: sqlx::PgPool,
    session_registry: SharedSessionRegistry,
    sign_in_service: RustSignInService,
    account_service: RustAccountService,
    realm_service: RustRealmRouteService,
    inventory_service: RustInventoryReadService,
    idle_service: RustIdleRouteService,
}

#[derive(Debug, Clone, Deserialize)]
struct TaskSeedFile {
    tasks: Vec<GameTaskSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct GameTaskSeed {
    id: String,
    category: String,
    title: Option<String>,
    realm: String,
    description: Option<String>,
    giver_npc_id: Option<String>,
    map_id: Option<String>,
    room_id: Option<String>,
    #[serde(default)]
    objectives: Vec<GameTaskObjectiveSeed>,
    #[serde(default)]
    rewards: Vec<GameTaskRewardSeed>,
    enabled: Option<bool>,
    #[serde(default)]
    sort_weight: i32,
}

#[derive(Debug, Clone, Deserialize)]
struct GameTaskObjectiveSeed {
    id: Option<String>,
    #[serde(rename = "type")]
    objective_type: Option<String>,
    text: Option<String>,
    target: Option<i32>,
    params: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct GameTaskRewardSeed {
    #[serde(rename = "type")]
    reward_type: Option<String>,
    item_def_id: Option<String>,
    qty: Option<i32>,
    qty_min: Option<i32>,
    qty_max: Option<i32>,
    amount: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaskItemSeedFile {
    items: Vec<TaskItemSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TaskItemSeed {
    id: String,
    name: String,
    icon: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MainQuestSeedFile {
    #[serde(default)]
    chapters: Vec<MainQuestChapterSeed>,
    #[serde(default)]
    sections: Vec<MainQuestSectionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct MainQuestChapterSeed {
    id: String,
    chapter_num: i32,
    name: Option<String>,
    description: Option<String>,
    background: Option<String>,
    min_realm: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MainQuestSectionSeed {
    id: String,
    chapter_id: String,
    section_num: i32,
    name: Option<String>,
    description: Option<String>,
    brief: Option<String>,
    npc_id: Option<String>,
    map_id: Option<String>,
    room_id: Option<String>,
    #[serde(default)]
    objectives: Vec<MainQuestObjectiveSeed>,
    rewards: Option<Value>,
    is_chapter_final: Option<bool>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MainQuestObjectiveSeed {
    id: Option<String>,
    #[serde(rename = "type")]
    objective_type: Option<String>,
    text: Option<String>,
    target: Option<i32>,
    params: Option<Value>,
}

#[derive(Debug, Clone)]
struct MainQuestCatalog {
    chapter_by_id: HashMap<String, MainQuestChapterSeed>,
    section_by_id: HashMap<String, MainQuestSectionSeed>,
    sorted_section_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct CharacterRealmState {
    realm: String,
    sub_realm: Option<String>,
}

#[derive(Debug, Clone)]
struct PreparedTaskEntry {
    seed: GameTaskSeed,
    status: String,
    tracked: bool,
    progress: HashMap<String, i32>,
}

#[derive(Debug, Clone)]
struct TaskRewardItemMeta {
    name: String,
    icon: Option<String>,
}

#[derive(Debug, Clone)]
struct TaskAuxiliaryCatalog {
    map_name_by_id: HashMap<String, String>,
    dungeon_name_by_id: HashMap<String, String>,
    entity_map_name_by_id: HashMap<String, String>,
    item_meta_by_id: HashMap<String, TaskRewardItemMeta>,
}

impl RustGameRouteService {
    pub fn new(
        pool: sqlx::PgPool,
        redis: redis::Client,
        runtime_services: SharedRuntimeServices,
        session_registry: SharedSessionRegistry,
    ) -> Self {
        Self {
            sign_in_service: RustSignInService::new(pool.clone()),
            account_service: RustAccountService::new(pool.clone()),
            realm_service: RustRealmRouteService::new(pool.clone()),
            inventory_service: RustInventoryReadService::new(pool.clone()),
            idle_service: RustIdleRouteService::new(pool.clone(), redis, runtime_services),
            pool,
            session_registry,
        }
    }

    async fn get_home_overview_impl(
        &self,
        user_id: i64,
        character_id: i64,
    ) -> Result<GameHomeOverviewView, BusinessError> {
        let current_month = build_current_month();
        let (
            sign_in_result,
            phone_binding,
            realm_overview_result,
            equipped_items_result,
            idle_session,
            team_overview,
            task_summary,
            main_quest_progress,
            achievement_claimable_count,
        ) = tokio::try_join!(
            self.sign_in_service.get_overview(user_id, &current_month),
            self.account_service.get_phone_binding_status(user_id),
            <RustRealmRouteService as RealmRouteServices>::get_overview(
                &self.realm_service,
                user_id
            ),
            <RustInventoryReadService as InventoryRouteServices>::get_inventory_items(
                &self.inventory_service,
                character_id,
                InventoryLocation::Equipped,
                1,
                200,
            ),
            self.idle_service.get_active_idle_session(character_id),
            self.load_team_overview(character_id),
            self.load_task_summary(character_id, None),
            self.load_main_quest_progress(character_id),
            self.load_achievement_claimable_count(character_id),
        )?;

        let sign_in_data = sign_in_result
            .success
            .then_some(sign_in_result.data)
            .flatten()
            .ok_or_else(|| internal_business_error("首页签到概览读取失败"))?;

        Ok(GameHomeOverviewView {
            sign_in: GameHomeSignInView {
                current_month,
                signed_today: sign_in_data.signed_today,
            },
            achievement: GameHomeAchievementView {
                claimable_count: achievement_claimable_count,
            },
            phone_binding,
            realm_overview: if realm_overview_result.success {
                realm_overview_result.data
            } else {
                None
            },
            equipped_items: equipped_items_result.items,
            idle_session,
            team: team_overview,
            task: task_summary,
            main_quest: main_quest_progress,
        })
    }

    async fn load_achievement_claimable_count(
        &self,
        character_id: i64,
    ) -> Result<i64, BusinessError> {
        sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(*)::bigint
            FROM character_achievement
            WHERE character_id = $1
              AND status = 'completed'
            "#,
        )
        .bind(character_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_sql_business_error)
    }

    async fn load_team_overview(
        &self,
        character_id: i64,
    ) -> Result<GameHomeTeamOverviewView, BusinessError> {
        let team_id = sqlx::query_scalar::<_, String>(
            "SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1",
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let Some(team_id) = team_id else {
            return Ok(empty_team_overview());
        };

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
        .bind(&team_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let Some(team_row) = team_row else {
            return Ok(empty_team_overview());
        };

        let members_rows = sqlx::query(
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
            ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, tm.joined_at ASC, tm.id ASC
            "#,
        )
        .bind(&team_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let character_ids = members_rows
            .iter()
            .filter_map(|row| row.try_get::<Option<i64>, _>("character_id").ok().flatten())
            .collect::<Vec<_>>();
        let month_card_active_map = self.load_month_card_active_map(character_ids).await?;
        let online_user_map = self
            .load_online_user_map(
                members_rows
                    .iter()
                    .filter_map(|row| row.try_get::<Option<i64>, _>("user_id").ok().flatten())
                    .collect(),
            )
            .await;

        let members = members_rows
            .into_iter()
            .filter_map(|row| {
                let character_id = row.try_get::<i64, _>("character_id").ok()?;
                let user_id = row.try_get::<Option<i64>, _>("user_id").ok().flatten();
                let role = row
                    .try_get::<String, _>("role")
                    .ok()
                    .unwrap_or_else(|| "member".to_string());
                let realm = normalize_realm_keeping_unknown(
                    row.try_get::<Option<String>, _>("realm")
                        .ok()
                        .flatten()
                        .as_deref(),
                    row.try_get::<Option<String>, _>("sub_realm")
                        .ok()
                        .flatten()
                        .as_deref(),
                );

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
                    realm,
                    online: user_id
                        .and_then(|value| online_user_map.get(&value).copied())
                        .unwrap_or(false),
                    avatar: row.try_get::<Option<String>, _>("avatar").ok().flatten(),
                })
            })
            .collect::<Vec<_>>();

        let leader_id = team_row.get::<i64, _>("leader_id");
        let info = GameHomeTeamInfoView {
            id: team_row.get::<String, _>("id"),
            name: team_row.get::<String, _>("name"),
            leader: team_row.get::<String, _>("leader_name"),
            leader_id,
            leader_month_card_active: month_card_active_map
                .get(&leader_id)
                .copied()
                .unwrap_or(false),
            member_count: members.len() as i32,
            members,
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
        };
        let role = if leader_id == character_id {
            Some("leader".to_string())
        } else {
            Some("member".to_string())
        };

        let applications = if role.as_deref() == Some("leader") {
            self.load_team_applications(&team_id).await?
        } else {
            Vec::new()
        };

        Ok(GameHomeTeamOverviewView {
            info: Some(info),
            role,
            applications,
        })
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
              (EXTRACT(EPOCH FROM ta.created_at) * 1000)::bigint AS created_at_ms,
              c.id AS character_id,
              c.nickname,
              c.realm,
              c.sub_realm,
              c.avatar
            FROM team_applications ta
            JOIN characters c ON c.id = ta.applicant_id
            WHERE ta.team_id = $1
              AND ta.status = 'pending'
            ORDER BY ta.created_at DESC
            "#,
        )
        .bind(team_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let month_card_active_map = self
            .load_month_card_active_map(
                rows.iter()
                    .filter_map(|row| row.try_get::<Option<i64>, _>("character_id").ok().flatten())
                    .collect(),
            )
            .await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let character_id = row.try_get::<i64, _>("character_id").ok()?;
                let created_at = row.try_get::<i64, _>("created_at_ms").ok().unwrap_or(0);
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

    async fn load_prepared_task_entries(
        &self,
        character_id: i64,
        category: Option<&str>,
    ) -> Result<Vec<PreparedTaskEntry>, BusinessError> {
        let Some(character_realm_state) = self.load_character_realm_state(character_id).await?
        else {
            return Ok(Vec::new());
        };

        let task_defs = task_seed_catalog()?
            .iter()
            .filter(|task| task.enabled != Some(false))
            .filter(|task| {
                category
                    .map(|value| task.category == value.trim())
                    .unwrap_or(true)
            })
            .filter(|task| is_task_visible_for_realm(task, &character_realm_state))
            .cloned()
            .collect::<Vec<_>>();

        if task_defs.is_empty() {
            return Ok(Vec::new());
        }

        let daily_ids = task_defs
            .iter()
            .filter(|task| task.category == "daily")
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        let event_ids = task_defs
            .iter()
            .filter(|task| task.category == "event")
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();

        if !daily_ids.is_empty() || !event_ids.is_empty() {
            sqlx::query(
                r#"
                UPDATE character_task_progress
                SET status = 'ongoing',
                    progress = '{}'::jsonb,
                    accepted_at = NOW(),
                    completed_at = NULL,
                    claimed_at = NULL,
                    updated_at = NOW()
                WHERE character_id = $1
                  AND (
                    (task_id = ANY($2::varchar[]) AND accepted_at < date_trunc('day', NOW()))
                    OR
                    (task_id = ANY($3::varchar[]) AND accepted_at < date_trunc('week', NOW()))
                  )
                "#,
            )
            .bind(character_id)
            .bind(&daily_ids)
            .bind(&event_ids)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;
        }

        let task_ids = task_defs
            .iter()
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        let progress_rows = sqlx::query(
            r#"
            SELECT task_id, status, tracked, progress
            FROM character_task_progress
            WHERE character_id = $1
              AND task_id = ANY($2::varchar[])
            "#,
        )
        .bind(character_id)
        .bind(&task_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let mut progress_by_task_id = HashMap::with_capacity(progress_rows.len());
        for row in progress_rows {
            let task_id = row.get::<String, _>("task_id");
            progress_by_task_id.insert(
                task_id,
                (
                    row.try_get::<Option<String>, _>("status").ok().flatten(),
                    row.try_get::<Option<bool>, _>("tracked")
                        .ok()
                        .flatten()
                        .unwrap_or(false),
                    parse_task_progress_map(
                        row.try_get::<Option<Value>, _>("progress").ok().flatten(),
                    ),
                ),
            );
        }

        let mut sorted_task_defs = task_defs;
        sorted_task_defs.sort_by(|left, right| {
            left.category
                .cmp(&right.category)
                .then_with(|| right.sort_weight.cmp(&left.sort_weight))
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(sorted_task_defs
            .into_iter()
            .map(|task| {
                let (status_raw, tracked, progress) = progress_by_task_id
                    .remove(&task.id)
                    .unwrap_or((None, false, HashMap::new()));
                PreparedTaskEntry {
                    seed: task,
                    status: map_task_status(status_raw.as_deref()),
                    tracked,
                    progress,
                }
            })
            .collect())
    }

    async fn load_task_summary(
        &self,
        character_id: i64,
        category: Option<&str>,
    ) -> Result<GameHomeTaskSummaryView, BusinessError> {
        let entries = self.load_prepared_task_entries(character_id, category).await?;
        Ok(GameHomeTaskSummaryView {
            tasks: entries
                .into_iter()
                .map(|entry| {
                    GameHomeTaskSummaryItemView {
                        id: entry.seed.id,
                        category: entry.seed.category,
                        map_id: normalize_optional_text(entry.seed.map_id.as_deref()),
                        room_id: normalize_optional_text(entry.seed.room_id.as_deref()),
                        status: entry.status,
                        tracked: entry.tracked,
                    }
                })
                .collect(),
        })
    }

    async fn load_task_overview(
        &self,
        character_id: i64,
        category: Option<&str>,
    ) -> Result<GameTaskOverviewView, BusinessError> {
        let entries = self.load_prepared_task_entries(character_id, category).await?;
        if entries.is_empty() {
            return Ok(GameTaskOverviewView { tasks: Vec::new() });
        }

        let auxiliary_catalog = task_auxiliary_catalog()?;
        Ok(GameTaskOverviewView {
            tasks: entries
                .into_iter()
                .map(|entry| {
                    let PreparedTaskEntry {
                        seed,
                        status,
                        tracked,
                        progress,
                    } = entry;
                    GameTaskOverviewItemView {
                        id: seed.id,
                        category: seed.category,
                        title: seed
                            .title
                            .as_deref()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .unwrap_or_default()
                            .to_string(),
                        realm: seed.realm,
                        giver_npc_id: normalize_optional_text(seed.giver_npc_id.as_deref()),
                        map_id: normalize_optional_text(seed.map_id.as_deref()),
                        map_name: resolve_task_map_name(
                            auxiliary_catalog,
                            seed.map_id.as_deref(),
                        ),
                        room_id: normalize_optional_text(seed.room_id.as_deref()),
                        status,
                        tracked,
                        description: seed
                            .description
                            .as_deref()
                            .map(str::trim)
                            .unwrap_or_default()
                            .to_string(),
                        objectives: build_task_objective_views(
                            &seed.objectives,
                            &progress,
                            seed.map_id.as_deref(),
                            auxiliary_catalog,
                        ),
                        rewards: build_task_reward_views(&seed.rewards, auxiliary_catalog),
                    }
                })
                .collect(),
        })
    }

    async fn set_task_tracked_impl(
        &self,
        character_id: i64,
        task_id: String,
        tracked: bool,
    ) -> Result<GameActionResult<GameTaskTrackDataView>, BusinessError> {
        let normalized_task_id = task_id.trim().to_string();
        if normalized_task_id.is_empty() {
            return Ok(GameActionResult {
                success: false,
                message: "任务ID不能为空".to_string(),
                data: None,
            });
        }

        let Some(character_realm_state) = self.load_character_realm_state(character_id).await?
        else {
            return Ok(GameActionResult {
                success: false,
                message: "角色不存在".to_string(),
                data: None,
            });
        };

        let task_def = task_seed_catalog()?
            .iter()
            .find(|task| task.enabled != Some(false) && task.id == normalized_task_id)
            .cloned();
        let Some(task_def) = task_def else {
            return Ok(GameActionResult {
                success: false,
                message: "任务不存在".to_string(),
                data: None,
            });
        };

        if let Some(required_realm) =
            build_task_unlock_failure_message(&task_def, &character_realm_state)
        {
            return Ok(GameActionResult {
                success: false,
                message: required_realm,
                data: None,
            });
        }

        let row = sqlx::query(
            r#"
            INSERT INTO character_task_progress (character_id, task_id, tracked)
            VALUES ($1, $2, $3)
            ON CONFLICT (character_id, task_id) DO UPDATE SET
              tracked = EXCLUDED.tracked,
              updated_at = NOW()
            RETURNING tracked
            "#,
        )
        .bind(character_id)
        .bind(&normalized_task_id)
        .bind(tracked)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(GameActionResult {
            success: true,
            message: "ok".to_string(),
            data: Some(GameTaskTrackDataView {
                task_id: normalized_task_id,
                tracked: row.get::<bool, _>("tracked"),
            }),
        })
    }

    async fn load_main_quest_progress(
        &self,
        character_id: i64,
    ) -> Result<GameHomeMainQuestProgressView, BusinessError> {
        let catalog = main_quest_catalog()?;
        let Some(first_section_id) = catalog.sorted_section_ids.first() else {
            return Ok(empty_main_quest_progress());
        };
        let Some(first_section) = catalog.section_by_id.get(first_section_id) else {
            return Ok(empty_main_quest_progress());
        };

        let mut row = sqlx::query(
            r#"
            SELECT
              current_chapter_id,
              current_section_id,
              section_status,
              objectives_progress,
              dialogue_state,
              completed_chapters,
              completed_sections,
              tracked
            FROM character_main_quest_progress
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if row.is_none() {
            sqlx::query(
                r#"
                INSERT INTO character_main_quest_progress
                  (
                    character_id,
                    current_chapter_id,
                    current_section_id,
                    section_status,
                    objectives_progress,
                    dialogue_state,
                    completed_chapters,
                    completed_sections
                  )
                VALUES ($1, $2, $3, 'not_started', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)
                ON CONFLICT (character_id) DO NOTHING
                "#,
            )
            .bind(character_id)
            .bind(&first_section.chapter_id)
            .bind(&first_section.id)
            .execute(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

            row = sqlx::query(
                r#"
                SELECT
                  current_chapter_id,
                  current_section_id,
                  section_status,
                  objectives_progress,
                  dialogue_state,
                  completed_chapters,
                  completed_sections,
                  tracked
                FROM character_main_quest_progress
                WHERE character_id = $1
                LIMIT 1
                "#,
            )
            .bind(character_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;
        }

        let Some(row) = row else {
            return Ok(empty_main_quest_progress());
        };

        let completed_chapters = value_to_string_vec(
            row.try_get::<Option<Value>, _>("completed_chapters")
                .ok()
                .flatten(),
        );
        let completed_sections = value_to_string_vec(
            row.try_get::<Option<Value>, _>("completed_sections")
                .ok()
                .flatten(),
        );
        let dialogue_state_value = row
            .try_get::<Option<Value>, _>("dialogue_state")
            .ok()
            .flatten();
        let objectives_progress = row
            .try_get::<Option<Value>, _>("objectives_progress")
            .ok()
            .flatten()
            .unwrap_or(Value::Null);
        let current_chapter_id = row
            .try_get::<Option<String>, _>("current_chapter_id")
            .ok()
            .flatten();
        let current_section_id = row
            .try_get::<Option<String>, _>("current_section_id")
            .ok()
            .flatten();
        let status = row
            .try_get::<Option<String>, _>("section_status")
            .ok()
            .flatten()
            .unwrap_or_else(|| "not_started".to_string());

        let current_chapter = current_chapter_id
            .as_ref()
            .and_then(|chapter_id| catalog.chapter_by_id.get(chapter_id))
            .filter(|chapter| chapter.enabled != Some(false))
            .map(|chapter| GameHomeMainQuestChapterView {
                id: chapter.id.clone(),
                chapter_num: chapter.chapter_num,
                name: chapter.name.clone(),
                description: chapter.description.clone(),
                background: chapter.background.clone(),
                min_realm: chapter
                    .min_realm
                    .clone()
                    .unwrap_or_else(|| "凡人".to_string()),
                is_completed: completed_chapters.iter().any(|value| value == &chapter.id),
            });

        let current_section = current_section_id
            .as_ref()
            .and_then(|section_id| catalog.section_by_id.get(section_id))
            .filter(|section| {
                section.enabled != Some(false)
                    && catalog
                        .chapter_by_id
                        .get(&section.chapter_id)
                        .map(|chapter| chapter.enabled != Some(false))
                        .unwrap_or(false)
            })
            .map(|section| GameHomeMainQuestSectionView {
                id: section.id.clone(),
                chapter_id: Some(section.chapter_id.clone()),
                section_num: section.section_num,
                name: section.name.clone(),
                description: section.description.clone(),
                brief: section.brief.clone(),
                npc_id: section.npc_id.clone(),
                map_id: section.map_id.clone(),
                room_id: resolve_main_quest_room_id(section, &status, &objectives_progress),
                status: status.clone(),
                objectives: build_main_quest_objectives(section, &objectives_progress),
                rewards: section
                    .rewards
                    .clone()
                    .unwrap_or(Value::Object(serde_json::Map::new())),
                is_chapter_final: section.is_chapter_final == Some(true),
            });

        Ok(GameHomeMainQuestProgressView {
            current_chapter,
            current_section,
            completed_chapters,
            completed_sections,
            dialogue_state: parse_dialogue_state(dialogue_state_value),
            tracked: row
                .try_get::<Option<bool>, _>("tracked")
                .ok()
                .flatten()
                .unwrap_or(true),
        })
    }

    async fn load_main_quest_chapters(
        &self,
        character_id: i64,
    ) -> Result<Vec<GameHomeMainQuestChapterView>, BusinessError> {
        let completed_chapters = sqlx::query(
            "SELECT completed_chapters FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?
        .and_then(|row| row.try_get::<Option<Value>, _>("completed_chapters").ok().flatten());

        let completed_chapter_ids = value_to_string_vec(completed_chapters);
        let catalog = main_quest_catalog()?;
        let section_count_by_chapter = build_enabled_section_count_by_chapter(catalog);
        let mut chapters = catalog
            .chapter_by_id
            .values()
            .filter(|chapter| chapter.enabled != Some(false))
            .filter_map(|chapter| {
                let chapter_id = chapter.id.trim().to_string();
                let chapter_num = chapter.chapter_num;
                if chapter_id.is_empty() || chapter_num <= 0 {
                    return None;
                }
                Some((
                    chapter_num,
                    *section_count_by_chapter.get(&chapter_id).unwrap_or(&0_i32),
                    GameHomeMainQuestChapterView {
                        id: chapter_id.clone(),
                        chapter_num,
                        name: chapter.name.clone(),
                        description: chapter.description.clone(),
                        background: chapter.background.clone(),
                        min_realm: chapter
                            .min_realm
                            .clone()
                            .unwrap_or_else(|| "凡人".to_string()),
                        is_completed: completed_chapter_ids.iter().any(|value| value == &chapter_id),
                    },
                ))
            })
            .collect::<Vec<_>>();
        chapters.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| left.2.id.cmp(&right.2.id))
        });
        chapters.dedup_by(|left, right| left.0 == right.0);
        Ok(chapters.into_iter().map(|(_, _, chapter)| chapter).collect())
    }

    async fn load_main_quest_sections(
        &self,
        character_id: i64,
        chapter_id: &str,
    ) -> Result<Vec<GameHomeMainQuestSectionView>, BusinessError> {
        let normalized_chapter_id = chapter_id.trim();
        if normalized_chapter_id.is_empty() {
            return Ok(Vec::new());
        }

        let _ = self.load_main_quest_progress(character_id).await?;
        let row = sqlx::query(
            r#"
            SELECT
              current_section_id,
              section_status,
              objectives_progress,
              completed_sections
            FROM character_main_quest_progress
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let completed_sections = value_to_string_vec(
            row.as_ref()
                .and_then(|value| value.try_get::<Option<Value>, _>("completed_sections").ok())
                .flatten(),
        );
        let current_section_id = row
            .as_ref()
            .and_then(|value| value.try_get::<Option<String>, _>("current_section_id").ok())
            .flatten();
        let current_status = row
            .as_ref()
            .and_then(|value| value.try_get::<Option<String>, _>("section_status").ok())
            .flatten()
            .unwrap_or_else(|| "not_started".to_string());
        let current_progress = row
            .as_ref()
            .and_then(|value| value.try_get::<Option<Value>, _>("objectives_progress").ok())
            .flatten()
            .unwrap_or(Value::Null);

        let catalog = main_quest_catalog()?;
        let mut sections = catalog
            .section_by_id
            .values()
            .filter(|section| section.chapter_id == normalized_chapter_id)
            .filter(|section| section.enabled != Some(false))
            .map(|section| {
                let is_current = current_section_id.as_deref() == Some(section.id.as_str());
                let is_completed = completed_sections.iter().any(|value| value == &section.id);
                let status = if is_completed {
                    "completed".to_string()
                } else if is_current {
                    current_status.clone()
                } else {
                    "not_started".to_string()
                };
                GameHomeMainQuestSectionView {
                    id: section.id.clone(),
                    chapter_id: Some(section.chapter_id.clone()),
                    section_num: section.section_num,
                    name: section.name.clone(),
                    description: section.description.clone(),
                    brief: section.brief.clone(),
                    npc_id: section.npc_id.clone(),
                    map_id: section.map_id.clone(),
                    room_id: if is_current {
                        resolve_main_quest_room_id(section, &status, &current_progress)
                    } else {
                        section.room_id.clone()
                    },
                    status,
                    objectives: if is_current {
                        build_main_quest_objectives(section, &current_progress)
                    } else if is_completed {
                        build_completed_main_quest_objectives(section)
                    } else {
                        build_main_quest_objectives(section, &Value::Null)
                    },
                    rewards: section
                        .rewards
                        .clone()
                        .unwrap_or(Value::Object(serde_json::Map::new())),
                    is_chapter_final: section.is_chapter_final == Some(true),
                }
            })
            .collect::<Vec<_>>();
        sections.sort_by(|left, right| left.section_num.cmp(&right.section_num));
        Ok(sections)
    }

    async fn set_main_quest_tracked_impl(
        &self,
        character_id: i64,
        tracked: bool,
    ) -> Result<GameActionResult<GameMainQuestTrackDataView>, BusinessError> {
        let progress = self.load_main_quest_progress(character_id).await?;
        let _ = progress;

        let row = sqlx::query(
            r#"
            UPDATE character_main_quest_progress
            SET tracked = $2, updated_at = NOW()
            WHERE character_id = $1
            RETURNING tracked
            "#,
        )
        .bind(character_id)
        .bind(tracked)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(GameActionResult {
            success: true,
            message: "ok".to_string(),
            data: Some(GameMainQuestTrackDataView {
                tracked: row.get::<bool, _>("tracked"),
            }),
        })
    }

    async fn load_character_realm_state(
        &self,
        character_id: i64,
    ) -> Result<Option<CharacterRealmState>, BusinessError> {
        let row = sqlx::query("SELECT realm, sub_realm FROM characters WHERE id = $1 LIMIT 1")
            .bind(character_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal_sql_business_error)?;

        Ok(row.map(|row| CharacterRealmState {
            realm: row
                .try_get::<Option<String>, _>("realm")
                .ok()
                .flatten()
                .unwrap_or_else(|| "凡人".to_string()),
            sub_realm: row.try_get::<Option<String>, _>("sub_realm").ok().flatten(),
        }))
    }

    async fn load_month_card_active_map(
        &self,
        character_ids: Vec<i64>,
    ) -> Result<HashMap<i64, bool>, BusinessError> {
        let mut result = HashMap::with_capacity(character_ids.len());
        let normalized_ids = normalize_character_ids(character_ids);
        for character_id in &normalized_ids {
            result.insert(*character_id, false);
        }
        if normalized_ids.is_empty() {
            return Ok(result);
        }

        let rows = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT character_id
            FROM month_card_ownership
            WHERE character_id = ANY($1::bigint[])
              AND month_card_id = $2
              AND expire_at > CURRENT_TIMESTAMP
            "#,
        )
        .bind(&normalized_ids)
        .bind(default_month_card_id())
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        for character_id in rows {
            result.insert(character_id, true);
        }
        Ok(result)
    }

    async fn load_online_user_map(&self, user_ids: Vec<i64>) -> HashMap<i64, bool> {
        let normalized_ids = normalize_character_ids(user_ids);
        let mut result = HashMap::with_capacity(normalized_ids.len());
        if normalized_ids.is_empty() {
            return result;
        }

        let registry = self.session_registry.lock().await;
        for user_id in normalized_ids {
            result.insert(user_id, registry.socket_id_by_user(user_id).is_some());
        }
        result
    }
}

impl GameRouteServices for RustGameRouteService {
    fn get_home_overview<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_home_overview_impl(user_id, character_id).await })
    }

    fn get_task_overview<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameTaskOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.load_task_overview(character_id, category.as_deref())
                .await
        })
    }

    fn get_task_overview_summary<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeTaskSummaryView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.load_task_summary(character_id, category.as_deref()).await
        })
    }

    fn set_task_tracked<'a>(
        &'a self,
        character_id: i64,
        task_id: String,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskTrackDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.set_task_tracked_impl(character_id, task_id, tracked).await })
    }

    fn get_main_quest_progress<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameHomeMainQuestProgressView, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { self.load_main_quest_progress(character_id).await })
    }

    fn get_main_quest_chapters<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestChapterView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.load_main_quest_chapters(character_id).await })
    }

    fn get_main_quest_sections<'a>(
        &'a self,
        character_id: i64,
        chapter_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestSectionView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.load_main_quest_sections(character_id, chapter_id.as_str())
                .await
        })
    }

    fn set_main_quest_tracked<'a>(
        &'a self,
        character_id: i64,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<GameActionResult<GameMainQuestTrackDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.set_main_quest_tracked_impl(character_id, tracked).await
        })
    }
}

fn task_auxiliary_catalog() -> Result<&'static TaskAuxiliaryCatalog, BusinessError> {
    let result = TASK_AUXILIARY_CATALOG.get_or_init(|| {
        build_task_auxiliary_catalog().map_err(|error| error.to_string())
    });
    match result {
        Ok(catalog) => Ok(catalog),
        Err(error) => Err(internal_string_business_error(error.clone())),
    }
}

fn build_task_auxiliary_catalog() -> Result<TaskAuxiliaryCatalog, crate::shared::error::AppError> {
    let static_catalog = get_static_data_catalog()?;
    let dungeon_catalog = get_dungeon_static_catalog()?;

    let map_name_by_id = static_catalog
        .maps()
        .iter()
        .map(|entry| (entry.id.clone(), entry.name.clone()))
        .collect::<HashMap<_, _>>();

    let mut entity_map_name_by_id = HashMap::new();
    for map in static_catalog.maps() {
        let Some(detail) = static_catalog.map_detail(map.id.as_str()) else {
            continue;
        };
        for room in &detail.rooms {
            if let Some(monsters) = room.monsters.as_ref() {
                for monster in monsters {
                    entity_map_name_by_id
                        .entry(monster.monster_def_id.clone())
                        .or_insert_with(|| map.name.clone());
                }
            }
            if let Some(resources) = room.resources.as_ref() {
                for resource in resources {
                    entity_map_name_by_id
                        .entry(resource.resource_id.clone())
                        .or_insert_with(|| map.name.clone());
                }
            }
        }
    }

    let dungeon_name_by_id = dungeon_catalog
        .list(&DungeonListFilter::default())
        .into_iter()
        .map(|entry| (entry.id, entry.name))
        .collect::<HashMap<_, _>>();

    let item_meta_by_id = read_seed_json::<TaskItemSeedFile>("item_def.json")?
        .items
        .into_iter()
        .filter(|entry| entry.enabled != Some(false))
        .map(|entry| {
            (
                entry.id,
                TaskRewardItemMeta {
                    name: entry.name,
                    icon: entry.icon,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    Ok(TaskAuxiliaryCatalog {
        map_name_by_id,
        dungeon_name_by_id,
        entity_map_name_by_id,
        item_meta_by_id,
    })
}

fn task_seed_catalog() -> Result<&'static Vec<GameTaskSeed>, BusinessError> {
    let result = TASK_SEED_CATALOG.get_or_init(|| {
        read_seed_json::<TaskSeedFile>("task_def.json")
            .map(|file| file.tasks)
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(catalog) => Ok(catalog),
        Err(error) => Err(internal_string_business_error(error.clone())),
    }
}

fn main_quest_catalog() -> Result<&'static MainQuestCatalog, BusinessError> {
    let result = MAIN_QUEST_CATALOG
        .get_or_init(|| load_main_quest_catalog().map_err(|error| error.to_string()));
    match result {
        Ok(catalog) => Ok(catalog),
        Err(error) => Err(internal_string_business_error(error.clone())),
    }
}

fn load_main_quest_catalog() -> Result<MainQuestCatalog, crate::shared::error::AppError> {
    let mut chapter_by_id = HashMap::new();
    let mut section_by_id = HashMap::new();

    for file_name in list_seed_files_with_prefix("main_quest_chapter")? {
        let file = read_seed_json::<MainQuestSeedFile>(&file_name)?;
        for chapter in file.chapters {
            chapter_by_id.insert(chapter.id.clone(), chapter);
        }
        for section in file.sections {
            section_by_id.insert(section.id.clone(), section);
        }
    }

    let mut sorted_sections = section_by_id
        .values()
        .filter(|section| section.enabled != Some(false))
        .filter(|section| {
            chapter_by_id
                .get(&section.chapter_id)
                .map(|chapter| chapter.enabled != Some(false))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    sorted_sections.sort_by(|left, right| {
        let left_chapter_num = chapter_by_id
            .get(&left.chapter_id)
            .map(|chapter| chapter.chapter_num)
            .unwrap_or(0);
        let right_chapter_num = chapter_by_id
            .get(&right.chapter_id)
            .map(|chapter| chapter.chapter_num)
            .unwrap_or(0);
        left_chapter_num
            .cmp(&right_chapter_num)
            .then_with(|| left.section_num.cmp(&right.section_num))
    });
    let sorted_section_ids = sorted_sections
        .into_iter()
        .map(|section| section.id.clone())
        .collect();

    Ok(MainQuestCatalog {
        chapter_by_id,
        section_by_id,
        sorted_section_ids,
    })
}

fn parse_task_progress_map(value: Option<Value>) -> HashMap<String, i32> {
    let Some(Value::Object(entries)) = value else {
        return HashMap::new();
    };
    entries
        .into_iter()
        .filter_map(|(key, value)| {
            let number = value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|item| i64::try_from(item).ok()))
                .unwrap_or(0);
            let normalized = number.max(0).min(i64::from(i32::MAX)) as i32;
            if key.trim().is_empty() {
                None
            } else {
                Some((key, normalized))
            }
        })
        .collect()
}

fn resolve_task_map_name(
    auxiliary_catalog: &TaskAuxiliaryCatalog,
    map_id: Option<&str>,
) -> Option<String> {
    let normalized_map_id = map_id?.trim();
    if normalized_map_id.is_empty() {
        return None;
    }
    auxiliary_catalog
        .map_name_by_id
        .get(normalized_map_id)
        .cloned()
}

fn resolve_task_objective_map_binding(
    auxiliary_catalog: &TaskAuxiliaryCatalog,
    task_map_id: Option<&str>,
    params: Option<&Value>,
) -> (Option<String>, Option<String>) {
    if let Some(Value::Object(entries)) = params {
        if let Some(dungeon_id) = entries.get("dungeon_id").and_then(Value::as_str) {
            let normalized_dungeon_id = dungeon_id.trim();
            if !normalized_dungeon_id.is_empty() {
                if let Some(name) = auxiliary_catalog
                    .dungeon_name_by_id
                    .get(normalized_dungeon_id)
                    .cloned()
                {
                    return (Some(name), Some("dungeon".to_string()));
                }
            }
        }

        for key in ["monster_id", "resource_id"] {
            if let Some(entity_id) = entries.get(key).and_then(Value::as_str) {
                let normalized_entity_id = entity_id.trim();
                if !normalized_entity_id.is_empty() {
                    if let Some(name) = auxiliary_catalog
                        .entity_map_name_by_id
                        .get(normalized_entity_id)
                        .cloned()
                    {
                        return (Some(name), Some("map".to_string()));
                    }
                }
            }
        }
    }

    match resolve_task_map_name(auxiliary_catalog, task_map_id) {
        Some(name) => (Some(name), Some("map".to_string())),
        None => (None, None),
    }
}

fn build_task_objective_views(
    objectives: &[GameTaskObjectiveSeed],
    progress: &HashMap<String, i32>,
    task_map_id: Option<&str>,
    auxiliary_catalog: &TaskAuxiliaryCatalog,
) -> Vec<GameTaskObjectiveView> {
    objectives
        .iter()
        .filter_map(|objective| {
            let text = objective
                .text
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let id = objective
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_default()
                .to_string();
            let target = objective.target.unwrap_or(1).max(1);
            let done = progress.get(id.as_str()).copied().unwrap_or(0).clamp(0, target);
            let (map_name, map_name_type) = resolve_task_objective_map_binding(
                auxiliary_catalog,
                task_map_id,
                objective.params.as_ref(),
            );
            Some(GameTaskObjectiveView {
                id,
                r#type: objective
                    .objective_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("unknown")
                    .to_string(),
                text,
                done,
                target,
                params: objective.params.clone(),
                map_name,
                map_name_type,
            })
        })
        .collect()
}

fn normalize_task_reward_amount(value: Option<i32>, fallback: i32) -> i32 {
    value.unwrap_or(fallback).max(0)
}

fn build_task_reward_views(
    rewards: &[GameTaskRewardSeed],
    auxiliary_catalog: &TaskAuxiliaryCatalog,
) -> Vec<GameTaskRewardView> {
    rewards
        .iter()
        .filter_map(|reward| {
            let reward_type = reward
                .reward_type
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            match reward_type {
                "silver" => {
                    let amount = normalize_task_reward_amount(reward.amount, 0);
                    (amount > 0).then(|| GameTaskRewardView {
                        r#type: "silver".to_string(),
                        name: "银两".to_string(),
                        amount,
                        item_def_id: None,
                        icon: None,
                        amount_max: None,
                    })
                }
                "spirit_stones" => {
                    let amount = normalize_task_reward_amount(reward.amount, 0);
                    (amount > 0).then(|| GameTaskRewardView {
                        r#type: "spirit_stones".to_string(),
                        name: "灵石".to_string(),
                        amount,
                        item_def_id: None,
                        icon: None,
                        amount_max: None,
                    })
                }
                "item" => {
                    let item_def_id = reward
                        .item_def_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let amount = normalize_task_reward_amount(
                        reward.qty.or(reward.qty_min),
                        0,
                    );
                    if amount <= 0 {
                        return None;
                    }
                    let amount_max = reward
                        .qty_max
                        .map(|value| value.max(amount))
                        .filter(|value| *value > amount);
                    let meta = auxiliary_catalog.item_meta_by_id.get(item_def_id);
                    Some(GameTaskRewardView {
                        r#type: "item".to_string(),
                        name: meta
                            .map(|entry| entry.name.clone())
                            .unwrap_or_else(|| item_def_id.to_string()),
                        amount,
                        item_def_id: Some(item_def_id.to_string()),
                        icon: meta.and_then(|entry| entry.icon.clone()),
                        amount_max,
                    })
                }
                _ => None,
            }
        })
        .collect()
}

fn build_current_month() -> String {
    let now = Local::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

fn normalize_character_ids(values: Vec<i64>) -> Vec<i64> {
    let mut values = values
        .into_iter()
        .filter(|value| *value > 0)
        .collect::<Vec<_>>();
    values.sort_unstable();
    values.dedup();
    values
}

fn build_task_unlock_failure_message(
    task: &GameTaskSeed,
    state: &CharacterRealmState,
) -> Option<String> {
    if task.category != "daily" && task.category != "event" {
        return None;
    }
    let required_realm = task.realm.trim();
    if required_realm.is_empty() || is_task_visible_for_realm(task, state) {
        return None;
    }
    Some(format!("需达到{required_realm}后开放"))
}

fn is_task_visible_for_realm(task: &GameTaskSeed, state: &CharacterRealmState) -> bool {
    if task.category != "daily" && task.category != "event" {
        return true;
    }
    let required_realm = task.realm.trim();
    if required_realm.is_empty() {
        return true;
    }
    get_realm_rank_zero_based(Some(&state.realm), state.sub_realm.as_deref())
        >= get_realm_rank_zero_based(Some(required_realm), None)
}

fn map_task_status(value: Option<&str>) -> String {
    match value.unwrap_or("ongoing") {
        "turnin" => "turnin".to_string(),
        "claimable" => "claimable".to_string(),
        "completed" | "claimed" => "completed".to_string(),
        _ => "ongoing".to_string(),
    }
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn empty_team_overview() -> GameHomeTeamOverviewView {
    GameHomeTeamOverviewView {
        info: None,
        role: None,
        applications: Vec::new(),
    }
}

fn build_enabled_section_count_by_chapter(catalog: &MainQuestCatalog) -> HashMap<String, i32> {
    let mut result = HashMap::new();
    for section in catalog.section_by_id.values() {
        if section.enabled == Some(false) {
            continue;
        }
        let chapter_enabled = catalog
            .chapter_by_id
            .get(&section.chapter_id)
            .map(|chapter| chapter.enabled != Some(false))
            .unwrap_or(false);
        if !chapter_enabled {
            continue;
        }
        *result.entry(section.chapter_id.clone()).or_insert(0) += 1;
    }
    result
}

fn empty_main_quest_progress() -> GameHomeMainQuestProgressView {
    GameHomeMainQuestProgressView {
        current_chapter: None,
        current_section: None,
        completed_chapters: Vec::new(),
        completed_sections: Vec::new(),
        dialogue_state: None,
        tracked: true,
    }
}

fn value_to_string_vec(value: Option<Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect()
}

fn build_main_quest_objectives(
    section: &MainQuestSectionSeed,
    progress: &Value,
) -> Vec<GameHomeMainQuestSectionObjectiveView> {
    let progress_map = progress.as_object();
    section
        .objectives
        .iter()
        .map(|objective| {
            let done = objective
                .id
                .as_ref()
                .and_then(|objective_id| progress_map.and_then(|map| map.get(objective_id)))
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32;
            GameHomeMainQuestSectionObjectiveView {
                id: objective.id.clone(),
                r#type: objective.objective_type.clone(),
                text: objective.text.clone(),
                target: objective.target.unwrap_or(1),
                done,
                params: objective.params.clone(),
            }
        })
        .collect()
}

fn build_completed_main_quest_objectives(
    section: &MainQuestSectionSeed,
) -> Vec<GameHomeMainQuestSectionObjectiveView> {
    section
        .objectives
        .iter()
        .map(|objective| GameHomeMainQuestSectionObjectiveView {
            id: objective.id.clone(),
            r#type: objective.objective_type.clone(),
            text: objective.text.clone(),
            target: objective.target.unwrap_or(1),
            done: objective.target.unwrap_or(1),
            params: objective.params.clone(),
        })
        .collect()
}

fn resolve_main_quest_room_id(
    section: &MainQuestSectionSeed,
    status: &str,
    progress: &Value,
) -> Option<String> {
    if status != "objectives" {
        return section.room_id.clone();
    }

    let progress_map = progress.as_object();
    for objective in &section.objectives {
        if objective.objective_type.as_deref() != Some("reach") {
            continue;
        }
        let target = objective.target.unwrap_or(1);
        let done = objective
            .id
            .as_ref()
            .and_then(|objective_id| progress_map.and_then(|map| map.get(objective_id)))
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
        if done >= target {
            continue;
        }
        let room_id = objective
            .params
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|params| params.get("room_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        if room_id.is_some() {
            return room_id;
        }
    }

    section.room_id.clone()
}

fn parse_dialogue_state(value: Option<Value>) -> Option<GameHomeDialogueStateView> {
    let value = value?;
    let object = value.as_object()?;
    let dialogue_id = object.get("dialogueId")?.as_str()?.trim().to_string();
    if dialogue_id.is_empty() {
        return None;
    }

    Some(GameHomeDialogueStateView {
        dialogue_id,
        current_node_id: object
            .get("currentNodeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        current_node: object.get("currentNode").cloned(),
        selected_choices: object
            .get("selectedChoices")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        is_complete: object
            .get("isComplete")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pending_effects: object
            .get("pendingEffects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

fn internal_sql_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn internal_string_business_error(error: String) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
