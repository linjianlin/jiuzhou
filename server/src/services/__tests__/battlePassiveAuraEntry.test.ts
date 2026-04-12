import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleEngine } from '../../battle/battleEngine.js';
import { createPVEBattle } from '../../battle/battleFactory.js';
import { executeSkill, getAvailableSkills } from '../../battle/modules/skill.js';
import { BATTLE_CONSTANTS } from '../../battle/types.js';
import type { BattleSkill, SkillEffect } from '../../battle/types.js';
import type { SkillData } from '../../battle/battleFactory.js';
import type { PartnerBattleMember } from '../shared/partnerBattleMember.js';
import type { SkillDefConfig } from '../staticConfigLoader.js';
import { buildEffectiveTechniqueSkillData } from '../shared/techniqueSkillProgression.js';
import { asActionLog, consumeBattleLogs, createCharacterData, createMonsterData, createState, createUnit } from './battleTestUtils.js';

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

const createPassiveAuraBattleSkill = (id: string, auraEffects: SkillEffect[]): BattleSkill => ({
  id,
  name: id,
  source: 'technique',
  cost: {},
  cooldown: 0,
  targetType: 'self',
  targetCount: 1,
  damageType: undefined,
  element: 'none',
  effects: [{
    type: 'buff',
    buffKind: 'aura',
    buffKey: 'buff-aura',
    auraTarget: 'all_ally',
    auraEffects,
  }],
  triggerType: 'passive',
  aiPriority: 10,
});

const createPassiveAuraSkillData = (params: {
  id: string;
  name: string;
  attrKey: 'wugong' | 'fagong';
  value: number;
}): SkillData => ({
  id: params.id,
  name: params.name,
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
          attrKey: params.attrKey,
          applyType: 'flat',
          value: params.value,
          duration: 1,
        },
      ],
      duration: 1,
    },
  ],
  trigger_type: 'passive',
  ai_priority: 10,
});

const createPartnerMember = (skills: SkillData[], skillPolicy: PartnerBattleMember['skillPolicy']): PartnerBattleMember => ({
  data: createCharacterData(101, {
    nickname: '伙伴甲',
    realm: '',
    sub_realm: null,
  }),
  skills,
  skillPolicy,
});

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

test('伙伴开场光环触发顺序应与策略排序一致', () => {
  const player = createCharacterData(1);
  const monster = createMonsterData('partner-passive-aura-order');
  const auraSkillA = createPassiveAuraSkillData({
    id: 'skill-partner-aura-a',
    name: '先天气环',
    attrKey: 'wugong',
    value: 20,
  });
  const auraSkillB = createPassiveAuraSkillData({
    id: 'skill-partner-aura-b',
    name: '后发灵环',
    attrKey: 'fagong',
    value: 35,
  });
  const state = createPVEBattle(
    'battle-partner-passive-aura-order',
    player,
    [ACTIVE_SKILL],
    [monster],
    { [monster.id]: [] },
    {
      partnerMember: createPartnerMember(
        [auraSkillA, auraSkillB],
        {
          slots: [
            { skillId: auraSkillB.id, priority: 1, enabled: true },
            { skillId: auraSkillA.id, priority: 2, enabled: true },
          ],
        },
      ),
    },
  );

  const partner = state.teams.attacker.units[0];
  assert.equal(partner?.type, 'partner');

  const engine = new BattleEngine(state);
  engine.startBattle();

  assert.equal(partner.currentAttrs.wugong, partner.baseAttrs.wugong + 20);
  assert.equal(partner.currentAttrs.fagong, partner.baseAttrs.fagong + 35);

  const actionSkillIds = consumeBattleLogs(state)
    .filter((log) => log.type === 'action')
    .map((log) => asActionLog(log).skillId)
    .filter((skillId) => skillId === auraSkillA.id || skillId === auraSkillB.id);

  assert.deepEqual(actionSkillIds, [auraSkillB.id, auraSkillA.id]);
});

test('伙伴策略禁用的光环不应在开场自动触发', () => {
  const player = createCharacterData(1);
  const monster = createMonsterData('partner-passive-aura-disabled');
  const enabledAuraSkill = createPassiveAuraSkillData({
    id: 'skill-partner-enabled-aura',
    name: '护身灵环',
    attrKey: 'wugong',
    value: 18,
  });
  const disabledAuraSkill = createPassiveAuraSkillData({
    id: 'skill-partner-disabled-aura',
    name: '封存灵环',
    attrKey: 'fagong',
    value: 28,
  });
  const state = createPVEBattle(
    'battle-partner-passive-aura-disabled',
    player,
    [ACTIVE_SKILL],
    [monster],
    { [monster.id]: [] },
    {
      partnerMember: createPartnerMember(
        [enabledAuraSkill, disabledAuraSkill],
        {
          slots: [
            { skillId: disabledAuraSkill.id, priority: 1, enabled: false },
            { skillId: enabledAuraSkill.id, priority: 2, enabled: true },
          ],
        },
      ),
    },
  );

  const partner = state.teams.attacker.units[0];
  assert.equal(partner?.type, 'partner');

  const engine = new BattleEngine(state);
  engine.startBattle();

  assert.equal(partner.currentAttrs.wugong, partner.baseAttrs.wugong + 18);
  assert.equal(partner.currentAttrs.fagong, partner.baseAttrs.fagong);

  const actionSkillIds = consumeBattleLogs(state)
    .filter((log) => log.type === 'action')
    .map((log) => asActionLog(log).skillId);

  assert.ok(actionSkillIds.includes(enabledAuraSkill.id));
  assert.ok(!actionSkillIds.includes(disabledAuraSkill.id));
});

test('光环获得摘要中的比率属性应按百分比显示，避免 flat 比率被写成 +0', () => {
  const caster = createUnit({ id: 'player-1', name: '施法者' });
  const enemy = createUnit({ id: 'monster-1', name: '敌人', type: 'monster' });
  const state = createState({
    attacker: [caster],
    defender: [enemy],
  });

  const auraSkill: BattleSkill = {
    id: 'skill-active-aura-log',
    name: '鎏金灵环',
    source: 'technique',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    damageType: 'magic',
    element: 'huo',
    effects: [
      {
        type: 'buff' as const,
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'all_ally' as const,
        duration: 2,
        auraEffects: [
          {
            type: 'buff' as const,
            buffKind: 'attr',
            buffKey: 'buff-zengshang-up',
            attrKey: 'zengshang',
            applyType: 'flat' as const,
            value: 0.1,
          },
          {
            type: 'buff' as const,
            buffKind: 'attr',
            buffKey: 'buff-fagong-up',
            attrKey: 'fagong',
            applyType: 'percent' as const,
            value: 0.06,
          },
          {
            type: 'restore_lingqi' as const,
            value: 4,
          },
        ],
      },
    ],
    triggerType: 'active' as const,
    aiPriority: 60,
  };
  caster.skills = [auraSkill];

  const result = executeSkill(state, caster, auraSkill, [caster.id]);
  assert.equal(result.success, true);

  const actionLog = asActionLog(consumeBattleLogs(state)[0]);
  assert.equal(
    actionLog.targets[0]?.buffsApplied?.[0],
    '增益光环（全体友方：增伤提升+10%、法攻提升+6%、灵气+4）',
  );
});

test('同一施法者的多个不同光环应同时挂载并分别生效', () => {
  const caster = createUnit({
    id: 'player-aura-owner',
    name: '灵阵师',
  });
  const ally = createUnit({
    id: 'player-aura-target',
    name: '同伴',
    attrs: {
      wugong: 120,
      fagong: 180,
    },
  });
  const enemy = createUnit({
    id: 'monster-aura-target',
    name: '敌人',
    type: 'monster',
  });

  caster.skills = [
    createPassiveAuraBattleSkill('skill-aura-wugong-up', [{
      type: 'buff',
      buffKind: 'attr',
      buffKey: 'buff-wugong-up',
      attrKey: 'wugong',
      applyType: 'flat',
      value: 20,
    }]),
    createPassiveAuraBattleSkill('skill-aura-fagong-up', [{
      type: 'buff',
      buffKind: 'attr',
      buffKey: 'buff-fagong-up',
      attrKey: 'fagong',
      applyType: 'flat',
      value: 30,
    }]),
  ];

  const state = createState({
    attacker: [caster, ally],
    defender: [enemy],
  });
  const engine = new BattleEngine(state);

  engine.startBattle();

  assert.equal(caster.buffs.filter((buff) => buff.aura).length, 2, '两个光环宿主 Buff 都应保留');
  assert.equal(ally.currentAttrs.wugong, ally.baseAttrs.wugong + 20);
  assert.equal(ally.currentAttrs.fagong, ally.baseAttrs.fagong + 30);
});

test('同一施法者的多个同类光环应保留最强子效果，而不是被最后一条覆盖', () => {
  const caster = createUnit({
    id: 'player-aura-owner-2',
    name: '灵阵师乙',
  });
  const ally = createUnit({
    id: 'player-aura-target-2',
    name: '同伴乙',
    attrs: {
      fagong: 200,
    },
  });
  const enemy = createUnit({
    id: 'monster-aura-target-2',
    name: '敌人乙',
    type: 'monster',
  });

  caster.skills = [
    createPassiveAuraBattleSkill('skill-aura-fagong-strong', [{
      type: 'buff',
      buffKind: 'attr',
      buffKey: 'buff-fagong-up',
      attrKey: 'fagong',
      applyType: 'percent',
      value: 0.2,
    }]),
    createPassiveAuraBattleSkill('skill-aura-fagong-weak', [{
      type: 'buff',
      buffKind: 'attr',
      buffKey: 'buff-fagong-up',
      attrKey: 'fagong',
      applyType: 'percent',
      value: 0.1,
    }]),
  ];

  const state = createState({
    attacker: [caster, ally],
    defender: [enemy],
  });
  const engine = new BattleEngine(state);

  engine.startBattle();

  assert.equal(ally.currentAttrs.fagong, 240, '应保留 20% 强光环，不应被后面的 10% 覆盖');
});

test('升级后的光环子效果进入战斗时应按升级值生效', () => {
  const techniqueSkillDef: SkillDefConfig = {
    id: 'skill-upgraded-passive-aura',
    name: '曜金灵环',
    source_type: 'technique',
    target_type: 'self',
    target_count: 1,
    damage_type: 'none',
    element: 'huo',
    effects: [
      {
        type: 'buff',
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'self',
        auraEffects: [
          {
            type: 'buff',
            buffKind: 'attr',
            buffKey: 'buff-fagong-up',
            attrKey: 'fagong',
            applyType: 'percent',
            value: 0.06,
          },
        ],
      },
    ],
    trigger_type: 'passive',
    upgrades: [
      {
        layer: 1,
        changes: {
          effects: [
            {
              type: 'buff',
              buffKind: 'aura',
              buffKey: 'buff-aura',
              auraTarget: 'self',
              auraEffects: [
                {
                  type: 'buff',
                  buffKind: 'attr',
                  buffKey: 'buff-fagong-up',
                  attrKey: 'fagong',
                  applyType: 'percent',
                  value: 0.06,
                },
                {
                  type: 'buff',
                  buffKind: 'attr',
                  buffKey: 'buff-zengshang-up',
                  attrKey: 'zengshang',
                  applyType: 'flat',
                  value: 0.1,
                },
              ],
            },
          ],
        },
      },
    ],
  };

  const effectiveSkill = buildEffectiveTechniqueSkillData(techniqueSkillDef, 1);
  const passiveAuraSkill: SkillData = {
    id: techniqueSkillDef.id,
    name: techniqueSkillDef.name,
    cost_lingqi: effectiveSkill.cost_lingqi,
    cost_lingqi_rate: effectiveSkill.cost_lingqi_rate,
    cost_qixue: effectiveSkill.cost_qixue,
    cost_qixue_rate: effectiveSkill.cost_qixue_rate,
    cooldown: effectiveSkill.cooldown,
    target_type: techniqueSkillDef.target_type,
    target_count: effectiveSkill.target_count,
    damage_type: techniqueSkillDef.damage_type ?? 'none',
    element: techniqueSkillDef.element ?? 'none',
    effects: effectiveSkill.effects,
    trigger_type: 'passive',
    ai_priority: effectiveSkill.ai_priority,
  };

  const player = createCharacterData(1);
  const monster = createMonsterData('passive-aura-upgrade-monster');
  const state = createPVEBattle(
    'battle-passive-aura-upgrade',
    player,
    [ACTIVE_SKILL, passiveAuraSkill],
    [monster],
    { [monster.id]: [] },
  );

  const attacker = state.teams.attacker.units[0];
  assert.ok(attacker, '应成功创建攻击方单位');

  const engine = new BattleEngine(state);
  engine.startBattle();

  const logs = consumeBattleLogs(state);
  const auraLog = logs.find((log) => log.type === 'aura');
  if (!auraLog || auraLog.type !== 'aura') {
    assert.fail('期望产生 aura 日志');
  }

  assert.equal(attacker.currentAttrs.fagong, Math.floor(attacker.baseAttrs.fagong * 1.06));
  assert.equal(attacker.currentAttrs.zengshang, 0.1);
  assert.deepEqual(
    auraLog.subResults[0]?.buffsApplied,
    ['法攻提升+6%', '增伤提升+10%'],
  );
});

test('减益光环宿主不应计入自身减益，但仍应正常压制敌方', () => {
  const caster = createUnit({
    id: 'player-debuff-aura-owner',
    name: '潮幕使',
  });
  const enemy = createUnit({
    id: 'monster-debuff-aura-target',
    name: '噬潮妖',
    type: 'monster',
    attrs: {
      fagong: 200,
    },
  });

  const debuffAuraSkill: BattleSkill = {
    id: 'skill-debuff-aura-host-type',
    name: '阑潮蝶幕',
    source: 'technique',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    damageType: 'magic',
    element: 'shui',
    effects: [
      {
        type: 'debuff',
        target: 'self',
        buffKind: 'aura',
        buffKey: 'debuff-aura',
        auraTarget: 'all_enemy',
        auraEffects: [
          {
            type: 'debuff',
            buffKind: 'attr',
            buffKey: 'debuff-fagong-down',
            attrKey: 'fagong',
            applyType: 'percent',
            value: 0.12,
          },
        ],
      },
    ],
    triggerType: 'passive',
    aiPriority: 80,
  };
  caster.skills = [debuffAuraSkill];

  const state = createState({
    attacker: [caster],
    defender: [enemy],
  });
  const engine = new BattleEngine(state);

  engine.startBattle();

  const auraHostBuff = caster.buffs.find((buff) => Boolean(buff.aura));
  assert.ok(auraHostBuff, '应成功挂载光环宿主 Buff');
  assert.equal(auraHostBuff.type, 'buff', '减益光环宿主只作为范围效果容器，不应记为自身减益');
  assert.equal(
    caster.buffs.filter((buff) => buff.type === 'debuff').length,
    0,
    '宿主身上不应因为减益光环额外增加 debuff 计数',
  );
  assert.equal(enemy.currentAttrs.fagong, 176, '敌方应正常吃到 12% 法攻压制');
});

test('旧减益光环子效果缺失 target 且误写成 buff 时，仍应按敌方减益结算', () => {
  const caster = createUnit({
    id: 'player-legacy-debuff-aura-owner',
    name: '玄潮使',
  });
  const enemy = createUnit({
    id: 'monster-legacy-debuff-aura-target',
    name: '海渊魇影',
    type: 'monster',
    attrs: {
      mingzhong: 0.3,
      sudu: 160,
    },
  });

  const legacyDebuffAuraSkill: BattleSkill = {
    id: 'skill-legacy-debuff-aura-target-default',
    name: '玄潮蚀域',
    source: 'technique',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    damageType: 'magic',
    element: 'shui',
    effects: [
      {
        type: 'debuff',
        buffKind: 'aura',
        buffKey: 'debuff-aura',
        auraTarget: 'all_enemy',
        auraEffects: [
          {
            type: 'buff',
            buffKind: 'attr',
            buffKey: 'debuff-mingzhong-down',
            attrKey: 'mingzhong',
            applyType: 'percent',
            value: 0.15,
          },
          {
            type: 'buff',
            buffKind: 'attr',
            buffKey: 'debuff-sudu-down',
            attrKey: 'sudu',
            applyType: 'flat',
            value: 30,
          },
        ],
      },
    ],
    triggerType: 'passive',
    aiPriority: 80,
  };
  caster.skills = [legacyDebuffAuraSkill];

  const state = createState({
    attacker: [caster],
    defender: [enemy],
  });
  const engine = new BattleEngine(state);

  engine.startBattle();

  const auraHostBuff = caster.buffs.find((buff) => Boolean(buff.aura));
  assert.ok(auraHostBuff, '未显式写 target 的减益光环也应先挂载宿主 Buff');
  assert.equal(enemy.currentAttrs.mingzhong, 0.15, '旧数据里的命中压制应按减益方向结算');
  assert.equal(enemy.currentAttrs.sudu, 130, '旧数据里的减速光环应真正压到敌方速度');
});

test('光环造成的直接伤害应吃防御属性减伤', () => {
  const caster = createUnit({
    id: 'player-aura-damage-owner',
    name: '曜环使',
    attrs: {
      fagong: 320,
    },
  });
  const enemy = createUnit({
    id: 'monster-aura-damage-target',
    name: '玄甲傀',
    type: 'monster',
    attrs: {
      fafang: 300,
    },
  });

  const directDamageAuraSkill: BattleSkill = {
    id: 'skill-direct-damage-aura',
    name: '曜火灵环',
    source: 'technique',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    damageType: 'magic',
    element: 'huo',
    effects: [
      {
        type: 'buff',
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'all_enemy',
        auraEffects: [
          {
            type: 'damage',
            valueType: 'flat',
            value: 200,
            damageType: 'magic',
          },
        ],
      },
    ],
    triggerType: 'passive',
    aiPriority: 70,
  };
  caster.skills = [directDamageAuraSkill];

  const state = createState({
    attacker: [caster],
    defender: [enemy],
  });
  const engine = new BattleEngine(state);
  const initialQixue = enemy.qixue;
  const expectedDamage = Math.floor(200 * (1 - (300 / (300 + BATTLE_CONSTANTS.DEFENSE_DAMAGE_K))));

  engine.startBattle();

  const auraLog = consumeBattleLogs(state).find((log) => log.type === 'aura');
  if (!auraLog || auraLog.type !== 'aura') {
    assert.fail('期望产生 aura 日志');
  }

  assert.equal(auraLog.subResults[0]?.damage, expectedDamage, '光环直伤日志应记录减伤后的最终值');
  assert.equal(enemy.qixue, initialQixue - expectedDamage, '光环直伤应按法防减伤后再扣血');
});
