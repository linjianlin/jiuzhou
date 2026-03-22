/**
 * 反弹伤害 Buff 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证技能型 reflect_damage Buff 会在受击后按实际扣血比例反弹真伤，并产出独立 action 日志。
 * 2) 不做什么：不覆盖套装词条 reflect/echo，不验证 AI 选技逻辑，只锁定技能 Buff 的战斗结算。
 *
 * 输入/输出：
 * - 输入：BattleState、施法者/受击者单位，以及带 reflect_damage 的自增益技能和单次伤害技能。
 * - 输出：Buff 挂载结果、受击后的双方气血变化，以及反弹日志内容。
 *
 * 数据流/状态流：
 * - 守方释放自增益技能 -> Buff 进入 BattleUnit.buffs
 * - 攻方造成直接伤害 -> skill.ts 读取 reflect_damage -> reactiveDamage.ts 统一结算反弹真伤
 * - 最终由 action 日志记录反弹结果，供战报与后续排查复用
 *
 * 关键边界条件与坑点：
 * 1) 反弹基于“实际扣血”而不是原始伤害，若本次未扣血则不应反弹。
 * 2) 反弹走独立 action 日志，不能把反弹结果偷偷塞回原命中结果里，否则战报会混淆主动作与被动反制。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../../battle/modules/skill.js';
import type { BattleSkill } from '../../battle/types.js';
import { BATTLE_CONSTANTS } from '../../battle/types.js';
import { asActionLog, consumeBattleLogs, createState, createUnit } from './battleTestUtils.js';

function createReflectBuffSkill(reflectRate = 0.5): BattleSkill {
  return {
    id: 'skill-reflect-buff',
    name: '玄甲守势',
    source: 'technique',
    sourceId: 'tech-taixi-ningtai-jue',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    element: 'tu',
    effects: [
      {
        type: 'buff',
        duration: 2,
        value: reflectRate,
        buffKey: 'buff-reflect-damage',
        buffKind: 'reflect_damage',
      },
    ],
    triggerType: 'active',
    aiPriority: 60,
  };
}

function createStrikeSkill(
  damage = 200,
  damageType: 'physical' | 'magic' | 'true' = 'true',
): BattleSkill {
  return {
    id: 'skill-flat-true-damage',
    name: '碎岳击',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType,
    element: 'none',
    effects: [
      {
        type: 'damage',
        valueType: 'flat',
        value: damage,
        damageType,
        element: 'none',
      },
    ],
    triggerType: 'active',
    aiPriority: 70,
  };
}

test('reflect_damage Buff 应按本次实际受击伤害比例反弹真伤', () => {
  const defender = createUnit({ id: 'player-1', name: '守御者' });
  const attacker = createUnit({ id: 'monster-1', name: '进攻者', type: 'monster' });
  const state = createState({ attacker: [defender], defender: [attacker] });

  const applyBuffResult = executeSkill(state, defender, createReflectBuffSkill());
  assert.equal(applyBuffResult.success, true);
  assert.equal(defender.buffs.length, 1);
  assert.equal(defender.buffs[0]?.reflectDamage?.rate, 0.5);

  const attackResult = executeSkill(state, attacker, createStrikeSkill(), [defender.id]);
  assert.equal(attackResult.success, true);
  assert.equal(defender.qixue, defender.currentAttrs.max_qixue - 200);
  assert.equal(attacker.qixue, attacker.currentAttrs.max_qixue - 100);

  const actionLogs = consumeBattleLogs(state).filter((log) => log.type === 'action');
  assert.equal(actionLogs.length, 3);
  const reflectLog = asActionLog(actionLogs[2]);
  assert.equal(reflectLog.actorId, defender.id);
  assert.equal(reflectLog.targets[0]?.targetId, attacker.id);
  assert.equal(reflectLog.targets[0]?.hits[0]?.damage, 100);
});

test('reflect_damage Buff 应被反弹伤害减免降低', () => {
  const defender = createUnit({ id: 'player-1', name: '守御者' });
  const attacker = createUnit({
    id: 'monster-1',
    name: '进攻者',
    type: 'monster',
    attrs: { jianfantan: 0.4 },
  });
  const state = createState({ attacker: [defender], defender: [attacker] });

  const applyBuffResult = executeSkill(state, defender, createReflectBuffSkill());
  assert.equal(applyBuffResult.success, true);

  const attackResult = executeSkill(state, attacker, createStrikeSkill(), [defender.id]);
  assert.equal(attackResult.success, true);
  assert.equal(attacker.qixue, attacker.currentAttrs.max_qixue - 60);

  const actionLogs = consumeBattleLogs(state).filter((log) => log.type === 'action');
  const reflectLog = asActionLog(actionLogs[2]);
  assert.equal(reflectLog.targets[0]?.hits[0]?.damage, 60);
});

test('reflect_damage Buff 在低伤害场景下不应因二次取整被额外抹掉', () => {
  const defender = createUnit({ id: 'player-1', name: '守御者' });
  const attacker = createUnit({
    id: 'monster-1',
    name: '进攻者',
    type: 'monster',
    attrs: { jianfantan: 0.1 },
  });
  const state = createState({ attacker: [defender], defender: [attacker] });

  const applyBuffResult = executeSkill(state, defender, createReflectBuffSkill(0.1));
  assert.equal(applyBuffResult.success, true);

  const attackResult = executeSkill(state, attacker, createStrikeSkill(19), [defender.id]);
  assert.equal(attackResult.success, true);
  assert.equal(attacker.qixue, attacker.currentAttrs.max_qixue - 1);

  const actionLogs = consumeBattleLogs(state).filter((log) => log.type === 'action');
  const reflectLog = asActionLog(actionLogs[2]);
  assert.equal(reflectLog.targets[0]?.hits[0]?.damage, 1);
});

test('reflect_damage Buff 应继承来源物理伤害类型并受目标物防减免', () => {
  const defender = createUnit({
    id: 'player-1',
    name: '守御者',
    attrs: { wufang: 0, fafang: 0 },
  });
  const attacker = createUnit({
    id: 'monster-1',
    name: '进攻者',
    type: 'monster',
    attrs: { wufang: 200, fafang: 0, jianfantan: 0 },
  });
  const state = createState({ attacker: [defender], defender: [attacker] });

  const applyBuffResult = executeSkill(state, defender, createReflectBuffSkill());
  assert.equal(applyBuffResult.success, true);

  const attackResult = executeSkill(state, attacker, createStrikeSkill(200, 'physical'), [defender.id]);
  assert.equal(attackResult.success, true);

  const expectedReduction = 200 / (200 + BATTLE_CONSTANTS.DEFENSE_DAMAGE_K);
  const expectedReflectDamage = Math.floor(100 * (1 - expectedReduction));

  const actionLogs = consumeBattleLogs(state).filter((log) => log.type === 'action');
  const reflectLog = asActionLog(actionLogs[2]);
  assert.equal(reflectLog.targets[0]?.hits[0]?.damage, expectedReflectDamage);
});
