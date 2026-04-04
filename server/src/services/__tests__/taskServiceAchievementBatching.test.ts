/**
 * 任务服务战斗成就批量推进回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定怪物击杀与秘境通关事件会把同一角色的多条成就 trackKey 合并成一次批量推进，避免延迟结算链路反复进入成就热路径。
 * 2. 做什么：覆盖普通秘境与噩梦秘境两种口径，确保通关、难度与组队成就仍能一次性完整推进。
 * 3. 不做什么：不校验任务定义命中细节，不触达真实数据库，也不验证前端推送内容。
 *
 * 输入/输出：
 * - 输入：对 `query`、静态配置、主线推进与成就批量入口的 mock。
 * - 输出：`updateAchievementProgressBatch` 的调用参数。
 *
 * 数据流/状态流：
 * - 事件入口 -> 轻量 mock 的任务链路前置步骤
 * - -> 成就批量入口
 * - -> 断言同一角色所有 trackKey 在单次调用内完成。
 *
 * 关键边界条件与坑点：
 * 1. `taskService` 内部会先读取角色境界与任务进度；测试必须补齐最小数据库返回，避免被无关链路干扰。
 * 2. 这里显式让任务进度查询为空，确保断言焦点只落在成就批量推进，而不是任务状态更新。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as achievementProgress from '../achievement/progress.js';
import * as mainQuestService from '../mainQuest/index.js';
import * as staticConfigLoader from '../staticConfigLoader.js';
import * as taskDefinitionService from '../taskDefinitionService.js';
import * as taskOverviewPush from '../taskOverviewPush.js';
import {
  recordDungeonClearEvent,
  recordCollectItemEvents,
  recordKillMonsterEvents,
} from '../taskService.js';

test('recordKillMonsterEvents: 应把多种怪物成就推进合并成一次批量更新', async (t) => {
  const achievementBatchCalls: Array<Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]> = [];

  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM characters')) {
      return {
        rows: [
          {
            realm: '炼气期',
            sub_realm: '初期',
          },
        ],
      };
    }
    if (sql.includes('FROM character_task_progress p')) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(taskDefinitionService, 'getStaticTaskDefinitions', () => []);
  t.mock.method(taskDefinitionService, 'getTaskDefinitionsByIds', async () => new Map());
  t.mock.method(mainQuestService, 'updateSectionProgressBatch', async () => undefined);
  t.mock.method(taskOverviewPush, 'notifyTaskOverviewUpdate', async () => undefined);
  t.mock.method(
    achievementProgress,
    'updateAchievementProgressBatch',
    async (inputs: Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]) => {
      achievementBatchCalls.push(inputs);
    },
  );

  await recordKillMonsterEvents(1001, [
    { monsterId: 'wolf-a', count: 2 },
    { monsterId: 'wolf-b', count: 3 },
  ]);

  assert.equal(achievementBatchCalls.length, 1);
  assert.deepEqual(achievementBatchCalls[0], [
    {
      characterId: 1001,
      trackKey: 'kill:monster:wolf-a',
      increment: 2,
    },
    {
      characterId: 1001,
      trackKey: 'kill:monster:wolf-b',
      increment: 3,
    },
  ]);
});

test('recordKillMonsterEvents: 应把任务推进链路收敛为一次角色读取与一次批量写回', async (t) => {
  let characterRealmQueryCount = 0;
  let taskProgressQueryCount = 0;
  let taskProgressUpdateCount = 0;

  const recurringTaskDefs = [
    {
      id: 'daily-kill-wolf-a',
      category: 'daily',
      realm: '炼气期',
      enabled: true,
      objectives: [
        {
          id: 'kill-wolf-a',
          type: 'kill_monster',
          target: 2,
          params: { monster_id: 'wolf-a' },
        },
      ],
    },
    {
      id: 'daily-kill-wolf-b',
      category: 'daily',
      realm: '炼气期',
      enabled: true,
      objectives: [
        {
          id: 'kill-wolf-b',
          type: 'kill_monster',
          target: 3,
          params: { monster_id: 'wolf-b' },
        },
      ],
    },
  ] as ReturnType<typeof taskDefinitionService.getStaticTaskDefinitions>;

  t.mock.method(database, 'query', async (...args: Parameters<typeof database.query>) => {
    const [sql] = args;
    if (sql.includes('FROM characters')) {
      characterRealmQueryCount += 1;
      return {
        rows: [
          {
            realm: '炼气期',
            sub_realm: '初期',
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO character_task_progress')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM character_task_progress p')) {
      taskProgressQueryCount += 1;
      return {
        rows: [
          {
            task_id: 'daily-kill-wolf-a',
            status: 'ongoing',
            progress: {},
          },
          {
            task_id: 'daily-kill-wolf-b',
            status: 'ongoing',
            progress: {},
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes('jsonb_to_recordset($2::jsonb)')) {
      taskProgressUpdateCount += 1;
      return { rows: [], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(taskDefinitionService, 'getStaticTaskDefinitions', () => recurringTaskDefs);
  t.mock.method(
    taskDefinitionService,
    'getTaskDefinitionsByIds',
    async () => new Map(recurringTaskDefs.map((taskDef) => [taskDef.id, taskDef])),
  );
  t.mock.method(mainQuestService, 'updateSectionProgressBatch', async () => undefined);
  t.mock.method(taskOverviewPush, 'notifyTaskOverviewUpdate', async () => undefined);
  t.mock.method(achievementProgress, 'updateAchievementProgressBatch', async () => undefined);

  await recordKillMonsterEvents(1001, [
    { monsterId: 'wolf-a', count: 2 },
    { monsterId: 'wolf-b', count: 3 },
  ]);

  assert.equal(characterRealmQueryCount, 1);
  assert.equal(taskProgressQueryCount, 1);
  assert.equal(taskProgressUpdateCount, 1);
});

test('recordCollectItemEvents: 应按 itemId 聚合后批量推进主线与成就', async (t) => {
  const sectionBatchCalls: Array<Parameters<typeof mainQuestService.updateSectionProgressBatch>[1]> = [];
  const achievementBatchCalls: Array<Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]> = [];

  t.mock.method(
    mainQuestService,
    'updateSectionProgressBatch',
    async (_characterId: number, events: Parameters<typeof mainQuestService.updateSectionProgressBatch>[1]) => {
      sectionBatchCalls.push(events);
    },
  );
  t.mock.method(
    achievementProgress,
    'updateAchievementProgressBatch',
    async (inputs: Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]) => {
      achievementBatchCalls.push(inputs);
    },
  );

  await recordCollectItemEvents(1001, [
    { itemId: 'herb-a', count: 1 },
    { itemId: 'herb-a', count: 2 },
    { itemId: 'ore-b', count: 3 },
  ]);

  assert.deepEqual(sectionBatchCalls, [[
    {
      type: 'collect',
      itemId: 'herb-a',
      count: 3,
    },
    {
      type: 'collect',
      itemId: 'ore-b',
      count: 3,
    },
  ]]);
  assert.deepEqual(achievementBatchCalls, [[
    {
      characterId: 1001,
      trackKey: 'item:obtain:herb-a',
      increment: 3,
    },
    {
      characterId: 1001,
      trackKey: 'item:obtain:ore-b',
      increment: 3,
    },
  ]]);
});

test('recordDungeonClearEvent: 应把秘境相关成就推进合并成一次批量更新', async (t) => {
  const achievementBatchCalls: Array<Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]> = [];

  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM characters')) {
      return {
        rows: [
          {
            realm: '炼气期',
            sub_realm: '初期',
          },
        ],
      };
    }
    if (sql.includes('FROM character_task_progress p')) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(taskDefinitionService, 'getStaticTaskDefinitions', () => []);
  t.mock.method(staticConfigLoader, 'getDungeonDifficultyById', () => ({
    name: '噩梦',
  }) as ReturnType<typeof staticConfigLoader.getDungeonDifficultyById>);
  t.mock.method(taskDefinitionService, 'getTaskDefinitionsByIds', async () => new Map());
  t.mock.method(mainQuestService, 'updateSectionProgress', async () => undefined);
  t.mock.method(taskOverviewPush, 'notifyTaskOverviewUpdate', async () => undefined);
  t.mock.method(
    achievementProgress,
    'updateAchievementProgressBatch',
    async (inputs: Parameters<typeof achievementProgress.updateAchievementProgressBatch>[0]) => {
      achievementBatchCalls.push(inputs);
    },
  );

  await recordDungeonClearEvent(
    1001,
    'dungeon-test',
    1,
    2,
    'difficulty-nightmare',
  );

  assert.equal(achievementBatchCalls.length, 1);
  assert.deepEqual(achievementBatchCalls[0], [
    {
      characterId: 1001,
      trackKey: 'dungeon:clear:dungeon-test',
      increment: 1,
    },
    {
      characterId: 1001,
      trackKey: 'dungeon:clear:difficulty:nightmare',
      increment: 1,
    },
    {
      characterId: 1001,
      trackKey: 'team:dungeon:clear:dungeon-test',
      increment: 1,
    },
  ]);
});
