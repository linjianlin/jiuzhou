use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use axum::http::StatusCode;
use serde::Deserialize;
use sqlx::Row;

use crate::application::static_data::realm::{normalize_realm_keeping_unknown, REALM_ORDER};
use crate::application::static_data::seed::read_seed_json;
use crate::bootstrap::app::SharedRuntimeServices;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::tower::{
    TowerFloorPreviewView, TowerOverviewProgressView, TowerOverviewView, TowerRankRow,
    TowerRouteServices,
};
use crate::runtime::session::build_battle_session_snapshot_view;

/**
 * tower 应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `tower/service.ts` 中概览与排行两条只读链路，统一处理角色解析、塔进度读取、活跃会话裁剪与楼层预览生成。
 * 2. 做什么：把怪物池索引、冻结前沿查询和稳定取样算法收口到单一服务，避免路由层或后续开战链路重复扫描静态配置。
 * 3. 不做什么：不在这里启动塔战、不创建 battle/session runtime，也不写入 Redis/数据库中的塔进度。
 *
 * 输入 / 输出：
 * - 输入：用户 ID、可选排行榜 limit、PostgreSQL 连接池、恢复运行时状态。
 * - 输出：`ServiceResultResponse<TowerOverviewView>` 与 `ServiceResultResponse<Vec<TowerRankRow>>`。
 *
 * 数据流 / 状态流：
 * - 路由层完成 Bearer 鉴权 -> 本服务解析角色 ID -> 读 `character_tower_progress` / `tower_frozen_*` / `characters`
 * - 同时读取恢复中的 battle/session registry 判定可见 active session
 * - 输出 Node 兼容 DTO。
 *
 * 复用设计说明：
 * - 楼层预览算法、冻结池装载和稳定 hash 都集中在这里，后续补 `/api/tower/challenge/start` 时可以直接复用，不必再写第二套塔规则。
 * - 概览里的 `activeSession` 直接复用 battle-session 公共 snapshot builder，后续塔战详情与概览不会出现字段协议漂移。
 *
 * 关键边界条件与坑点：
 * 1. `tower_frozen_frontier` 缺省时必须严格视作 `frozen_floor_max = 0`，表示全部楼层走最新怪物池，而不是返回空预览。
 * 2. 同一 `bestFloor` 下排行仍按 `reached_at` 升序排列，`NULL` 需要排在最前面，保持与 Node 端字符串比较口径一致。
 */
#[derive(Debug, Clone)]
pub struct RustTowerRouteService {
    pool: sqlx::PgPool,
    runtime_services: SharedRuntimeServices,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TowerProgressRecord {
    best_floor: i32,
    next_floor: i32,
    current_run_id: Option<String>,
    current_floor: Option<i32>,
    last_settled_floor: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TowerFloorKind {
    Normal,
    Elite,
    Boss,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TowerMonsterDef {
    id: String,
    name: String,
    realm: String,
    kind: TowerFloorKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TowerMonsterPools {
    normal: BTreeMap<String, Vec<TowerMonsterDef>>,
    elite: BTreeMap<String, Vec<TowerMonsterDef>>,
    boss: BTreeMap<String, Vec<TowerMonsterDef>>,
}

#[derive(Debug, Clone, Deserialize)]
struct TowerMonsterSeedFile {
    monsters: Vec<TowerMonsterSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TowerMonsterSeed {
    id: Option<String>,
    name: Option<String>,
    realm: Option<String>,
    kind: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct TowerFrozenFrontierRow {
    frozen_floor_max: i32,
}

#[derive(Debug, Clone)]
struct TowerFrozenMonsterSnapshotRow {
    frozen_floor_max: i32,
    kind: String,
    realm: String,
    monster_def_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TowerPoolMode {
    Realm,
    Mixed,
}

static TOWER_MONSTER_DEFINITIONS: OnceLock<Result<Vec<TowerMonsterDef>, String>> = OnceLock::new();
static TOWER_LATEST_MONSTER_POOLS: OnceLock<Result<TowerMonsterPools, String>> = OnceLock::new();

const TOWER_SCOPE: &str = "tower";
const TOWER_CYCLE_FLOORS: i32 = 10;
const TOWER_NORMAL_MONSTER_COUNT_MIN: i32 = 2;
const TOWER_NORMAL_MONSTER_COUNT_VARIANCE: i32 = 2;
const TOWER_NORMAL_MONSTER_COUNT_INTERVAL: i32 = 50;
const TOWER_NORMAL_MONSTER_COUNT_CAP: i32 = 5;
const TOWER_ELITE_MONSTER_COUNT_BASE: i32 = 2;
const TOWER_ELITE_MONSTER_COUNT_INTERVAL: i32 = 75;
const TOWER_ELITE_MONSTER_COUNT_CAP: i32 = 4;
const TOWER_BOSS_MONSTER_COUNT_BASE: i32 = 1;
const TOWER_BOSS_MONSTER_COUNT_INTERVAL: i32 = 100;
const TOWER_BOSS_MONSTER_COUNT_CAP: i32 = 3;
const FNV_OFFSET_BASIS: u32 = 0x811c9dc5;
const FNV_PRIME: u32 = 0x01000193;

impl RustTowerRouteService {
    pub fn new(pool: sqlx::PgPool, runtime_services: SharedRuntimeServices) -> Self {
        Self {
            pool,
            runtime_services,
        }
    }

    async fn get_overview_impl(
        &self,
        user_id: i64,
    ) -> Result<ServiceResultResponse<TowerOverviewView>, BusinessError> {
        let Some(character_id) = self.resolve_character_id_by_user_id(user_id).await? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };

        let progress = self.load_tower_progress(character_id).await?;
        let next_floor_preview = self.resolve_tower_floor_preview(progress.next_floor).await?;
        let active_session = self.load_visible_active_tower_session(user_id).await;

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(TowerOverviewView {
                progress: TowerOverviewProgressView {
                    best_floor: progress.best_floor,
                    next_floor: progress.next_floor,
                    current_run_id: progress.current_run_id,
                    current_floor: progress.current_floor,
                    last_settled_floor: progress.last_settled_floor,
                },
                active_session,
                next_floor_preview,
            }),
        ))
    }

    async fn get_rank_list_impl(
        &self,
        limit: Option<i64>,
    ) -> Result<ServiceResultResponse<Vec<TowerRankRow>>, BusinessError> {
        let normalized_limit = clamp_rank_limit(limit);
        let rows = sqlx::query(
            r#"
            SELECT
              ROW_NUMBER() OVER (
                ORDER BY ctp.best_floor DESC, ctp.reached_at ASC NULLS FIRST, ctp.character_id ASC
              )::int AS rank,
              ctp.character_id,
              c.nickname,
              c.realm,
              c.sub_realm,
              ctp.best_floor,
              CASE
                WHEN ctp.reached_at IS NULL THEN NULL
                ELSE to_char(ctp.reached_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END AS reached_at
            FROM character_tower_progress ctp
            JOIN characters c ON c.id = ctp.character_id
            ORDER BY ctp.best_floor DESC, ctp.reached_at ASC NULLS FIRST, ctp.character_id ASC
            LIMIT $1
            "#,
        )
        .bind(normalized_limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut result = Vec::with_capacity(rows.len());
        for row in rows {
            let character_id = row.get::<i64, _>("character_id");
            let nickname = row.get::<String, _>("nickname");
            result.push(TowerRankRow {
                rank: row.get::<i32, _>("rank"),
                character_id,
                name: if nickname.trim().is_empty() {
                    format!("修士{character_id}")
                } else {
                    nickname
                },
                realm: normalize_realm_keeping_unknown(
                    row.try_get::<Option<String>, _>("realm").ok().flatten().as_deref(),
                    row.try_get::<Option<String>, _>("sub_realm").ok().flatten().as_deref(),
                ),
                best_floor: row.get::<i32, _>("best_floor"),
                reached_at: row.try_get::<Option<String>, _>("reached_at").ok().flatten(),
            });
        }

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(result),
        ))
    }

    async fn resolve_character_id_by_user_id(
        &self,
        user_id: i64,
    ) -> Result<Option<i64>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT id
            FROM characters
            WHERE user_id = $1
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(row.map(|value| value.get::<i64, _>("id")))
    }

    async fn load_tower_progress(
        &self,
        character_id: i64,
    ) -> Result<TowerProgressRecord, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              best_floor,
              next_floor,
              current_run_id,
              current_floor,
              last_settled_floor
            FROM character_tower_progress
            WHERE character_id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Ok(TowerProgressRecord {
                best_floor: 0,
                next_floor: 1,
                current_run_id: None,
                current_floor: None,
                last_settled_floor: 0,
            });
        };

        Ok(TowerProgressRecord {
            best_floor: row.get::<i32, _>("best_floor").max(0),
            next_floor: row.get::<i32, _>("next_floor").max(1),
            current_run_id: row.try_get::<Option<String>, _>("current_run_id").ok().flatten(),
            current_floor: row
                .try_get::<Option<i32>, _>("current_floor")
                .ok()
                .flatten()
                .map(|value| value.max(1)),
            last_settled_floor: row.get::<i32, _>("last_settled_floor").max(0),
        })
    }

    async fn load_visible_active_tower_session(
        &self,
        user_id: i64,
    ) -> Option<crate::runtime::session::BattleSessionSnapshotView> {
        let runtime_services = self.runtime_services.read().await;
        let session = runtime_services
            .session_registry
            .find_active_session_by_user_id(user_id)?;
        if session.session_type != "tower" {
            return None;
        }
        let battle_id = session.current_battle_id.as_deref()?;
        if runtime_services.battle_registry.get(battle_id).is_none() {
            return None;
        }

        Some(build_battle_session_snapshot_view(session))
    }

    async fn resolve_tower_floor_preview(
        &self,
        floor: i32,
    ) -> Result<TowerFloorPreviewView, BusinessError> {
        let normalized_floor = floor.max(1);
        let frontier = self.load_frozen_frontier().await?;
        if normalized_floor <= frontier.frozen_floor_max {
            let frozen_rows = self
                .load_frozen_monster_snapshots(frontier.frozen_floor_max)
                .await?;
            let pools = build_frozen_tower_monster_pools(&frozen_rows)?;
            return resolve_tower_floor_preview_from_pools(normalized_floor, &pools);
        }

        let pools = get_latest_tower_monster_pools()?;
        resolve_tower_floor_preview_from_pools(normalized_floor, pools)
    }

    async fn load_frozen_frontier(&self) -> Result<TowerFrozenFrontierRow, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT frozen_floor_max
            FROM tower_frozen_frontier
            WHERE scope = $1
            LIMIT 1
            "#,
        )
        .bind(TOWER_SCOPE)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        Ok(TowerFrozenFrontierRow {
            frozen_floor_max: row
                .map(|value| value.get::<i32, _>("frozen_floor_max").max(0))
                .unwrap_or(0),
        })
    }

    async fn load_frozen_monster_snapshots(
        &self,
        frozen_floor_max: i32,
    ) -> Result<Vec<TowerFrozenMonsterSnapshotRow>, BusinessError> {
        if frozen_floor_max <= 0 {
            return Ok(Vec::new());
        }

        let rows = sqlx::query(
            r#"
            SELECT
              frozen_floor_max,
              kind,
              realm,
              monster_def_id
            FROM tower_frozen_monster_snapshot
            WHERE frozen_floor_max = $1
            ORDER BY kind ASC, realm ASC, monster_def_id ASC
            "#,
        )
        .bind(frozen_floor_max)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        if rows.is_empty() {
            return Err(BusinessError::with_status(
                format!("千层塔冻结怪物池缺失: frozen_floor_max={frozen_floor_max}"),
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }

        Ok(rows
            .into_iter()
            .map(|row| TowerFrozenMonsterSnapshotRow {
                frozen_floor_max: row.get::<i32, _>("frozen_floor_max").max(0),
                kind: row.get::<String, _>("kind"),
                realm: row.get::<String, _>("realm"),
                monster_def_id: row.get::<String, _>("monster_def_id"),
            })
            .collect())
    }
}

impl TowerRouteServices for RustTowerRouteService {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<TowerOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_overview_impl(user_id).await })
    }

    fn get_rank_list<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<TowerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_rank_list_impl(limit).await })
    }
}

fn get_tower_monster_definitions() -> Result<&'static Vec<TowerMonsterDef>, BusinessError> {
    match TOWER_MONSTER_DEFINITIONS
        .get_or_init(|| load_tower_monster_definitions().map_err(|error| error.message))
    {
        Ok(definitions) => Ok(definitions),
        Err(message) => Err(BusinessError::with_status(
            message.clone(),
            StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

fn get_latest_tower_monster_pools() -> Result<&'static TowerMonsterPools, BusinessError> {
    match TOWER_LATEST_MONSTER_POOLS
        .get_or_init(|| build_latest_tower_monster_pools().map_err(|error| error.message))
    {
        Ok(pools) => Ok(pools),
        Err(message) => Err(BusinessError::with_status(
            message.clone(),
            StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

fn load_tower_monster_definitions() -> Result<Vec<TowerMonsterDef>, BusinessError> {
    let seed_file = read_seed_json::<TowerMonsterSeedFile>("monster_def.json")
        .map_err(internal_business_error)?;
    let mut monsters = Vec::new();
    for raw in seed_file.monsters {
        if raw.enabled == Some(false) {
            continue;
        }
        let id = raw.id.unwrap_or_default().trim().to_string();
        let name = raw.name.unwrap_or_default().trim().to_string();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        monsters.push(TowerMonsterDef {
            id,
            name,
            realm: normalize_tower_realm(raw.realm.as_deref()),
            kind: normalize_tower_floor_kind(raw.kind.as_deref()),
        });
    }
    if monsters.is_empty() {
        return Err(BusinessError::with_status(
            "千层塔缺少可用怪物定义",
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }
    monsters.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(monsters)
}

fn build_latest_tower_monster_pools() -> Result<TowerMonsterPools, BusinessError> {
    let definitions = get_tower_monster_definitions()?;
    Ok(group_tower_monster_pools(definitions))
}

fn build_frozen_tower_monster_pools(
    rows: &[TowerFrozenMonsterSnapshotRow],
) -> Result<TowerMonsterPools, BusinessError> {
    if rows.is_empty() {
        return Ok(TowerMonsterPools::default());
    }

    let definitions = get_tower_monster_definitions()?;
    let definition_index = definitions
        .iter()
        .cloned()
        .map(|monster| (monster.id.clone(), monster))
        .collect::<HashMap<_, _>>();
    let expected_frozen_floor_max = rows[0].frozen_floor_max;
    let mut pools = TowerMonsterPools::default();

    for row in rows {
        if row.frozen_floor_max != expected_frozen_floor_max {
            return Err(BusinessError::with_status(
                "千层塔冻结怪物快照前沿值不一致",
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
        let Some(base_monster) = definition_index.get(row.monster_def_id.trim()).cloned() else {
            return Err(BusinessError::with_status(
                format!("千层塔冻结怪物定义不存在: {}", row.monster_def_id.trim()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        };
        let monster = TowerMonsterDef {
            kind: normalize_tower_floor_kind(Some(row.kind.as_str())),
            realm: normalize_tower_realm(Some(row.realm.as_str())),
            ..base_monster
        };
        push_tower_monster(&mut pools, monster);
    }

    sort_tower_monster_pools(&mut pools);
    Ok(pools)
}

fn group_tower_monster_pools(definitions: &[TowerMonsterDef]) -> TowerMonsterPools {
    let mut pools = TowerMonsterPools::default();
    for monster in definitions.iter().cloned() {
        push_tower_monster(&mut pools, monster);
    }
    sort_tower_monster_pools(&mut pools);
    pools
}

fn push_tower_monster(pools: &mut TowerMonsterPools, monster: TowerMonsterDef) {
    let bucket = match monster.kind {
        TowerFloorKind::Normal => &mut pools.normal,
        TowerFloorKind::Elite => &mut pools.elite,
        TowerFloorKind::Boss => &mut pools.boss,
    };
    bucket.entry(monster.realm.clone()).or_default().push(monster);
}

fn sort_tower_monster_pools(pools: &mut TowerMonsterPools) {
    for bucket in [&mut pools.normal, &mut pools.elite, &mut pools.boss] {
        for monsters in bucket.values_mut() {
            monsters.sort_by(|left, right| left.id.cmp(&right.id));
        }
    }
}

fn resolve_tower_floor_preview_from_pools(
    floor: i32,
    pools: &TowerMonsterPools,
) -> Result<TowerFloorPreviewView, BusinessError> {
    let normalized_floor = floor.max(1);
    let kind = resolve_tower_floor_kind(normalized_floor);
    let seed = format!("tower:{normalized_floor}");
    let candidate_result = resolve_tower_monster_candidates_for_floor(normalized_floor, kind, pools)?;
    let preview_realm = match candidate_result.pool_mode {
        TowerPoolMode::Realm => candidate_result.realm.clone(),
        TowerPoolMode::Mixed => format!("{}·混池", candidate_result.realm),
    };
    let monster_count = resolve_tower_monster_count_for_floor(kind, normalized_floor, seed.as_str());
    let picked_monsters = pick_deterministic_items(
        format!("{seed}::monster").as_str(),
        &candidate_result.candidates,
        monster_count as usize,
    )?;

    Ok(TowerFloorPreviewView {
        floor: normalized_floor,
        kind: kind.as_str().to_string(),
        seed,
        realm: preview_realm,
        monster_ids: picked_monsters.iter().map(|monster| monster.id.clone()).collect(),
        monster_names: picked_monsters
            .iter()
            .map(|monster| monster.name.clone())
            .collect(),
    })
}

struct TowerMonsterCandidateResult<'a> {
    realm: String,
    pool_mode: TowerPoolMode,
    candidates: Vec<&'a TowerMonsterDef>,
}

fn resolve_tower_monster_candidates_for_floor<'a>(
    floor: i32,
    kind: TowerFloorKind,
    pools: &'a TowerMonsterPools,
) -> Result<TowerMonsterCandidateResult<'a>, BusinessError> {
    let bucket = tower_pool_bucket(pools, kind);
    let realms = REALM_ORDER
        .iter()
        .filter(|realm| bucket.contains_key(**realm))
        .map(|realm| (*realm).to_string())
        .collect::<Vec<_>>();
    if realms.is_empty() {
        return Err(BusinessError::with_status(
            format!("千层塔缺少 {} 境界怪物", kind.as_str()),
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    let cycle_index = ((floor.max(1) - 1) / TOWER_CYCLE_FLOORS).max(0) as usize;
    let realm_index = cycle_index.min(realms.len().saturating_sub(1));
    let overflow_tier_count = cycle_index.saturating_sub(realms.len().saturating_sub(1));
    let realm = realms[realm_index].clone();

    if overflow_tier_count > 0 {
        let candidates = REALM_ORDER
            .iter()
            .filter_map(|realm_name| bucket.get(*realm_name))
            .flat_map(|items| items.iter())
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Err(BusinessError::with_status(
                format!("千层塔缺少 {} 混池怪物", kind.as_str()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
        return Ok(TowerMonsterCandidateResult {
            realm,
            pool_mode: TowerPoolMode::Mixed,
            candidates,
        });
    }

    let Some(candidates) = bucket.get(realm.as_str()) else {
        return Err(BusinessError::with_status(
            format!(
                "千层塔楼层缺少怪物候选: floor={floor}, kind={}, realm={realm}",
                kind.as_str()
            ),
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
    };

    Ok(TowerMonsterCandidateResult {
        realm,
        pool_mode: TowerPoolMode::Realm,
        candidates: candidates.iter().collect(),
    })
}

fn resolve_tower_floor_kind(floor: i32) -> TowerFloorKind {
    if floor % 10 == 0 {
        return TowerFloorKind::Boss;
    }
    if floor % 5 == 0 {
        return TowerFloorKind::Elite;
    }
    TowerFloorKind::Normal
}

fn resolve_tower_monster_count_for_floor(
    kind: TowerFloorKind,
    floor: i32,
    seed: &str,
) -> i32 {
    match kind {
        TowerFloorKind::Boss => (TOWER_BOSS_MONSTER_COUNT_BASE
            + resolve_tower_monster_count_growth(floor, TOWER_BOSS_MONSTER_COUNT_INTERVAL))
            .min(TOWER_BOSS_MONSTER_COUNT_CAP),
        TowerFloorKind::Elite => (TOWER_ELITE_MONSTER_COUNT_BASE
            + resolve_tower_monster_count_growth(floor, TOWER_ELITE_MONSTER_COUNT_INTERVAL))
            .min(TOWER_ELITE_MONSTER_COUNT_CAP),
        TowerFloorKind::Normal => {
            let extra_count = pick_deterministic_index(seed, TOWER_NORMAL_MONSTER_COUNT_VARIANCE as usize, 0)
                .unwrap_or(0) as i32;
            (TOWER_NORMAL_MONSTER_COUNT_MIN
                + extra_count
                + resolve_tower_monster_count_growth(floor, TOWER_NORMAL_MONSTER_COUNT_INTERVAL))
                .min(TOWER_NORMAL_MONSTER_COUNT_CAP)
        }
    }
}

fn resolve_tower_monster_count_growth(floor: i32, interval: i32) -> i32 {
    (floor.max(1) / interval.max(1)).max(0)
}

fn tower_pool_bucket(
    pools: &TowerMonsterPools,
    kind: TowerFloorKind,
) -> &BTreeMap<String, Vec<TowerMonsterDef>> {
    match kind {
        TowerFloorKind::Normal => &pools.normal,
        TowerFloorKind::Elite => &pools.elite,
        TowerFloorKind::Boss => &pools.boss,
    }
}

fn pick_deterministic_items<'a>(
    seed: &str,
    items: &'a [&'a TowerMonsterDef],
    count: usize,
) -> Result<Vec<&'a TowerMonsterDef>, BusinessError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if items.is_empty() {
        return Err(BusinessError::with_status(
            "deterministic hash 缺少可选项",
            StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    let mut remaining = items.to_vec();
    let mut picked = Vec::with_capacity(count);

    while !remaining.is_empty() && picked.len() < count {
        let Some(index) = pick_deterministic_index(seed, remaining.len(), picked.len()) else {
            return Err(BusinessError::with_status(
                "deterministic hash 缺少可选长度",
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        };
        picked.push(remaining.remove(index));
    }

    while picked.len() < count {
        let Some(index) = pick_deterministic_index(seed, items.len(), picked.len()) else {
            return Err(BusinessError::with_status(
                "deterministic hash 缺少可选长度",
                StatusCode::INTERNAL_SERVER_ERROR,
            ));
        };
        picked.push(items[index]);
    }

    Ok(picked)
}

fn pick_deterministic_index(seed: &str, length: usize, offset: usize) -> Option<usize> {
    if length == 0 {
        return None;
    }
    Some(hash_text_u32(format!("pick-index::{seed}::{offset}").as_str()) as usize % length)
}

fn hash_text_u32(value: &str) -> u32 {
    let mut hash = FNV_OFFSET_BASIS;
    for code_unit in value.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn normalize_tower_realm(raw: Option<&str>) -> String {
    let normalized = normalize_realm_keeping_unknown(raw, None);
    if REALM_ORDER.contains(&normalized.as_str()) {
        normalized
    } else {
        "凡人".to_string()
    }
}

fn normalize_tower_floor_kind(raw: Option<&str>) -> TowerFloorKind {
    match raw.unwrap_or_default().trim() {
        "boss" => TowerFloorKind::Boss,
        "elite" => TowerFloorKind::Elite,
        _ => TowerFloorKind::Normal,
    }
}

fn clamp_rank_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(50).clamp(1, 100)
}

impl TowerFloorKind {
    fn as_str(self) -> &'static str {
        match self {
            TowerFloorKind::Normal => "normal",
            TowerFloorKind::Elite => "elite",
            TowerFloorKind::Boss => "boss",
        }
    }
}

impl Default for TowerMonsterPools {
    fn default() -> Self {
        Self {
            normal: BTreeMap::new(),
            elite: BTreeMap::new(),
            boss: BTreeMap::new(),
        }
    }
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
