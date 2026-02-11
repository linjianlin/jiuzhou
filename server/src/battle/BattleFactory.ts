/**
 * 九州修仙录 - 战斗工厂
 * 从数据库数据创建战斗状态
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleAttrs,
  BattleSkill,
  BattleStats,
  BattleSetBonusEffect
} from './types.js';
import { generateBattleSeed, getNextRandom } from './utils/random.js';
import { getNormalAttack } from './modules/skill.js';

// 角色数据接口（来自数据库）
export interface CharacterData {
  user_id: number;
  id: number;
  nickname: string;
  realm: string;
  attribute_element: string;
  qixue: number;
  max_qixue: number;
  lingqi: number;
  max_lingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  sudu: number;
  mingzhong: number;
  shanbi: number;
  zhaojia: number;
  baoji: number;
  baoshang: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
  kongzhi_kangxing: number;
  jin_kangxing: number;
  mu_kangxing: number;
  shui_kangxing: number;
  huo_kangxing: number;
  tu_kangxing: number;
  qixue_huifu: number;
  lingqi_huifu: number;
  setBonusEffects?: BattleSetBonusEffect[];
}

// 怪物数据接口（来自数据库）
export interface MonsterData {
  id: string;
  name: string;
  realm: string;
  element: string;
  attr_variance?: number | string;
  attr_multiplier_min?: number | string;
  attr_multiplier_max?: number | string;
  // 属性存储在 base_attrs JSONB 字段中
  base_attrs: {
    qixue?: number;
    max_qixue?: number;
    lingqi?: number;
    max_lingqi?: number;
    wugong?: number;
    fagong?: number;
    wufang?: number;
    fafang?: number;
    sudu?: number;
    mingzhong?: number;
    shanbi?: number;
    zhaojia?: number;
    baoji?: number;
    baoshang?: number;
    kangbao?: number;
    zengshang?: number;
    zhiliao?: number;
    jianliao?: number;
    xixue?: number;
    lengque?: number;
    kongzhi_kangxing?: number;
    jin_kangxing?: number;
    mu_kangxing?: number;
    shui_kangxing?: number;
    huo_kangxing?: number;
    tu_kangxing?: number;
    qixue_huifu?: number;
    lingqi_huifu?: number;
  };
  skills?: string[];
  exp_reward: number;
  silver_reward_min: number;
  silver_reward_max: number;
  drop_pool_id?: string;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function applyMonsterEncounterScaling(state: BattleState, base: BattleAttrs, monster: MonsterData): BattleAttrs {
  const variance = clampNumber(toNumber(monster.attr_variance, 0.05), 0, 1);
  const minMul = toNumber(monster.attr_multiplier_min, 0.9);
  const maxMul = toNumber(monster.attr_multiplier_max, 1.1);
  const low = Math.min(minMul, maxMul);
  const high = Math.max(minMul, maxMul);
  const overallMultiplier = low + getNextRandom(state) * (high - low);

  const keys: Array<keyof BattleAttrs> = [
    'max_qixue',
    'max_lingqi',
    'wugong',
    'fagong',
    'wufang',
    'fafang',
    'sudu',
    'mingzhong',
    'shanbi',
    'zhaojia',
    'baoji',
    'baoshang',
    'kangbao',
    'zengshang',
    'zhiliao',
    'jianliao',
    'xixue',
    'lengque',
    'kongzhi_kangxing',
    'jin_kangxing',
    'mu_kangxing',
    'shui_kangxing',
    'huo_kangxing',
    'tu_kangxing',
    'qixue_huifu',
    'lingqi_huifu',
  ];

  const next: BattleAttrs = { ...base };
  for (const k of keys) {
    const raw = Number((base as any)[k]) || 0;
    const wave = variance > 0 ? (getNextRandom(state) * 2 - 1) * variance : 0;
    const factor = (1 + wave) * overallMultiplier;
    const scaled = Math.round(raw * factor);
    (next as any)[k] = Math.max(0, scaled);
  }

  next.max_qixue = Math.max(1, next.max_qixue);
  next.max_lingqi = Math.max(0, next.max_lingqi);
  next.sudu = Math.max(1, next.sudu);
  next.mingzhong = Math.max(0, next.mingzhong);
  next.realm = base.realm;
  next.element = base.element;
  return next;
}

// 技能数据接口
export interface SkillData {
  id: string;
  name: string;
  cost_lingqi: number;
  cost_qixue: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string;
  element: string;
  effects: any[];
  ai_priority: number;
}

/**
 * 创建PVE战斗状态（支持单人或组队多人）
 */
export function createPVEBattle(
  battleId: string,
  playerData: CharacterData,
  playerSkills: SkillData[],
  monsters: MonsterData[],
  monsterSkillsMap: Record<string, SkillData[]>,
  teamMembers?: Array<{ data: CharacterData; skills: SkillData[] }>
): BattleState {
  const randomSeed = generateBattleSeed();
  // 创建玩家单位列表
  const playerUnits: BattleUnit[] = [];
  
  // 主玩家（队长或单人）
  const mainPlayerUnit = createPlayerUnit(playerData, playerSkills);
  playerUnits.push(mainPlayerUnit);
  
  // 队友单位
  if (teamMembers && teamMembers.length > 0) {
    for (const member of teamMembers) {
      const memberUnit = createPlayerUnit(member.data, member.skills);
      playerUnits.push(memberUnit);
    }
  }

  const state: BattleState = {
    battleId,
    battleType: 'pve',
    teams: {
      attacker: {
        odwnerId: playerData.user_id,
        units: playerUnits,
        totalSpeed: 0,
      },
      defender: {
        units: [],
        totalSpeed: 0,
      },
    },
    roundCount: 0,
    currentTeam: 'attacker',
    currentUnitIndex: 0,
    phase: 'roundStart',
    firstMover: 'attacker',
    logs: [],
    randomSeed,
    randomIndex: 0,
  };

  const monsterUnits = monsters.map((m, index) =>
    createMonsterUnit(state, m, monsterSkillsMap[m.id] || [], index)
  );
  state.teams.defender.units = monsterUnits;

  state.teams.attacker.totalSpeed = playerUnits.reduce((sum, u) => sum + u.currentAttrs.sudu, 0);
  state.teams.defender.totalSpeed = monsterUnits.reduce((sum, u) => sum + u.currentAttrs.sudu, 0);
  
  return state;
}

/**
 * 创建PVP战斗状态
 */
export function createPVPBattle(
  battleId: string,
  player1Data: CharacterData,
  player1Skills: SkillData[],
  player2Data: CharacterData,
  player2Skills: SkillData[],
  options?: { defenderUnitType?: 'player' | 'npc' }
): BattleState {
  const player1Unit = createPlayerUnit(player1Data, player1Skills);
  const defenderUnitType = options?.defenderUnitType ?? 'player';
  const player2Unit = defenderUnitType === 'npc'
    ? createNpcUnit(player2Data, player2Skills)
    : createPlayerUnit(player2Data, player2Skills);
  
  const state: BattleState = {
    battleId,
    battleType: 'pvp',
    teams: {
      attacker: {
        odwnerId: player1Data.user_id,
        units: [player1Unit],
        totalSpeed: player1Unit.currentAttrs.sudu,
      },
      defender: {
        odwnerId: defenderUnitType === 'player' ? player2Data.user_id : undefined,
        units: [player2Unit],
        totalSpeed: player2Unit.currentAttrs.sudu,
      },
    },
    roundCount: 0,
    currentTeam: 'attacker',
    currentUnitIndex: 0,
    phase: 'roundStart',
    firstMover: 'attacker',
    logs: [],
    randomSeed: generateBattleSeed(),
    randomIndex: 0,
  };
  
  return state;
}

/**
 * 创建玩家战斗单位
 */
function createPlayerUnit(data: CharacterData, skills: SkillData[]): BattleUnit {
  return createCharacterUnit(data, skills, 'player');
}

function createNpcUnit(data: CharacterData, skills: SkillData[]): BattleUnit {
  return createCharacterUnit(data, skills, 'npc');
}

function createCharacterUnit(data: CharacterData, skills: SkillData[], type: 'player' | 'npc'): BattleUnit {
  const attrs = extractAttrs(data);
  const battleSkills = skills.map(convertSkillData);
  
  // 确保有普通攻击
  const hasNormalAttack = battleSkills.some(s => s.id === 'skill-normal-attack');
  if (!hasNormalAttack) {
    const normalAttack = getNormalAttack({
      currentAttrs: attrs,
    } as BattleUnit);
    battleSkills.unshift(normalAttack);
  }
  
  return {
    id: `${type}-${data.id}`,
    name: data.nickname,
    type,
    sourceId: data.id,
    baseAttrs: { ...attrs },
    currentAttrs: attrs,
    qixue: data.qixue,
    lingqi: data.lingqi,
    shields: [],
    buffs: [],
    setBonusEffects: Array.isArray(data.setBonusEffects) ? data.setBonusEffects : [],
    skills: battleSkills,
    skillCooldowns: {},
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: createEmptyStats(),
  };
}

/**
 * 创建怪物战斗单位
 */
function createMonsterUnit(state: BattleState, data: MonsterData, skills: SkillData[], index: number): BattleUnit {
  const attrs = extractMonsterAttrs(data);
  const finalAttrs = applyMonsterEncounterScaling(state, attrs, data);
  const battleSkills = skills.map(convertSkillData);
  
  // 确保有普通攻击
  const hasNormalAttack = battleSkills.some(s => s.id === 'skill-normal-attack');
  if (!hasNormalAttack) {
    const normalAttack = getNormalAttack({
      currentAttrs: finalAttrs,
    } as BattleUnit);
    battleSkills.unshift(normalAttack);
  }
  
  return {
    id: `monster-${data.id}-${index}`,
    name: data.name,
    type: 'monster',
    sourceId: data.id,
    baseAttrs: { ...finalAttrs },
    currentAttrs: finalAttrs,
    qixue: finalAttrs.max_qixue,
    lingqi: finalAttrs.max_lingqi,
    shields: [],
    buffs: [],
    setBonusEffects: [],
    skills: battleSkills,
    skillCooldowns: {},
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: createEmptyStats(),
  };
}

/**
 * 提取角色属性
 */
function extractAttrs(data: CharacterData): BattleAttrs {
  return {
    max_qixue: data.max_qixue,
    max_lingqi: data.max_lingqi,
    wugong: data.wugong,
    fagong: data.fagong,
    wufang: data.wufang,
    fafang: data.fafang,
    sudu: data.sudu,
    mingzhong: data.mingzhong,
    shanbi: data.shanbi,
    zhaojia: data.zhaojia,
    baoji: data.baoji,
    baoshang: data.baoshang,
    kangbao: data.kangbao,
    zengshang: data.zengshang,
    zhiliao: data.zhiliao,
    jianliao: data.jianliao,
    xixue: data.xixue,
    lengque: data.lengque,
    kongzhi_kangxing: data.kongzhi_kangxing,
    jin_kangxing: data.jin_kangxing,
    mu_kangxing: data.mu_kangxing,
    shui_kangxing: data.shui_kangxing,
    huo_kangxing: data.huo_kangxing,
    tu_kangxing: data.tu_kangxing,
    qixue_huifu: data.qixue_huifu,
    lingqi_huifu: data.lingqi_huifu,
    realm: data.realm,
    element: data.attribute_element,
  };
}

/**
 * 提取怪物属性（从 base_attrs JSONB 字段）
 */
function extractMonsterAttrs(data: MonsterData): BattleAttrs {
  const attrs = data.base_attrs || {};
  
  return {
    max_qixue: attrs.max_qixue || attrs.qixue || 100,
    max_lingqi: attrs.max_lingqi || attrs.lingqi || 0,
    wugong: attrs.wugong || 0,
    fagong: attrs.fagong || 0,
    wufang: attrs.wufang || 0,
    fafang: attrs.fafang || 0,
    sudu: attrs.sudu || 1,
    mingzhong: attrs.mingzhong || 9000,
    shanbi: attrs.shanbi || 0,
    zhaojia: attrs.zhaojia || 0,
    baoji: attrs.baoji || 0,
    baoshang: attrs.baoshang ?? 0,
    kangbao: attrs.kangbao || 0,
    zengshang: attrs.zengshang || 0,
    zhiliao: attrs.zhiliao || 0,
    jianliao: attrs.jianliao || 0,
    xixue: attrs.xixue || 0,
    lengque: attrs.lengque || 0,
    kongzhi_kangxing: attrs.kongzhi_kangxing || 0,
    jin_kangxing: attrs.jin_kangxing || 0,
    mu_kangxing: attrs.mu_kangxing || 0,
    shui_kangxing: attrs.shui_kangxing || 0,
    huo_kangxing: attrs.huo_kangxing || 0,
    tu_kangxing: attrs.tu_kangxing || 0,
    qixue_huifu: attrs.qixue_huifu || 0,
    lingqi_huifu: attrs.lingqi_huifu || 0,
    realm: data.realm || '凡人',
    element: data.element || 'none',
  };
}

/**
 * 转换技能数据
 */
function convertSkillData(data: SkillData): BattleSkill {
  return {
    id: data.id,
    name: data.name,
    source: 'innate',
    cost: {
      lingqi: data.cost_lingqi || 0,
      qixue: data.cost_qixue || 0,
    },
    cooldown: data.cooldown || 0,
    targetType: (data.target_type || 'single_enemy') as any,
    targetCount: data.target_count || 1,
    damageType: data.damage_type as any,
    element: data.element || 'none',
    effects: data.effects || [],
    triggerType: 'active',
    aiPriority: data.ai_priority || 50,
  };
}

/**
 * 创建空统计
 */
function createEmptyStats(): BattleStats {
  return {
    damageDealt: 0,
    damageTaken: 0,
    healingDone: 0,
    healingReceived: 0,
    killCount: 0,
  };
}

/**
 * 计算战斗奖励
 */
export function calculateRewards(
  state: BattleState,
  monsters: MonsterData[],
  _playerRealm: string
): { exp: number; silver: number; drops: Array<{ itemDefId: string; quantity: number }> } {
  if (state.result !== 'attacker_win') {
    return { exp: 0, silver: 0, drops: [] };
  }
  
  let totalExp = 0;
  let totalSilver = 0;
  const drops: Array<{ itemDefId: string; quantity: number }> = [];
  
  for (const monster of monsters) {
    // 经验
    totalExp += monster.exp_reward;
    
    // 银两
    const silverRange = monster.silver_reward_max - monster.silver_reward_min;
    totalSilver += monster.silver_reward_min + Math.floor(Math.random() * (silverRange + 1));
    
    // 掉落（需要查询掉落池，这里简化处理）
    // TODO: 实现掉落池查询
  }
  
  return { exp: totalExp, silver: totalSilver, drops };
}
