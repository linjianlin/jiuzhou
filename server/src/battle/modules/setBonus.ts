/**
 * 九州修仙录 - 套装战斗效果执行模块
 * 仅处理战斗期触发型套装效果（equip 常驻属性已在穿戴时写入角色）
 */

import type {
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleSetBonusTrigger,
  BattleState,
  BattleUnit,
} from '../types.js';
import { rollChance } from '../utils/random.js';
import { addBuff } from './buff.js';
import { applyDamage } from './damage.js';
import { applyHealing } from './healing.js';

export interface SetBonusTriggerContext {
  target?: BattleUnit;
  damage?: number;
  heal?: number;
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

    switch (effect.effectType) {
      case 'buff':
      case 'debuff':
        applySetBuffOrDebuff(effect, owner, target, params);
        break;
      case 'damage':
        logs.push(...applySetDamage(state, effect, owner, target, params, context.damage));
        break;
      case 'heal':
        applySetHeal(owner, target, params);
        break;
      case 'resource':
        applySetResource(owner, target, params);
        break;
      default:
        break;
    }
  }

  return logs;
}

function applySetBuffOrDebuff(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): void {
  const attrKey = asNonEmptyString(params.attr_key);
  const applyType = asApplyType(params.apply_type);
  const value = asFiniteNumber(params.value);
  const duration = normalizeDuration(effect.durationRound);
  const isDebuff = effect.effectType === 'debuff';

  if (attrKey && value !== null && applyType) {
    const buffDefId = buildSetBuffDefId(effect, attrKey);
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: `${effect.setName}${isDebuff ? '负面' : '增益'}`,
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
    return;
  }

  const debuffType = asNonEmptyString(params.debuff_type);
  if (isDebuff && debuffType === 'bleed') {
    const rawValue = asFiniteNumber(params.value) ?? 0;
    const dotDamage = Math.max(
      1,
      Math.floor(owner.currentAttrs.wugong * normalizeRate(rawValue))
    );
    const buffDefId = buildSetBuffDefId(effect, 'bleed');
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: `${effect.setName}·流血`,
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
  }
}

function applySetDamage(
  state: BattleState,
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>,
  sourceDamage?: number
): BattleLogEntry[] {
  const logs: BattleLogEntry[] = [];
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

  if (damage <= 0) return logs;

  const damageType = normalizeDamageType(damageTypeRaw);
  const wasAlive = target.isAlive;
  const { actualDamage } = applyDamage(state, target, Math.max(1, damage), damageType);
  owner.stats.damageDealt += Math.max(0, actualDamage);

  if (wasAlive && !target.isAlive) {
    owner.stats.killCount += 1;
    logs.push({
      type: 'death',
      round: state.roundCount,
      unitId: target.id,
      unitName: target.name,
      killerId: owner.id,
      killerName: owner.name,
    });
  }

  return logs;
}

function applySetHeal(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): void {
  const base = asFiniteNumber(params.value) ?? 0;
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRateRaw = asFiniteNumber(params.scale_rate);

  let healAmount = Math.floor(base);
  if (scaleKey && scaleRateRaw !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    healAmount += Math.floor(attrValue * normalizeRate(scaleRateRaw));
  }
  if (healAmount <= 0) return;

  const actualHeal = applyHealing(target, healAmount);
  if (actualHeal > 0) {
    owner.stats.healingDone += actualHeal;
  }
}

function applySetResource(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): void {
  const resourceType = asNonEmptyString(params.resource_type) ?? asNonEmptyString(params.resource);
  const value = asFiniteNumber(params.value);
  if (!resourceType || value === null) return;

  const amount = Math.floor(value);
  if (amount <= 0) return;

  if (resourceType === 'qixue') {
    const actualHeal = applyHealing(target, amount);
    if (actualHeal > 0) owner.stats.healingDone += actualHeal;
    return;
  }

  if (resourceType === 'lingqi') {
    target.lingqi = Math.min(target.currentAttrs.max_lingqi, target.lingqi + amount);
  }
}

function passChance(state: BattleState, params: Record<string, unknown>): boolean {
  const chanceRaw = asFiniteNumber(params.chance);
  if (chanceRaw === null) return true;
  const chance = Math.max(0, Math.min(10000, Math.floor(chanceRaw)));
  if (chance >= 10000) return true;
  return rollChance(state, chance);
}

function normalizeRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) <= 1) return value;
  return value / 10000;
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
