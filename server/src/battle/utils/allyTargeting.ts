/**
 * 单体友方目标选择工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一单体友方技能在“未显式指定目标”时的智能选人规则，覆盖治疗、护盾、净化、回灵、增益等常见支援技能。
 * - 不做什么：不处理群体/随机友方，不处理敌方目标，也不直接执行技能效果结算。
 *
 * 输入/输出：
 * - 输入：施法者、技能、当前存活友方列表、可选的显式目标 ID。
 * - 输出：应命中的友方目标 ID；若显式目标无效或当前没有可用友方则返回 null。
 *
 * 数据流/状态流：
 * - battle/modules/target.ts、battle/modules/ai.ts、services/battle/runtime/ticker.ts
 *   统一调用本模块，拿到默认单体友方目标，再交给技能执行层结算。
 *
 * 关键边界条件与坑点：
 * 1) 显式点选优先级最高；一旦传了目标但该目标无效，必须返回 null，不能静默回退到其他友方。
 * 2) 同一个技能可能同时带治疗、增益、净化等多类效果，这里采用“多效果累计打分”避免不同入口手写 if/else 漂移。
 */

import type { BattleSkill, BattleUnit, SkillEffect } from '../types.js';
import { normalizeBuffAttrKey, normalizeBuffKind } from './buffSpec.js';

const OFFENSIVE_BUFF_ATTRS = new Set([
  'wugong',
  'fagong',
  'zengshang',
  'baoji',
  'baoshang',
  'mingzhong',
  'xixue',
]);

const DEFENSIVE_BUFF_ATTRS = new Set([
  'max_qixue',
  'wufang',
  'fafang',
  'jianliao',
  'kangbao',
  'shanbi',
  'zhaojia',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const HEALING_BUFF_ATTRS = new Set([
  'zhiliao',
  'qixue_huifu',
]);

const RESOURCE_BUFF_ATTRS = new Set([
  'max_lingqi',
  'lingqi_huifu',
  'lengque',
  'sudu',
]);

const getAliveAllies = (allies: BattleUnit[]): BattleUnit[] =>
  allies.filter((ally) => ally.isAlive);

const getExplicitTarget = (
  aliveAllies: BattleUnit[],
  selectedTargetIds?: string[],
): BattleUnit | null => {
  if (!selectedTargetIds || selectedTargetIds.length === 0) return null;
  return aliveAllies.find((ally) => ally.id === selectedTargetIds[0]) ?? null;
};

const getMissingHp = (unit: BattleUnit): number =>
  Math.max(0, unit.currentAttrs.max_qixue - unit.qixue);

const getMissingHpRatio = (unit: BattleUnit): number => {
  const maxHp = Math.max(1, unit.currentAttrs.max_qixue);
  return getMissingHp(unit) / maxHp;
};

const getMissingLingqi = (unit: BattleUnit): number =>
  Math.max(0, unit.currentAttrs.max_lingqi - unit.lingqi);

const getMissingLingqiRatio = (unit: BattleUnit): number => {
  const maxLingqi = Math.max(1, unit.currentAttrs.max_lingqi);
  return getMissingLingqi(unit) / maxLingqi;
};

const getShieldValue = (unit: BattleUnit): number =>
  unit.shields.reduce((sum, shield) => sum + Math.max(0, shield.value), 0);

const getDebuffCount = (unit: BattleUnit): number =>
  unit.buffs.filter((buff) => buff.type === 'debuff').length;

const getControlDebuffCount = (unit: BattleUnit): number =>
  unit.buffs.filter((buff) => buff.type === 'debuff' && Boolean(buff.control)).length;

const getDamageRoleScore = (unit: BattleUnit): number =>
  unit.stats.damageDealt
  + Math.max(unit.currentAttrs.wugong, unit.currentAttrs.fagong)
  + unit.currentAttrs.zengshang * 800
  + unit.currentAttrs.baoji * 600
  + unit.currentAttrs.baoshang * 120;

const getHealingRoleScore = (unit: BattleUnit): number =>
  unit.stats.healingDone
  + unit.currentAttrs.fagong
  + unit.currentAttrs.zhiliao * 1000
  + unit.currentAttrs.qixue_huifu * 600;

const getTankPressureScore = (unit: BattleUnit): number =>
  unit.stats.damageTaken
  + getMissingHpRatio(unit) * 1800
  + getDebuffCount(unit) * 120
  - getShieldValue(unit) * 0.25;

const getTeammateBias = (caster: BattleUnit, unit: BattleUnit): number =>
  unit.id === caster.id ? 0 : 120;

function scoreHealLikeEffect(caster: BattleUnit, unit: BattleUnit): number {
  const missingHp = getMissingHp(unit);
  if (missingHp <= 0) return unit.id === caster.id ? 5 : 10;
  return 2600
    + getTeammateBias(caster, unit)
    + getMissingHpRatio(unit) * 2400
    + missingHp * 0.12
    + getTankPressureScore(unit) * 0.25;
}

function scoreShieldEffect(caster: BattleUnit, unit: BattleUnit): number {
  return 1800
    + getTeammateBias(caster, unit)
    + getTankPressureScore(unit)
    + Math.max(0, 600 - getShieldValue(unit) * 0.2);
}

function scoreLingqiEffect(caster: BattleUnit, unit: BattleUnit): number {
  const missingLingqi = getMissingLingqi(unit);
  if (missingLingqi <= 0) return unit.id === caster.id ? 5 : 15;
  return 1500
    + getTeammateBias(caster, unit)
    + getMissingLingqiRatio(unit) * 1800
    + missingLingqi * 0.18
    + getDamageRoleScore(unit) * 0.18
    + getHealingRoleScore(unit) * 0.12;
}

function scoreCleanseEffect(caster: BattleUnit, unit: BattleUnit, controlOnly: boolean): number {
  const controlCount = getControlDebuffCount(unit);
  const debuffCount = getDebuffCount(unit);
  const relevantCount = controlOnly ? controlCount : debuffCount;
  if (relevantCount <= 0) return unit.id === caster.id ? 0 : 10;
  return 2200
    + getTeammateBias(caster, unit)
    + relevantCount * (controlOnly ? 900 : 700)
    + controlCount * 400
    + getTankPressureScore(unit) * 0.2;
}

type BuffIntent = 'offense' | 'defense' | 'healing' | 'resource' | 'generic';

function resolveBuffIntent(effect: SkillEffect): BuffIntent {
  const buffKind = normalizeBuffKind(effect.buffKind);
  if (buffKind === 'hot') return 'healing';
  if (buffKind === 'dodge_next') return 'defense';
  if (buffKind !== 'attr') return 'generic';

  const attrKey = normalizeBuffAttrKey(effect.attrKey);
  if (OFFENSIVE_BUFF_ATTRS.has(attrKey)) return 'offense';
  if (DEFENSIVE_BUFF_ATTRS.has(attrKey)) return 'defense';
  if (HEALING_BUFF_ATTRS.has(attrKey)) return 'healing';
  if (RESOURCE_BUFF_ATTRS.has(attrKey)) return 'resource';
  return 'generic';
}

function scoreBuffEffect(caster: BattleUnit, unit: BattleUnit, effect: SkillEffect): number {
  const teammateBias = getTeammateBias(caster, unit);
  const intent = resolveBuffIntent(effect);

  if (intent === 'offense') {
    return 1700 + teammateBias + getDamageRoleScore(unit);
  }
  if (intent === 'defense') {
    return 1650 + teammateBias + getTankPressureScore(unit);
  }
  if (intent === 'healing') {
    return 1600 + teammateBias + getHealingRoleScore(unit) + getMissingHpRatio(unit) * 500;
  }
  if (intent === 'resource') {
    return 1550 + teammateBias + getDamageRoleScore(unit) * 0.22 + getMissingLingqiRatio(unit) * 1000;
  }

  return 1450 + teammateBias + getDamageRoleScore(unit) * 0.35 + getTankPressureScore(unit) * 0.12;
}

function scoreSingleEffect(caster: BattleUnit, unit: BattleUnit, effect: SkillEffect): number {
  if (effect.type === 'heal') return scoreHealLikeEffect(caster, unit);
  if (effect.type === 'shield') return scoreShieldEffect(caster, unit);
  if (effect.type === 'resource' && effect.resourceType === 'qixue') return scoreHealLikeEffect(caster, unit);
  if (effect.type === 'resource' && effect.resourceType === 'lingqi') return scoreLingqiEffect(caster, unit);
  if (effect.type === 'restore_lingqi') return scoreLingqiEffect(caster, unit);
  if (effect.type === 'cleanse') return scoreCleanseEffect(caster, unit, false);
  if (effect.type === 'cleanse_control') return scoreCleanseEffect(caster, unit, true);
  if (effect.type === 'dispel' && effect.dispelType !== 'buff') return scoreCleanseEffect(caster, unit, false);
  if (effect.type === 'buff') return scoreBuffEffect(caster, unit, effect);
  return 0;
}

function resolveBestSupportTarget(caster: BattleUnit, skill: BattleSkill, aliveAllies: BattleUnit[]): string | null {
  let bestUnit: BattleUnit | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const unit of aliveAllies) {
    let score = getTeammateBias(caster, unit);
    for (const effect of skill.effects) {
      score += scoreSingleEffect(caster, unit, effect);
    }
    if (score > bestScore) {
      bestScore = score;
      bestUnit = unit;
    }
  }

  return bestUnit?.id ?? null;
}

export function resolveSingleAllyTargetId(
  caster: BattleUnit,
  skill: BattleSkill,
  allies: BattleUnit[],
  selectedTargetIds?: string[],
): string | null {
  const aliveAllies = getAliveAllies(allies);
  if (aliveAllies.length === 0) return null;

  if (selectedTargetIds && selectedTargetIds.length > 0) {
    const explicitTarget = getExplicitTarget(aliveAllies, selectedTargetIds);
    return explicitTarget ? explicitTarget.id : null;
  }

  return resolveBestSupportTarget(caster, skill, aliveAllies);
}
