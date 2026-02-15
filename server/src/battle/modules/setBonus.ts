/**
 * 九州修仙录 - 套装战斗效果执行模块
 * 仅处理战斗期触发型套装效果（equip 常驻属性已在穿戴时写入角色）
 */

import type {
  ActionLog,
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleSetBonusTrigger,
  BattleState,
  TargetResult,
  BattleUnit,
} from '../types.js';
import { rollChance } from '../utils/random.js';
import { addBuff, addShield } from './buff.js';
import { applyDamage } from './damage.js';
import { applyHealing } from './healing.js';

interface SetBonusTriggerContext {
  target?: BattleUnit;
  damage?: number;
  heal?: number;
}

interface SetBonusApplyResult {
  targetResult: TargetResult;
  extraLogs?: BattleLogEntry[];
}

export function triggerSetBonusEffects(
  state: BattleState,
  trigger: BattleSetBonusTrigger,
  owner: BattleUnit,
  context: SetBonusTriggerContext = {}
): BattleLogEntry[] {
  const effects = Array.isArray(owner.setBonusEffects) ? owner.setBonusEffects : [];
  if (effects.length === 0) return [];

  const logs: BattleLogEntry[] = [];
    for (const effect of effects) {
      if (effect.trigger !== trigger) continue;

      const params = toObject(effect.params);
      if (!passChance(state, params)) continue;

    const target = effect.target === 'enemy' ? context.target : owner;
    if (!target || !target.isAlive) continue;

    let applyResult: SetBonusApplyResult | null = null;
      switch (effect.effectType) {
        case 'buff':
        case 'debuff':
          applyResult = applySetBuffOrDebuff(effect, owner, target, params);
          break;
        case 'damage':
          applyResult = applySetDamage(state, owner, target, params, context.damage);
          break;
        case 'heal':
          applyResult = applySetHeal(owner, target, params);
          break;
        case 'resource':
          applyResult = applySetResource(owner, target, params);
          break;
        case 'shield':
          applyResult = applySetShield(effect, owner, target, params);
          break;
        default:
          break;
      }

    if (!applyResult) continue;
    logs.push(buildSetBonusActionLog(state, owner, effect, applyResult.targetResult));
    if (Array.isArray(applyResult.extraLogs) && applyResult.extraLogs.length > 0) {
      logs.push(...applyResult.extraLogs);
    }
  }

  return logs;
}

function applySetBuffOrDebuff(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const attrKey = asNonEmptyString(params.attr_key);
  const applyType = asApplyType(params.apply_type);
  const value = asFiniteNumber(params.value);
  const duration = normalizeDuration(effect.durationRound);
  const isDebuff = effect.effectType === 'debuff';

  if (attrKey && value !== null && applyType) {
    const buffDefId = buildSetBuffDefId(effect, attrKey);
    const buffName = `${effect.setName}${isDebuff ? '负面' : '增益'}`;
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: buffName,
        type: isDebuff ? 'debuff' : 'buff',
        category: 'set_bonus',
        sourceUnitId: owner.id,
        maxStacks: 1,
        attrModifiers: [{ attr: attrKey, value: isDebuff ? -Math.abs(value) : value, mode: applyType }],
        tags: ['set_bonus', effect.setId],
        dispellable: true,
      },
      duration,
      1
    );
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        buffsApplied: [buffName],
      },
    };
  }

  const debuffType = asNonEmptyString(params.debuff_type);
  if (isDebuff && debuffType === 'bleed') {
    const rawValue = asFiniteNumber(params.value) ?? 0;
    const dotDamage = Math.max(
      1,
      Math.floor(owner.currentAttrs.wugong * normalizeRate(rawValue))
    );
    const buffDefId = buildSetBuffDefId(effect, 'bleed');
    const buffName = `${effect.setName}·流血`;
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: buffName,
        type: 'debuff',
        category: 'set_bonus',
        sourceUnitId: owner.id,
        maxStacks: 1,
        dot: {
          damage: dotDamage,
          damageType: 'true',
        },
        tags: ['set_bonus', effect.setId, 'bleed'],
        dispellable: true,
      },
      duration,
      1
    );
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        buffsApplied: [buffName],
      },
    };
  }

  return null;
}

function applySetDamage(
  state: BattleState,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>,
  sourceDamage?: number
): SetBonusApplyResult | null {
  const rawValue = asFiniteNumber(params.value) ?? 0;
  const damageTypeRaw = asNonEmptyString(params.damage_type) ?? 'true';

  let damage = 0;
  if (damageTypeRaw === 'reflect' && typeof sourceDamage === 'number' && sourceDamage > 0) {
    damage += Math.floor(sourceDamage * normalizeRate(rawValue));
  } else {
    damage += Math.floor(rawValue);
  }

  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRateRaw = asFiniteNumber(params.scale_rate);
  if (scaleKey && scaleRateRaw !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    damage += Math.floor(attrValue * normalizeRate(scaleRateRaw));
  }

  if (damage <= 0) return null;

  const damageType = normalizeDamageType(damageTypeRaw);
  const wasAlive = target.isAlive;
  const { actualDamage, shieldAbsorbed } = applyDamage(state, target, Math.max(1, damage), damageType);
  owner.stats.damageDealt += Math.max(0, actualDamage);

  const extraLogs: BattleLogEntry[] = [];
  if (wasAlive && !target.isAlive) {
    owner.stats.killCount += 1;
    extraLogs.push({
      type: 'death',
      round: state.roundCount,
      unitId: target.id,
      unitName: target.name,
      killerId: owner.id,
      killerName: owner.name,
    });
  }

  const safeDamage = Math.max(0, actualDamage);
  const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
  return {
    targetResult: {
      ...buildTargetResultBase(target),
      hits: [
        {
          index: 1,
          damage: safeDamage,
          isMiss: false,
          isCrit: false,
          isParry: false,
          isElementBonus: false,
          shieldAbsorbed: safeShieldAbsorbed,
        },
      ],
      damage: safeDamage,
      shieldAbsorbed: safeShieldAbsorbed,
    },
    extraLogs,
  };
}

function applySetHeal(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const base = asFiniteNumber(params.value) ?? 0;
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRateRaw = asFiniteNumber(params.scale_rate);

  let healAmount = Math.floor(base);
  if (scaleKey && scaleRateRaw !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    healAmount += Math.floor(attrValue * normalizeRate(scaleRateRaw));
  }
  if (healAmount <= 0) return null;

  const actualHeal = applyHealing(target, healAmount);
  if (actualHeal > 0) {
    owner.stats.healingDone += actualHeal;
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        heal: actualHeal,
      },
    };
  }

  return null;
}

function applySetResource(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const resourceType = asNonEmptyString(params.resource_type) ?? asNonEmptyString(params.resource);
  const value = asFiniteNumber(params.value);
  if (!resourceType || value === null) return null;

  const amount = Math.floor(value);
  if (amount <= 0) return null;

  if (resourceType === 'qixue') {
    const actualHeal = applyHealing(target, amount);
    if (actualHeal > 0) {
      owner.stats.healingDone += actualHeal;
      return {
        targetResult: {
          ...buildTargetResultBase(target),
          heal: actualHeal,
        },
      };
    }
    return null;
  }

  if (resourceType === 'lingqi') {
    const before = target.lingqi;
    const after = Math.min(target.currentAttrs.max_lingqi, before + amount);
    const gain = Math.max(0, after - before);
    target.lingqi = after;
    if (gain <= 0) return null;
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        resources: [{ type: 'lingqi', amount: gain }],
      },
    };
  }

  return null;
}

function applySetShield(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const baseValue = asFiniteNumber(params.value) ?? 0;
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRate = asFiniteNumber(params.scale_rate);

  let shieldValue = Math.floor(baseValue);
  if (scaleKey && scaleRate !== null) {
    const scaleAttr = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    shieldValue += Math.floor(scaleAttr * normalizeRate(scaleRate));
  }

  if (shieldValue <= 0) return null;

  const absorbTypeRaw = asNonEmptyString(params.absorb_type);
  const absorbType = absorbTypeRaw === 'physical' || absorbTypeRaw === 'magic' ? absorbTypeRaw : 'all';
  const duration = normalizeDuration(effect.durationRound);

  addShield(
    target,
    {
      value: shieldValue,
      maxValue: shieldValue,
      duration,
      absorbType,
      priority: 1,
      sourceSkillId: effect.setId,
    },
    owner.id,
  );

  return {
    targetResult: {
      ...buildTargetResultBase(target),
      buffsApplied: [`${effect.setName}·护盾`],
    },
  };
}

function passChance(state: BattleState, params: Record<string, unknown>): boolean {
  const chanceRaw = asFiniteNumber(params.chance);
  if (chanceRaw === null) return true;
  const chance = Math.max(0, Math.min(1, chanceRaw));
  if (chance >= 1) return true;
  return rollChance(state, chance);
}

function normalizeRate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeDamageType(value: string): 'physical' | 'magic' | 'true' {
  if (value === 'physical') return 'physical';
  if (value === 'magic') return 'magic';
  return 'true';
}

function normalizeDuration(value: unknown): number {
  const n = asFiniteNumber(value);
  if (n === null) return 1;
  return Math.max(1, Math.floor(n));
}

function buildSetBuffDefId(effect: BattleSetBonusEffect, suffix: string): string {
  return `set-${effect.setId}-${effect.pieceCount}-${effect.trigger}-${suffix}`;
}

function buildSetBonusActionLog(
  state: BattleState,
  owner: BattleUnit,
  effect: BattleSetBonusEffect,
  targetResult: TargetResult
): ActionLog {
  return {
    type: 'action',
    round: state.roundCount,
    actorId: owner.id,
    actorName: owner.name,
    skillId: `proc-${effect.setId}`,
    skillName: effect.setName,
    targets: [targetResult],
  };
}

function buildTargetResultBase(target: BattleUnit): TargetResult {
  return {
    targetId: target.id,
    targetName: target.name,
    hits: [],
  };
}

function asApplyType(value: unknown): 'flat' | 'percent' | null {
  if (value === 'flat') return 'flat';
  if (value === 'percent') return 'percent';
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out ? out : null;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readAttrValue(owner: BattleUnit, key: string): unknown {
  return (owner.currentAttrs as unknown as Record<string, unknown>)[key];
}
