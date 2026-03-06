/**
 * 单体友方支援技能目标测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证单体治疗/增益技能在未显式选目标时，会优先命中更合适的队友，而不是默认回退到施法者自己。
 * - 不做什么：不覆盖群体友方、随机友方或前端选中态，仅验证 battle 模块的服务端目标解析与执行结果。
 *
 * 输入/输出：
 * - 输入：BattleState、BattleUnit、BattleSkill，以及可选的 selectedTargetIds。
 * - 输出：executeSkill/selectTargets 的目标选择结果，以及目标单位的治疗/Buff 实际结算。
 *
 * 数据流/状态流：
 * - 测试构造 state/unit/skill -> 调用 selectTargets / executeSkill -> 断言目标解析与单位状态变化。
 *
 * 关键边界条件与坑点：
 * 1) 施法者需要排在 attacker 首位，才能稳定复现“默认首位友方就是自己”的旧问题。
 * 2) 显式点选自己必须保留，不能因为“队友优先”把玩家主动选择覆盖掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../../battle/modules/skill.js';
import { selectTargets } from '../../battle/modules/ai.js';
import { resolveSingleAllyTargetId } from '../../battle/utils/allyTargeting.js';
import type { BattleSkill } from '../../battle/types.js';
import { createState, createUnit } from './battleTestUtils.js';

test('单体治疗技能在未显式选目标时应优先治疗受伤队友', () => {
  const caster = createUnit({ id: 'player-1', name: '医修甲' });
  const teammate = createUnit({ id: 'player-2', name: '剑修乙' });
  const enemy = createUnit({ id: 'monster-1', name: '木桩妖', type: 'monster' });
  caster.qixue = 800;
  teammate.qixue = 400;

  const state = createState({ attacker: [caster, teammate], defender: [enemy] });
  const skill: BattleSkill = {
    id: 'skill-single-heal-ally',
    name: '回春诀',
    source: 'technique',
    sourceId: 'tech-heal-1',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'heal',
        value: 200,
        valueType: 'flat',
      },
    ],
    triggerType: 'active',
    aiPriority: 90,
  };

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(teammate.qixue, 600);
  assert.equal(caster.qixue, 800);
});

test('单体增益技能在未显式选目标时应优先命中队友输出位', () => {
  const caster = createUnit({ id: 'player-3', name: '道修甲' });
  const teammate = createUnit({ id: 'player-4', name: '枪修乙' });
  const enemy = createUnit({ id: 'monster-2', name: '木桩妖', type: 'monster' });
  teammate.stats.damageDealt = 680;

  const state = createState({ attacker: [caster, teammate], defender: [enemy] });
  const skill: BattleSkill = {
    id: 'skill-single-buff-ally',
    name: '凝神诀',
    source: 'technique',
    sourceId: 'tech-buff-1',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'buff',
        buffKind: 'attr',
        attrKey: 'zengshang',
        applyType: 'flat',
        value: 0.12,
        duration: 2,
      },
    ],
    triggerType: 'active',
    aiPriority: 80,
  };

  const targets = selectTargets(state, caster, skill);
  assert.deepEqual(targets, [teammate.id]);

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(teammate.buffs.length, 1);
  assert.equal(caster.buffs.length, 0);
});

test('单体友方技能显式点选自己时应保留玩家选择', () => {
  const caster = createUnit({ id: 'player-5', name: '医修甲' });
  const teammate = createUnit({ id: 'player-6', name: '体修乙' });
  const enemy = createUnit({ id: 'monster-3', name: '木桩妖', type: 'monster' });
  caster.qixue = 500;
  teammate.qixue = 300;

  const state = createState({ attacker: [caster, teammate], defender: [enemy] });
  const skill: BattleSkill = {
    id: 'skill-single-heal-self',
    name: '归元术',
    source: 'technique',
    sourceId: 'tech-heal-2',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'shui',
    effects: [
      {
        type: 'heal',
        value: 180,
        valueType: 'flat',
      },
    ],
    triggerType: 'active',
    aiPriority: 70,
  };

  const result = executeSkill(state, caster, skill, [caster.id]);
  assert.equal(result.success, true);
  assert.equal(caster.qixue, 680);
  assert.equal(teammate.qixue, 300);
});

test('单体护盾技能在未显式选目标时应优先保护残血且无盾队友', () => {
  const caster = createUnit({ id: 'player-7', name: '符修甲' });
  const lowHpTeammate = createUnit({ id: 'player-8', name: '剑修乙' });
  const healthyTeammate = createUnit({ id: 'player-9', name: '体修丙' });
  lowHpTeammate.qixue = 350;
  healthyTeammate.qixue = 1100;
  healthyTeammate.shields.push({
    id: 'shield-old',
    sourceSkillId: 'old',
    value: 300,
    maxValue: 300,
    duration: 1,
    absorbType: 'all',
    priority: 1,
  });

  const skill: BattleSkill = {
    id: 'skill-single-shield-ally',
    name: '玄甲护符',
    source: 'technique',
    sourceId: 'tech-shield-1',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'tu',
    effects: [{ type: 'shield', valueType: 'flat', value: 240, duration: 2 }],
    triggerType: 'active',
    aiPriority: 70,
  };

  const chosen = resolveSingleAllyTargetId(caster, skill, [caster, lowHpTeammate, healthyTeammate]);
  assert.equal(chosen, lowHpTeammate.id);
});

test('单体净化技能在未显式选目标时应优先选择被控制队友', () => {
  const caster = createUnit({ id: 'player-10', name: '医修甲' });
  const controlledTeammate = createUnit({ id: 'player-11', name: '剑修乙' });
  const debuffedTeammate = createUnit({ id: 'player-12', name: '枪修丙' });
  controlledTeammate.buffs.push({
    id: 'debuff-stun',
    buffDefId: 'debuff-stun',
    name: '眩晕',
    type: 'debuff',
    category: 'skill',
    sourceUnitId: 'monster-1',
    remainingDuration: 1,
    stacks: 1,
    maxStacks: 1,
    control: 'stun',
    tags: [],
    dispellable: true,
  });
  debuffedTeammate.buffs.push({
    id: 'debuff-burn',
    buffDefId: 'debuff-burn',
    name: '灼烧',
    type: 'debuff',
    category: 'skill',
    sourceUnitId: 'monster-1',
    remainingDuration: 2,
    stacks: 1,
    maxStacks: 1,
    tags: [],
    dispellable: true,
  });

  const skill: BattleSkill = {
    id: 'skill-cleanse-control-ally',
    name: '清心诀',
    source: 'technique',
    sourceId: 'tech-cleanse-1',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'shui',
    effects: [{ type: 'cleanse_control', count: 1 }],
    triggerType: 'active',
    aiPriority: 70,
  };

  const chosen = resolveSingleAllyTargetId(caster, skill, [caster, controlledTeammate, debuffedTeammate]);
  assert.equal(chosen, controlledTeammate.id);
});

test('单体回灵技能在未显式选目标时应优先选择缺灵气的高输出队友', () => {
  const caster = createUnit({ id: 'player-13', name: '道修甲' });
  const damageTeammate = createUnit({ id: 'player-14', name: '剑修乙', attrs: { wugong: 500, fagong: 120 } });
  const supportTeammate = createUnit({ id: 'player-15', name: '医修丙', attrs: { wugong: 120, fagong: 420, zhiliao: 0.4 } });
  damageTeammate.lingqi = 10;
  supportTeammate.lingqi = 40;
  damageTeammate.stats.damageDealt = 900;

  const skill: BattleSkill = {
    id: 'skill-restore-lingqi-ally',
    name: '聚灵咒',
    source: 'technique',
    sourceId: 'tech-qi-1',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [{ type: 'restore_lingqi', value: 60 }],
    triggerType: 'active',
    aiPriority: 70,
  };

  const chosen = resolveSingleAllyTargetId(caster, skill, [caster, damageTeammate, supportTeammate]);
  assert.equal(chosen, damageTeammate.id);
});
