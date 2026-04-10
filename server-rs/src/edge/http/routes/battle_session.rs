use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::domain::battle::types::BattleRealtimeStateSnapshot;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};
use crate::runtime::battle::BattleRuntime;
use crate::runtime::session::{build_battle_session_snapshot_view, BattleSessionSnapshotView};

/**
 * battle-session 只读 HTTP 路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/battle-session/current`、`/api/battle-session/:sessionId`、`/api/battle-session/by-battle/:battleId` 三条只读接口，保持 `requireAuth + sendResult/sendSuccess` 的包体语义一致。
 * 2. 做什么：直接复用已恢复的 battle/session runtime 索引与 battle 状态快照，避免每次查询都重新扫描全部会话或重复拼 `state/finished` 字段。
 * 3. 不做什么：不在这里启动战斗、不推进会话，也不新增 projection/Redis 回填逻辑。
 *
 * 输入 / 输出：
 * - 输入：`Authorization: Bearer <token>`，以及 `sessionId` / `battleId` 路径参数。
 * - 输出：`{ success:true, data:{ session, state?, finished? } }` 或 `{ success:true, data:{ session:null } }`，失败走 `400 { success:false, message }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> Bearer 鉴权 -> 共享 runtime 索引读取 session -> 若存在 `currentBattleId` 则复用 battle runtime 构建 `state` -> 返回 Node 兼容数据。
 *
 * 复用设计说明：
 * - “按 battleId 查 session”、“按 userId 找当前活跃 session”和“对外快照裁剪”都复用 `runtime/session` 的统一索引与 view builder，避免路由层各自扫描、各自手写字段裁剪。
 * - `BattleSessionDetailData` 与 `CurrentBattleSessionData` 只承载 HTTP 合同，不反向污染 runtime struct；后续补 `/start`、`/advance` 时仍可继续复用同一份 detail builder。
 *
 * 关键边界条件与坑点：
 * 1. `current` 无活跃会话时必须返回 `200 + { session: null }`，不能擅自改成 404/400。
 * 2. `:sessionId` 缺失或无权访问要复用 Node 的统一文案 `战斗会话不存在或无权访问`；`by-battle` 缺失则固定 `战斗会话不存在`，两者不能混用。
 */

#[derive(Debug, Clone, Serialize, PartialEq)]
struct CurrentBattleSessionData {
    session: Option<BattleSessionSnapshotView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BattleSessionDetailData {
    session: BattleSessionSnapshotView,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<BattleRealtimeStateSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished: Option<bool>,
}

pub fn build_battle_session_router() -> Router<AppState> {
    Router::new()
        .route("/current", get(current_battle_session_handler))
        .route(
            "/by-battle/{battleId}",
            get(battle_session_by_battle_id_handler),
        )
        .route("/{sessionId}", get(battle_session_detail_handler))
}

async fn current_battle_session_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };

    let runtime_services = state.runtime_services.read().await;
    let Some(session) = runtime_services
        .session_registry
        .find_active_session_by_user_id(user_id)
    else {
        return success(CurrentBattleSessionData { session: None });
    };

    success(build_detail_data(
        session,
        &runtime_services.battle_registry,
    ))
}

async fn battle_session_detail_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };

    let runtime_services = state.runtime_services.read().await;
    let Some(session) = runtime_services.session_registry.get(&session_id) else {
        return battle_session_access_denied_response();
    };
    if !session.user_ids().contains(&user_id) {
        return battle_session_access_denied_response();
    }

    success(build_detail_data(
        session,
        &runtime_services.battle_registry,
    ))
}

async fn battle_session_by_battle_id_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(battle_id): Path<String>,
) -> Response {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };

    let runtime_services = state.runtime_services.read().await;
    let Some(session) = runtime_services
        .session_registry
        .find_session_by_battle_id(&battle_id)
    else {
        return battle_session_not_found_response();
    };
    if !session.user_ids().contains(&user_id) {
        return battle_session_access_denied_response();
    }

    success(build_detail_data(
        session,
        &runtime_services.battle_registry,
    ))
}

fn build_detail_data(
    session: &crate::runtime::session::projection::OnlineBattleSessionSnapshotRedis,
    battle_registry: &crate::runtime::battle::BattleRuntimeRegistry,
) -> BattleSessionDetailData {
    let state = session
        .current_battle_id
        .as_deref()
        .and_then(|battle_id| battle_registry.get(battle_id))
        .map(build_battle_state_snapshot);
    BattleSessionDetailData {
        session: build_battle_session_snapshot_view(session),
        state,
        finished: Some(session.status != "running"),
    }
}

fn build_battle_state_snapshot(runtime: &BattleRuntime) -> BattleRealtimeStateSnapshot {
    crate::domain::battle::types::build_realtime_state(runtime)
}

fn battle_session_not_found_response() -> Response {
    service_result(ServiceResultResponse::<()>::new(
        false,
        Some("战斗会话不存在".to_string()),
        None,
    ))
}

fn battle_session_access_denied_response() -> Response {
    service_result(ServiceResultResponse::<()>::new(
        false,
        Some("战斗会话不存在或无权访问".to_string()),
        None,
    ))
}
