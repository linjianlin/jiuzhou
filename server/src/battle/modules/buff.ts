/**
 * 九州修仙录 - Buff/Debuff 管理模块
 */

import type {
  BattleState,
  BattleUnit,
  BattleAttrs,
  ActiveBuff,
  DelayedBurstEffect,
  DotEffect,
  HotEffect,
  NextSkillBonusEffect,
  ReflectDamageEffect,
  Shield,
  BattleLogEntry,
  AuraSubEffect,
  AuraLog,
  AuraSubResult,
  AuraTargetType,
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { applyDamage } from './damage.js';
import { applyHealing } from './healing.js';
import { applySoulShackleRecoveryReduction } from './mark.js';
import { appendBattleLog } from '../logStream.js';
import { buildAuraSubEffectSummary } from '../utils/auraSummary.js';
import { buildAuraSubRuntimeBuffKey, resolveAuraSubRuntimeGroupKey } from '../utils/buffSpec.js';
import { CHARACTER_RATIO_ATTR_KEY_SET } from '../../services/shared/characterAttrRegistry.js';

/**
 * 计算 Buff 强度分值
 *
 * 作用：
 * 1. 为“同类光环效果取最高”提供统一比较口径，避免属性重算、DOT/HOT、反伤等消费端各自比较。
 * 2. 只比较当前运行时真正参与结算的数值字段，不引入额外兜底规则。
 * 3. 不做什么：不负责决定 Buff 是否可共存，只输出用于排序的强度分值。
 *
 * 输入/输出：
 * - 输入：单个 ActiveBuff。
 * - 输出：>= 0 的数值分值；分值越大表示效果越强。
 *
 * 数据流/状态流：
 * ActiveBuff 运行时快照 -> 读取 attr/dot/hot/reflect 等字段 -> 汇总为单一强度分值 -> 供光环聚合函数复用。
 *
 * 关键边界条件与坑点：
 * 1. Debuff 的属性值通常为负数，这里必须按绝对值比较，否则 `-30` 会被错误判成比 `-10` 更弱。
 * 2. 同类光环效果应保持“同 key 比强度”，不应跨 buffDefId 比较，所以这里只负责强度，不负责分组。
 */
function calculateBuffStrengthScore(buff: ActiveBuff): number {
  let score = 0;

  for (const modifier of buff.attrModifiers ?? []) {
    score += Math.abs(modifier.value * Math.max(1, buff.stacks));
  }

  if (buff.dot) {
    score += Math.abs(buff.dot.damage);
    if (typeof buff.dot.bonusTargetMaxQixueRate === 'number') {
      score += Math.abs(buff.dot.bonusTargetMaxQixueRate);
    }
  }

  if (buff.hot) {
    score += Math.abs(buff.hot.heal);
  }

  if (buff.reflectDamage) {
    score += Math.abs(buff.reflectDamage.rate);
  }

  if (buff.delayedBurst) {
    score += Math.abs(buff.delayedBurst.damage);
  }

  if (buff.dodgeNext) {
    score += Math.max(1, buff.stacks);
  }

  if (buff.nextSkillBonus) {
    score += Math.abs(buff.nextSkillBonus.rate);
  }

  if (buff.healForbidden) {
    score += 1;
  }

  if (buff.control) {
    score += 1;
  }

  return score;
}

function resolveAuraSubEffectGroupKey(buff: ActiveBuff): string | null {
  if (buff.category !== 'aura') return null;
  if (!buff.tags.includes('aura_sub')) return null;

  const groupKey = resolveAuraSubRuntimeGroupKey(buff.buffDefId);
  if (!groupKey) return null;

  return `${buff.type}:${groupKey}`;
}

/**
 * 获取当前真正参与结算的 Buff 列表
 *
 * 作用：
 * 1. 把“多个相同光环子效果取最高，不再叠加”集中成单一入口，供属性重算、回合效果、反伤/禁疗判断共同复用。
 * 2. 非光环 Buff 维持原有可叠加行为，避免把普通技能 Buff 误改成互斥。
 * 3. 不做什么：不修改原始 `unit.buffs` 数组，也不处理持续时间递减。
 *
 * 输入/输出：
 * - 输入：单位当前持有的 Buff 列表。
 * - 输出：去重后的“有效 Buff”数组；同类光环子 Buff 只保留强度最高的一条。
 *
 * 数据流/状态流：
 * unit.buffs -> 识别 aura_sub 分组 key -> 比较强度 -> 返回消费端统一复用的有效 Buff 列表。
 *
 * 关键边界条件与坑点：
 * 1. 光环子 Buff 仍需按来源分别保留在原始列表里，用于各自刷新/过期；这里只是在消费时做“同类取最高”。
 * 2. 同强度时优先保留持续时间更长的那条，避免数值相同但剩余时长更长的效果被短时 Buff 抢走。
 */
function collectEffectiveBuffs(buffs: readonly ActiveBuff[]): ActiveBuff[] {
  const effectiveBuffs: ActiveBuff[] = [];
  const auraBuffIndexByGroupKey = new Map<string, number>();

  for (const buff of buffs) {
    const groupKey = resolveAuraSubEffectGroupKey(buff);
    if (!groupKey) {
      effectiveBuffs.push(buff);
      continue;
    }

    const existingIndex = auraBuffIndexByGroupKey.get(groupKey);
    if (existingIndex == null) {
      auraBuffIndexByGroupKey.set(groupKey, effectiveBuffs.length);
      effectiveBuffs.push(buff);
      continue;
    }

    const existingBuff = effectiveBuffs[existingIndex];
    const nextScore = calculateBuffStrengthScore(buff);
    const existingScore = calculateBuffStrengthScore(existingBuff);
    if (nextScore > existingScore) {
      effectiveBuffs[existingIndex] = buff;
      continue;
    }
    if (nextScore === existingScore && buff.remainingDuration > existingBuff.remainingDuration) {
      effectiveBuffs[existingIndex] = buff;
    }
  }

  return effectiveBuffs;
}

/**
 * 添加Buff到单位
 *
 * 坑点1：刷新已有 Buff 时，若 stacks 发生变化，attrModifiers 的叠加值也会变化，
 *        必须重新计算属性，否则 currentAttrs 会与实际 stacks 不一致。
 * 坑点2：同 buffDefId 可能来自不同技能等级/来源，刷新时必须同步更新 runtime 数据，
 *        否则会出现“强效果覆盖弱效果失败”。
 */
export function addBuff(
  unit: BattleUnit,
  buff: Omit<ActiveBuff, 'remainingDuration' | 'stacks'>,
  duration: number,
  stacks: number = 1
): { added: boolean; refreshed: boolean } {
  // 查找已存在的同ID Buff
  const existingIndex = unit.buffs.findIndex(b => b.buffDefId === buff.buffDefId);

  if (existingIndex >= 0) {
    const existing = unit.buffs[existingIndex];

    // 刷新持续时间
    existing.remainingDuration = Math.max(existing.remainingDuration, duration);

    // 同 buffDefId 刷新时同步覆盖最新 runtime 数据
    existing.name = buff.name;
    existing.type = buff.type;
    existing.category = buff.category;
    existing.sourceUnitId = buff.sourceUnitId;
    existing.attrModifiers = buff.attrModifiers;
    existing.dot = buff.dot;
    existing.hot = buff.hot;
    existing.reflectDamage = buff.reflectDamage;
    existing.delayedBurst = buff.delayedBurst;
    existing.dodgeNext = buff.dodgeNext;
    existing.nextSkillBonus = buff.nextSkillBonus;
    existing.healForbidden = buff.healForbidden;
    existing.aura = buff.aura;
    existing.control = buff.control;
    existing.tags = [...buff.tags];
    existing.dispellable = buff.dispellable;

    existing.maxStacks = Math.max(1, buff.maxStacks);
    if (existing.maxStacks > 1) {
      existing.stacks = Math.min(existing.stacks + stacks, existing.maxStacks);
    } else {
      existing.stacks = 1;
    }

    recalculateUnitAttrs(unit);

    return { added: false, refreshed: true };
  }

  // 添加新Buff
  const newBuff: ActiveBuff = {
    ...buff,
    remainingDuration: duration,
    stacks: Math.min(stacks, buff.maxStacks),
  };

  unit.buffs.push(newBuff);

  // 重新计算属性
  recalculateUnitAttrs(unit);

  return { added: true, refreshed: false };
}

/**
 * 移除Buff
 */
export function removeBuff(unit: BattleUnit, buffId: string): boolean {
  const index = unit.buffs.findIndex(b => b.id === buffId);
  if (index < 0) return false;

  unit.buffs.splice(index, 1);
  recalculateUnitAttrs(unit);

  return true;
}

function resolveNextDodgeBuffScore(buff: ActiveBuff): number {
  const finiteDuration = buff.remainingDuration === -1 ? Number.MAX_SAFE_INTEGER : buff.remainingDuration;
  return finiteDuration * 1000 + Math.max(1, buff.stacks);
}

/**
 * 消耗“下一次闪避”类 Buff。
 *
 * 作用：
 * 1. 统一管理一次性闪避 Buff 的查找、减层与移除，避免伤害模块直接操作 buffs 数组。
 * 2. 优先消耗更早过期的 Buff，减少长时效 Buff 被短时效 Buff 抢先吞掉。
 *
 * 输入/输出：
 * - 输入：受击方 BattleUnit。
 * - 输出：是否成功消费到一个下一次闪避效果。
 *
 * 数据流：
 * - damage.ts 在直接伤害命中判定前调用本函数。
 * - 命中前若消费成功，则本次直接判定 miss，并同步更新 Buff 层数/属性快照。
 *
 * 关键边界条件与坑点：
 * 1. stacks > 1 时只能减 1 层，不能整条 Buff 一次删掉，否则升级后的“双闪”会被错误吃光。
 * 2. 这里只处理显式 dodgeNext 运行时效果；DOT/HOT/反伤等不经过命中判定的伤害不应误触发。
 */
export function consumeNextDodgeBuff(unit: BattleUnit): boolean {
  let selectedBuff: ActiveBuff | null = null;

  for (const buff of unit.buffs) {
    if (!buff.dodgeNext) continue;
    if (!selectedBuff || resolveNextDodgeBuffScore(buff) < resolveNextDodgeBuffScore(selectedBuff)) {
      selectedBuff = buff;
    }
  }

  if (!selectedBuff) return false;

  if (selectedBuff.stacks > 1) {
    selectedBuff.stacks -= 1;
    recalculateUnitAttrs(unit);
    return true;
  }

  return removeBuff(unit, selectedBuff.id);
}

/**
 * 添加护盾
 *
 * 坑点：护盾 ID 使用防作弊随机数生成器，与战斗内其他随机判定保持一致。
 *       此处 ID 仅用于唯一标识，不影响战斗结果，但统一来源便于调试追踪。
 */
export function addShield(
  unit: BattleUnit,
  shield: Omit<Shield, 'id'>,
  sourceSkillId: string
): void {
  // 使用时间戳+计数器生成唯一ID，不依赖 Math.random()
  const newShield: Shield = {
    ...shield,
    id: `shield-${sourceSkillId}-${Date.now()}-${unit.shields.length}`,
    sourceSkillId,
  };

  unit.shields.push(newShield);
}

/**
 * 处理回合开始的DOT/HOT
 */
export function processRoundStartEffects(
  state: BattleState,
  unit: BattleUnit
): BattleLogEntry[] {
  const logs: BattleLogEntry[] = [];
  const effectiveBuffs = collectEffectiveBuffs(unit.buffs);

  for (const buff of effectiveBuffs) {
    if (buff.delayedBurst) {
      if (buff.delayedBurst.remainingRounds > 1) {
        buff.delayedBurst.remainingRounds -= 1;
      } else if (unit.isAlive) {
        const { actualDamage } = applyDamage(state, unit, buff.delayedBurst.damage, buff.delayedBurst.damageType);
        logs.push({
          type: 'dot',
          round: state.roundCount,
          unitId: unit.id,
          unitName: unit.name,
          buffName: `${buff.name || '延迟爆发'}（延迟爆发）`,
          damage: actualDamage,
        });
        buff.remainingDuration = 0;
      }
    }

    // DOT伤害
    if (buff.dot) {
      const dotDamage = calculateDotDamage(buff.dot, unit);
      const { actualDamage } = applyDamage(state, unit, dotDamage, buff.dot.damageType);

      logs.push({
        type: 'dot',
        round: state.roundCount,
        unitId: unit.id,
        unitName: unit.name,
        buffName: buff.name,
        damage: actualDamage,
      });

      // 检查死亡
      if (!unit.isAlive) {
        logs.push({
          type: 'death',
          round: state.roundCount,
          unitId: unit.id,
          unitName: unit.name,
        });
      }
    }

    // HOT治疗
    if (buff.hot && unit.isAlive && !isHealingForbidden(unit)) {
      const hotHeal = calculateHotHeal(buff.hot, unit);
      const actualHeal = applyHealing(unit, hotHeal);

      if (actualHeal > 0) {
        logs.push({
          type: 'hot',
          round: state.roundCount,
          unitId: unit.id,
          unitName: unit.name,
          buffName: buff.name,
          heal: actualHeal,
        });
      }
    }

    // 光环回合结算
    if (buff.aura && unit.isAlive) {
      const auraLog = processAuraEffect(state, unit, buff);
      if (auraLog) {
        logs.push(auraLog);
      }
    }
  }

  return logs;
}

/**
 * 处理回合结束的Buff递减
 */
export function processRoundEndBuffs(
  state: BattleState,
  unit: BattleUnit
): BattleLogEntry[] {
  const logs: BattleLogEntry[] = [];

  // Buff持续时间递减（remainingDuration === -1 为永久 buff，如光环，跳过递减）
  unit.buffs = unit.buffs.filter(buff => {
    if (buff.remainingDuration === -1) return true;
    buff.remainingDuration--;

    if (buff.remainingDuration <= 0) {
      logs.push({
        type: 'buff_expire',
        round: state.roundCount,
        unitId: unit.id,
        unitName: unit.name,
        buffName: buff.name,
      });
      return false;
    }
    return true;
  });

  // 护盾持续时间递减
  unit.shields = unit.shields.filter(shield => {
    if (shield.duration === -1) return true;  // 永久护盾
    shield.duration--;
    return shield.duration > 0;
  });

  // 重新计算属性
  recalculateUnitAttrs(unit);

  return logs;
}

/**
 * 计算DOT伤害
 */
function calculateDotDamage(dot: DotEffect, target: BattleUnit): number {
  // DOT伤害不受防御影响，但受五行抗性影响
  let damage = dot.damage;

  if (dot.bonusTargetMaxQixueRate && dot.bonusTargetMaxQixueRate > 0) {
    damage += target.currentAttrs.max_qixue * dot.bonusTargetMaxQixueRate;
  }

  if (dot.element && dot.element !== 'none') {
    const resistance = getElementResistanceForDot(target, dot.element);
    damage *= (1 - resistance);
  }

  return Math.floor(Math.max(1, damage));
}

/**
 * 计算HOT治疗
 */
function calculateHotHeal(hot: HotEffect, target: BattleUnit): number {
  let heal = hot.heal;

  // 受减疗影响
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  heal *= (1 - healReduction);

  return Math.floor(Math.max(1, heal));
}

/**
 * 解析光环目标列表
 *
 * 作用：根据光环持有者所在队伍和 auraTarget 类型，返回对应的存活单位列表。
 * 输入：战斗状态、光环持有者、光环目标类型。
 * 输出：符合条件的存活单位数组。
 *
 * 坑点：
 * 1) 必须先确定光环持有者所在队伍（attacker/defender），再按 auraTarget 解析。
 * 2) 'self' 只返回持有者自身（若存活）。
 */
function resolveAuraTargets(
  state: BattleState,
  auraOwner: BattleUnit,
  auraTarget: AuraTargetType,
): BattleUnit[] {
  if (auraTarget === 'self') {
    return auraOwner.isAlive ? [auraOwner] : [];
  }

  const isAttacker = state.teams.attacker.units.some(u => u.id === auraOwner.id);
  const allyUnits = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemyUnits = isAttacker ? state.teams.defender.units : state.teams.attacker.units;

  if (auraTarget === 'all_ally') {
    return allyUnits.filter(u => u.isAlive);
  }
  if (auraTarget === 'all_enemy') {
    return enemyUnits.filter(u => u.isAlive);
  }
  return [];
}

/**
 * 处理光环回合结算
 *
 * 作用：每回合对光环范围内的目标施加子效果，生成 AuraLog。
 * 输入：战斗状态、光环持有者、携带光环的 ActiveBuff。
 * 输出：AuraLog（若有有效目标和结果）或 null。
 *
 * 坑点：
 * 1) 子 Buff 的 buffDefId 必须包含“光环实例键”，避免同一施法者的多条光环互相刷新。
 * 2) 子 Buff 的 duration 固定为 1 回合，保证光环消失后子效果在当回合结束时自然清除。
 */
function processAuraEffect(
  state: BattleState,
  auraOwner: BattleUnit,
  buff: ActiveBuff,
): AuraLog | null {
  const aura = buff.aura;
  if (!aura) return null;

  const targets = resolveAuraTargets(state, auraOwner, aura.auraTarget);
  if (targets.length === 0) return null;

  const subResults: AuraSubResult[] = [];

  for (const target of targets) {
    if (!target.isAlive) continue;
    const subResult: AuraSubResult = {
      targetId: target.id,
      targetName: target.name,
    };

    for (const sub of aura.effects) {
      applyAuraSubEffect(state, auraOwner, target, sub, buff, subResult);
    }

    subResults.push(subResult);
  }

  if (subResults.length === 0) return null;

  return {
    type: 'aura',
    round: state.roundCount,
    unitId: auraOwner.id,
    unitName: auraOwner.name,
    buffName: buff.name,
    auraTarget: aura.auraTarget,
    subResults,
  };
}

/**
 * 对单个目标施加单个光环子效果
 *
 * 坑点：
 * 1) damage 子效果使用 applyDamage，会触发护盾吸收和死亡判定。
 * 2) restore_lingqi 受蚀心锁减益影响，需调用 applySoulShackleRecoveryReduction。
 */
function applyAuraSubEffect(
  state: BattleState,
  auraOwner: BattleUnit,
  target: BattleUnit,
  sub: AuraSubEffect,
  auraBuff: ActiveBuff,
  subResult: AuraSubResult,
): void {
  switch (sub.type) {
    case 'damage': {
      if (!target.isAlive) break;
      const dmgType = sub.damageType ?? 'physical';
      const { actualDamage } = applyDamage(state, target, sub.resolvedValue, dmgType);
      subResult.damage = (subResult.damage ?? 0) + actualDamage;
      if (!target.isAlive) {
        appendBattleLog(state, {
          type: 'death',
          round: state.roundCount,
          unitId: target.id,
          unitName: target.name,
          killerId: auraOwner.id,
          killerName: auraOwner.name,
        });
      }
      break;
    }

    case 'heal': {
      if (!target.isAlive || isHealingForbidden(target)) break;
      const actualHeal = applyHealing(target, sub.resolvedValue);
      if (actualHeal > 0) {
        subResult.heal = (subResult.heal ?? 0) + actualHeal;
      }
      break;
    }

    case 'buff':
    case 'debuff': {
      if (!target.isAlive || !sub.buffDefId) break;
      const isolatedBuffDefId = buildAuraSubRuntimeBuffKey({
        sourceUnitId: auraOwner.id,
        auraHostBuffDefId: auraBuff.buffDefId,
        subBuffDefId: sub.buffDefId,
      });
      addBuff(target, {
        id: `${isolatedBuffDefId}-${Date.now()}`,
        buffDefId: isolatedBuffDefId,
        name: sub.buffDefId,
        type: sub.buffType ?? 'buff',
        category: 'aura',
        sourceUnitId: auraOwner.id,
        maxStacks: 1,
        attrModifiers: sub.attrModifiers,
        dot: sub.dot,
        hot: sub.hot,
        healForbidden: sub.healForbidden,
        tags: ['aura_sub'],
        dispellable: true,
      }, 1, 1);
      if (!subResult.buffsApplied) subResult.buffsApplied = [];
      subResult.buffsApplied.push(buildAuraSubEffectSummary(sub) || sub.buffDefId);
      break;
    }
    case 'resource': {
      if (!target.isAlive) break;
      const resType = sub.resourceType ?? 'lingqi';
      const value = sub.resolvedValue;
      if (value === 0) break;
      if (resType === 'lingqi') {
        target.lingqi = Math.min(target.lingqi + value, target.currentAttrs.max_lingqi);
      } else {
        target.qixue = Math.min(target.qixue + value, target.currentAttrs.max_qixue);
      }
      if (!subResult.resources) subResult.resources = [];
      subResult.resources.push({ type: resType, amount: Math.abs(Math.floor(value)) });
      break;
    }

    case 'restore_lingqi': {
      if (!target.isAlive) break;
      const rawValue = sub.resolvedValue;
      const value = applySoulShackleRecoveryReduction(rawValue, target);
      if (value <= 0) break;
      target.lingqi = Math.min(target.lingqi + value, target.currentAttrs.max_lingqi);
      if (!subResult.resources) subResult.resources = [];
      subResult.resources.push({ type: 'lingqi', amount: value });
      break;
    }
  }
}

export function isHealingForbidden(unit: BattleUnit): boolean {
  return collectEffectiveBuffs(unit.buffs).some((buff) => buff.healForbidden === true);
}

export function getUnitReflectDamageRate(unit: BattleUnit): number {
  let totalRate = 0;

  for (const buff of collectEffectiveBuffs(unit.buffs)) {
    const reflectDamage = buff.reflectDamage;
    if (!reflectDamage) continue;

    const rate = resolveReflectDamageRate(reflectDamage, buff.stacks);
    if (rate <= 0) continue;
    totalRate += rate;
  }

  return totalRate;
}

function resolveReflectDamageRate(reflectDamage: ReflectDamageEffect, stacks: number): number {
  if (!Number.isFinite(reflectDamage.rate) || reflectDamage.rate <= 0) return 0;
  const safeStacks = Math.max(1, Math.floor(stacks));
  return reflectDamage.rate * safeStacks;
}

export const createDelayedBurstRuntime = (params: {
  damage: number;
  damageType: DelayedBurstEffect['damageType'];
  element?: string;
  remainingRounds: number;
}): DelayedBurstEffect => ({
  damage: params.damage,
  damageType: params.damageType,
  element: params.element,
  remainingRounds: Math.max(1, Math.floor(params.remainingRounds)),
});

export const createNextSkillBonusRuntime = (params: {
  rate: number;
  bonusType: NextSkillBonusEffect['bonusType'];
}): NextSkillBonusEffect => ({
  rate: Math.max(0, params.rate),
  bonusType: params.bonusType,
});

/**
 * 重新计算单位属性
 *
 * 作用：从 baseAttrs 快照出发，叠加所有存活 Buff 的 attrModifiers，得到 currentAttrs。
 * 数据流：baseAttrs（只读快照）→ flatMods/percentMods 累加 → currentAttrs（可变）。
 * 坑点1：先叠加所有 flat，再叠加所有 percent，顺序不能颠倒，否则百分比基数会错。
 * 坑点2：percent 修正以 baseAttrs 为基数（已在 flat 叠加后），不是对 currentAttrs 再乘，
 *        当前实现是先 flat 后 percent，符合"基础值+固定值，再乘百分比"的标准公式。
 */
function recalculateUnitAttrs(unit: BattleUnit): void {
  // 从基础属性开始
  unit.currentAttrs = { ...unit.baseAttrs };
  const effectiveBuffs = collectEffectiveBuffs(unit.buffs);

  // 收集所有属性修正
  const flatMods: Partial<Record<keyof BattleAttrs, number>> = {};
  const percentMods: Partial<Record<keyof BattleAttrs, number>> = {};

  for (const buff of effectiveBuffs) {
    if (!buff.attrModifiers) continue;

    for (const mod of buff.attrModifiers) {
      const attr = mod.attr as keyof BattleAttrs;
      // 跳过非数值属性（realm、element 等字符串字段）
      if (typeof unit.currentAttrs[attr] !== 'number') continue;

      const value = mod.value * buff.stacks;

      if (mod.mode === 'flat') {
        flatMods[attr] = ((flatMods[attr] ?? 0)) + value;
      } else {
        percentMods[attr] = ((percentMods[attr] ?? 0)) + value;
      }
    }
  }

  // 应用固定值修正
  for (const [attr, value] of Object.entries(flatMods) as [string, number][]) {
    const key = attr as keyof BattleAttrs;
    if (typeof unit.currentAttrs[key] === 'number') {
      (unit.currentAttrs[key] as number) += value;
    }
  }

  // 应用百分比修正
  for (const [attr, value] of Object.entries(percentMods) as [string, number][]) {
    const key = attr as keyof BattleAttrs;
    if (typeof unit.currentAttrs[key] === 'number') {
      const nextValue = (unit.currentAttrs[key] as number) * (1 + value);
      (unit.currentAttrs[key] as number) = CHARACTER_RATIO_ATTR_KEY_SET.has(attr)
        ? Number(nextValue.toFixed(6))
        : Math.floor(nextValue);
    }
  }

  // 确保属性不为负
  unit.currentAttrs.max_qixue = Math.max(1, unit.currentAttrs.max_qixue);
  unit.currentAttrs.wugong = Math.max(0, unit.currentAttrs.wugong);
  unit.currentAttrs.fagong = Math.max(0, unit.currentAttrs.fagong);
  unit.currentAttrs.wufang = Math.max(0, unit.currentAttrs.wufang);
  unit.currentAttrs.fafang = Math.max(0, unit.currentAttrs.fafang);
  unit.currentAttrs.sudu = Math.max(0, unit.currentAttrs.sudu);
}

/**
 * 获取五行抗性（用于DOT）
 */
function getElementResistanceForDot(unit: BattleUnit, element: string): number {
  const resistanceMap: Record<string, keyof typeof unit.currentAttrs> = {
    'jin': 'jin_kangxing',
    'mu': 'mu_kangxing',
    'shui': 'shui_kangxing',
    'huo': 'huo_kangxing',
    'tu': 'tu_kangxing',
  };

  const key = resistanceMap[element];
  return key ? (unit.currentAttrs[key] as number) || 0 : 0;
}
