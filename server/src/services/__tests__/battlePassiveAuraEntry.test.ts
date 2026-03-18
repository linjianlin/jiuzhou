import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleEngine } from '../../battle/battleEngine.js';
import { createPVEBattle } from '../../battle/battleFactory.js';
import { getAvailableSkills } from '../../battle/modules/skill.js';
import type { SkillData } from '../../battle/battleFactory.js';
import { createCharacterData, createMonsterData } from './battleTestUtils.js';

/**
 * 自研功法 passive 技能回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证 passive 光环技能在 battleFactory 装配后仍保留 triggerType=passive。
 * 2. 做什么：验证被动光环会在 startBattle 开场立即生效，且不会进入主动技能可用列表。
 * 3. 不做什么：不覆盖完整伤害公式，也不验证 UI 技能栏展示。
 *
 * 输入/输出：
 * - 输入：一个主动技能 + 一个排在后面的被动光环技能。
 * - 输出：BattleEngine 启动后的单位属性与可用技能列表断言。
 *
 * 数据流/状态流：
 * SkillData(trigger_type=passive) -> createPVEBattle -> BattleSkill.triggerType -> startBattle/processPassiveSkills -> roundStart 光环结算。
 *
 * 关键边界条件与坑点：
 * 1. 被动技能故意放在主动技能后面，确保不依赖技能栏轮到前才生效。
 * 2. 断言同时覆盖“开场自动生效”和“不会进入主动轮转”两个症状，避免只修一半。
 */

const ACTIVE_SKILL: SkillData = {
  id: 'skill-active-self-buff',
  name: '聚气诀',
  cost_lingqi: 0,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 0,
  target_type: 'self',
  target_count: 1,
  damage_type: 'none',
  element: 'none',
  effects: [],
  trigger_type: 'active',
  ai_priority: 60,
};

const PASSIVE_AURA_SKILL: SkillData = {
  id: 'skill-passive-aura-entry',
  name: '玄门护体阵',
  cost_lingqi: 0,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 0,
  target_type: 'self',
  target_count: 1,
  damage_type: 'none',
  element: 'none',
  effects: [
    {
      type: 'buff',
      buffKind: 'aura',
      auraTarget: 'all_ally',
      auraEffects: [
        {
          type: 'buff',
          buffKind: 'attr',
          attrKey: 'wugong',
          applyType: 'flat',
          value: 25,
          duration: 1,
        },
      ],
      duration: 1,
    },
  ],
  trigger_type: 'passive',
  ai_priority: 10,
};

test('被动光环在进入战斗时立即生效，且不会进入主动技能轮转', () => {
  const player = createCharacterData(1);
  const monster = createMonsterData('passive-aura-monster');
  const state = createPVEBattle(
    'battle-passive-aura-entry',
    player,
    [ACTIVE_SKILL, PASSIVE_AURA_SKILL],
    [monster],
    { [monster.id]: [] },
  );

  const attacker = state.teams.attacker.units[0];
  assert.ok(attacker, '应成功创建攻击方单位');

  const passiveSkill = attacker.skills.find((skill) => skill.id === PASSIVE_AURA_SKILL.id);
  assert.equal(passiveSkill?.triggerType, 'passive');

  const engine = new BattleEngine(state);
  engine.startBattle();

  assert.equal(attacker.currentAttrs.wugong, attacker.baseAttrs.wugong + 25);

  const availableSkillIds = getAvailableSkills(attacker).map((skill) => skill.id);
  assert.deepEqual(
    availableSkillIds,
    ['skill-normal-attack', ACTIVE_SKILL.id],
  );
});

test('光环技能即使被错误写成 active，进入战斗时也应强制按 passive 处理', () => {
  const player = createCharacterData(1);
  const monster = createMonsterData('passive-aura-monster-active-input');
  const wrongTriggerAuraSkill: SkillData = {
    ...PASSIVE_AURA_SKILL,
    id: 'skill-passive-aura-wrong-active',
    trigger_type: 'active',
  };

  const state = createPVEBattle(
    'battle-passive-aura-wrong-active',
    player,
    [ACTIVE_SKILL, wrongTriggerAuraSkill],
    [monster],
    { [monster.id]: [] },
  );

  const attacker = state.teams.attacker.units[0];
  assert.ok(attacker, '应成功创建攻击方单位');

  const auraSkill = attacker.skills.find((skill) => skill.id === wrongTriggerAuraSkill.id);
  assert.equal(auraSkill?.triggerType, 'passive');

  const engine = new BattleEngine(state);
  engine.startBattle();

  assert.equal(attacker.currentAttrs.wugong, attacker.baseAttrs.wugong + 25);

  const availableSkillIds = getAvailableSkills(attacker).map((skill) => skill.id);
  assert.deepEqual(
    availableSkillIds,
    ['skill-normal-attack', ACTIVE_SKILL.id],
  );
});
