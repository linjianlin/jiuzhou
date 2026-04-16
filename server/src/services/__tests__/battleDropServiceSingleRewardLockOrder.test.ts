/**
 * 单人战斗奖励锁顺序回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `settleSinglePlayerBattleRewardPlan` 在有掉落时必须先统一获取库存目标锁，再进入真实入包流程。
 * 2. 做什么：覆盖挂机/单人奖励兑现路径，避免只修多人发奖而遗漏单人结算，重新引入 `item_instance FOR UPDATE -> 背包锁` 的反向等待。
 * 3. 不做什么：不验证真实掉落概率、不连接真实数据库，也不覆盖补发邮件分支。
 *
 * 输入 / 输出：
 * - 输入：单角色单掉落奖励计划，以及 mocked 的事务、锁、物品创建依赖。
 * - 输出：执行后应记录出“先锁库存目标，再进入 createItem”的稳定顺序。
 *
 * 数据流 / 状态流：
 * 单人奖励计划 -> settleSinglePlayerBattleRewardPlan -> 库存目标锁
 * -> 自动分解入口 -> createItem -> 收集事件 / 资源增量。
 *
 * 复用设计说明：
 * 1. 直接走真实 `battleDropService.settleSinglePlayerBattleRewardPlan` 入口，只 mock 外围依赖，确保锁协议回归测试和线上调用链一致。
 * 2. 通过事件序列断言锁顺序，而不是复制业务实现细节，后续内部重构时仍能稳定约束并发协议。
 *
 * 关键边界条件与坑点：
 * 1. 必须提供 `dropPlans`，否则本测试不会进入需要背包写入的路径，也就无法验证锁顺序。
 * 2. 这里选择普通材料掉落而不是装备掉落，确保能覆盖最容易先触发 `item_instance FOR UPDATE` 的普通入包分支。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as autoDisassembleRewardService from '../autoDisassembleRewardService.js';
import { battleDropService, type BattleParticipant } from '../battleDropService.js';
import * as characterRewardSettlement from '../shared/characterRewardSettlement.js';
import * as characterRewardTargetLock from '../shared/characterRewardTargetLock.js';
import { itemService } from '../itemService.js';
import * as staticConfigLoader from '../staticConfigLoader.js';
import * as taskService from '../taskService.js';

test('battleDropService.settleSinglePlayerBattleRewardPlan: 应先锁库存目标再入包', async (t) => {
  const steps: string[] = [];
  const participant: BattleParticipant = {
    userId: 101,
    characterId: 1001,
    nickname: '甲',
    realm: '炼气期',
    fuyuan: 1,
  };

  t.mock.method(database, 'withTransactionAuto', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(characterRewardTargetLock, 'lockCharacterRewardInventoryTargets', async (characterIds: number[]) => {
    steps.push(`lock:${characterIds.join(',')}`);
    return characterIds;
  });
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM characters')) {
      steps.push('load-auto-disassemble');
      return {
        rows: [
          {
            auto_disassemble_enabled: false,
            auto_disassemble_rules: null,
          },
        ],
      };
    }
    return { rows: [] };
  });
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
    async (
      input: Parameters<typeof autoDisassembleRewardService.grantRewardItemWithAutoDisassemble>[0],
    ) => {
      steps.push('grant');
      const createResult = await input.createItem({
        itemDefId: input.itemDefId,
        qty: input.qty,
        bindType: input.bindType,
        obtainedFrom: input.sourceObtainedFrom,
      });
      assert.equal(createResult.success, true);
      return {
        grantedItems: [
          {
            itemDefId: input.itemDefId,
            qty: input.qty,
            itemIds: [9001],
          },
        ],
        pendingMailItems: [],
        gainedSilver: 0,
        warnings: [],
      };
    },
  );
  t.mock.method(itemService, 'createItem', async () => {
    steps.push('createItem');
    return {
      success: true,
      message: '成功',
      itemIds: [9001],
    };
  });
  t.mock.method(taskService, 'recordCollectItemEventsBatch', async () => {
    steps.push('recordCollect');
  });
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => {
    steps.push('applyRewardDelta');
  });

  const result = await battleDropService.settleSinglePlayerBattleRewardPlan(participant, {
    expGained: 12,
    silverGained: 8,
    previewItems: [
      {
        itemDefId: 'material_herb',
        quantity: 1,
        itemName: '灵草',
      },
    ],
    dropPlans: [
      {
        itemDefId: 'material_herb',
        quantity: 1,
        bindType: 'bound',
      },
    ],
  });

  assert.equal(result.expGained, 12);
  assert.equal(result.silverGained, 8);
  assert.deepEqual(steps, [
    'lock:1001',
    'load-auto-disassemble',
    'grant',
    'createItem',
    'recordCollect',
    'applyRewardDelta',
  ]);
});
