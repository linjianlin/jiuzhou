/**
 * idleSessionActivity — 挂机会话活跃态判定工具
 *
 * 作用：
 *   统一封装“哪些 stopping 会话已经失去执行循环承接，应被视为孤儿”的判定规则，
 *   避免在 IdleSessionService、路由或其他业务模块里重复书写同一条状态判断。
 *   不负责数据库查询、不负责更新状态，只返回可供上层收敛的 sessionId 列表。
 *
 * 输入/输出：
 *   - 输入：最小会话视图（id / characterId / status）和执行循环心跳探针
 *   - 输出：应被收敛的孤儿 stopping 会话 ID 列表
 *
 * 数据流：
 *   DB 查询得到 stopping 会话最小视图 → resolveOrphanStoppingSessionIds
 *   → IdleSessionService 根据返回的 sessionId 批量更新为 interrupted
 *
 * 关键边界条件与坑点：
 *   1. 只处理 status='stopping' 的会话；active 会话即使暂无执行循环，也不在这里直接判死。
 *   2. 判定依据只依赖进程内执行循环心跳探针，保持纯函数，方便单测和复用。
 *   3. 已注册但心跳长期不推进的 stopping 会话，也视为失活，避免注册表残留导致状态永久卡住。
 *   3. 返回顺序与输入顺序一致，便于上层在日志或批处理时保留原始遍历顺序。
 *   4. 本模块不做去重；调用方若传入重复 sessionId，会按输入重复返回。
 */

/**
 * stopping 会话允许的最大静默心跳时长。
 *
 * 设计原因：
 * 1. Worker 任务默认 30s 超时，这里额外预留 15s 作为调度与 flush 缓冲，避免正常收尾被误判。
 * 2. 仅用于 stopping 自愈，不参与 active 会话判死，因此阈值只需要覆盖“停止请求后仍应快速结束”的路径。
 */
export const IDLE_STOPPING_STALE_HEARTBEAT_MS = 45_000;

export interface IdleSessionActivitySnapshot {
  id: string;
  characterId: number;
  status: 'active' | 'stopping' | 'completed' | 'interrupted';
}

/**
 * 识别“已进入 stopping，但当前没有任何执行循环承接”的孤儿会话。
 *
 * 复用点：
 *   - IdleSessionService 在状态查询、启动互斥、组队互斥前调用
 *   - 单测直接验证该纯函数，避免把数据库和 Redis 依赖带入测试
 *
 * 为什么这样设计能减少重复：
 *   把孤儿判定从 Service 的数据库逻辑中剥离后，所有需要识别 stopping 孤儿的入口
 *   都只复用这一处纯函数，不再散落重复的状态判断和执行循环探针调用。
 */
export function resolveOrphanStoppingSessionIds(
  sessions: IdleSessionActivitySnapshot[],
  getExecutionLoopHeartbeatAt: (sessionId: string) => number | null,
  now: number = Date.now(),
): string[] {
  const orphanSessionIds: string[] = [];

  for (const session of sessions) {
    if (session.status !== 'stopping') {
      continue;
    }

    const heartbeatAt = getExecutionLoopHeartbeatAt(session.id);
    if (heartbeatAt === null) {
      orphanSessionIds.push(session.id);
      continue;
    }

    if (now - heartbeatAt > IDLE_STOPPING_STALE_HEARTBEAT_MS) {
      orphanSessionIds.push(session.id);
    }
  }

  return orphanSessionIds;
}
