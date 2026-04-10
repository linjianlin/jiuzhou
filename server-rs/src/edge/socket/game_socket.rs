use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::Router;
use serde::Serialize;
use socketioxide::extract::{Data, SocketRef, State};
use socketioxide::socket::DisconnectReason;
use socketioxide::SocketIo;

use crate::bootstrap::app::AppState;
use crate::edge::socket::events::{
    GAME_AUTH_EVENT, GAME_AUTH_READY_EVENT, GAME_ERROR_EVENT, GAME_KICKED_EVENT, GAME_SOCKET_PATH,
};
use crate::runtime::connection::session_registry::{RealtimeSession, SharedSessionRegistry};

const AUTH_FAILED_MESSAGE: &str = "认证失败";
const SESSION_KICKED_MESSAGE: &str = "账号已在其他设备登录";
const SERVER_ERROR_MESSAGE: &str = "服务器错误";

/**
 * 作用：提供 `/game-socket` 的最小认证骨架，只覆盖 token/session 校验、session registry 写入、房间加入、旧连接踢下线与 `game:auth-ready`。
 * 不做什么：不发送 battle/idle/chat 运行时数据，也不承接完整角色全量同步。
 * 输入/输出：输入为 Socket.IO `game:auth(token)` 事件与共享认证/会话状态；输出为 `game:error`、`game:kicked`、`game:auth-ready` 以及对应房间加入动作。
 * 数据流/状态流：客户端发 `game:auth` -> 认证服务复用既有 token/session 校验链 -> session registry 更新并计算房间 -> 如有旧连接则旧连接收到 `game:kicked` 并断开 -> 新连接加入房间 -> 发 `game:auth-ready`。
 * 复用设计说明：
 * 1. `GameSocketConnectionManager` 把认证编排和 socketioxide 传输适配分开，测试可直接验证业务时序而不依赖真实网络连接。
 * 2. 房间名完全复用 `events.rs` 与 `session_registry.rs`，避免 `/game-socket` 和后续 battle/idle 推送各自维护一套命名。
 * 关键边界条件与坑点：
 * 1. session 失效必须走 `game:kicked`，不能错误地降级成 `game:error`，否则会破坏前端单点登录语义。
 * 2. 旧连接的 registry 映射要先由 `SessionRegistry::insert` 原子替换，再触发旧 socket 断开，避免短窗口内两个 socket 同时占用同一 user 映射。
 */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameSocketAuthProfile {
    pub user_id: i64,
    pub session_token: String,
    pub character_id: Option<i64>,
    pub team_id: Option<String>,
    pub sect_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameSocketAuthFailure {
    pub event: &'static str,
    pub message: String,
    pub disconnect_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameSocketAuthOutcome {
    Rejected {
        event: &'static str,
        message: String,
        disconnect_current: bool,
    },
    Authenticated {
        ready_event: &'static str,
        replaced_socket_id: Option<String>,
        joined_rooms: Vec<String>,
    },
}

pub trait GameSocketAuthServices: Send + Sync {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    >;
}

#[derive(Clone)]
pub struct GameSocketConnectionManager {
    auth_services: Arc<dyn GameSocketAuthServices>,
    session_registry: SharedSessionRegistry,
}

impl GameSocketConnectionManager {
    pub fn new(
        auth_services: Arc<dyn GameSocketAuthServices>,
        session_registry: SharedSessionRegistry,
    ) -> Self {
        Self {
            auth_services,
            session_registry,
        }
    }

    pub async fn authenticate(&self, socket_id: &str, token: &str) -> GameSocketAuthOutcome {
        let profile = match self.auth_services.resolve_game_socket_auth(token).await {
            Ok(profile) => profile,
            Err(failure) => {
                return GameSocketAuthOutcome::Rejected {
                    event: failure.event,
                    message: failure.message,
                    disconnect_current: failure.disconnect_current,
                };
            }
        };

        let session = RealtimeSession {
            socket_id: socket_id.to_string(),
            user_id: profile.user_id,
            session_token: profile.session_token,
            character_id: profile.character_id,
            team_id: profile.team_id,
            sect_id: profile.sect_id,
            last_update_ms: current_timestamp_ms(),
        };
        let insert_result = self.session_registry.lock().await.insert(session);

        GameSocketAuthOutcome::Authenticated {
            ready_event: GAME_AUTH_READY_EVENT,
            replaced_socket_id: insert_result.replaced_socket_id,
            joined_rooms: insert_result.joined_rooms,
        }
    }

    pub async fn remove_socket(&self, socket_id: &str) {
        let _ = self.session_registry.lock().await.remove(socket_id);
    }
}

#[derive(Clone)]
struct GameSocketRuntime {
    manager: GameSocketConnectionManager,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct MessagePayload {
    message: String,
}

pub fn attach_game_socket_layer(router: Router, state: &AppState) -> Router {
    let runtime = GameSocketRuntime {
        manager: GameSocketConnectionManager::new(
            state.game_socket_services.clone(),
            state.session_registry.clone(),
        ),
    };
    let (layer, io) = SocketIo::builder()
        .req_path(GAME_SOCKET_PATH)
        .with_state(runtime)
        .build_layer();
    io.ns("/", on_game_socket_connect);
    router.layer(layer)
}

async fn on_game_socket_connect(socket: SocketRef, State(runtime): State<GameSocketRuntime>) {
    let auth_runtime = runtime.clone();
    socket.on(
        GAME_AUTH_EVENT,
        move |socket: SocketRef, Data(token): Data<String>| {
            let runtime = auth_runtime.clone();
            async move {
                match runtime
                    .manager
                    .authenticate(&socket.id.to_string(), token.trim())
                    .await
                {
                    GameSocketAuthOutcome::Rejected {
                        event,
                        message,
                        disconnect_current,
                    } => {
                        socket.emit(event, &MessagePayload { message }).ok();
                        if disconnect_current {
                            socket.disconnect().ok();
                        }
                    }
                    GameSocketAuthOutcome::Authenticated {
                        ready_event,
                        replaced_socket_id,
                        joined_rooms,
                    } => {
                        for room in joined_rooms {
                            socket.join(room);
                        }
                        if let Some(previous_socket_id) = replaced_socket_id {
                            kick_previous_socket(&socket, &previous_socket_id).await;
                        }
                        socket.emit(ready_event, &()).ok();
                    }
                }
            }
        },
    );

    let disconnect_runtime = runtime.clone();
    socket.on_disconnect(move |socket: SocketRef, _reason: DisconnectReason| {
        let runtime = disconnect_runtime.clone();
        async move {
            runtime.manager.remove_socket(&socket.id.to_string()).await;
        }
    });
}

async fn kick_previous_socket(current_socket: &SocketRef, previous_socket_id: &str) {
    let previous_socket_room = previous_socket_id.to_string();
    current_socket
        .to(previous_socket_room.clone())
        .emit(
            GAME_KICKED_EVENT,
            &MessagePayload {
                message: SESSION_KICKED_MESSAGE.to_string(),
            },
        )
        .await
        .ok();
    current_socket
        .to(previous_socket_room)
        .disconnect()
        .await
        .ok();
}

pub fn auth_failed_failure() -> GameSocketAuthFailure {
    GameSocketAuthFailure {
        event: GAME_ERROR_EVENT,
        message: AUTH_FAILED_MESSAGE.to_string(),
        disconnect_current: false,
    }
}

pub fn kicked_failure() -> GameSocketAuthFailure {
    GameSocketAuthFailure {
        event: GAME_KICKED_EVENT,
        message: SESSION_KICKED_MESSAGE.to_string(),
        disconnect_current: true,
    }
}

pub fn server_error_failure() -> GameSocketAuthFailure {
    GameSocketAuthFailure {
        event: GAME_ERROR_EVENT,
        message: SERVER_ERROR_MESSAGE.to_string(),
        disconnect_current: false,
    }
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
