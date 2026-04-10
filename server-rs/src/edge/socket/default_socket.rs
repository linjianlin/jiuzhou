use axum::Router;
use socketioxide::{extract::SocketRef, SocketIo};

/**
 * 作用：挂载默认 `/socket.io` 通道，保留现有双通道兼容边界。
 * 不做什么：不承接业务认证、不处理游戏事件，也不实现聊天/战斗推送。
 * 输入/输出：输入为已构建的 Axum Router，输出为附加默认 Socket.IO layer 后的 Router。
 * 数据流/状态流：HTTP Router -> 默认 Socket.IO layer -> 默认命名空间连接回调（当前仅保活，不写入业务状态）。
 * 复用设计说明：
 * 1. 默认通道和 `/game-socket` 分离挂载，避免后续游戏实时逻辑污染默认 Socket.IO 入口。
 * 2. `build_router` 统一调用此模块，保证所有测试与真实启动共用同一挂载路径。
 * 关键边界条件与坑点：
 * 1. 这里不能误用 `/game-socket` 路径，否则会破坏客户端既有连接地址。
 * 2. 当前默认通道只保留握手兼容，不能提前塞入未来业务事件，避免超出本任务范围。
 */
pub fn attach_default_socket_layer(router: Router) -> Router {
    let (layer, io) = SocketIo::new_layer();
    io.ns("/", on_default_connect);
    router.layer(layer)
}

async fn on_default_connect(_socket: SocketRef) {}
