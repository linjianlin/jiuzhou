/**
 * 任务静态索引缓存
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把静态任务定义预解析为 recurring 任务视图、原始 objectives 索引和归一化目标索引，供任务热路径直接复用。
 * 2. 做什么：以 `getStaticTaskDefinitions()` 的返回数组引用作为缓存失效条件，避免击杀/收集事件每次都重复扫描与重复归一化。
 * 3. 不做什么：不读写数据库，不执行任务匹配，也不缓存动态悬赏任务定义。
 *
 * 输入 / 输出：
 * - 输入：任务定义服务提供的静态任务定义数组。
 * - 输出：`TaskStaticIndex`，包含 recurring 任务列表、`taskId -> objectives` 索引与 `taskId -> normalizedObjectives` 索引。
 *
 * 数据流 / 状态流：
 * - 静态任务数组 -> 本模块预解析目标与目标上限
 * - -> `taskService.applyTaskEvents` 直接复用
 * - -> 静态配置热重载导致数组引用变化时才整体重建。
 *
 * 复用设计说明：
 * - recurring 命中筛选与任务进度推进原先都要各自读取 `objectives`，现在收敛到同一缓存模块，减少重复维护与重复遍历。
 * - 高频变化点是静态任务配置本身，因此把预解析前置到模块级最能同时服务击杀、收集、通关等多条链路。
 *
 * 关键边界条件与坑点：
 * 1. 缓存失效必须依赖源数组引用变化；如果每次 getter 都返回新数组，热路径缓存就会完全失效。
 * 2. 动态任务不能混入这里的缓存，否则悬赏任务刷新后会出现陈旧目标。
 */

import { getStaticTaskDefinitions, type TaskDefinition } from '../taskDefinitionService.js';
import type {
  RecurringTaskDefinitionLike,
  TaskObjectiveLike,
} from './taskRecurringEventMatcher.js';

export type NormalizedTaskObjective = {
  objective: TaskObjectiveLike;
  objectiveId: string;
  target: number;
};

export type TaskStaticIndex = {
  recurringTaskDefinitions: readonly RecurringTaskDefinitionLike[];
  objectivesByTaskId: ReadonlyMap<string, readonly TaskObjectiveLike[]>;
  normalizedObjectivesByTaskId: ReadonlyMap<string, readonly NormalizedTaskObjective[]>;
};

type TaskStaticIndexSnapshot = {
  source: readonly TaskDefinition[];
  index: TaskStaticIndex;
};

let taskStaticIndexSnapshot: TaskStaticIndexSnapshot | null = null;

const parseTaskObjectives = (objectives: TaskDefinition['objectives']): TaskObjectiveLike[] => {
  return Array.isArray(objectives) ? (objectives as TaskObjectiveLike[]) : [];
};

export const normalizeTaskObjectives = (
  objectives: readonly TaskObjectiveLike[],
): NormalizedTaskObjective[] => {
  return objectives
    .map((objective) => {
      const objectiveId = typeof objective.id === 'string' ? objective.id.trim() : '';
      if (!objectiveId) return null;
      const targetRaw = Number(objective.target);
      return {
        objective,
        objectiveId,
        target: Number.isFinite(targetRaw) && targetRaw > 0 ? Math.floor(targetRaw) : 1,
      };
    })
    .filter((objective): objective is NormalizedTaskObjective => objective !== null);
};

const buildTaskStaticIndex = (definitions: readonly TaskDefinition[]): TaskStaticIndex => {
  const recurringTaskDefinitions: RecurringTaskDefinitionLike[] = [];
  const objectivesByTaskId = new Map<string, readonly TaskObjectiveLike[]>();
  const normalizedObjectivesByTaskId = new Map<string, readonly NormalizedTaskObjective[]>();

  for (const definition of definitions) {
    const objectives = parseTaskObjectives(definition.objectives);
    recurringTaskDefinitions.push({
      id: definition.id,
      category: definition.category,
      realm: definition.realm,
      enabled: definition.enabled,
      objectives,
    });
    objectivesByTaskId.set(definition.id, objectives);
    normalizedObjectivesByTaskId.set(definition.id, normalizeTaskObjectives(objectives));
  }

  return {
    recurringTaskDefinitions,
    objectivesByTaskId,
    normalizedObjectivesByTaskId,
  };
};

export const getTaskStaticIndex = (): TaskStaticIndex => {
  const definitions = getStaticTaskDefinitions();
  if (taskStaticIndexSnapshot?.source === definitions) {
    return taskStaticIndexSnapshot.index;
  }

  const index = buildTaskStaticIndex(definitions);
  taskStaticIndexSnapshot = {
    source: definitions,
    index,
  };
  return index;
};

export const resetTaskStaticIndexCacheForTest = (): void => {
  taskStaticIndexSnapshot = null;
};
