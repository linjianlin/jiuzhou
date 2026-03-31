/**
 * 九州修仙录 - 战斗系统类型定义
 */

import type { SkillCostValue } from '../shared/skillCost.js';
import type { PartnerSkillPolicySlotDto } from '../services/shared/partnerSkillPolicy.js';

// ============================================
// 怪物AI配置
// ============================================
export type MonsterPhaseTriggerAction = 'enrage' | 'summon';

export interface MonsterAISummonTemplate {
  id: string;
  name: string;
  realm: string;
  element: string;
  baseAttrs: BattleAttrs;
  skills: BattleSkill[];
  aiProfile?: MonsterAIProfile;
}

export interface MonsterAIPhaseTrigger {
  id: string;
  hpPercent: number;
  action: MonsterPhaseTriggerAction;
  effects: SkillEffect[];
  summonMonsterId?: string;
  summonCount: number;
  summonTemplate?: MonsterAISummonTemplate;
}

export interface MonsterAIProfile {
  skillIds: string[];
  skillWeights: Record<string, number>;
  phaseTriggers: MonsterAIPhaseTrigger[];
}

// ============================================
// 战斗单位
// ============================================
export interface BattleUnit {
  id: string;
  name: string;
  type: 'player' | 'partner' | 'monster' | 'npc' | 'summon';
  sourceId: number | string;  // 原始数据ID（角色ID/怪物定义ID）
  monthCardActive?: boolean;
  avatar?: string | null;

  // 基础属性快照（战斗开始时从数据库读取）
  baseAttrs: BattleAttrs;
  // 当前属性（含Buff修正）
  currentAttrs: BattleAttrs;

  // 当前状态
  qixue: number;
  lingqi: number;

  // 护盾
  shields: Shield[];

  // Buff/Debuff
  buffs: ActiveBuff[];
  // 战斗印记（如：虚蚀印记）
  marks?: ActiveMark[];
  // 战斗势能（施法者侧连招资源）
  momentum?: ActiveMomentum | null;

  // 技能与冷却
  skills: BattleSkill[];
  skillCooldowns: Record<string, number>;
  skillCooldownDiscountBank: Record<string, number>;
  partnerSkillPolicy?: { slots: PartnerSkillPolicySlotDto[] };

  // 套装战斗效果（仅战斗期触发型效果）
  setBonusEffects: BattleSetBonusEffect[];
  // 词缀/套装按回合限次触发状态（如“同回合同词缀最多触发1次”）
  setBonusTriggerState?: BattleSetBonusTriggerState;
  // 承劫：延后结算的劫痕池
  deferredDamageState?: DeferredDamageState | null;
  // 踏虚：额外行动运行时
  extraActionState?: ExtraActionState | null;

  // 怪物AI配置（怪物/召唤物可选）
  aiProfile?: MonsterAIProfile;
  // 阶段触发去重（同一条phase trigger仅触发一次）
  triggeredPhaseIds?: string[];
  // 召唤关系（用于结算口径）
  isSummon?: boolean;
  summonerId?: string;

  // 控制递减（PVP用）
  controlDiminishing: Record<string, ControlDiminishing>;

  // 状态
  isAlive: boolean;
  canAct: boolean;

  // 战斗统计
  stats: BattleStats;
}

export interface BattleAttrs {
  max_qixue: number;
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
  jianbaoshang: number;
  jianfantan: number;
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
  realm?: string;
  element?: string;
}


export interface BattleStats {
  damageDealt: number;
  damageTaken: number;
  healingDone: number;
  healingReceived: number;
  killCount: number;
}

export interface DeferredDamageState {
  pool: number;
  remainingRounds: number;
  settleRate: number;
  lastSourceUnitId: string | null;
  damageType: 'physical' | 'magic' | null;
}

export interface ExtraActionState {
  charges: number;
  grantedThisRound: number;
  currentActionIsExtra: boolean;
}

export interface MagicSkillSnapshot {
  skillId: string;
  element: string | null;
  hitTargetIds: string[];
  primaryTargetId: string | null;
  averageFinalDamage: number;
  hitCount: number;
}

interface ControlDiminishing {
  count: number;
  resetRound: number;
}

// ============================================
// 护盾
// ============================================
export interface Shield {
  id: string;
  sourceSkillId: string;
  value: number;
  maxValue: number;
  duration: number;  // -1为永久
  absorbType: 'all' | 'physical' | 'magic';
  priority: number;
}

// ============================================
// 战斗印记
// ============================================
export interface ActiveMark {
  id: string;
  sourceUnitId: string;
  stacks: number;
  maxStacks: number;
  remainingDuration: number;
}

export interface ActiveMomentum {
  id: string;
  stacks: number;
  maxStacks: number;
}

// ============================================
// Buff/Debuff
// ============================================
export interface ActiveBuff {
  id: string;
  buffDefId: string;
  name: string;
  type: 'buff' | 'debuff';
  category: string;
  sourceUnitId: string;

  remainingDuration: number;
  stacks: number;
  maxStacks: number;

  attrModifiers?: AttrModifier[];
  dot?: DotEffect;
  hot?: HotEffect;
  reflectDamage?: ReflectDamageEffect;
  delayedBurst?: DelayedBurstEffect;
  dodgeNext?: DodgeNextEffect;
  nextSkillBonus?: NextSkillBonusEffect;
  healForbidden?: boolean;
  aura?: AuraEffect;
  control?: string;

  tags: string[];
  dispellable: boolean;
}

export interface AttrModifier {
  attr: string;
  value: number;
  mode: 'flat' | 'percent';
}

export interface DotEffect {
  damage: number;
  damageType: 'physical' | 'magic' | 'true';
  element?: string;
  bonusTargetMaxQixueRate?: number;
}

export interface HotEffect {
  heal: number;
}

export interface ReflectDamageEffect {
  rate: number;
}

export interface DelayedBurstEffect {
  damage: number;
  damageType: 'physical' | 'magic' | 'true';
  element?: string;
  remainingRounds: number;
}

export interface DodgeNextEffect {
  guaranteedMiss: true;
}

export interface NextSkillBonusEffect {
  rate: number;
  bonusType: 'damage' | 'heal' | 'shield' | 'resource' | 'all';
}

/** 光环作用范围 */
export type AuraTargetType = 'all_ally' | 'all_enemy' | 'self';

/**
 * 光环子效果（数值已在创建时快照解析）
 *
 * 作用：描述光环每回合对范围目标施加的单个子效果，数值在光环创建时按施法者属性快照计算。
 * 输入：由 skill.ts 的 resolveAuraSubEffects 构建。
 * 输出：由 buff.ts 的 processAuraEffect 在每回合结算时消费。
 *
 * 坑点：
 * 1) resolvedValue 是快照值，不随施法者后续属性变化而变化。
 * 2) buff/debuff 子效果的 attrModifiers 等运行时数据也在创建时快照，子 Buff duration 固定 1 回合。
 */
export interface AuraSubEffect {
  type: 'damage' | 'heal' | 'buff' | 'debuff' | 'resource' | 'restore_lingqi';
  resolvedValue: number;
  // damage 子效果
  damageType?: 'physical' | 'magic' | 'true';
  element?: string;
  // buff/debuff 子效果
  buffDefId?: string;
  buffType?: 'buff' | 'debuff';
  attrModifiers?: AttrModifier[];
  dot?: DotEffect;
  hot?: HotEffect;
  healForbidden?: boolean;
  // resource 子效果
  resourceType?: 'lingqi' | 'qixue';
}

/** 光环运行时效果（挂在施法者的 ActiveBuff 上） */
export interface AuraEffect {
  auraTarget: AuraTargetType;
  effects: AuraSubEffect[];
  damageType?: 'physical' | 'magic' | 'true';
  element?: string;
}

// ============================================
// 技能
// ============================================
export interface BattleSkill {
  id: string;
  name: string;
  source: 'innate' | 'technique' | 'equipment' | 'item';
  sourceId?: string;

  cost: SkillCostValue;
  cooldown: number;

  targetType: SkillTargetType;
  targetCount: number;

  damageType?: 'physical' | 'magic' | 'true';
  element: string;

  effects: SkillEffect[];
  conditions?: SkillConditions;

  triggerType: 'active' | 'passive' | 'counter' | 'chase';
  aiPriority: number;
}

type SkillTargetType =
  | 'self'
  | 'single_enemy'
  | 'single_ally'
  | 'all_enemy'
  | 'all_ally'
  | 'random_enemy'
  | 'random_ally';

export interface SkillEffect {
  type:
  | 'damage'
  | 'heal'
  | 'shield'
  | 'buff'
  | 'debuff'
  | 'dispel'
  | 'resource'
  | 'restore_lingqi'
  | 'cleanse'
  | 'cleanse_control'
  | 'lifesteal'
  | 'control'
  | 'mark'
  | 'momentum'
  | 'delayed_burst'
  | 'fate_swap';
  value?: number;
  valueType?: 'flat' | 'percent' | 'scale' | 'combined';
  baseValue?: number;  // 固定基础值（用于 combined 模式）
  scaleAttr?: string;
  scaleRate?: number;
  buffKey?: string;  // Buff唯一键（用于刷新/去重）
  buffKind?: string; // 扩展型 Buff 类别（attr/dot/hot/dodge_next/reflect_damage/heal_forbid/next_skill_bonus/...）
  attrKey?: string;  // buffKind=attr 时的属性键
  applyType?: 'flat' | 'percent'; // buffKind=attr 时的叠加模式
  duration?: number;
  stacks?: number;
  bonusTargetMaxQixueRate?: number;  // 额外附加目标最大气血比例伤害（用于灼烧等持续伤害）
  dispelType?: 'buff' | 'debuff' | 'all';
  count?: number;
  controlType?: string;
  chance?: number;  // 概率（0~1，1=100%）
  resourceType?: 'lingqi' | 'qixue';  // 资源类型
  target?: 'self' | 'enemy' | 'ally';
  damageType?: 'physical' | 'magic' | 'true';
  element?: string;
  hit_count?: number;
  markId?: string;
  operation?: 'apply' | 'consume' | 'gain';
  maxStacks?: number;
  consumeMode?: 'all' | 'fixed';
  consumeStacks?: number;
  perStackRate?: number;
  resultType?: 'damage' | 'shield_self' | 'heal_self';
  momentumId?: string;
  gainStacks?: number;
  bonusType?: 'damage' | 'heal' | 'shield' | 'resource' | 'all';
  swapMode?: 'debuff_to_target' | 'buff_to_self' | 'shield_steal';
  // 光环子效果配置（buffKind='aura' 时使用）
  auraTarget?: 'all_ally' | 'all_enemy' | 'self';
  auraEffects?: SkillEffect[];
}

interface SkillConditions {
  minQixuePercent?: number;
  maxQixuePercent?: number;
  requireBuff?: string;
  requireDebuff?: string;
}

export interface BattleSetBonusTriggerState {
  round: number;
  counts: Record<string, number>;
}

export type BattleSetBonusTrigger =
  | 'on_turn_start'
  | 'on_skill'
  | 'after_skill'
  | 'on_hit'
  | 'on_ally_hit'
  | 'on_crit'
  | 'on_be_hit'
  | 'on_heal';

export interface BattleSetBonusEffect {
  setId: string;
  setName: string;
  pieceCount: number;
  trigger: BattleSetBonusTrigger;
  target: 'self' | 'enemy';
  effectType:
  | 'buff'
  | 'debuff'
  | 'damage'
  | 'heal'
  | 'resource'
  | 'shield'
  | 'mark'
  | 'pursuit'
  | 'spell_projection'
  | 'defer_damage'
  | 'extra_action';
  durationRound?: number;
  element?: string;
  params: Record<string, unknown>;
}

// ============================================
// 战斗状态
// ============================================
export interface BattleState {
  battleId: string;
  battleType: 'pve' | 'pvp';
  /**
   * 技能冷却推进口径。
   * - round_start: 旧口径，回合开始时全体统一递减（仅用于恢复旧存档时识别迁移来源）
   * - self_action_end: 新口径，单位行动结束后仅推进自身冷却
   */
  cooldownTimingMode?: 'round_start' | 'self_action_end';

  teams: {
    attacker: BattleTeam;
    defender: BattleTeam;
  };

  roundCount: number;
  currentTeam: 'attacker' | 'defender';
  /**
   * 当前应行动单位的 ID。
   * 替代原 currentUnitIndex（数组下标），避免行动过程中有单位死亡导致列表缩短、
   * 下标漂移、跳过后续单位的 bug。null 表示当前队伍无可行动单位。
   */
  currentUnitId: string | null;
  phase: 'roundStart' | 'action' | 'roundEnd' | 'finished';

  firstMover: 'attacker' | 'defender';

  result?: 'attacker_win' | 'defender_win' | 'draw';
  rewards?: BattleRewards;

  // 防作弊：服务端随机种子
  randomSeed: number;
  randomIndex: number;
}

interface BattleTeam {
  odwnerId?: number;  // 玩家用户ID
  units: BattleUnit[];
  totalSpeed: number;
}

// ============================================
// 战斗日志
// ============================================
export type BattleLogEntry =
  | ActionLog
  | DotLog
  | HotLog
  | BuffExpireLog
  | DeathLog
  | RoundLog
  | AuraLog;

export interface ActionLog {
  type: 'action';
  round: number;
  actorId: string;
  actorName: string;
  skillId: string;
  skillName: string;
  targets: TargetResult[];
}

export interface TargetHitResult {
  index: number;
  damage: number;
  isMiss: boolean;
  isCrit: boolean;
  isParry: boolean;
  isElementBonus: boolean;
  shieldAbsorbed: number;
}

export interface TargetResult {
  targetId: string;
  targetName: string;
  hits: TargetHitResult[];
  damage?: number;
  heal?: number;
  resources?: TargetResourceResult[];
  isMiss?: boolean;
  isCrit?: boolean;
  isParry?: boolean;
  isElementBonus?: boolean;
  shieldAbsorbed?: number;
  buffsApplied?: string[];
  buffsRemoved?: string[];
  marksApplied?: string[];
  marksConsumed?: string[];
  momentumGained?: string[];
  momentumConsumed?: string[];
  controlApplied?: string;
  controlResisted?: boolean;
}

export interface TargetResourceResult {
  type: 'qixue' | 'lingqi';
  amount: number;
}

interface DotLog {
  type: 'dot';
  round: number;
  unitId: string;
  unitName: string;
  buffName: string;
  damage: number;
}

interface HotLog {
  type: 'hot';
  round: number;
  unitId: string;
  unitName: string;
  buffName: string;
  heal: number;
}

interface BuffExpireLog {
  type: 'buff_expire';
  round: number;
  unitId: string;
  unitName: string;
  buffName: string;
}

interface DeathLog {
  type: 'death';
  round: number;
  unitId: string;
  unitName: string;
  killerId?: string;
  killerName?: string;
}

export interface RoundLog {
  type: 'round_start' | 'round_end';
  round: number;
}

/**
 * 光环回合结算日志
 *
 * 作用：记录光环每回合对范围目标施加子效果的结果。
 * 数据流：processAuraEffect -> AuraLog -> battle log stream。
 *
 * 坑点：
 * 1) subResults 可能为空（所有目标已死亡时光环仍在但无有效目标）。
 * 2) unitId 是光环持有者，不是受影响目标。
 */
export interface AuraLog {
  type: 'aura';
  round: number;
  unitId: string;
  unitName: string;
  buffName: string;
  auraTarget: string;
  subResults: AuraSubResult[];
}

export interface AuraSubResult {
  targetId: string;
  targetName: string;
  damage?: number;
  heal?: number;
  buffsApplied?: string[];
  resources?: TargetResourceResult[];
}

// ============================================
// 战斗奖励
// ============================================
interface BattleRewards {
  exp: number;
  silver: number;
  items: Array<{
    itemDefId: string;
    quantity: number;
  }>;
}

// ============================================
// 伤害计算结果
// ============================================
export interface DamageResult {
  damage: number;
  isMiss: boolean;
  isParry: boolean;
  isCrit: boolean;
  isElementBonus: boolean;
  shieldAbsorbed: number;
  actualDamage: number;  // 扣血后的实际伤害
}

// ============================================
// 战斗常量
// ============================================
export const BATTLE_CONSTANTS = {
  MAX_ROUNDS_PVE: 100,
  MAX_ROUNDS_PVP: 100,

  MIN_HIT_RATE: 0.2,
  MAX_HIT_RATE: 1,
  MAX_DODGE_RATE: 0.8,
  MAX_PARRY_RATE: 0.6,
  PARRY_REDUCTION: 0.7,

  MAX_CRIT_RATE: 1,
  MAX_CRIT_DAMAGE: 3,
  MAX_CRIT_RESIST: 0.8,

  MAX_DAMAGE_BONUS: 1,
  MAX_HEAL_BONUS: 1,
  MAX_HEAL_REDUCTION: 0.8,
  HEAL_CAP_PERCENT: 0.5,

  MAX_LIFESTEAL: 0.5,
  MAX_CONTROL_RESIST: 0.8,
  CONTROL_DIMINISHING_RESET: 5,

  ELEMENT_COUNTER_BONUS: 0.15,
  MAX_ELEMENT_RESIST: 0.8,

  BASE_LINGQI_REGEN: 10,

  // 防御结算常量：最终伤害倍率 = K / (防御 + K)
  DEFENSE_DAMAGE_K: 1200,

  ELEMENT_COUNTER: {
    'jin': 'mu',
    'mu': 'tu',
    'tu': 'shui',
    'shui': 'huo',
    'huo': 'jin',
  } as Record<string, string>,
} as const;
