/**
 * dungeonStartFlow 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证“开启战斗失败时，不应执行后续扣费/状态提交”与“开启成功时执行提交”两条关键规则。
 * - 不做什么：不触达数据库、不验证秘境完整业务分支，仅验证启动流程编排的提交时机。
 *
 * 输入/输出：
 * - 输入：可注入的 startBattle 与 commitOnBattleStarted 回调。
 * - 输出：流程函数的 success/message 结果，以及提交回调是否被调用。
 *
 * 数据流/状态流：
 * - startBattle 先执行。
 * - 仅当 startBattle 返回 success 且包含 battleId 时，才执行 commitOnBattleStarted。
 * - 任一前置条件不满足时直接返回失败，不触发提交。
 *
 * 关键边界条件与坑点：
 * 1. startBattle success=false 时，必须短路返回并保证 commit 回调调用次数为 0。
 * 2. startBattle success=true 但缺 battleId 时，也必须短路返回，避免误扣资源。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runDungeonStartFlow } from '../dungeon/shared/startFlow.js';

test('开启战斗失败时不执行提交回调', async () => {
  let commitCalled = 0;
  const result = await runDungeonStartFlow({
    startBattle: async () => ({ success: false, message: '开启战斗失败' }),
    commitOnBattleStarted: async () => {
      commitCalled += 1;
      return { success: true, data: { committed: true } };
    },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.message, '开启战斗失败');
  }
  assert.equal(commitCalled, 0);
});

test('开启战斗成功后执行提交回调', async () => {
  let commitCalled = 0;
  const result = await runDungeonStartFlow({
    startBattle: async () => ({
      success: true,
      data: {
        battleId: 'battle-1',
        state: { phase: 'running' },
      },
    }),
    commitOnBattleStarted: async ({ battleId, state }) => {
      commitCalled += 1;
      return { success: true, data: { battleId, state } };
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.battleId, 'battle-1');
    assert.deepEqual(result.data.state, { phase: 'running' });
  }
  assert.equal(commitCalled, 1);
});

test('开启战斗缺少 battleId 时不执行提交回调', async () => {
  let commitCalled = 0;
  const result = await runDungeonStartFlow({
    startBattle: async () => ({
      success: true,
      data: {
        state: { phase: 'running' },
      },
    }),
    commitOnBattleStarted: async () => {
      commitCalled += 1;
      return { success: true, data: { committed: true } };
    },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.message, '开启战斗失败');
  }
  assert.equal(commitCalled, 0);
});
