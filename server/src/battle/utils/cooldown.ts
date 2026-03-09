/**
 * 战斗技能冷却工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一处理技能冷却剩余读取、阻塞文案、回合递减，以及冷却缩减的累计折扣池结算。
 * - 不做什么：不负责技能目标解析、不负责资源扣除，也不处理战斗外的开战间隔冷却。
 *
 * 输入/输出：
 * - 输入：BattleUnit、技能 ID、技能基础冷却、角色当前冷却缩减属性。
 * - 输出：冷却剩余回合、统一错误文案，以及本次施放后应写入的实际冷却回合数。
 *
 * 数据流/状态流：
 * - skill.ts 在技能成功施放时调用本模块，为 unit.skillCooldowns / unit.skillCooldownDiscountBank 写入统一结果。
 * - validation.ts / AI 等读取 unit.skillCooldowns 时统一经由本模块，避免展示文案与服务端拦截不一致。
 * - battleEngine.ts 在每回合开始调用本模块递减技能冷却，保持单一规则入口。
 *
 * 关键边界条件与坑点：
 * 1) 小额冷却缩减不会立刻跨整回合，而是先累计到折扣池；累计满 1 回合后才兑现，避免 1%~3% 直接把 2 回合技能压成 1 回合。
 * 2) 技能冷却最低仍为 1 回合，1 回合基础冷却技能无法再被压到 0，这是当前整回合战斗节奏下的硬边界。
 */

import type { BattleState, BattleUnit } from "../types.js";

export const MAX_SKILL_COOLDOWN_REDUCTION = 0.5;
const COOLDOWN_BANK_PRECISION = 1_000_000;

export const ensureUnitSkillCooldownState = (unit: BattleUnit): void => {
  if (unit.skillCooldowns === undefined) {
    unit.skillCooldowns = {};
  }
  if (unit.skillCooldownDiscountBank === undefined) {
    unit.skillCooldownDiscountBank = {};
  }
};

export const ensureBattleStateSkillCooldownState = (
  state: BattleState,
): void => {
  for (const team of [state.teams.attacker, state.teams.defender]) {
    for (const unit of team.units) {
      ensureUnitSkillCooldownState(unit);
    }
  }
};

const roundCooldownBankValue = (value: number): number => {
  return Math.round(value * COOLDOWN_BANK_PRECISION) / COOLDOWN_BANK_PRECISION;
};

const normalizeCooldownReduction = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_SKILL_COOLDOWN_REDUCTION);
};

export const getSkillCooldownRemainingRounds = (
  unit: BattleUnit,
  skillId: string,
): number => {
  ensureUnitSkillCooldownState(unit);
  const cooldown = unit.skillCooldowns[skillId] ?? 0;
  if (!Number.isFinite(cooldown) || cooldown <= 0) return 0;
  return Math.ceil(cooldown);
};

export const buildSkillCooldownBlockedMessage = (
  remainingRounds: number,
): string => {
  return `技能冷却中: ${remainingRounds}回合`;
};

export const getSkillCooldownBlockedMessage = (
  unit: BattleUnit,
  skillId: string,
): string | null => {
  const remainingRounds = getSkillCooldownRemainingRounds(unit, skillId);
  if (remainingRounds <= 0) return null;
  return buildSkillCooldownBlockedMessage(remainingRounds);
};

export const reduceUnitSkillCooldowns = (unit: BattleUnit): void => {
  ensureUnitSkillCooldownState(unit);
  for (const skillId of Object.keys(unit.skillCooldowns)) {
    const remaining = getSkillCooldownRemainingRounds(unit, skillId);
    if (remaining <= 1) {
      delete unit.skillCooldowns[skillId];
      continue;
    }
    unit.skillCooldowns[skillId] = remaining - 1;
  }
};

export const applySkillCooldownAfterCast = (
  unit: BattleUnit,
  skillId: string,
  baseCooldown: number,
): number => {
  ensureUnitSkillCooldownState(unit);
  const normalizedBaseCooldown = Math.max(0, Math.floor(baseCooldown));
  if (normalizedBaseCooldown <= 0) {
    delete unit.skillCooldowns[skillId];
    delete unit.skillCooldownDiscountBank[skillId];
    return 0;
  }

  const cooldownReduction = normalizeCooldownReduction(unit.currentAttrs.lengque);
  const maxDiscountRounds = Math.max(0, normalizedBaseCooldown - 1);
  if (maxDiscountRounds <= 0 || cooldownReduction <= 0) {
    unit.skillCooldowns[skillId] = normalizedBaseCooldown;
    return normalizedBaseCooldown;
  }

  const carriedDiscount =
    typeof unit.skillCooldownDiscountBank[skillId] === "number"
      ? unit.skillCooldownDiscountBank[skillId]
      : 0;
  const accumulatedDiscount = roundCooldownBankValue(
    carriedDiscount + normalizedBaseCooldown * cooldownReduction,
  );
  const discountRounds = Math.min(
    maxDiscountRounds,
    Math.floor(accumulatedDiscount),
  );
  const actualCooldown = Math.max(1, normalizedBaseCooldown - discountRounds);
  const remainingDiscount = roundCooldownBankValue(
    accumulatedDiscount - discountRounds,
  );

  unit.skillCooldowns[skillId] = actualCooldown;
  if (remainingDiscount > 0) {
    unit.skillCooldownDiscountBank[skillId] = remainingDiscount;
  } else {
    delete unit.skillCooldownDiscountBank[skillId];
  }

  return actualCooldown;
};
