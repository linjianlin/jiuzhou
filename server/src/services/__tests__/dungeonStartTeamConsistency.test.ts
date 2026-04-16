/**
 * 秘境开战队伍一致性回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：覆盖“准备态秘境创建后，队伍被解散或成员变更”时必须拒绝开战，避免旧 `teamId` 继续流入延迟结算落库。
 * 2. 做什么：锁定校验发生在开战热路径前半段，确保不会继续进入战斗启动、次数扣减和体力扣减链路。
 * 3. 不做什么：不验证真实战斗引擎、数据库事务或奖励内容；这里只验证秘境开战前的队伍一致性约束。
 *
 * 输入/输出：
 * - 输入：带有 `teamId` 的 preparing 秘境投影，以及“当前队伍已解散/成员列表不匹配”的队伍投影快照。
 * - 输出：`startDungeonInstance` 返回失败，且不会触发 `runDungeonStartFlow`。
 *
 * 数据流/状态流：
 * - startDungeonInstance -> 读取 preparing 秘境投影
 * - 若实例绑定队伍，则立即读取当前在线战斗队伍投影
 * - 队伍缺失或成员集合不一致时直接失败，不再继续后续启动流程。
 *
 * 复用设计说明：
 * 1. 直接复用真实 `startDungeonInstance` 入口，只 mock 队伍/实例投影依赖，避免测试里复制一套开战前校验。
 * 2. 这里把“失效 teamId”和“成员集合漂移”统一锁在同一入口，后续秘境与队伍联动规则都能共享这条回归保障。
 *
 * 关键边界条件与坑点：
 * 1. 队伍被解散时，当前队伍投影可能是 `null`，不能再让旧实例继续启动。
 * 2. 即便 `teamId` 未变化，只要成员集合和实例快照不一致，也必须拒绝开战，避免旧参与者名单进入后续链路。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startDungeonInstance } from '../dungeon/combat.js';
import * as participantHelpers from '../dungeon/shared/participants.js';
import * as projectionService from '../onlineBattleProjectionService.js';
import * as startFlow from '../dungeon/shared/startFlow.js';

const createPreparingTeamDungeonProjection = () => ({
  instanceId: 'dungeon-instance-team-consistency',
  dungeonId: 'dungeon-team-consistency',
  difficultyId: 'difficulty-team-consistency',
  difficultyRank: 1,
  creatorCharacterId: 1001,
  teamId: 'team-consistency',
  status: 'preparing' as const,
  currentStage: 1,
  currentWave: 1,
  participants: [
    { userId: 1, characterId: 1001, role: 'leader' as const },
    { userId: 2, characterId: 1002, role: 'member' as const },
  ],
  currentBattleId: null,
  rewardEligibleCharacterIds: [],
  startTime: null,
  endTime: null,
});

test('startDungeonInstance: 队伍已解散时应拒绝开启组队秘境', async (t) => {
  let startFlowCalled = false;

  t.mock.method(participantHelpers, 'getUserAndCharacter', async (userId: number) => {
    assert.equal(userId, 1);
    return {
      ok: true as const,
      userId,
      characterId: 1001,
      realm: '炼精化炁·养气期',
      teamId: null,
      isLeader: false,
    };
  });
  t.mock.method(projectionService, 'getDungeonProjection', async () => createPreparingTeamDungeonProjection());
  t.mock.method(projectionService, 'getTeamProjectionByUserId', async () => null);
  t.mock.method(startFlow, 'runDungeonStartFlow', async () => {
    startFlowCalled = true;
    return {
      success: true as const,
      data: {
        instanceId: 'dungeon-instance-team-consistency',
        status: 'running' as const,
        battleId: 'battle-should-not-start',
        state: {},
      },
    };
  });

  const result = await startDungeonInstance(1, 'dungeon-instance-team-consistency');

  assert.equal(result.success, false);
  if (result.success) {
    assert.fail('预期队伍已解散时拒绝开战，但实际返回成功');
  }
  assert.equal(result.message, '队伍已变更，请重新创建秘境');
  assert.equal(startFlowCalled, false);
});

test('startDungeonInstance: 队伍成员已变更时应拒绝开启组队秘境', async (t) => {
  let startFlowCalled = false;

  t.mock.method(participantHelpers, 'getUserAndCharacter', async (userId: number) => {
    assert.equal(userId, 1);
    return {
      ok: true as const,
      userId,
      characterId: 1001,
      realm: '炼精化炁·养气期',
      teamId: 'team-consistency',
      isLeader: true,
    };
  });
  t.mock.method(projectionService, 'getDungeonProjection', async () => createPreparingTeamDungeonProjection());
  t.mock.method(projectionService, 'getTeamProjectionByUserId', async () => ({
    teamId: 'team-consistency',
    role: 'leader' as const,
    memberCharacterIds: [1001, 1003],
  }));
  t.mock.method(startFlow, 'runDungeonStartFlow', async () => {
    startFlowCalled = true;
    return {
      success: true as const,
      data: {
        instanceId: 'dungeon-instance-team-consistency',
        status: 'running' as const,
        battleId: 'battle-should-not-start',
        state: {},
      },
    };
  });

  const result = await startDungeonInstance(1, 'dungeon-instance-team-consistency');

  assert.equal(result.success, false);
  if (result.success) {
    assert.fail('预期队伍成员变更时拒绝开战，但实际返回成功');
  }
  assert.equal(result.message, '队伍已变更，请重新创建秘境');
  assert.equal(startFlowCalled, false);
});
