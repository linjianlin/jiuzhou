import type { TaskOverviewRowDto, TaskStatus } from '../../../services/api';

/**
 * 作用：统一计算“任务入口红点/红数字”使用的可完成任务数量，避免页面和弹窗各自维护一套状态判断。
 * 不做什么：不请求接口、不处理 UI 展示，只负责基于任务列表进行纯计算。
 * 输入/输出：输入为任务总览数组 `TaskOverviewRowDto[]`，输出为可完成任务数量 `number`。
 * 数据流：服务端任务总览 -> 本函数按状态过滤 -> `Game` 页右侧功能菜单 badge 数字。
 *
 * 边界条件与坑点：
 * 1) 仅 `turnin` 与 `claimable` 视为“可完成”，`ongoing/completed` 都不计入，避免把进行中任务误提示为可完成。
 * 2) 异常数据（如 tasks 为空）返回 0，保证菜单 badge 逻辑稳定且可预测。
 */
const TASK_COMPLETABLE_STATUS: ReadonlySet<TaskStatus> = new Set(['turnin', 'claimable']);

export const countCompletableTasks = (tasks: TaskOverviewRowDto[]): number => {
  return tasks.reduce((total, task) => (TASK_COMPLETABLE_STATUS.has(task.status) ? total + 1 : total), 0);
};

