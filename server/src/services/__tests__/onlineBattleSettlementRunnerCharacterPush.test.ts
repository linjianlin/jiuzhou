/**
 * 在线战斗延迟结算后的角色刷新回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定延迟结算任务真实发奖完成后，会再次推送 `game:character` 刷新，避免前端长期停留在旧经验。
 * 2. 做什么：覆盖组队多人奖励场景，确保所有受影响成员都会收到角色刷新。
 * 3. 不做什么：不验证具体掉落内容，也不覆盖 Redis 任务持久化细节；这里只关心结算完成后的角色刷新派发。
 *
 * 输入/输出：
 * - 输入：一条已排队的 PVE 胜利延迟结算任务，以及 mocked 的发奖/任务/Socket 依赖。
 * - 输出：`flushOnlineBattleSettlementTasks` 完成后，应对所有参战成员调用 `pushCharacterUpdate`。
 *
 * 数据流/状态流：
 * pending task -> settlement runner 执行真实发奖 -> 删除任务 -> 推送角色刷新。
 *
 * 关键边界条件与坑点：
 * 1. `listPendingDeferredSettlementTasks` 必须在删任务后返回空数组，否则 runner 会重复消费同一条 mocked 任务。
 * 2. 用真实 `flushOnlineBattleSettlementTasks` 驱动单例 runner，才能覆盖“任务执行成功后再补推角色刷新”的完整调用链。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as gameServerModule from '../../game/gameServer.js';
import { battleDropService } from '../battleDropService.js';
import * as onlineBattleProjectionService from '../onlineBattleProjectionService.js';
import { flushOnlineBattleSettlementTasks } from '../onlineBattleSettlementRunner.js';
import type { DeferredSettlementTask } from '../onlineBattleProjectionService.js';
import * as taskService from '../taskService.js';

test('flushOnlineBattleSettlementTasks: 组队发奖落库后应再次推送角色刷新', async (t) => {
  const rewardPlan: NonNullable<DeferredSettlementTask['payload']['battleRewardPlan']> = {
    totalExp: 240,
    totalSilver: 60,
    drops: [],
    perPlayerRewards: [
      {
        characterId: 1001,
        userId: 101,
        exp: 120,
        silver: 30,
        drops: [],
      },
      {
        characterId: 1002,
        userId: 102,
        exp: 120,
        silver: 30,
        drops: [],
      },
    ],
  };
  const task: DeferredSettlementTask = {
    taskId: 'task-team-exp-refresh',
    battleId: 'battle-team-exp-refresh',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorMessage: null,
    payload: {
      battleId: 'battle-team-exp-refresh',
      battleType: 'pve',
      result: 'attacker_win',
      participants: [
        {
          userId: 101,
          characterId: 1001,
          nickname: '甲',
          realm: '炼气期',
          fuyuan: 1,
        },
        {
          userId: 102,
          characterId: 1002,
          nickname: '乙',
          realm: '炼气期',
          fuyuan: 1,
        },
      ],
      rewardParticipants: [
        {
          userId: 101,
          characterId: 1001,
          nickname: '甲',
          realm: '炼气期',
          fuyuan: 1,
        },
        {
          userId: 102,
          characterId: 1002,
          nickname: '乙',
          realm: '炼气期',
          fuyuan: 1,
        },
      ],
      isDungeonBattle: false,
      isTowerBattle: false,
      rewardsPreview: null,
      battleRewardPlan: rewardPlan,
      monsters: [
        {
          id: 'wolf-king',
          name: '狼王',
          realm: '炼气期',
          expReward: 120,
          silverRewardMin: 20,
          silverRewardMax: 30,
          dropPoolId: null,
          kind: 'boss',
        },
      ],
      arenaDelta: null,
      dungeonContext: null,
      dungeonStartConsumption: null,
      dungeonSettlement: null,
      session: null,
    },
  };

  let pendingTasks: DeferredSettlementTask[] = [task];
  const pushedUserIds: number[] = [];

  t.mock.method(
    onlineBattleProjectionService,
    'listPendingDeferredSettlementTasks',
    () => pendingTasks,
  );
  t.mock.method(
    onlineBattleProjectionService,
    'getDeferredSettlementTask',
    async (taskId: string) => pendingTasks.find((entry) => entry.taskId === taskId) ?? null,
  );
  t.mock.method(
    onlineBattleProjectionService,
    'updateDeferredSettlementTaskStatus',
    async (
      params: Parameters<typeof onlineBattleProjectionService.updateDeferredSettlementTaskStatus>[0],
    ) => {
      const { taskId, status, errorMessage } = params;
      const current = pendingTasks.find((entry) => entry.taskId === taskId) ?? null;
      if (!current) return null;
      const nextTask: DeferredSettlementTask = {
        ...current,
        status,
        attempts: current.attempts + 1,
        updatedAt: Date.now(),
        errorMessage: errorMessage ?? current.errorMessage,
      };
      pendingTasks = pendingTasks.map((entry) => (entry.taskId === taskId ? nextTask : entry));
      return nextTask;
    },
  );
  t.mock.method(
    onlineBattleProjectionService,
    'deleteDeferredSettlementTask',
    async (taskId: string) => {
      pendingTasks = pendingTasks.filter((entry) => entry.taskId !== taskId);
    },
  );
  t.mock.method(battleDropService, 'settleBattleRewardPlan', async () => undefined);
  t.mock.method(taskService, 'recordKillMonsterEvents', async () => undefined);
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    pushCharacterUpdate: async (userId: number) => {
      pushedUserIds.push(userId);
    },
  }) as never);

  await flushOnlineBattleSettlementTasks();

  assert.deepEqual(pushedUserIds, [101, 102]);
  assert.equal(pendingTasks.length, 0);
});
