/**
 * 战斗技能冷却工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一处理技能冷却剩余读取、阻塞文案、行动递减，以及冷却缩减的累计折扣池结算。
 * - 不做什么：不负责技能目标解析、不负责资源扣除，也不处理战斗外的开战间隔冷却。
 *
 * 输入/输出：
 * - 输入：BattleUnit、技能 ID、技能基础冷却、角色当前冷却缩减属性。
 * - 输出：冷却剩余回合、统一错误文案，以及本次施放后应写入的实际冷却回合数。
 *
 * 数据流/状态流：
 * - skill.ts 在技能成功施放时调用本模块，为 unit.skillCooldowns / unit.skillCooldownDiscountBank 写入统一结果。
 * - validation.ts / AI 等读取 unit.skillCooldowns 时统一经由本模块，避免展示文案与服务端拦截不一致。
 * - battleEngine.ts 在单位行动结束后调用本模块递减该单位技能冷却，并跳过本次刚施放的技能，确保 cooldown=1 会跳过下一次自身出手。
 * - battle lifecycle 在 Redis 恢复活跃战斗前调用本模块，把旧版“回合开始递减”的冷却状态迁移到新版“自身行动结束递减”口径。
 *
 * 关键边界条件与坑点：
 * 1) 小额冷却缩减不会立刻跨整回合，而是先累计到折扣池；累计满 1 回合后才兑现，避免 1%~3% 直接把 2 回合技能压成 1 回合。
 * 2) 技能冷却最低仍为 1 回合，1 回合基础冷却技能无法再被压到 0，这是当前整回合战斗节奏下的硬边界。
 */

import type { BattleState, BattleUnit } from "../types.js";

export const MAX_SKILL_COOLDOWN_REDUCTION = 0.5;
const COOLDOWN_BANK_PRECISION = 1_000_000;
export const LEGACY_BATTLE_COOLDOWN_TIMING_MODE = "round_start";
export const ACTIVE_BATTLE_COOLDOWN_TIMING_MODE = "self_action_end";

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

const getCurrentTeamPendingUnitIdSet = (
  state: BattleState,
): Set<string> => {
  if (state.phase !== "action") return new Set();
  const team = state.teams[state.currentTeam];
  if (!state.currentUnitId) {
    return new Set(
      team.units
        .filter((unit) => unit.isAlive && unit.canAct)
        .map((unit) => unit.id),
    );
  }
  const currentIndex = team.units.findIndex((unit) => unit.id === state.currentUnitId);
  if (currentIndex < 0) return new Set();
  return new Set(
    team.units
      .slice(currentIndex)
      .filter((unit) => unit.isAlive && unit.canAct)
      .map((unit) => unit.id),
  );
};

const shouldSubtractLegacyRoundStartTickForUnit = (
  state: BattleState,
  teamKey: "attacker" | "defender",
  unit: BattleUnit,
  currentTeamPendingUnitIds: ReadonlySet<string>,
): boolean => {
  if (state.phase === "roundStart" || state.phase === "roundEnd") {
    return true;
  }
  if (state.phase !== "action") {
    return false;
  }
  if (!unit.isAlive || !unit.canAct) {
    return true;
  }
  if (teamKey === state.currentTeam) {
    return !currentTeamPendingUnitIds.has(unit.id);
  }
  if (state.currentTeam === "attacker" && teamKey === "defender") {
    return false;
  }
  return true;
};

/**
 * 迁移 Redis 恢复出来的旧冷却状态。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：把旧版“回合开始全体递减”语义下保存的 `skillCooldowns`，换算成新版“自身行动结束递减”口径。
 * - 做什么：只在恢复入口执行一次，并把 `state.cooldownTimingMode` 更新为当前口径，避免重复迁移。
 * - 不做什么：不处理新开战斗，不修改冷却折扣池，也不改动已是新口径的状态。
 *
 * 输入/输出：
 * - 输入：从 Redis 解析出的 `BattleState`。
 * - 输出：原地修改 `state.teams[*].units[*].skillCooldowns` 与 `state.cooldownTimingMode`。
 *
 * 数据流/状态流：
 * Redis battle state -> 本函数按“本回合是否还会在 round_start 前行动”换算冷却 -> BattleEngine 恢复运行。
 *
 * 关键边界条件与坑点：
 * 1) 旧口径里“下一次 round_start 会先递减”的单位，恢复后必须先减 1；否则 deploy 窗口中的在途战斗会多锁一次自身行动。
 * 2) 当前轮还没轮到的单位（如 defender 正等待 attacker 行动完）本轮不会经历新的 round_start，不能提前减 1。
 */
export const migrateRecoveredLegacyBattleCooldownState = (
  state: BattleState,
): void => {
  if (state.cooldownTimingMode === ACTIVE_BATTLE_COOLDOWN_TIMING_MODE) return;

  ensureBattleStateSkillCooldownState(state);
  const currentTeamPendingUnitIds = getCurrentTeamPendingUnitIdSet(state);

  for (const teamKey of ["attacker", "defender"] as const) {
    for (const unit of state.teams[teamKey].units) {
      if (
        !shouldSubtractLegacyRoundStartTickForUnit(
          state,
          teamKey,
          unit,
          currentTeamPendingUnitIds,
        )
      ) {
        continue;
      }

      for (const skillId of Object.keys(unit.skillCooldowns)) {
        const remaining = getSkillCooldownRemainingRounds(unit, skillId);
        if (remaining <= 1) {
          delete unit.skillCooldowns[skillId];
          continue;
        }
        unit.skillCooldowns[skillId] = remaining - 1;
      }
    }
  }

  state.cooldownTimingMode = ACTIVE_BATTLE_COOLDOWN_TIMING_MODE;
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

export const reduceUnitSkillCooldowns = (
  unit: BattleUnit,
  options?: { skipSkillIds?: string[] },
): void => {
  ensureUnitSkillCooldownState(unit);
  const skipSkillIdSet = new Set(options?.skipSkillIds ?? []);
  for (const skillId of Object.keys(unit.skillCooldowns)) {
    if (skipSkillIdSet.has(skillId)) continue;
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

export const reduceSkillCooldownRemainingRounds = (
  unit: BattleUnit,
  skillId: string,
  rounds: number,
): number => {
  ensureUnitSkillCooldownState(unit);
  const discountRounds = Math.max(0, Math.floor(rounds));
  if (discountRounds <= 0) {
    return getSkillCooldownRemainingRounds(unit, skillId);
  }

  const remaining = getSkillCooldownRemainingRounds(unit, skillId);
  if (remaining <= 0) return 0;

  const nextRemaining = Math.max(0, remaining - discountRounds);
  if (nextRemaining <= 0) {
    delete unit.skillCooldowns[skillId];
    return 0;
  }

  unit.skillCooldowns[skillId] = nextRemaining;
  return nextRemaining;
};
