/**
 * 战斗运行时全局状态管理
 *
 * 作用：
 * - 集中管理所有活跃战斗的内存状态（Map / Set）
 * - 提供战斗查找、注册、冷却、缓存等基础操作
 *
 * 不做什么：不执行战斗逻辑、不推送前端、不操作 Redis。
 *
 * 数据流：
 * - activeBattles: battleId -> BattleEngine（战斗引擎实例）
 * - battleParticipants: battleId -> userId[]（参与者映射）
 * - finishedBattleResults: battleId -> { result, at }（结束结果缓存）
 *
 * 复用点：几乎所有 battle 子模块都通过此文件访问共享状态。
 *
 * 边界条件：
 * 1) findActiveBattleByCharacterId 跳过无参与者的战斗（脏状态），避免误拦截
 * 2) characterOwnerCache 有 TTL，防止用户换号后缓存不刷新
 */

import { query } from "../../../config/database.js";
import { BattleEngine } from "../../../battle/battleEngine.js";
import type { BattleState, BattleUnit } from "../../../battle/types.js";
import { getGameServer } from "../../../game/gameServer.js";
import {
  scheduleBattleCooldownPush,
} from "../cooldownManager.js";
import type { BattleResult, BattleStartCooldownValidation } from "../battleTypes.js";

// ============================================================
// 全局状态 Map / Set（所有模块通过 import 访问同一实例）
// ============================================================

/** 活跃战斗引擎实例 */
export const activeBattles = new Map<string, BattleEngine>();

/** 战斗参与者映射（battleId -> userId[]） */
export const battleParticipants = new Map<string, number[]>();

/** 已结束战斗结果缓存 */
export const finishedBattleResults = new Map<
  string,
  { result: BattleResult; at: number }
>();

/** 正在结算中的 Promise（去重） */
export const finishingBattleResults = new Map<string, Promise<BattleResult>>();

/** 战斗 tick 定时器 */
export const battleTickers = new Map<string, ReturnType<typeof setInterval>>();

/** 战斗 tick 锁（防止并发 tick） */
export const battleTickLocks = new Set<string>();

/** 日志增量追踪 */
export const battleLastEmittedLogLen = new Map<string, number>();

/** Redis 持久化时间追踪 */
export const battleLastRedisSavedAt = new Map<string, number>();

// ------ 常量 ------

export const BATTLE_TICK_MS = 650;
export const BATTLE_START_COOLDOWN_MS = 3000;
const FINISHED_BATTLE_TTL_MS = 2 * 60 * 1000;
const CHARACTER_OWNER_CACHE_TTL_MS = 60000;

// ------ 冷却管理 ------

const characterBattleStartCooldownUntil = new Map<number, number>();

function cleanupBattleStartCooldownCache(now: number): void {
  for (const [
    characterId,
    cooldownUntil,
  ] of characterBattleStartCooldownUntil.entries()) {
    if (
      !Number.isFinite(characterId) ||
      characterId <= 0 ||
      cooldownUntil <= now
    ) {
      characterBattleStartCooldownUntil.delete(characterId);
    }
  }
}

export function getBattleStartCooldownRemainingMs(
  characterId: number,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(characterId) || characterId <= 0) return 0;
  const cooldownUntilRaw = characterBattleStartCooldownUntil.get(characterId);
  if (
    typeof cooldownUntilRaw !== "number" ||
    !Number.isFinite(cooldownUntilRaw)
  )
    return 0;
  const remainingMs = cooldownUntilRaw - now;
  if (remainingMs <= 0) {
    characterBattleStartCooldownUntil.delete(characterId);
    return 0;
  }
  return remainingMs;
}

function formatBattleStartCooldownMessage(remainingMs: number): string {
  const remainSec = Math.max(0.1, Math.ceil(remainingMs / 100) / 10);
  return `战斗间隔冷却中，请 ${remainSec.toFixed(1)} 秒后再试`;
}

export function validateBattleStartCooldown(
  characterId: number,
  now: number = Date.now(),
): BattleStartCooldownValidation | null {
  const remainingMs = getBattleStartCooldownRemainingMs(characterId, now);
  if (remainingMs <= 0) return null;
  return {
    message: formatBattleStartCooldownMessage(remainingMs),
    retryAfterMs: remainingMs,
    cooldownMs: BATTLE_START_COOLDOWN_MS,
    nextBattleAvailableAt: now + remainingMs,
  };
}

export function setBattleStartCooldownByCharacterIds(
  characterIds: number[],
  now: number = Date.now(),
): number {
  const cooldownUntil = now + BATTLE_START_COOLDOWN_MS;
  for (const raw of characterIds) {
    const characterId = Math.floor(Number(raw));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    characterBattleStartCooldownUntil.set(characterId, cooldownUntil);
    scheduleBattleCooldownPush(characterId, BATTLE_START_COOLDOWN_MS);
  }
  cleanupBattleStartCooldownCache(now);
  return cooldownUntil;
}

export const buildBattleStartCooldownResult = (
  cooldown: BattleStartCooldownValidation,
  reason: string,
  message?: string,
): BattleResult => ({
  success: false,
  message: message ?? cooldown.message,
  data: {
    reason,
    retryAfterMs: cooldown.retryAfterMs,
    battleStartCooldownMs: cooldown.cooldownMs,
    nextBattleAvailableAt: cooldown.nextBattleAvailableAt,
  },
});

// ------ 角色归属缓存 ------

const characterOwnerCache = new Map<number, { userId: number; at: number }>();

export async function getUserIdByCharacterId(
  characterId: number,
): Promise<number | null> {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  const cached = characterOwnerCache.get(characterId);
  const now = Date.now();
  if (cached && now - cached.at <= CHARACTER_OWNER_CACHE_TTL_MS)
    return cached.userId;

  try {
    const res = await query("SELECT user_id FROM characters WHERE id = $1", [
      characterId,
    ]);
    const userId = Number(res.rows?.[0]?.user_id);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    characterOwnerCache.set(characterId, { userId, at: now });
    return userId;
  } catch (error) {
    console.warn("[battle] 查询角色归属用户失败:", error);
    return null;
  }
}

// ------ 战斗查找 ------

type ActiveBattleByCharacter = {
  battleId: string;
  state: BattleState;
};

export function findActiveBattleByCharacterId(
  characterId: number,
): ActiveBattleByCharacter | null {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0)
    return null;

  for (const [battleId, engine] of activeBattles.entries()) {
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) continue;

    const state = engine.getState();
    if (state.phase === "finished") continue;

    const units = [
      ...state.teams.attacker.units,
      ...state.teams.defender.units,
    ];
    for (const unit of units) {
      if (unit.type !== "player") continue;
      if (Number(unit.sourceId) !== normalizedCharacterId) continue;
      return { battleId, state };
    }
  }

  return null;
}

export function buildCharacterInBattleResult(
  characterId: number,
  reason: "character_in_battle" | "opponent_in_battle",
  message: string,
): BattleResult | null {
  const activeBattle = findActiveBattleByCharacterId(characterId);
  if (!activeBattle) return null;

  const teamMemberCount = Math.max(
    1,
    collectAttackerPlayerCharacterIdsFromBattleState(activeBattle.state).length,
  );

  return {
    success: false,
    message,
    data: {
      reason,
      battleId: activeBattle.battleId,
      state: activeBattle.state,
      isTeamBattle: teamMemberCount > 1,
      teamMemberCount,
    },
  };
}

function collectPlayerCharacterIdsFromUnits(units: BattleUnit[]): number[] {
  const ids = new Set<number>();
  for (const unit of units) {
    if (unit.type !== "player") continue;
    const characterId = Math.floor(Number(unit.sourceId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    ids.add(characterId);
  }
  return [...ids];
}

export function collectAttackerPlayerCharacterIdsFromBattleState(
  state: BattleState,
): number[] {
  return collectPlayerCharacterIdsFromUnits(state.teams.attacker.units);
}

export function collectPlayerCharacterIdsFromBattleState(
  state: BattleState,
): number[] {
  return collectPlayerCharacterIdsFromUnits([
    ...state.teams.attacker.units,
    ...state.teams.defender.units,
  ]);
}

export function normalizeBattleParticipantUserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<number>();
  for (const item of raw) {
    const userId = Math.floor(Number(item));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    ids.add(userId);
  }
  return [...ids];
}

export function collectBattleOwnerUserIds(state: BattleState): number[] {
  const ownerIds = new Set<number>();
  const attackerOwnerId = Math.floor(Number(state.teams.attacker?.odwnerId));
  const defenderOwnerId = Math.floor(Number(state.teams.defender?.odwnerId));
  if (Number.isFinite(attackerOwnerId) && attackerOwnerId > 0)
    ownerIds.add(attackerOwnerId);
  if (Number.isFinite(defenderOwnerId) && defenderOwnerId > 0)
    ownerIds.add(defenderOwnerId);
  return [...ownerIds];
}

export function listActiveBattleIdsByUserId(userId: number): string[] {
  const ids: string[] = [];
  if (!Number.isFinite(userId) || userId <= 0) return ids;
  for (const [battleId, participants] of battleParticipants.entries()) {
    if (!Array.isArray(participants)) continue;
    if (participants.includes(userId)) ids.push(battleId);
  }
  return ids;
}

export function getAttackerPlayerCount(state: BattleState): number {
  return collectAttackerPlayerCharacterIdsFromBattleState(state).length;
}

export function isCharacterInBattle(characterId: number): boolean {
  return findActiveBattleByCharacterId(characterId) !== null;
}

export function getFinishedBattleResultIfFresh(
  battleId: string,
): BattleResult | null {
  const cached = finishedBattleResults.get(battleId);
  if (!cached) return null;
  if (Date.now() - cached.at > FINISHED_BATTLE_TTL_MS) {
    finishedBattleResults.delete(battleId);
    return null;
  }
  return cached.result;
}

// ------ 数据优化 ------

export function stripStaticUnitFields(
  unit: BattleUnit,
): Omit<BattleUnit, "baseAttrs" | "skills" | "setBonusEffects" | "aiProfile"> {
  const {
    baseAttrs: _ba,
    skills: _sk,
    setBonusEffects: _sbe,
    aiProfile: _ai,
    ...dynamic
  } = unit;
  return dynamic;
}

export function stripStaticFieldsFromState(
  state: BattleState,
): Record<string, unknown> {
  const strippedAttacker = state.teams.attacker.units.map(
    stripStaticUnitFields,
  );
  const strippedDefender = state.teams.defender.units.map(
    stripStaticUnitFields,
  );
  return {
    ...state,
    teams: {
      attacker: { ...state.teams.attacker, units: strippedAttacker },
      defender: { ...state.teams.defender, units: strippedDefender },
    },
  };
}

// ------ 注册战斗 ------

/**
 * 注册已创建的战斗到全局状态并启动 ticker
 *
 * 注意：此函数依赖 ticker.ts 的 startBattleTicker + emitBattleUpdate，
 * 通过延迟 import 避免 state <-> ticker 循环。
 */
export function registerStartedBattle(
  battleId: string,
  engine: BattleEngine,
  participantUserIds: number[],
): void {
  engine.startBattle();
  activeBattles.set(battleId, engine);
  battleParticipants.set(battleId, participantUserIds);
  // 延迟导入避免循环依赖：state.ts <-> ticker.ts
  import("./ticker.js").then(({ emitBattleUpdate, startBattleTicker }) => {
    emitBattleUpdate(battleId, {
      kind: "battle_started",
      battleId,
      state: engine.getState(),
    });
    startBattleTicker(battleId);
  });
}
