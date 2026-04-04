/**
 * 战斗掉落真实发奖慢日志分段回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `settleBattleRewardPlan` 会对真实发奖事务输出细分阶段打点，便于区分慢在角色加锁、自动分解配置读取、逐掉落发放还是尾部资源回写。
 * 2. 做什么：覆盖有掉落的胜利发奖路径，防止后续重构时把关键阶段日志删掉或顺序打乱。
 * 3. 不做什么：不验证真实数据库耗时、不覆盖掉落概率，也不连接真实邮件/背包服务。
 *
 * 输入/输出：
 * - 输入：一条包含单角色单掉落的战斗奖励计划，以及 mocked 的事务、掉落发放和慢日志依赖。
 * - 输出：`settleBattleRewardPlan` 执行后，应按预期阶段顺序调用 slow logger，并带出聚合字段。
 *
 * 数据流/状态流：
 * reward plan -> settleBattleRewardPlan -> 事务内角色加锁/配置读取/掉落发放/事件回写
 * -> slow logger 记录各阶段 -> flush 输出结构化字段。
 *
 * 复用设计说明：
 * 1. 直接复用真实 `battleDropService.settleBattleRewardPlan` 入口，只 mock 外部依赖，避免测试与真实发奖流程分叉。
 * 2. 通过统一 mock `createSlowOperationLogger` 收集阶段名，后续 battle/dungeon 其他链路需要类似断言时也能沿用同样模式。
 *
 * 关键边界条件与坑点：
 * 1. 测试必须走 `plan.drops.length > 0` 分支，否则角色锁与自动分解配置读取阶段不会出现。
 * 2. 这里故意不产生补发邮件，避免让 `sendPendingMail` 阶段掺入额外断言噪音；只锁定主干热点阶段。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as autoDisassembleRewardService from '../autoDisassembleRewardService.js';
import { battleDropService, type BattleRewardSettlementPlan } from '../battleDropService.js';
import * as characterRewardSettlement from '../shared/characterRewardSettlement.js';
import * as characterRewardTargetLock from '../shared/characterRewardTargetLock.js';
import * as slowOperationLogger from '../../utils/slowOperationLogger.js';
import * as staticConfigLoader from '../staticConfigLoader.js';
import * as taskService from '../taskService.js';

test('battleDropService.settleBattleRewardPlan: 应输出真实发奖分段慢日志', async (t) => {
  const marks: Array<{ name: string; fields?: Record<string, boolean | number | string | null | undefined> }> = [];
  const flushes: Array<Record<string, boolean | number | string | null | undefined> | undefined> = [];
  const plan: BattleRewardSettlementPlan = {
    totalExp: 120,
    totalSilver: 36,
    drops: [
      {
        receiverCharacterId: 1001,
        receiverUserId: 101,
        receiverFuyuan: 1,
        itemDefId: 'weapon_test_blade',
        quantity: 1,
        bindType: 'bound',
      },
    ],
    perPlayerRewards: [
      {
        characterId: 1001,
        userId: 101,
        exp: 120,
        silver: 36,
        drops: [],
      },
    ],
  };

  t.mock.method(
    slowOperationLogger,
    'createSlowOperationLogger',
    (options: Parameters<typeof slowOperationLogger.createSlowOperationLogger>[0]) => {
    assert.equal(options.label, 'battleDropService.settleBattleRewardPlan');
    assert.equal(options.thresholdMs, 200);
    assert.equal(options.fields?.rewardPlayerCount, 1);
    assert.equal(options.fields?.dropCount, 1);
    assert.equal(options.fields?.requiresInventoryMutation, true);
    return {
      mark: (name: string, fields?: Record<string, boolean | number | string | null | undefined>) => {
        marks.push({ name, fields });
      },
      flush: (fields?: Record<string, boolean | number | string | null | undefined>) => {
        flushes.push(fields);
      },
    };
    },
  );
  t.mock.method(database, 'withTransactionAuto', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(
    characterRewardTargetLock,
    'lockCharacterRewardSettlementTargets',
    async (characterIds: number[]) => {
      assert.deepEqual(characterIds, [1001]);
      return characterIds;
    },
  );
  t.mock.method(database, 'query', async () => ({
    rows: [
      {
        id: 1001,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: null,
      },
    ],
  }));
  t.mock.method(staticConfigLoader, 'getItemDefinitionById', () => ({
    id: 'weapon_test_blade',
    name: '测试刀',
    category: 'equipment',
    subCategory: 'weapon',
    effectDefs: [],
    quality: '黄',
    disassemblable: true,
  }) as never);
  t.mock.method(autoDisassembleRewardService, 'grantRewardItemWithAutoDisassemble', async () => ({
    grantedItems: [
      {
        itemDefId: 'weapon_test_blade',
        qty: 1,
        itemIds: [9001],
      },
    ],
    pendingMailItems: [],
    gainedSilver: 0,
    warnings: [],
  }));
  t.mock.method(taskService, 'recordCollectItemEvents', async () => undefined);
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => undefined);

  await battleDropService.settleBattleRewardPlan(plan);

  assert.deepEqual(marks.map((entry) => entry.name), [
    'aggregateRewardDeltas',
    'lockCharacterRewardSettlementTargets',
    'loadAutoDisassembleSettings',
    'grantRewardDrops',
    'recordCollectItemEvents',
    'sendPendingMail',
    'applyCharacterRewardDeltas',
  ]);
  assert.equal(marks[3]?.fields?.grantedDropCount, 1);
  assert.equal(marks[3]?.fields?.pendingMailReceiverCount, 0);
  assert.equal(marks[4]?.fields?.collectEventCount, 1);
  assert.equal(marks[5]?.fields?.pendingMailCount, 0);
  assert.equal(marks[6]?.fields?.rewardDeltaCharacterCount, 1);
  assert.deepEqual(flushes, [
    {
      success: true,
      rewardPlayerCount: 1,
      dropCount: 1,
      collectEventCount: 1,
      pendingMailCount: 0,
    },
  ]);
});

test('battleDropService.settleBattleRewardPlan: 应按角色批量记录收集事件', async (t) => {
  const collectEventCalls: Array<{
    characterId: number;
    events: Array<{ itemId: string; count: number }>;
  }> = [];
  const plan: BattleRewardSettlementPlan = {
    totalExp: 120,
    totalSilver: 36,
    drops: [
      {
        receiverCharacterId: 1001,
        receiverUserId: 101,
        receiverFuyuan: 1,
        itemDefId: 'material_herb',
        quantity: 1,
        bindType: 'bound',
      },
      {
        receiverCharacterId: 1001,
        receiverUserId: 101,
        receiverFuyuan: 1,
        itemDefId: 'material_herb',
        quantity: 2,
        bindType: 'bound',
      },
    ],
    perPlayerRewards: [
      {
        characterId: 1001,
        userId: 101,
        exp: 120,
        silver: 36,
        drops: [],
      },
    ],
  };

  t.mock.method(database, 'withTransactionAuto', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(characterRewardTargetLock, 'lockCharacterRewardSettlementTargets', async () => undefined);
  t.mock.method(database, 'query', async () => ({
    rows: [
      {
        id: 1001,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: null,
      },
    ],
    rowCount: 1,
  }));
  t.mock.method(staticConfigLoader, 'getItemDefinitionById', () => ({
    id: 'material_herb',
    name: '灵草',
    category: 'material',
    subCategory: 'material',
    effectDefs: [],
    quality: '黄',
    disassemblable: false,
  }) as never);
  t.mock.method(
    autoDisassembleRewardService,
    'grantRewardItemWithAutoDisassemble',
    async (input: Parameters<typeof autoDisassembleRewardService.grantRewardItemWithAutoDisassemble>[0]) => ({
      grantedItems: [
        {
          itemDefId: input.itemDefId,
          qty: input.qty,
          itemIds: [],
        },
      ],
      pendingMailItems: [],
      gainedSilver: 0,
      warnings: [],
    }),
  );
  t.mock.method(
    taskService,
    'recordCollectItemEvents',
    async (characterId: number, events: Array<{ itemId: string; count: number }>) => {
      collectEventCalls.push({ characterId, events });
    },
  );
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => undefined);

  await battleDropService.settleBattleRewardPlan(plan);

  assert.deepEqual(collectEventCalls, [
    {
      characterId: 1001,
      events: [
        {
          itemId: 'material_herb',
          count: 3,
        },
      ],
    },
  ]);
});
