/**
 * 任务静态索引缓存回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定相同静态任务定义数组引用下会复用同一份预解析索引，避免任务热路径重复扫描与重复归一化目标。
 * 2. 做什么：锁定静态任务定义数组引用变化后会触发索引重建，避免配置热重载后继续命中旧缓存。
 * 3. 不做什么：不验证任务事件匹配结果，也不触达数据库与任务进度落库逻辑。
 *
 * 输入/输出：
 * - 输入：mock 后的 `getStaticTaskDefinitions` 返回值。
 * - 输出：`getTaskStaticIndex` 的缓存命中与失效结果。
 *
 * 数据流/状态流：
 * - 静态任务定义数组 -> 索引 getter -> 任务预解析结果
 * - 同引用重复读取命中缓存
 * - 新引用再次读取触发重建。
 *
 * 关键边界条件与坑点：
 * 1. 缓存必须按“数组引用”而不是内容深比较失效，否则热重载场景会退化为高成本深比较。
 * 2. recurring 任务索引与 objective 归一化结果必须绑定同一批源定义，不能只更新其中一部分。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskDefinition } from '../taskDefinitionService.js';
import * as taskDefinitionService from '../taskDefinitionService.js';
import {
  getTaskStaticIndex,
  resetTaskStaticIndexCacheForTest,
} from '../shared/taskStaticIndex.js';

const createTaskDefinition = (overrides: Partial<TaskDefinition>): TaskDefinition => ({
  id: 'task-static-001',
  category: 'daily',
  title: '静态任务',
  realm: '炼气期',
  description: '',
  giver_npc_id: null,
  map_id: null,
  room_id: null,
  objectives: [],
  rewards: [],
  prereq_task_ids: [],
  enabled: true,
  sort_weight: 0,
  version: 1,
  source: 'static',
  ...overrides,
});

test('getTaskStaticIndex: 应在相同静态任务数组引用下复用缓存，并在引用变化后重建', (t) => {
  const firstDefinitions: TaskDefinition[] = [
    createTaskDefinition({
      id: 'task-kill-wolf',
      objectives: [
        {
          id: 'obj-kill-wolf',
          type: 'kill_monster',
          target: 2,
          params: { monster_id: 'wolf-a' },
        },
      ],
    }),
  ];
  let currentDefinitions = firstDefinitions;

  t.mock.method(taskDefinitionService, 'getStaticTaskDefinitions', () => currentDefinitions);
  resetTaskStaticIndexCacheForTest();

  const firstIndex = getTaskStaticIndex();
  const secondIndex = getTaskStaticIndex();

  assert.equal(firstIndex, secondIndex);
  assert.equal(firstIndex.recurringTaskDefinitions, secondIndex.recurringTaskDefinitions);
  assert.equal(
    firstIndex.normalizedObjectivesByTaskId.get('task-kill-wolf'),
    secondIndex.normalizedObjectivesByTaskId.get('task-kill-wolf'),
  );

  currentDefinitions = [
    createTaskDefinition({
      id: 'task-kill-wolf',
      objectives: [
        {
          id: 'obj-kill-wolf',
          type: 'kill_monster',
          target: 3,
          params: { monster_id: 'wolf-b' },
        },
      ],
    }),
  ];

  const rebuiltIndex = getTaskStaticIndex();

  assert.notEqual(firstIndex, rebuiltIndex);
  assert.notEqual(firstIndex.recurringTaskDefinitions, rebuiltIndex.recurringTaskDefinitions);
  assert.notEqual(
    firstIndex.normalizedObjectivesByTaskId.get('task-kill-wolf'),
    rebuiltIndex.normalizedObjectivesByTaskId.get('task-kill-wolf'),
  );
});
