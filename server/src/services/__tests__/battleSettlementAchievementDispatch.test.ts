/**
 * 战斗结算成就异步派发回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `finishBattle` 不会等待战斗成就写库完成后才返回，从而压低主链路同步耗时。
 * 2. 做什么：验证成就任务仍会被真实调度，不会因为异步化而直接丢失。
 * 3. 不做什么：不校验奖励计划、竞技场积分、socket 推送 payload 细节，也不覆盖延迟结算任务内容。
 *
 * 输入/输出：
 * - 输入：最小合法 BattleEngine、一个可手动控制 resolve 时机的成就 Promise，以及结算链路依赖的 mock。
 * - 输出：`finishBattle` 的返回时机与成就调度次数。
 *
 * 数据流/状态流：
 * - finishBattle -> 主链路构建 battleResult
 * - -> 调度异步成就任务
 * - -> 不等待成就 Promise 即返回 battleResult。
 *
 * 关键边界条件与坑点：
 * 1. 断言时必须在成就 Promise 未 resolve 前观察 `finishBattle` 是否已完成，否则测不到阻塞差异。
 * 2. 清理阶段必须显式放行成就 Promise 并等待 `finishBattle` 收尾，避免悬挂 Promise 污染后续测试。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BattleEngine } from '../../battle/battleEngine.js';
import * as logStream from '../../battle/logStream.js';
import * as gameServerModule from '../../game/gameServer.js';
import * as achievementTracking from '../achievement/battleTracking.js';
import * as battleSessionModule from '../battleSession/index.js';
import * as projectionService from '../onlineBattleProjectionService.js';
import type { BattleResult } from '../battle/battleTypes.js';
import * as persistenceModule from '../battle/runtime/persistence.js';
import * as realtimeModule from '../battle/runtime/realtime.js';
import * as pvpModule from '../battle/pvp.js';
import * as stateModule from '../battle/runtime/state.js';
import * as settlementModule from '../battle/settlement.js';
import { createState, createUnit } from './battleTestUtils.js';

const waitForMacrotask = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

const requireBattleResult = (result: BattleResult | null): BattleResult => {
  if (result === null) {
    throw new Error('finishBattle 在成就异步派发前未返回结果');
  }
  return result;
};

test('finishBattle: 应在战斗成就未完成时先返回主结果，再异步完成成就落库', async (t) => {
  const battleId = 'battle-achievement-async-dispatch';
  const state = {
    ...createState({
      attacker: [createUnit({ id: 'player-1001', name: '主角' })],
      defender: [createUnit({ id: 'monster-2001', name: '野狼', type: 'monster' })],
    }),
    battleId,
    phase: 'finished' as const,
    result: 'attacker_win' as const,
  };
  const engine = new BattleEngine(state);
  let achievementDispatchCount = 0;
  let releaseAchievementDispatch = (): void => undefined;
  const achievementSettled = new Promise<void>((resolve) => {
    releaseAchievementDispatch = resolve;
  });

  t.mock.method(logStream, 'consumeBattleLogDelta', () => ({
    logStart: 0,
    logDelta: 0,
    logs: [],
  }));
  t.mock.method(logStream, 'getBattleLogCursor', () => 0);
  t.mock.method(projectionService, 'getOnlineBattleCharacterSnapshotsByCharacterIds', async () => new Map());
  t.mock.method(projectionService, 'getDungeonProjectionByBattleId', async () => null);
  t.mock.method(projectionService, 'createDeferredSettlementTask', async () => undefined);
  t.mock.method(
    projectionService,
    'buildImmediateBattleResultWithProjectionPreview',
    (battleResult: Awaited<ReturnType<typeof settlementModule.finishBattle>>) => battleResult,
  );
  t.mock.method(battleSessionModule, 'markBattleSessionFinished', async () => null);
  t.mock.method(pvpModule, 'resolveArenaBattleSettlementContext', () => null);
  t.mock.method(realtimeModule, 'buildBattleFinishedRealtimePayload', () => null);
  t.mock.method(stateModule, 'setBattleStartCooldownByCharacterIds', () => 0);
  t.mock.method(persistenceModule, 'removeBattleFromRedis', async () => undefined);
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: () => undefined,
    pushCharacterUpdate: async () => undefined,
  }));
  t.mock.method(
    achievementTracking,
    'recordBattleOutcomeAchievements',
    async () => {
      achievementDispatchCount += 1;
      await achievementSettled;
    },
  );

  let finishResult: BattleResult | null = null;
  const finishPromise = settlementModule.finishBattle(battleId, engine, []).then((result) => {
    finishResult = result;
    return result;
  });

  try {
    await waitForMacrotask();
    assert.equal(achievementDispatchCount, 1);
    const resolvedFinishResult = requireBattleResult(finishResult);
    assert.equal(resolvedFinishResult.success, true);
    assert.equal(resolvedFinishResult.data?.result, 'attacker_win');
  } finally {
    releaseAchievementDispatch();
    await finishPromise;
  }
});
