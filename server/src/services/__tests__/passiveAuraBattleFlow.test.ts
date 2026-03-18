/**
 * 作用：
 * - 校验 passive 光环在战斗开始时自动生效，不会进入主动可释放技能池。
 * - 用一条完整战斗链路同时覆盖方案一和方案二落地后的真实行为。
 *
 * 输入/输出：
 * - 输入：带被动光环和主动伤害技的最小 PVE 战斗数据。
 * - 输出：战斗开始后的单位状态、可用技能列表和 AI 选技结果。
 *
 * 数据流：
 * - SkillData 进入 battleFactory 转成 BattleSkill。
 * - BattleEngine.startBattle 自动执行 passive。
 * - getAvailableSkills / AI 只能看到 active 技能。
 *
 * 边界条件与坑点：
 * 1. 光环日志应该表现为 `aura` 结算，而不是角色把回合花在重新施法上。
 * 2. 被动技能即使存在于 skills 中，也不能被 AI 选为正常行动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPVEBattle, type CharacterData, type MonsterData, type SkillData } from '../../battle/battleFactory.js';
import { BattleEngine } from '../../battle/battleEngine.js';
import { getAvailableSkills } from '../../battle/modules/skill.js';
import { makeAIDecision } from '../../battle/modules/ai.js';

const createPlayerData = (): CharacterData => ({
  user_id: 1,
  id: 101,
  nickname: '镜主',
  realm: '炼气',
  sub_realm: null,
  attribute_element: 'shui',
  qixue: 1200,
  max_qixue: 1200,
  lingqi: 100,
  max_lingqi: 100,
  wugong: 80,
  fagong: 220,
  wufang: 80,
  fafang: 120,
  sudu: 150,
  mingzhong: 0.95,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 1.5,
  jianbaoshang: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
});

const createMonster = (): MonsterData => ({
  id: 'monster-sandbag',
  name: '木桩妖',
  realm: '炼气',
  element: 'none',
  base_attrs: {
    qixue: 800,
    max_qixue: 800,
    lingqi: 0,
    max_lingqi: 0,
    wugong: 50,
    fagong: 50,
    wufang: 50,
    fafang: 50,
    sudu: 60,
    mingzhong: 0.95,
  },
  exp_reward: 0,
  silver_reward_min: 0,
  silver_reward_max: 0,
});

const passiveAuraSkill: SkillData = {
  id: 'skill-passive-mirror-aura',
  name: '镜月常明',
  cost_lingqi: 0,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 0,
  target_type: 'self',
  target_count: 1,
  damage_type: 'magic',
  element: 'shui',
  effects: [
    {
      type: 'buff',
      buffKind: 'aura',
      auraTarget: 'self',
      auraEffects: [
        { type: 'restore_lingqi', value: 8 },
        {
          type: 'buff',
          buffKind: 'attr',
          attrKey: 'fagong',
          applyType: 'percent',
          value: 0.08,
          duration: 1,
        },
      ],
    },
    {
      type: 'debuff',
      buffKind: 'aura',
      auraTarget: 'all_enemy',
      auraEffects: [
        {
          type: 'debuff',
          buffKind: 'attr',
          attrKey: 'sudu',
          applyType: 'flat',
          value: 10,
          duration: 1,
        },
      ],
    },
  ],
  trigger_type: 'passive',
  ai_priority: 90,
};

const activeStrikeSkill: SkillData = {
  id: 'skill-active-water-strike',
  name: '水月击',
  cost_lingqi: 10,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 0,
  target_type: 'single_enemy',
  target_count: 1,
  damage_type: 'magic',
  element: 'shui',
  effects: [
    {
      type: 'damage',
      valueType: 'flat',
      value: 120,
      damageType: 'magic',
      element: 'shui',
    },
  ],
  trigger_type: 'active',
  ai_priority: 70,
};

test('被动光环开场自动生效，AI 只会选择主动技能', () => {
  const battle = createPVEBattle(
    'battle-passive-aura',
    createPlayerData(),
    [passiveAuraSkill, activeStrikeSkill],
    [createMonster()],
    { 'monster-sandbag': [] },
  );

  const engine = new BattleEngine(battle);
  engine.startBattle();

  const state = engine.getState();
  const player = state.teams.attacker.units[0];
  const enemy = state.teams.defender.units[0];
  assert.ok(player);
  assert.ok(enemy);

  const auraSkill = player.skills.find((skill) => skill.id === 'skill-passive-mirror-aura');
  const strikeSkill = player.skills.find((skill) => skill.id === 'skill-active-water-strike');
  assert.equal(auraSkill?.triggerType, 'passive');
  assert.equal(strikeSkill?.triggerType, 'active');

  const auraBuffs = player.buffs.filter((buff) => buff.aura);
  assert.equal(auraBuffs.length, 2);
  assert.ok(auraBuffs.every((buff) => buff.remainingDuration === -1));

  const availableSkills = getAvailableSkills(player);
  assert.deepEqual(
    availableSkills.map((skill) => skill.id),
    ['skill-normal-attack', 'skill-active-water-strike'],
  );

  const aiDecision = makeAIDecision(state, player);
  assert.equal(aiDecision.skill.id, 'skill-active-water-strike');

  const auraLogs = state.logs.filter((log) => log.type === 'aura');
  assert.ok(auraLogs.length >= 1);

  const enemySpeedDebuff = enemy.buffs.find((buff) =>
    buff.attrModifiers?.some((modifier) => modifier.attr === 'sudu' && modifier.value === -10),
  );
  assert.ok(enemySpeedDebuff);
});
