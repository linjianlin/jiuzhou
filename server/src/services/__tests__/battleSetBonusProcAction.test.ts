import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeBattleLogDelta } from '../../battle/logStream.js';
import { triggerSetBonusEffects } from '../../battle/modules/setBonus.js';
import { executeSkill } from '../../battle/modules/skill.js';
import type {
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleSkill,
  BattleState,
  BattleUnit,
} from '../../battle/types.js';

const createAttrs = () => ({
  max_qixue: 1200,
  max_lingqi: 240,
  wugong: 300,
  fagong: 220,
  wufang: 120,
  fafang: 110,
  sudu: 100,
  mingzhong: 0.95,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 0,
  jianbaoshang: 0,
  jianfantan: 0,
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

const createUnit = (id: string, name: string, effects: BattleSetBonusEffect[] = []): BattleUnit => {
  const attrs = createAttrs();
  return {
    id,
    name,
    type: 'player',
    sourceId: Number(id.replace(/\D/g, '')) || 1,
    baseAttrs: { ...attrs },
    currentAttrs: { ...attrs },
    qixue: attrs.max_qixue,
    lingqi: 80,
    shields: [],
    buffs: [],
    skills: [],
    skillCooldowns: {},
    skillCooldownDiscountBank: {},
    setBonusEffects: effects,
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
      killCount: 0,
    },
  };
};

const createState = (attacker: BattleUnit, defender: BattleUnit): BattleState => ({
  battleId: 'battle-test-proc',
  battleType: 'pve',
  teams: {
    attacker: {
      odwnerId: 1,
      units: [attacker],
      totalSpeed: attacker.currentAttrs.sudu,
    },
    defender: {
      odwnerId: 2,
      units: [defender],
      totalSpeed: defender.currentAttrs.sudu,
    },
  },
  roundCount: 1,
  currentTeam: 'attacker',
  currentUnitId: null,
  phase: 'action',
  firstMover: 'attacker',
  randomSeed: 1,
  randomIndex: 0,
});

const createTeamState = (attackers: BattleUnit[], defenders: BattleUnit[]): BattleState => ({
  battleId: 'battle-test-proc-team',
  battleType: 'pve',
  teams: {
    attacker: {
      odwnerId: 1,
      units: attackers,
      totalSpeed: attackers.reduce((sum, unit) => sum + unit.currentAttrs.sudu, 0),
    },
    defender: {
      odwnerId: 2,
      units: defenders,
      totalSpeed: defenders.reduce((sum, unit) => sum + unit.currentAttrs.sudu, 0),
    },
  },
  roundCount: 1,
  currentTeam: 'attacker',
  currentUnitId: null,
  phase: 'action',
  firstMover: 'attacker',
  randomSeed: 1,
  randomIndex: 0,
});

const assertActionLog = (
  log: BattleLogEntry | undefined
): Extract<BattleLogEntry, { type: 'action' }> => {
  if (!log) {
    assert.fail('缺少触发日志');
  }
  if (log.type !== 'action') {
    assert.fail(`期望 action 日志，实际为 ${log.type}`);
  }
  return log;
};

test('触发词条命中后应产出独立action日志', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-100-proc_zhuihun',
    setName: '赤焰枪·追魂斩',
    pieceCount: 1,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
  chance: 1,
      value: 120,
      damage_type: 'true',
    },
  };
  const owner = createUnit('player-1', '测试剑修', [effect]);
  const target = createUnit('monster-1', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, { target, damage: 150 });
  const actionLog = assertActionLog(logs[0]);
  assert.match(actionLog.skillId, /^proc-/);
  assert.equal(actionLog.skillName, '赤焰枪·追魂斩');
  assert.equal(actionLog.actorName, '测试剑修');
  assert.equal(actionLog.targets.length, 1);
  assert.equal(actionLog.targets[0]?.targetName, '木桩妖');
  assert.equal(actionLog.targets[0]?.hits.length, 1);
  assert.ok((actionLog.targets[0]?.hits[0]?.damage ?? 0) > 0);
});

test('灵气触发词条应在独立action日志中记录资源变化', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-101-proc_lingchao',
    setName: '玄玉佩·灵潮息',
    pieceCount: 1,
    trigger: 'on_turn_start',
    target: 'self',
    effectType: 'resource',
    params: {
      chance: 1,
      resource_type: 'lingqi',
      value: 18,
    },
  };
  const owner = createUnit('player-2', '测试法修', [effect]);
  owner.lingqi = 50;
  const target = createUnit('monster-2', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_turn_start', owner);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets.length, 1);
  assert.deepEqual(actionLog.targets[0]?.resources, [{ type: 'lingqi', amount: 18 }]);
  assert.equal(owner.lingqi, 68);
});

test('同词条多件装备应合并概率且单次触发（不重复生效）', () => {
  const lowTier: BattleSetBonusEffect = {
    setId: 'affix-301-proc_hushen',
    setName: '青藤甲·护心诀',
    pieceCount: 1,
    trigger: 'on_be_hit',
    target: 'self',
    effectType: 'heal',
    params: {
      affix_key: 'proc_hushen',
      chance: 1,
      value: 80,
    },
  };
  const highTier: BattleSetBonusEffect = {
    setId: 'affix-302-proc_hushen',
    setName: '玄鳞甲·护心诀',
    pieceCount: 1,
    trigger: 'on_be_hit',
    target: 'self',
    effectType: 'heal',
    params: {
      affix_key: 'proc_hushen',
      chance: 1,
      value: 120,
    },
  };

  const owner = createUnit('player-4', '测试体修', [lowTier, highTier]);
  owner.qixue = 600;
  const target = createUnit('monster-4', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_be_hit', owner, { target });
  assert.equal(logs.length, 1, '同词条只应产出一次action日志');

  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.heal, 120, '同词条不重复触发，应按单次效果结算');
  assert.equal(owner.qixue, 720, '护心诀应只治疗一次');
});

test('技能与词条触发日志应按时机排序（主动作在前，on_skill触发在后）', () => {
  const onSkillEffect: BattleSetBonusEffect = {
    setId: 'affix-201-proc_lingchao',
    setName: '青玉冠·灵潮息',
    pieceCount: 1,
    trigger: 'on_skill',
    target: 'self',
    effectType: 'resource',
    params: {
      chance: 1,
      resource_type: 'lingqi',
      value: 10,
    },
  };
  const owner = createUnit('player-3', '测试道修', [onSkillEffect]);
  owner.lingqi = 40;
  const target = createUnit('monster-3', '木桩妖', []);
  const state = createState(owner, target);
  const skill: BattleSkill = {
    id: 'skill-test-normal',
    name: '试剑式',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'physical',
    element: 'none',
    effects: [
      {
        type: 'damage',
        value: 80,
        valueType: 'flat',
      },
    ],
    triggerType: 'active',
    aiPriority: 50,
  };

  const result = executeSkill(state, owner, skill, [target.id]);
  assert.equal(result.success, true);
  const logs = consumeBattleLogDelta(state.battleId).logs;
  assert.equal(logs.length >= 2, true);

  const firstLog = logs[0];
  const secondLog = logs[1];
  const firstAction = assertActionLog(firstLog);
  const secondAction = assertActionLog(secondLog);

  assert.equal(firstAction.skillId, 'skill-test-normal');
  assert.match(secondAction.skillId, /^proc-/);
  assert.equal(secondAction.skillName, '青玉冠·灵潮息');
});

test('echo伤害词条应按本次命中伤害比例结算真伤', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-601-proc_huixiang',
    setName: '太虚回锋',
    pieceCount: 1,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
      chance: 1,
      damage_type: 'echo',
      value: 0.3,
    },
  };
  const owner = createUnit('player-6', '测试剑修', [effect]);
  const target = createUnit('monster-6', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, { target, damage: 200 });
  assert.equal(logs.length, 1);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.hits[0]?.damage, 60);
});

test('echo伤害词条缺失本次命中伤害时不应生效', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-602-proc_huixiang',
    setName: '太虚回锋',
    pieceCount: 1,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
      chance: 1,
      damage_type: 'echo',
      value: 0.3,
    },
  };
  const owner = createUnit('player-7', '测试剑修', [effect]);
  const target = createUnit('monster-7', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, { target });
  assert.equal(logs.length, 0);
});

test('reflect反击词条应继承来源伤害类型并受目标物防减免', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-603-proc_fansha',
    setName: '反煞甲',
    pieceCount: 1,
    trigger: 'on_be_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
      chance: 1,
      damage_type: 'reflect',
      value: 0.5,
    },
  };
  const owner = createUnit('player-7', '测试体修', [effect]);
  const target = createUnit('monster-7', '木桩妖', []);
  target.currentAttrs.wufang = 200;
  target.baseAttrs.wufang = 200;
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_be_hit', owner, {
    target,
    damage: 200,
    damageType: 'physical',
  });
  assert.equal(logs.length, 1);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.hits[0]?.damage, 80);
});

test('damage_echo护盾词条应按本次受击伤害比例生成护盾', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-701-proc_xuangang',
    setName: '玄罡回璧',
    pieceCount: 1,
    trigger: 'on_be_hit',
    target: 'self',
    effectType: 'shield',
    durationRound: 2,
    params: {
      chance: 1,
      shield_mode: 'damage_echo',
      value: 0.5,
    },
  };
  const owner = createUnit('player-8', '测试体修', [effect]);
  const target = createUnit('monster-8', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_be_hit', owner, { target, damage: 120 });
  assert.equal(logs.length, 1);
  assert.equal(owner.shields.length, 1);
  assert.equal(owner.shields[0]?.value, 60);
  assert.equal(owner.shields[0]?.maxValue, 60);
  assert.equal(owner.shields[0]?.duration, 2);
});

test('on_hit印记词条应写入 marksApplied 日志并施加到目标', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'set-taixu',
    setName: '太虚套装',
    pieceCount: 4,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'mark',
    params: {
      chance: 1,
      operation: 'apply',
      mark_id: 'void_erosion',
      max_stacks: 5,
    },
  };
  const owner = createUnit('player-10', '测试剑修', [effect]);
  const target = createUnit('monster-10', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, { target, damage: 120 });
  assert.equal(logs.length, 1);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.marksApplied?.length, 1);
  assert.match(actionLog.targets[0]?.marksApplied?.[0] ?? '', /虚蚀印记/);
  assert.equal(target.marks?.length, 1);
  assert.equal(target.marks?.[0]?.sourceUnitId, owner.id);
});

test('on_crit印记引爆词条应写入 marksConsumed 并造成伤害', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'set-taixu',
    setName: '太虚套装',
    pieceCount: 8,
    trigger: 'on_crit',
    target: 'enemy',
    effectType: 'mark',
    params: {
      chance: 1,
      operation: 'consume',
      mark_id: 'void_erosion',
      consume_mode: 'all',
      per_stack_rate: 0.4,
      result_type: 'damage',
      value: 100,
    },
  };
  const owner = createUnit('player-11', '测试剑修', [effect]);
  const target = createUnit('monster-11', '木桩妖', []);
  target.marks = [
    {
      id: 'void_erosion',
      sourceUnitId: owner.id,
      stacks: 3,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_crit', owner, { target, damage: 180 });
  assert.equal(logs.length, 1);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.marksConsumed?.length, 1);
  assert.ok((actionLog.targets[0]?.damage ?? 0) > 0);
  assert.equal(target.marks?.length, 0);
});

test('on_be_hit印记转护盾词条应写入 marksConsumed 并为自身加盾', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'set-zhenhun',
    setName: '镇魂套装',
    pieceCount: 8,
    trigger: 'on_be_hit',
    target: 'enemy',
    effectType: 'mark',
    params: {
      chance: 1,
      operation: 'consume',
      mark_id: 'void_erosion',
      consume_mode: 'fixed',
      consume_stacks: 2,
      per_stack_rate: 1,
      result_type: 'shield_self',
      value: 100,
    },
  };
  const owner = createUnit('player-12', '测试体修', [effect]);
  const attacker = createUnit('monster-12', '木桩妖', []);
  attacker.marks = [
    {
      id: 'void_erosion',
      sourceUnitId: owner.id,
      stacks: 2,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];
  const state = createState(owner, attacker);

  const logs = triggerSetBonusEffects(state, 'on_be_hit', owner, { target: attacker, damage: 200 });
  assert.equal(logs.length, 1);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets[0]?.marksConsumed?.length, 1);
  assert.equal(owner.shields.length, 1);
  assert.ok((owner.shields[0]?.value ?? 0) > 0);
  assert.equal(attacker.marks?.length, 0);
});

test('队友命中后应由词缀佩戴者触发协锋追击', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-801-proc_tongqi',
    setName: '协锋追击',
    pieceCount: 1,
    trigger: 'on_ally_hit',
    target: 'enemy',
    effectType: 'pursuit',
    params: {
      affix_key: 'proc_tongqi',
      chance: 1,
      value: 0.4,
      scale_key: 'main_attack',
      damage_type: 'main_attack',
      round_limit: 1,
    },
  };
  const owner = createUnit('player-20', '连携者', [effect]);
  owner.currentAttrs.wugong = 500;
  owner.baseAttrs.wugong = 500;
  owner.currentAttrs.fagong = 180;
  owner.baseAttrs.fagong = 180;
  owner.currentAttrs.mingzhong = 1;
  owner.baseAttrs.mingzhong = 1;
  const ally = createUnit('player-21', '先手队友', []);
  const target = createUnit('monster-20', '木桩妖', []);
  target.currentAttrs.wufang = 0;
  target.baseAttrs.wufang = 0;
  target.currentAttrs.fafang = 0;
  target.baseAttrs.fafang = 0;
  const state = createTeamState([owner, ally], [target]);
  const skill: BattleSkill = {
    id: 'skill-team-hit',
    name: '协同起手',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'physical',
    element: 'none',
    effects: [
      {
        type: 'damage',
        value: 80,
        valueType: 'flat',
      },
    ],
    triggerType: 'active',
    aiPriority: 50,
  };

  const result = executeSkill(state, ally, skill, [target.id]);
  assert.equal(result.success, true);

  const logs = consumeBattleLogDelta(state.battleId).logs;
  assert.equal(logs.length >= 2, true);
  const pursuitLog = assertActionLog(logs[1]);
  assert.equal(pursuitLog.actorName, '连携者');
  assert.equal(pursuitLog.skillName, '协锋追击');
  assert.equal(pursuitLog.targets[0]?.targetName, '木桩妖');
  assert.equal(pursuitLog.targets[0]?.hits[0]?.damage, 200);
});

test('协锋追击同回合同词缀只应触发一次', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-802-proc_tongqi',
    setName: '协锋追击',
    pieceCount: 1,
    trigger: 'on_ally_hit',
    target: 'enemy',
    effectType: 'pursuit',
    params: {
      affix_key: 'proc_tongqi',
      chance: 1,
      value: 0.4,
      scale_key: 'main_attack',
      damage_type: 'main_attack',
      round_limit: 1,
    },
  };
  const owner = createUnit('player-22', '连携者', [effect]);
  owner.currentAttrs.wugong = 500;
  owner.baseAttrs.wugong = 500;
  const target = createUnit('monster-22', '木桩妖', []);
  const state = createState(owner, target);

  const firstLogs = triggerSetBonusEffects(state, 'on_ally_hit', owner, { target });
  const secondLogs = triggerSetBonusEffects(state, 'on_ally_hit', owner, { target });

  assert.equal(firstLogs.length, 1);
  assert.equal(secondLogs.length, 0);
});

test('协锋追击跨回合后应重置触发次数', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-803-proc_tongqi',
    setName: '协锋追击',
    pieceCount: 1,
    trigger: 'on_ally_hit',
    target: 'enemy',
    effectType: 'pursuit',
    params: {
      affix_key: 'proc_tongqi',
      chance: 1,
      value: 0.4,
      scale_key: 'main_attack',
      damage_type: 'main_attack',
      round_limit: 1,
    },
  };
  const owner = createUnit('player-23', '连携者', [effect]);
  owner.currentAttrs.wugong = 500;
  owner.baseAttrs.wugong = 500;
  const target = createUnit('monster-23', '木桩妖', []);
  const state = createState(owner, target);

  const roundOneLogs = triggerSetBonusEffects(state, 'on_ally_hit', owner, { target });
  state.roundCount = 2;
  const roundTwoLogs = triggerSetBonusEffects(state, 'on_ally_hit', owner, { target });

  assert.equal(roundOneLogs.length, 1);
  assert.equal(roundTwoLogs.length, 1);
});
