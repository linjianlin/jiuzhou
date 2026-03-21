/**
 * 战斗冷却策略回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定普通 PVE、秘境、千层塔在“开战冷却 / 战后冷却”上的共享策略，避免后续只改一头导致规则漂移。
 * 2. 做什么：明确千层塔不参与 3 秒战斗冷却，这样 start 与 settlement 都能复用同一口径。
 * 3. 不做什么：不发起真实战斗，也不校验 BattleSession 推进逻辑。
 *
 * 输入/输出：
 * - 输入：共享冷却策略对象。
 * - 输出：是否校验开战冷却、是否应用战后冷却的布尔值。
 *
 * 数据流/状态流：
 * - 调用方选择 battle start policy -> 本测试锁定共享判定函数输出。
 *
 * 关键边界条件与坑点：
 * 1. 千层塔如果只跳过结算冷却、不跳过开战冷却，仍会在点开始时被 3 秒挡住。
 * 2. 秘境与千层塔都应跳过战后冷却，否则 BattleArea 会错误进入等待冷却态。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
  PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
  shouldApplyBattleSettlementCooldown,
  shouldValidateBattleStarterCooldown,
  TOWER_PVE_BATTLE_START_POLICY,
} from '../battle/shared/startPolicy.js';

test('PLAYER_DRIVEN_PVE_BATTLE_START_POLICY: 普通战斗仍需要开战与战后冷却', () => {
  assert.equal(shouldValidateBattleStarterCooldown(PLAYER_DRIVEN_PVE_BATTLE_START_POLICY), true);
  assert.equal(shouldApplyBattleSettlementCooldown(PLAYER_DRIVEN_PVE_BATTLE_START_POLICY), true);
});

test('DUNGEON_FLOW_PVE_BATTLE_START_POLICY: 秘境推进应跳过开战与战后冷却', () => {
  assert.equal(shouldValidateBattleStarterCooldown(DUNGEON_FLOW_PVE_BATTLE_START_POLICY), false);
  assert.equal(shouldApplyBattleSettlementCooldown(DUNGEON_FLOW_PVE_BATTLE_START_POLICY), false);
});

test('TOWER_PVE_BATTLE_START_POLICY: 千层塔应跳过开战与战后冷却', () => {
  assert.equal(shouldValidateBattleStarterCooldown(TOWER_PVE_BATTLE_START_POLICY), false);
  assert.equal(shouldApplyBattleSettlementCooldown(TOWER_PVE_BATTLE_START_POLICY), false);
});
