/**
 * idleExecutionRegistry — 挂机执行循环注册表
 *
 * 作用：
 *   集中维护“某个挂机会话当前是否仍被执行器承接”的运行态信息，
 *   供 Worker/普通执行器注册与注销，供 IdleSessionService 判定 stopping 会话是否已沦为孤儿。
 *   不负责调度 setTimeout、不负责数据库收尾，也不直接触发停止逻辑。
 *
 * 输入/输出：
 *   - registerIdleExecutionLoop(sessionId): 标记会话已被执行器承接
 *   - touchIdleExecutionLoop(sessionId): 更新会话最近一次运行心跳
 *   - unregisterIdleExecutionLoop(sessionId): 标记会话已退出执行器
 *   - hasRegisteredIdleExecutionLoop(sessionId): 查询会话是否仍在执行中
 *   - getIdleExecutionLoopHeartbeatAt(sessionId): 读取最近一次心跳时间戳
 *
 * 数据流：
 *   执行器 startExecutionLoop → register
 *   执行器 finalize/stop/shutdown → unregister
 *   IdleSessionService 查询 stopping 会话 → hasRegisteredIdleExecutionLoop
 *   → 决定是否把孤儿 stopping 会话收敛为 interrupted
 *
 * 关键边界条件与坑点：
 *   1. 这里只记录“进程内是否存在执行循环”，不表示数据库状态一定仍为 active。
 *   2. 最近心跳只表示“执行循环最近仍有推进”，不代表批次一定已落库；真正的状态收敛仍由 Service 决定。
 *   3. 服务重启后注册表天然为空，因此 stopping 会话必须由恢复逻辑重新注册，或由服务层收敛为最终态。
 *   4. 只存 sessionId，避免把调度器实现细节泄漏给 Service 层，减少循环依赖。
 */

const idleExecutionLoopHeartbeatBySessionId = new Map<string, number>();

/** 标记某个挂机会话已被执行循环承接。 */
export function registerIdleExecutionLoop(sessionId: string): void {
  idleExecutionLoopHeartbeatBySessionId.set(sessionId, Date.now());
}

/** 更新某个挂机会话的最近运行心跳。 */
export function touchIdleExecutionLoop(sessionId: string): void {
  if (!idleExecutionLoopHeartbeatBySessionId.has(sessionId)) {
    return;
  }
  idleExecutionLoopHeartbeatBySessionId.set(sessionId, Date.now());
}

/** 标记某个挂机会话已退出执行循环。 */
export function unregisterIdleExecutionLoop(sessionId: string): void {
  idleExecutionLoopHeartbeatBySessionId.delete(sessionId);
}

/** 查询某个挂机会话当前是否仍被执行循环承接。 */
export function hasRegisteredIdleExecutionLoop(sessionId: string): boolean {
  return idleExecutionLoopHeartbeatBySessionId.has(sessionId);
}

/** 读取某个挂机会话的最近运行心跳时间戳。 */
export function getIdleExecutionLoopHeartbeatAt(sessionId: string): number | null {
  return idleExecutionLoopHeartbeatBySessionId.get(sessionId) ?? null;
}

/** 清空执行循环注册表（用于进程级停机或测试收尾）。 */
export function clearIdleExecutionLoopRegistry(): void {
  idleExecutionLoopHeartbeatBySessionId.clear();
}
