/**
 * 挂机历史保留策略常量
 *
 * 作用：
 *   统一管理离线挂机历史的“已结束会话”保留口径，避免查询接口、定时清理、日志说明各写一份常量后发生漂移。
 *   不负责执行删除，不负责调度，也不处理活跃会话状态流。
 *
 * 输入 / 输出：
 *   - 输入：无，纯常量模块。
 *   - 输出：导出历史保留条数与可清理的已结束状态集合。
 *
 * 数据流 / 状态流：
 *   idleSessionService / idleBattleBatchCleanupService / cleanupWorker
 *   -> 读取统一常量 -> 执行查询或输出说明。
 *
 * 复用设计说明：
 *   “历史保留条数”同时影响历史列表查询与后台清理；集中在这里可以保证服务端口径一致，避免一个地方保留 3 条、另一个地方仍按 30 条处理。
 *   已结束状态集合也在这里统一，减少 completed/interrupted 条件在多个 SQL 中重复散落。
 *
 * 关键边界条件与坑点：
 *   1. 仅对 completed / interrupted 生效，active / stopping 会话绝不能进入历史裁剪集合。
 *   2. 这里定义的是“会话级历史”而不是“批次级历史”；批次删除依赖 idle_sessions 的级联删除完成。
 */

export const IDLE_HISTORY_KEEP_SESSION_COUNT = 3;

export const IDLE_FINISHED_SESSION_STATUSES = ['completed', 'interrupted'] as const;
