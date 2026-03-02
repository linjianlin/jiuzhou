/**
 * 九州修仙录 - 战斗服务层
 */

import { query } from "../../config/database.js";
import { redis } from "../../config/redis.js";
import {
  createPVEBattle,
  createPVPBattle,
  type CharacterData,
  type MonsterData,
  type SkillData,
} from "../../battle/battleFactory.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import { canUseSkill, isFeared, isStunned } from "../../battle/modules/control.js";
import { getNormalAttack } from "../../battle/modules/skill.js";
import type {
  BattleAttrs,
  BattleUnit,
  BattleSkill,
  BattleState,
  BattleSetBonusEffect,
  MonsterAIPhaseTrigger,
  MonsterAIProfile,
  SkillEffect,
} from "../../battle/types.js";
import {
  battleDropService,
  type BattleParticipant,
  type DistributeResult,
} from "../battleDropService.js";
import {
  extractBattleAffixEffectsFromEquippedItems,
  type BattleAffixEffectSource,
} from "../battleAffixEffectService.js";
import { getRoomInMap } from "../mapService.js";
import { getGameServer } from "../../game/gameServer.js";
import { recordKillMonsterEvent } from "../taskService.js";
import { characterTechniqueService } from "../characterTechniqueService.js";
import { getArenaStatus } from "../arenaService.js";
import type { PoolClient } from "pg";
import {
  scheduleBattleCooldownPush,
  cancelBattleCooldown,
} from "./cooldownManager.js";
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByCharacterId,
  getCharacterComputedByUserId,
  recoverBattleStartResourcesByUserIds,
  setCharacterResourcesByCharacterId,
} from "../characterComputedService.js";
import {
  getItemDefinitionsByIds,
  getItemSetDefinitions,
  getMonsterDefinitions,
  getSkillDefinitions,
  type MonsterAIProfileConfig,
  type MonsterDefConfig,
  type MonsterPhaseTriggerConfig,
  type SkillDefConfig,
} from "../staticConfigLoader.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { idleSessionService } from "../idle/idleSessionService.js";
import {
  calculateArenaRatingDelta,
  DEFAULT_ARENA_RATING,
  type ArenaBattleOutcome,
} from "../shared/arenaRatingDelta.js";

// 活跃战斗缓存
const activeBattles = new Map<string, BattleEngine>();
// 战斗参与者映射（battleId -> userId[]）
const battleParticipants = new Map<string, number[]>();
const finishedBattleResults = new Map<
  string,
  { result: BattleResult; at: number }
>();
const finishingBattleResults = new Map<string, Promise<BattleResult>>();
const FINISHED_BATTLE_TTL_MS = 2 * 60 * 1000;
const battleTickers = new Map<string, ReturnType<typeof setInterval>>();
const battleTickLocks = new Set<string>();
const characterOwnerCache = new Map<number, { userId: number; at: number }>();
const CHARACTER_OWNER_CACHE_TTL_MS = 60000;
export const BATTLE_TICK_MS = 650;
export const BATTLE_START_COOLDOWN_MS = 3000;
const characterBattleStartCooldownUntil = new Map<number, number>();
const battleLastEmittedLogLen = new Map<string, number>();
const battleLastRedisSavedAt = new Map<string, number>();
const BATTLE_REDIS_SAVE_INTERVAL_MS = 2000;
const MAX_BATTLE_LOG_DELTA = 80;
const BATTLE_SET_BONUS_TRIGGER_SET = new Set([
  "on_turn_start",
  "on_skill",
  "on_hit",
  "on_crit",
  "on_be_hit",
  "on_heal",
]);
const BATTLE_SET_BONUS_EFFECT_TYPE_SET = new Set([
  "buff",
  "debuff",
  "damage",
  "heal",
  "resource",
  "shield",
]);

const getFinishedBattleResultIfFresh = (
  battleId: string,
): BattleResult | null => {
  const cached = finishedBattleResults.get(battleId);
  if (!cached) return null;
  if (Date.now() - cached.at > FINISHED_BATTLE_TTL_MS) {
    finishedBattleResults.delete(battleId);
    return null;
  }
  return cached.result;
};

/**
 * 挂机中检查 — 若角色有活跃挂机会话则拒绝发起战斗
 *
 * 复用点：startPVEBattle / startDungeonPVEBattle / startPVPBattle 三处调用，
 * 避免重复编写相同的查询 + 判断逻辑。
 *
 * 返回：null 表示未挂机，可继续；非 null 为拒绝结果，直接 return 即可。
 */
async function rejectIfIdling(
  characterId: number,
): Promise<BattleResult | null> {
  const idleSession =
    await idleSessionService.getActiveIdleSession(characterId);
  if (idleSession) {
    return { success: false, message: "离线挂机中，无法发起战斗" };
  }
  return null;
}

// Redis 战斗持久化常量
const REDIS_BATTLE_KEY_PREFIX = "battle:state:";
const REDIS_BATTLE_PARTICIPANTS_PREFIX = "battle:participants:";
const REDIS_BATTLE_TTL_SECONDS = 30 * 60; // 30分钟

/**
 * 保存战斗状态到 Redis
 */
async function saveBattleToRedis(
  battleId: string,
  engine: BattleEngine,
  participants: number[],
): Promise<void> {
  try {
    const state = engine.getState();
    await Promise.all([
      redis.setex(
        `${REDIS_BATTLE_KEY_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(state),
      ),
      redis.setex(
        `${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(participants),
      ),
    ]);
  } catch (error) {
    console.error("保存战斗到 Redis 失败:", error);
  }
}

/**
 * 从 Redis 删除战斗状态
 */
async function removeBattleFromRedis(battleId: string): Promise<void> {
  try {
    await Promise.all([
      redis.del(`${REDIS_BATTLE_KEY_PREFIX}${battleId}`),
      redis.del(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
    ]);
  } catch (error) {
    console.error("从 Redis 删除战斗失败:", error);
  }
}

/**
 * 从 Redis 恢复所有活跃战斗（服务启动时调用）
 */
export async function recoverBattlesFromRedis(): Promise<number> {
  let recoveredCount = 0;
  try {
    const keys = await redis.keys(`${REDIS_BATTLE_KEY_PREFIX}*`);
    if (keys.length === 0) {
      console.log("✓ 没有需要恢复的战斗");
      return 0;
    }

    for (const key of keys) {
      const battleId = key.replace(REDIS_BATTLE_KEY_PREFIX, "");
      try {
        const [stateJson, participantsJson] = await Promise.all([
          redis.get(key),
          redis.get(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
        ]);

        if (!stateJson) {
          await removeBattleFromRedis(battleId);
          continue;
        }

        const state = JSON.parse(stateJson) as BattleState;

        // 跳过已结束的战斗
        if (state.phase === "finished") {
          await removeBattleFromRedis(battleId);
          continue;
        }
        const participantsRaw = participantsJson
          ? JSON.parse(participantsJson)
          : null;
        const participants = await resolveRecoveredBattleParticipants(
          state,
          participantsRaw,
        );
        if (participants.length === 0) {
          // 参与者无法恢复时，该战斗无法被玩家重连接管，会导致“误判仍在战斗中”。
          // 直接清理该脏战斗，避免阻塞后续开战。
          console.warn(
            `  跳过恢复战斗 ${battleId}: 参与者缺失且无法从战斗状态反推`,
          );
          await removeBattleFromRedis(battleId);
          continue;
        }

        // 恢复战斗引擎
        const engine = new BattleEngine(state);
        activeBattles.set(battleId, engine);
        battleParticipants.set(battleId, participants);
        startBattleTicker(battleId);

        recoveredCount++;
        console.log(
          `  恢复战斗: ${battleId} (${participants.length} 名参与者)`,
        );
      } catch (error) {
        console.error(`  恢复战斗 ${battleId} 失败:`, error);
        await removeBattleFromRedis(battleId);
      }
    }

    console.log(`✓ 已恢复 ${recoveredCount} 场战斗`);
  } catch (error) {
    console.error("恢复战斗失败:", error);
  }
  return recoveredCount;
}

export interface BattleResult {
  success: boolean;
  message: string;
  data?: any;
}

function uniqueStringIds(ids: string[]): string[] {
  return [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
}

/**
 * 从 BattleUnit 中剥离战斗期间不变的静态字段，仅保留 tick 间会变化的动态字段。
 *
 * 剥离字段：baseAttrs(24字段)、skills(完整技能定义)、setBonusEffects、aiProfile
 * 保留字段：id、name、type、sourceId、currentAttrs、qixue、lingqi、shields、buffs、
 *           skillCooldowns、isAlive、canAct、stats、controlDiminishing、
 *           triggeredPhaseIds、isSummon、summonerId
 *
 * 复用点：仅在 patchBattleUpdatePayload 的 battle_state 分支调用
 * 边界条件：
 *   - 若 unit 为 null/undefined 直接返回原值
 *   - 使用解构 + rest 模式确保类型安全，不遗漏新增字段
 */
function stripStaticUnitFields(
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

function stripStaticFieldsFromState(
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

function patchBattleUpdatePayload(battleId: string, payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const kind = String((payload as any).kind || "");

  if (kind === "battle_started") {
    const state = (payload as any).state as any;
    const logsLen = Array.isArray(state?.logs) ? state.logs.length : 0;
    battleLastEmittedLogLen.set(battleId, logsLen);
    // battle_started 发送完整 state（含 baseAttrs/skills），客户端缓存静态数据
    return payload;
  }

  if (kind === "battle_finished" || kind === "battle_abandoned") {
    battleLastEmittedLogLen.delete(battleId);
    return payload;
  }

  if (kind !== "battle_state") return payload;

  const state = (payload as any).state as BattleState | undefined;
  if (!state || typeof state !== "object") return payload;

  const logs = Array.isArray(state.logs) ? state.logs : [];
  const currentLen = logs.length;
  const prevLenRaw = battleLastEmittedLogLen.get(battleId);
  const prevLen =
    typeof prevLenRaw === "number" && prevLenRaw >= 0 ? prevLenRaw : 0;
  const startIndex = currentLen >= prevLen ? prevLen : 0;
  const deltaLogs = logs.slice(startIndex);

  battleLastEmittedLogLen.set(battleId, currentLen);

  // 剥离静态字段 + 日志增量
  const strippedState = stripStaticFieldsFromState(state);
  strippedState.logs =
    deltaLogs.length > MAX_BATTLE_LOG_DELTA ? logs : deltaLogs;
  const logDelta = deltaLogs.length <= MAX_BATTLE_LOG_DELTA;
  const logStart = logDelta ? startIndex : 0;

  return {
    ...(payload as any),
    state: strippedState,
    logStart,
    logDelta,
    unitsDelta: true,
  };
}

function randomIntInclusive(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}

function withBattleStartResources<
  T extends {
    qixue?: number;
    max_qixue?: number;
    lingqi?: number;
    max_lingqi?: number;
  },
>(data: T): T {
  const maxQixue = Number(data.max_qixue ?? 0);
  const maxLingqi = Number(data.max_lingqi ?? 0);
  const currentLingqiRaw = Number(data.lingqi ?? 0);
  const currentLingqi = Number.isFinite(currentLingqiRaw)
    ? currentLingqiRaw
    : 0;
  const targetLingqi =
    maxLingqi > 0 ? Math.max(0, Math.floor(maxLingqi * 0.5)) : currentLingqi;
  return {
    ...data,
    qixue: maxQixue > 0 ? maxQixue : Number(data.qixue ?? 0),
    lingqi: currentLingqi < targetLingqi ? targetLingqi : currentLingqi,
  };
}

type QueryExecutor = Pick<PoolClient, "query">;

async function restoreBattleStartResourcesInDb(
  userIds: number[],
  queryExecutor?: QueryExecutor,
): Promise<void> {
  void queryExecutor;
  await recoverBattleStartResourcesByUserIds(userIds);
}

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

function getBattleStartCooldownRemainingMs(
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

function setBattleStartCooldownByCharacterIds(
  characterIds: number[],
  now: number = Date.now(),
): number {
  const cooldownUntil = now + BATTLE_START_COOLDOWN_MS;
  for (const raw of characterIds) {
    const characterId = Math.floor(Number(raw));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    characterBattleStartCooldownUntil.set(characterId, cooldownUntil);

    // 启动服务端推送定时器
    scheduleBattleCooldownPush(characterId, BATTLE_START_COOLDOWN_MS);
  }
  cleanupBattleStartCooldownCache(now);
  return cooldownUntil;
}

function formatBattleStartCooldownMessage(remainingMs: number): string {
  const remainSec = Math.max(0.1, Math.ceil(remainingMs / 100) / 10);
  return `战斗间隔冷却中，请 ${remainSec.toFixed(1)} 秒后再试`;
}

type BattleStartCooldownValidation = {
  message: string;
  retryAfterMs: number;
  cooldownMs: number;
  nextBattleAvailableAt: number;
};

function validateBattleStartCooldown(
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

type ActiveBattleByCharacter = {
  battleId: string;
  state: BattleState;
};

/**
 * 按角色ID查找其当前所在的活跃战斗。
 *
 * 输入：
 * - characterId：角色ID（必须是正整数）
 *
 * 输出：
 * - 命中时返回 { battleId, state }
 * - 未命中时返回 null
 *
 * 数据流：
 * - activeBattles(Map) -> BattleEngine.getState() -> attacker/defender 双方单位扫描 -> 匹配 player.sourceId
 *
 * 关键边界条件与坑点：
 * - characterId 非法（非数字/<=0）时直接返回 null，避免误判。
 * - sourceId 存在字符串数字场景，统一使用 Number(...) 比较，避免类型不一致导致漏命中。
 * - 战斗已结束（phase === 'finished'）时不算作"活跃战斗"，避免状态残留导致误判。
 */
function findActiveBattleByCharacterId(
  characterId: number,
): ActiveBattleByCharacter | null {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0)
    return null;

  for (const [battleId, engine] of activeBattles.entries()) {
    // 无参与者战斗无法被重连同步，视为脏状态，避免误拦截“正在战斗中”。
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) continue;

    const state = engine.getState();

    // 战斗已结束不算作活跃战斗
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

/**
 * 构建“角色已在战斗中”的标准返回体。
 *
 * 输入：
 * - characterId：要查询的角色ID
 * - reason：前端状态机识别用原因码
 * - message：用户可读提示
 *
 * 输出：
 * - 命中战斗时返回 BattleResult（success=false，附带 battleId/state）
 * - 未命中返回 null（由调用方继续执行后续开战逻辑）
 *
 * 数据流：
 * - findActiveBattleByCharacterId -> 提取当前战斗state -> 计算组队信息 -> 组装 BattleResult.data
 *
 * 关键边界条件与坑点：
 * - reason 仅允许当前协议定义值，避免前后端分支漂移。
 * - teamMemberCount 最少为1，保证前端展示逻辑不出现0人队伍。
 */
function buildCharacterInBattleResult(
  characterId: number,
  reason: "character_in_battle" | "opponent_in_battle",
  message: string,
): BattleResult | null {
  const activeBattle = findActiveBattleByCharacterId(characterId);
  if (!activeBattle) return null;

  const teamMemberCount = Math.max(
    1,
    (activeBattle.state.teams.attacker.units ?? []).filter(
      (unit) => unit.type === "player",
    ).length,
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

function collectPlayerCharacterIdsFromBattleState(
  state: BattleState,
): number[] {
  const ids = new Set<number>();
  const units = [...state.teams.attacker.units, ...state.teams.defender.units];
  for (const unit of units) {
    if (unit.type !== "player") continue;
    const characterId = Math.floor(Number(unit.sourceId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    ids.add(characterId);
  }
  return [...ids];
}

function normalizeBattleParticipantUserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<number>();
  for (const item of raw) {
    const userId = Math.floor(Number(item));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    ids.add(userId);
  }
  return [...ids];
}

function collectBattleOwnerUserIds(state: BattleState): number[] {
  const ownerIds = new Set<number>();
  const attackerOwnerId = Math.floor(Number(state.teams.attacker?.odwnerId));
  const defenderOwnerId = Math.floor(Number(state.teams.defender?.odwnerId));
  if (Number.isFinite(attackerOwnerId) && attackerOwnerId > 0)
    ownerIds.add(attackerOwnerId);
  if (Number.isFinite(defenderOwnerId) && defenderOwnerId > 0)
    ownerIds.add(defenderOwnerId);
  return [...ownerIds];
}

/**
 * 恢复战斗参与者（userId 列表）
 *
 * 作用：
 * - 优先复用 Redis 持久化的 participants
 * - 若历史脏数据导致 participants 缺失，则从 BattleState 中反推角色归属用户
 *
 * 输入/输出：
 * - state: BattleState（已从 Redis 反序列化）
 * - participantsRaw: Redis participants 原始值（可能为空/脏格式）
 * - 返回去重后的 userId 列表；无法恢复时返回空数组
 *
 * 数据流：
 * - participantsRaw -> normalizeBattleParticipantUserIds
 * - 缺失时：state.teams ownerId + collectPlayerCharacterIdsFromBattleState
 *   -> getUserIdByCharacterId -> 去重 userId
 *
 * 关键边界条件与坑点：
 * - participantsRaw 非数组或含非法值时，必须过滤，避免恢复出无效 userId。
 * - BattleState 仅存 characterId，不直接存 userId；需通过角色归属查询反推。
 */
async function resolveRecoveredBattleParticipants(
  state: BattleState,
  participantsRaw: unknown,
): Promise<number[]> {
  const fromRedis = normalizeBattleParticipantUserIds(participantsRaw);
  if (fromRedis.length > 0) return fromRedis;

  const ids = new Set<number>();
  for (const ownerUserId of collectBattleOwnerUserIds(state)) {
    ids.add(ownerUserId);
  }

  const playerCharacterIds = collectPlayerCharacterIdsFromBattleState(state);
  if (playerCharacterIds.length > 0) {
    const ownerUserIds = await Promise.all(
      playerCharacterIds.map((characterId) =>
        getUserIdByCharacterId(characterId),
      ),
    );
    for (const userId of ownerUserIds) {
      const normalizedUserId = Math.floor(Number(userId));
      if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
      ids.add(normalizedUserId);
    }
  }

  return [...ids];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const MONSTER_PHASE_ACTION_SET = new Set(["enrage", "summon"]);
const MONSTER_PHASE_BUFF_PATTERN = /^(buff|debuff)-([a-z0-9-]+)-(up|down)$/i;
const MONSTER_SKILL_TARGET_TYPE_SET = new Set<BattleSkill["targetType"]>([
  "self",
  "single_enemy",
  "single_ally",
  "all_enemy",
  "all_ally",
  "random_enemy",
  "random_ally",
]);

type MonsterRuntimeCacheEntry = {
  monster: MonsterData;
  skills: SkillData[];
  attrs: BattleAttrs;
  battleSkills: BattleSkill[];
  aiProfile: MonsterAIProfile;
};

type MonsterRuntimeResolveResult =
  | { success: true; entry: MonsterRuntimeCacheEntry }
  | { success: false; error: string };

type OrderedMonstersResolveResult =
  | {
      success: true;
      monsters: MonsterData[];
      monsterSkillsMap: Record<string, SkillData[]>;
    }
  | { success: false; error: string };

function normalizeSkillTargetType(raw: unknown): BattleSkill["targetType"] {
  const target = toText(raw);
  return MONSTER_SKILL_TARGET_TYPE_SET.has(target as BattleSkill["targetType"])
    ? (target as BattleSkill["targetType"])
    : "single_enemy";
}

function normalizeSkillDamageType(raw: unknown): BattleSkill["damageType"] {
  const value = toText(raw);
  if (value === "physical" || value === "magic" || value === "true")
    return value;
  return undefined;
}

function cloneSkillEffectList(raw: unknown): SkillEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillEffect[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    out.push({ ...(row as SkillEffect) });
  }
  return out;
}

function toBattleSkillData(row: SkillDefConfig): SkillData {
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    cost_lingqi: Math.max(0, Math.floor(Number(row.cost_lingqi ?? 0) || 0)),
    cost_qixue: Math.max(0, Math.floor(Number(row.cost_qixue ?? 0) || 0)),
    cooldown: Math.max(0, Math.floor(Number(row.cooldown ?? 0) || 0)),
    target_type: String(row.target_type || "single_enemy"),
    target_count: Math.max(1, Math.floor(Number(row.target_count ?? 1) || 1)),
    damage_type: String(row.damage_type || "none"),
    element: String(row.element || "none"),
    effects: cloneSkillEffectList(row.effects),
    ai_priority: Math.max(0, Math.floor(Number(row.ai_priority ?? 50) || 50)),
  };
}

function toBattleSkill(skill: SkillData): BattleSkill {
  return {
    id: skill.id,
    name: skill.name,
    source: "innate",
    cost: {
      lingqi: skill.cost_lingqi,
      qixue: skill.cost_qixue,
    },
    cooldown: skill.cooldown,
    targetType: normalizeSkillTargetType(skill.target_type),
    targetCount: Math.max(1, Math.floor(skill.target_count || 1)),
    damageType: normalizeSkillDamageType(skill.damage_type),
    element: String(skill.element || "none"),
    effects: skill.effects.map((effect) => ({ ...effect })),
    triggerType: "active",
    aiPriority: Math.max(0, Math.floor(skill.ai_priority || 0)),
  };
}

function cloneBattleSkill(skill: BattleSkill): BattleSkill {
  return {
    ...skill,
    cost: { ...skill.cost },
    effects: skill.effects.map((effect) => ({ ...effect })),
  };
}

function toOptionalNumber(value: unknown): number | undefined {
  const n = toNumber(value);
  return n === null ? undefined : n;
}

function normalizeMonsterBaseAttrs(raw: unknown): MonsterData["base_attrs"] {
  const attrs = toRecord(raw);
  return {
    qixue: toOptionalNumber(attrs.qixue),
    max_qixue: toOptionalNumber(attrs.max_qixue),
    lingqi: toOptionalNumber(attrs.lingqi),
    max_lingqi: toOptionalNumber(attrs.max_lingqi),
    wugong: toOptionalNumber(attrs.wugong),
    fagong: toOptionalNumber(attrs.fagong),
    wufang: toOptionalNumber(attrs.wufang),
    fafang: toOptionalNumber(attrs.fafang),
    sudu: toOptionalNumber(attrs.sudu),
    mingzhong: toOptionalNumber(attrs.mingzhong),
    shanbi: toOptionalNumber(attrs.shanbi),
    zhaojia: toOptionalNumber(attrs.zhaojia),
    baoji: toOptionalNumber(attrs.baoji),
    baoshang: toOptionalNumber(attrs.baoshang),
    kangbao: toOptionalNumber(attrs.kangbao),
    zengshang: toOptionalNumber(attrs.zengshang),
    zhiliao: toOptionalNumber(attrs.zhiliao),
    jianliao: toOptionalNumber(attrs.jianliao),
    xixue: toOptionalNumber(attrs.xixue),
    lengque: toOptionalNumber(attrs.lengque),
    kongzhi_kangxing: toOptionalNumber(attrs.kongzhi_kangxing),
    jin_kangxing: toOptionalNumber(attrs.jin_kangxing),
    mu_kangxing: toOptionalNumber(attrs.mu_kangxing),
    shui_kangxing: toOptionalNumber(attrs.shui_kangxing),
    huo_kangxing: toOptionalNumber(attrs.huo_kangxing),
    tu_kangxing: toOptionalNumber(attrs.tu_kangxing),
    qixue_huifu: toOptionalNumber(attrs.qixue_huifu),
    lingqi_huifu: toOptionalNumber(attrs.lingqi_huifu),
  };
}

function extractMonsterAttrsForSummon(def: MonsterDefConfig): BattleAttrs {
  const attrs = normalizeMonsterBaseAttrs(def.base_attrs);
  return {
    max_qixue: toNumber(attrs.max_qixue ?? attrs.qixue) ?? 100,
    max_lingqi: toNumber(attrs.max_lingqi ?? attrs.lingqi) ?? 0,
    wugong: toNumber(attrs.wugong) ?? 0,
    fagong: toNumber(attrs.fagong) ?? 0,
    wufang: toNumber(attrs.wufang) ?? 0,
    fafang: toNumber(attrs.fafang) ?? 0,
    sudu: Math.max(1, toNumber(attrs.sudu) ?? 1),
    mingzhong: toNumber(attrs.mingzhong) ?? 0.9,
    shanbi: toNumber(attrs.shanbi) ?? 0,
    zhaojia: toNumber(attrs.zhaojia) ?? 0,
    baoji: toNumber(attrs.baoji) ?? 0,
    baoshang: toNumber(attrs.baoshang) ?? 0,
    kangbao: toNumber(attrs.kangbao) ?? 0,
    zengshang: toNumber(attrs.zengshang) ?? 0,
    zhiliao: toNumber(attrs.zhiliao) ?? 0,
    jianliao: toNumber(attrs.jianliao) ?? 0,
    xixue: toNumber(attrs.xixue) ?? 0,
    lengque: toNumber(attrs.lengque) ?? 0,
    kongzhi_kangxing: toNumber(attrs.kongzhi_kangxing) ?? 0,
    jin_kangxing: toNumber(attrs.jin_kangxing) ?? 0,
    mu_kangxing: toNumber(attrs.mu_kangxing) ?? 0,
    shui_kangxing: toNumber(attrs.shui_kangxing) ?? 0,
    huo_kangxing: toNumber(attrs.huo_kangxing) ?? 0,
    tu_kangxing: toNumber(attrs.tu_kangxing) ?? 0,
    qixue_huifu: toNumber(attrs.qixue_huifu) ?? 0,
    lingqi_huifu: toNumber(attrs.lingqi_huifu) ?? 0,
    realm: toText(def.realm) || "凡人",
    element: toText(def.element) || "none",
  };
}

function parsePhaseEffects(
  raw: unknown,
  monsterId: string,
  triggerIndex: number,
):
  | { success: true; effects: SkillEffect[] }
  | { success: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      success: false,
      error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发缺少effects配置`,
    };
  }

  const effects: SkillEffect[] = [];
  for (let i = 0; i < raw.length; i++) {
    const effect = toRecord(raw[i]);
    const effectType = toText(effect.type);
    if (effectType !== "buff" && effectType !== "debuff") {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect仅支持buff/debuff`,
      };
    }

    const buffId = toText(effect.buffId);
    if (!MONSTER_PHASE_BUFF_PATTERN.test(buffId)) {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect的buffId非法: ${buffId}`,
      };
    }

    const value = toNumber(effect.value);
    if (value === null || value <= 0) {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect的value必须>0`,
      };
    }

    const durationRaw = toNumber(effect.duration);
    const duration =
      durationRaw === null ? 1 : Math.max(1, Math.floor(durationRaw));
    const stacksRaw = toNumber(effect.stacks);
    const stacks = stacksRaw === null ? 1 : Math.max(1, Math.floor(stacksRaw));
    effects.push({
      type: effectType,
      buffId,
      value,
      duration,
      stacks,
    });
  }
  return { success: true, effects };
}

function resolveMonsterRuntime(
  monsterId: string,
  monsterDefMap: Map<string, MonsterDefConfig>,
  skillDefMap: Map<string, SkillDefConfig>,
  cache: Map<string, MonsterRuntimeCacheEntry>,
  resolvingPath: Set<string>,
): MonsterRuntimeResolveResult {
  const cached = cache.get(monsterId);
  if (cached) return { success: true, entry: cached };
  if (resolvingPath.has(monsterId)) {
    return { success: false, error: `怪物AI配置存在循环召唤: ${monsterId}` };
  }

  const def = monsterDefMap.get(monsterId);
  if (!def || def.enabled === false) {
    return { success: false, error: `怪物配置不存在或未启用: ${monsterId}` };
  }

  resolvingPath.add(monsterId);
  const aiProfileRaw: MonsterAIProfileConfig = def.ai_profile ?? {};

  const skillIds = uniqueStringIds(
    (Array.isArray(aiProfileRaw.skills) ? aiProfileRaw.skills : [])
      .map((skillId) => String(skillId || "").trim())
      .filter((skillId) => skillId.length > 0),
  );
  const skills: SkillData[] = [];
  for (const skillId of skillIds) {
    const skillDef = skillDefMap.get(skillId);
    if (!skillDef || skillDef.enabled === false) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 引用了不存在的技能: ${skillId}`,
      };
    }
    skills.push(toBattleSkillData(skillDef));
  }

  const skillWeights: Record<string, number> = {};
  const skillWeightRaw = toRecord(aiProfileRaw.skill_weights);
  for (const [skillIdRaw, weightRaw] of Object.entries(skillWeightRaw)) {
    const skillId = String(skillIdRaw || "").trim();
    if (!skillId) continue;
    if (!skillIds.includes(skillId)) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] skill_weights包含未配置技能: ${skillId}`,
      };
    }
    const weight = toNumber(weightRaw);
    if (weight === null || weight <= 0) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 技能权重非法: ${skillId}`,
      };
    }
    skillWeights[skillId] = weight;
  }

  const phaseTriggers: MonsterAIPhaseTrigger[] = [];
  const rawPhaseTriggers = Array.isArray(aiProfileRaw.phase_triggers)
    ? aiProfileRaw.phase_triggers
    : [];
  for (let i = 0; i < rawPhaseTriggers.length; i++) {
    const triggerRaw = (rawPhaseTriggers[i] ?? {}) as MonsterPhaseTriggerConfig;
    const hpPercentRaw = toNumber(triggerRaw.hp_percent);
    if (hpPercentRaw === null || hpPercentRaw <= 0 || hpPercentRaw > 1) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条阶段触发hp_percent非法`,
      };
    }

    const action = toText(triggerRaw.action);
    if (!MONSTER_PHASE_ACTION_SET.has(action)) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条阶段触发action非法: ${action}`,
      };
    }

    const triggerId = `${monsterId}-phase-${i + 1}`;
    if (action === "enrage") {
      const effectResult = parsePhaseEffects(
        triggerRaw.effects,
        monsterId,
        i + 1,
      );
      if (!effectResult.success) {
        resolvingPath.delete(monsterId);
        return { success: false, error: effectResult.error };
      }
      phaseTriggers.push({
        id: triggerId,
        hpPercent: hpPercentRaw,
        action: "enrage",
        effects: effectResult.effects,
        summonCount: 1,
      });
      continue;
    }

    const summonMonsterId = toText(triggerRaw.summon_id);
    if (!summonMonsterId) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条召唤触发缺少summon_id`,
      };
    }
    const summonCountRaw = toNumber(triggerRaw.summon_count);
    const summonCount =
      summonCountRaw === null ? 1 : Math.max(1, Math.floor(summonCountRaw));
    const summonResult = resolveMonsterRuntime(
      summonMonsterId,
      monsterDefMap,
      skillDefMap,
      cache,
      resolvingPath,
    );
    if (!summonResult.success) {
      resolvingPath.delete(monsterId);
      return { success: false, error: summonResult.error };
    }
    phaseTriggers.push({
      id: triggerId,
      hpPercent: hpPercentRaw,
      action: "summon",
      effects: [],
      summonMonsterId,
      summonCount,
      summonTemplate: {
        id: summonMonsterId,
        name: summonResult.entry.monster.name,
        realm: summonResult.entry.monster.realm,
        element: summonResult.entry.monster.element,
        baseAttrs: { ...summonResult.entry.attrs },
        skills: summonResult.entry.battleSkills.map((skill) =>
          cloneBattleSkill(skill),
        ),
        aiProfile: summonResult.entry.aiProfile,
      },
    });
  }

  const aiProfile: MonsterAIProfile = {
    skillIds,
    skillWeights,
    phaseTriggers,
  };
  const monster: MonsterData = {
    id: monsterId,
    name: toText(def.name) || monsterId,
    realm: toText(def.realm) || "凡人",
    element: toText(def.element) || "none",
    attr_variance: def.attr_variance,
    attr_multiplier_min: def.attr_multiplier_min,
    attr_multiplier_max: def.attr_multiplier_max,
    base_attrs: normalizeMonsterBaseAttrs(def.base_attrs),
    skills: [...skillIds],
    ai_profile: aiProfile,
    exp_reward: Math.max(0, Math.floor(Number(def.exp_reward ?? 0) || 0)),
    silver_reward_min: Math.max(
      0,
      Math.floor(Number(def.silver_reward_min ?? 0) || 0),
    ),
    silver_reward_max: Math.max(
      0,
      Math.floor(Number(def.silver_reward_max ?? 0) || 0),
    ),
    kind: toText(def.kind) || "normal",
    drop_pool_id: toText(def.drop_pool_id) || undefined,
  };
  const entry: MonsterRuntimeCacheEntry = {
    monster,
    skills,
    attrs: extractMonsterAttrsForSummon(def),
    battleSkills: skills.map((skill) => toBattleSkill(skill)),
    aiProfile,
  };
  cache.set(monsterId, entry);
  resolvingPath.delete(monsterId);
  return { success: true, entry };
}

function resolveOrderedMonsters(
  monsterIds: string[],
): OrderedMonstersResolveResult {
  const ids = monsterIds
    .map((id) => String(id || "").trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return { success: false, error: "请指定战斗目标" };
  }

  const monsterDefMap = new Map(
    getMonsterDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );
  const skillDefMap = new Map(
    getSkillDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );

  const cache = new Map<string, MonsterRuntimeCacheEntry>();
  const monsters: MonsterData[] = [];
  const monsterSkillsMap: Record<string, SkillData[]> = {};
  for (const id of ids) {
    const runtimeResult = resolveMonsterRuntime(
      id,
      monsterDefMap,
      skillDefMap,
      cache,
      new Set<string>(),
    );
    if (!runtimeResult.success) {
      return { success: false, error: runtimeResult.error };
    }
    monsters.push(runtimeResult.entry.monster);
    monsterSkillsMap[id] = runtimeResult.entry.skills.map((skill) => ({
      ...skill,
      effects: skill.effects.map((effect) => ({ ...effect })),
    }));
  }

  return { success: true, monsters, monsterSkillsMap };
}

type SkillUpgradeRule = {
  layer: number;
  changes: Record<string, unknown>;
};

function cloneEffects(raw: unknown[]): unknown[] {
  return raw.map((effect) => {
    if (!effect || typeof effect !== "object" || Array.isArray(effect))
      return effect;
    return { ...(effect as Record<string, unknown>) };
  });
}

function isDamageEffect(effect: unknown): effect is Record<string, unknown> {
  return Boolean(
    effect &&
    typeof effect === "object" &&
    !Array.isArray(effect) &&
    (effect as any).type === "damage",
  );
}

function findFirstDamageEffect(
  effects: unknown[],
): Record<string, unknown> | null {
  for (const effect of effects) {
    if (isDamageEffect(effect)) return { ...effect };
  }
  return null;
}

function hasDamageEffect(effects: unknown[]): boolean {
  return effects.some((effect) => isDamageEffect(effect));
}

function parseSkillUpgradeRules(raw: unknown): SkillUpgradeRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: SkillUpgradeRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = toRecord(raw[i]);
    const changes = toRecord(row.changes);
    if (Object.keys(changes).length === 0) continue;
    const layer = Math.max(1, Math.floor(toNumber(row.layer) ?? i + 1));
    rules.push({ layer, changes });
  }
  rules.sort((a, b) => a.layer - b.layer);
  return rules;
}

function applySkillUpgradeChanges(
  base: {
    cost_lingqi: number;
    cost_qixue: number;
    cooldown: number;
    target_count: number;
    effects: unknown[];
    ai_priority: number;
  },
  changes: Record<string, unknown>,
): void {
  const preservedDamageEffect = findFirstDamageEffect(base.effects);

  const targetCount = toNumber(changes.target_count);
  if (targetCount !== null) {
    base.target_count = Math.max(1, Math.floor(targetCount));
  }

  const cooldownDelta = toNumber(changes.cooldown);
  if (cooldownDelta !== null) {
    base.cooldown = Math.max(0, Math.floor(base.cooldown + cooldownDelta));
  }

  const costLingqiDelta = toNumber(changes.cost_lingqi);
  if (costLingqiDelta !== null) {
    base.cost_lingqi = Math.max(
      0,
      Math.floor(base.cost_lingqi + costLingqiDelta),
    );
  }

  const costQixueDelta = toNumber(changes.cost_qixue);
  if (costQixueDelta !== null) {
    base.cost_qixue = Math.max(0, Math.floor(base.cost_qixue + costQixueDelta));
  }

  const aiPriorityDelta = toNumber(changes.ai_priority);
  if (aiPriorityDelta !== null) {
    base.ai_priority = Math.max(
      0,
      Math.floor(base.ai_priority + aiPriorityDelta),
    );
  }

  if (Array.isArray(changes.effects)) {
    const nextEffects = cloneEffects(changes.effects);
    if (preservedDamageEffect && !hasDamageEffect(nextEffects)) {
      nextEffects.unshift({ ...preservedDamageEffect });
    }
    base.effects = nextEffects;
  }
  const addEffect = changes.addEffect;
  if (addEffect && typeof addEffect === "object" && !Array.isArray(addEffect)) {
    base.effects = [
      ...base.effects,
      { ...(addEffect as Record<string, unknown>) },
    ];
  }
}

async function getCharacterBattleSetBonusEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT item_def_id
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
    `,
    [characterId],
  );

  const itemDefIds = Array.from(
    new Set(
      (result.rows as Array<Record<string, unknown>>)
        .map((row) => toText(row.item_def_id))
        .filter((itemDefId): itemDefId is string => !!itemDefId),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const setCountMap = new Map<string, number>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const itemDefId = toText(row.item_def_id);
    if (!itemDefId) continue;
    const setId = toText(defs.get(itemDefId)?.set_id);
    if (!setId) continue;
    setCountMap.set(setId, (setCountMap.get(setId) ?? 0) + 1);
  }

  const staticSetMap = new Map(
    getItemSetDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );

  const out: BattleSetBonusEffect[] = [];
  for (const [setId, equippedCount] of setCountMap.entries()) {
    const setDef = staticSetMap.get(setId);
    if (!setDef) continue;
    const setName = toText(setDef.name) || setId;
    const bonuses = Array.isArray(setDef.bonuses) ? setDef.bonuses : [];
    const sortedBonuses = bonuses
      .map((bonus) => ({
        pieceCount: Math.max(1, Math.floor(Number(bonus.piece_count) || 1)),
        priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
        effectDefs: Array.isArray(bonus.effect_defs) ? bonus.effect_defs : [],
      }))
      .sort(
        (left, right) =>
          left.priority - right.priority || left.pieceCount - right.pieceCount,
      );

    for (const bonus of sortedBonuses) {
      if (equippedCount < bonus.pieceCount) continue;
      for (const raw of bonus.effectDefs) {
        const effectRow = toRecord(raw);
        const trigger = toText(effectRow.trigger);
        const effectType = toText(effectRow.effect_type);
        if (!BATTLE_SET_BONUS_TRIGGER_SET.has(trigger)) continue;
        if (!BATTLE_SET_BONUS_EFFECT_TYPE_SET.has(effectType)) continue;

        const targetRaw = toText(effectRow.target);
        const target = targetRaw === "enemy" ? "enemy" : "self";
        const params = toRecord(effectRow.params);
        const duration = toNumber(effectRow.duration_round);
        const element = toText(effectRow.element);

        out.push({
          setId,
          setName,
          pieceCount: bonus.pieceCount,
          trigger: trigger as BattleSetBonusEffect["trigger"],
          target,
          effectType: effectType as BattleSetBonusEffect["effectType"],
          durationRound:
            duration === null ? undefined : Math.max(1, Math.floor(duration)),
          element: element || undefined,
          params,
        });
      }
    }
  }

  return out;
}

async function getCharacterBattleAffixEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT id AS item_instance_id, item_def_id, affixes
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
      ORDER BY id ASC
    `,
    [characterId],
  );

  const itemDefIds = Array.from(
    new Set(
      (result.rows as Array<Record<string, unknown>>)
        .map((row) => toText(row.item_def_id))
        .filter((itemDefId): itemDefId is string => !!itemDefId),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const sources: BattleAffixEffectSource[] = [];
  for (const row of result.rows) {
    const record = row as Record<string, unknown>;
    const itemInstanceId = Math.floor(toNumber(record.item_instance_id) ?? 0);
    if (itemInstanceId <= 0) continue;
    const itemDefId = toText(record.item_def_id);
    if (!itemDefId) continue;
    const itemDef = defs.get(itemDefId);
    if (!itemDef || itemDef.category !== "equipment") continue;

    sources.push({
      itemInstanceId,
      itemName: toText(itemDef.name),
      affixesRaw: record.affixes,
    });
  }

  return extractBattleAffixEffectsFromEquippedItems(sources);
}

async function attachSetBonusEffectsToCharacterData<T extends CharacterData>(
  characterId: number,
  data: T,
): Promise<T> {
  try {
    const [setBonusEffects, affixEffects] = await Promise.all([
      getCharacterBattleSetBonusEffects(characterId),
      getCharacterBattleAffixEffects(characterId),
    ]);
    const mergedEffects = [...setBonusEffects, ...affixEffects];
    if (mergedEffects.length === 0) return data;
    return {
      ...data,
      setBonusEffects: mergedEffects,
    };
  } catch {
    return data;
  }
}

async function getCharacterBattleSkillData(
  characterId: number,
): Promise<SkillData[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const battleSkillsRes =
    await characterTechniqueService.getBattleSkills(characterId);
  if (!battleSkillsRes.success || !battleSkillsRes.data) return [];

  const orderedSkillSlots = battleSkillsRes.data
    .map((s) => ({
      skillId: String(s?.skillId ?? "").trim(),
      upgradeLevel: Math.max(0, Math.floor(toNumber(s?.upgradeLevel) ?? 0)),
    }))
    .filter((x) => x.skillId.length > 0);

  const orderedSkillIds = orderedSkillSlots.map((x) => x.skillId);

  if (orderedSkillIds.length === 0) return [];

  const uniqIds = uniqueStringIds(orderedSkillIds);
  const idSet = new Set(uniqIds);
  const byId = new Map<
    string,
    ReturnType<typeof getSkillDefinitions>[number]
  >();
  for (const row of getSkillDefinitions()) {
    if (row.enabled === false) continue;
    if (!idSet.has(row.id)) continue;
    byId.set(row.id, row);
  }

  const skills: SkillData[] = [];
  for (const slot of orderedSkillSlots) {
    const row = byId.get(slot.skillId);
    if (!row) continue;

    const skillData = {
      cost_lingqi: Math.max(0, Math.floor(Number(row.cost_lingqi ?? 0) || 0)),
      cost_qixue: Math.max(0, Math.floor(Number(row.cost_qixue ?? 0) || 0)),
      cooldown: Math.max(0, Math.floor(Number(row.cooldown ?? 0) || 0)),
      target_count: Math.max(1, Math.floor(Number(row.target_count ?? 1) || 1)),
      effects: cloneSkillEffectList(
        Array.isArray(row.effects) ? row.effects : (row.effects ?? []),
      ),
      ai_priority: Math.max(0, Math.floor(Number(row.ai_priority ?? 50) || 50)),
    };

    if (slot.upgradeLevel > 0) {
      const rules = parseSkillUpgradeRules(row.upgrades);
      const applyRules = rules.slice(0, slot.upgradeLevel);
      for (const rule of applyRules) {
        applySkillUpgradeChanges(skillData, rule.changes);
      }
    }

    skills.push({
      id: String(row.id),
      name: String(row.name || row.id),
      cost_lingqi: skillData.cost_lingqi,
      cost_qixue: skillData.cost_qixue,
      cooldown: skillData.cooldown,
      target_type: String(row.target_type || "single_enemy"),
      target_count: skillData.target_count,
      damage_type: String(row.damage_type || "none"),
      element: String(row.element || "none"),
      effects: skillData.effects,
      ai_priority: skillData.ai_priority,
    });
  }

  return skills;
}

async function getBattleMonsters(engine: BattleEngine): Promise<MonsterData[]> {
  const state = engine.getState();
  if (state.battleType !== "pve") return [];
  const orderedIds = state.teams.defender.units
    .filter((u) => u.type === "monster")
    .map((u) => String(u.sourceId))
    .filter(Boolean);
  if (orderedIds.length === 0) return [];
  const uniqIds = [...new Set(orderedIds)];
  const idSet = new Set(uniqIds);
  const defs = getMonsterDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => idSet.has(entry.id)) as MonsterData[];
  const defMap = new Map(defs.map((m) => [m.id, m] as const));
  const monsters: MonsterData[] = [];
  for (const id of orderedIds) {
    const def = defMap.get(id);
    if (def) monsters.push(def);
  }
  return monsters;
}

async function getUserIdByCharacterId(
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
  } catch {
    return null;
  }
}

function getAttackerPlayerCount(state: BattleState): number {
  return (state.teams?.attacker?.units ?? []).filter(
    (unit) => unit.type === "player",
  ).length;
}

function hasAnyOnlineUser(
  userIds: number[],
  gameServer: ReturnType<typeof getGameServer>,
): boolean {
  for (const userId of userIds) {
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (gameServer.isUserOnline(userId)) return true;
  }
  return false;
}

async function shouldServerTakeoverDisconnectedPlayerTurn(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
): Promise<boolean> {
  if (state.currentTeam !== "attacker") return false;
  if (currentUnit.type !== "player") return false;
  if (getAttackerPlayerCount(state) <= 1) return false;

  const gameServer = getGameServer();
  const participants = battleParticipants.get(battleId) || [];
  if (!hasAnyOnlineUser(participants, gameServer)) return false;

  const characterId = Math.floor(Number(currentUnit.sourceId));
  if (!Number.isFinite(characterId) || characterId <= 0) return true;

  const ownerUserId = await getUserIdByCharacterId(characterId);
  if (!ownerUserId) return true;
  return !gameServer.isUserOnline(ownerUserId);
}

function emitBattleUpdate(battleId: string, payload: any): void {
  try {
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) return;
    const gameServer = getGameServer();
    const patched = patchBattleUpdatePayload(battleId, payload);
    for (const userId of participants) {
      if (!Number.isFinite(userId)) continue;
      gameServer.emitToUser(userId, "battle:update", patched);
    }
    // 保存战斗状态到 Redis（异步，不阻塞）
    const engine = activeBattles.get(battleId);
    if (engine) {
      const kind = typeof payload?.kind === "string" ? payload.kind : "";
      const now = Date.now();
      const lastSavedAt = battleLastRedisSavedAt.get(battleId) ?? 0;
      const shouldSave =
        kind === "battle_started" ||
        kind === "battle_finished" ||
        kind === "battle_abandoned" ||
        now - lastSavedAt >= BATTLE_REDIS_SAVE_INTERVAL_MS;
      if (shouldSave) {
        battleLastRedisSavedAt.set(battleId, now);
        void saveBattleToRedis(battleId, engine, participants);
      }
    }
  } catch {
    // 忽略
  }
}

const hasPgErrorCode = (error: unknown, code: string): boolean => {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === code;
};

const rethrowIfTransactionAborted = (error: unknown): void => {
  if (hasPgErrorCode(error, "25P02")) {
    throw error;
  }
};

const handleOptionalBattleSideEffectError = (
  context: string,
  error: unknown,
): void => {
  rethrowIfTransactionAborted(error);
  console.warn(`[battle] ${context} 失败:`, error);
};

const isTransientBattleTickError = (error: unknown): boolean => {
  return hasPgErrorCode(error, "55P03") || hasPgErrorCode(error, "57014");
};

const resolveAutoSkipTargetIds = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): string[] => {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  const aliveAllies = allies.filter((u) => u.isAlive);
  const aliveEnemies = enemies.filter((u) => u.isAlive);

  if (skill.targetType === "self") {
    return [unit.id];
  }
  if (skill.targetType === "single_enemy") {
    return aliveEnemies[0] ? [aliveEnemies[0].id] : [];
  }
  if (skill.targetType === "single_ally") {
    return aliveAllies[0] ? [aliveAllies[0].id] : [];
  }
  return [];
};

const canCastSkillForAutoSkip = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): boolean => {
  if (skill.triggerType !== "active") return false;
  if (!canUseSkill(unit, skill.damageType)) return false;
  if ((unit.skillCooldowns[skill.id] || 0) > 0) return false;
  if (skill.cost.lingqi && unit.lingqi < skill.cost.lingqi) return false;
  if (skill.cost.qixue && unit.qixue <= skill.cost.qixue) return false;

  if (
    skill.targetType === "self" ||
    skill.targetType === "single_enemy" ||
    skill.targetType === "single_ally"
  ) {
    return resolveAutoSkipTargetIds(state, unit, skill).length > 0;
  }
  return true;
};

const canPlayerUseAnySkillThisTurn = (
  state: BattleState,
  currentUnit: BattleUnit,
): boolean => {
  const activeSkills = currentUnit.skills.filter(
    (skill) => skill.triggerType === "active",
  );
  const normalAttack = getNormalAttack(currentUnit);
  const candidateSkills = [...activeSkills, normalAttack];
  const seenSkillIds = new Set<string>();

  for (const skill of candidateSkills) {
    if (seenSkillIds.has(skill.id)) continue;
    seenSkillIds.add(skill.id);
    if (canCastSkillForAutoSkip(state, currentUnit, skill)) return true;
  }
  return false;
};

async function tickBattle(battleId: string): Promise<void> {
  if (battleTickLocks.has(battleId)) return;
  battleTickLocks.add(battleId);
  try {
    const engine = activeBattles.get(battleId);
    if (!engine) {
      stopBattleTicker(battleId);
      return;
    }

    const state = engine.getState();
    if (state.phase === "finished") {
      const monsters = await getBattleMonsters(engine);
      await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return;
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) return;

    if (currentUnit.type === "player") {
      if (state.currentTeam !== "attacker") {
        // 防守方玩家单位当前仍由服务端推进，避免 PVP 在 defender 回合卡死。
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (isStunned(currentUnit) || isFeared(currentUnit)) {
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (
        await shouldServerTakeoverDisconnectedPlayerTurn(
          battleId,
          state,
          currentUnit,
        )
      ) {
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (!canPlayerUseAnySkillThisTurn(state, currentUnit)) {
        // 手动模式下若无可用技能（控制/资源/冷却共同导致），由服务端自动推进，避免卡回合。
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      // 进攻方玩家单位回合统一由客户端驱动：服务端仅推送当前状态，等待客户端发起 playerAction。
      emitBattleUpdate(battleId, {
        kind: "battle_state",
        battleId,
        state: engine.getState(),
      });
      return;
    }

    engine.aiAction();
    emitBattleUpdate(battleId, {
      kind: "battle_state",
      battleId,
      state: engine.getState(),
    });
  } catch (error) {
    if (isTransientBattleTickError(error)) {
      console.warn(
        `[battle] tickBattle 发生可重试异常，等待下个 tick 重试: ${battleId}`,
        error,
      );
      return;
    }
    console.error(
      `[battle] tickBattle 发生未处理异常，已停止 ticker: ${battleId}`,
      error,
    );
    stopBattleTicker(battleId);
  } finally {
    battleTickLocks.delete(battleId);
  }
}

function startBattleTicker(battleId: string): void {
  if (battleTickers.has(battleId)) return;
  const timer = setInterval(() => {
    void tickBattle(battleId);
  }, BATTLE_TICK_MS);
  battleTickers.set(battleId, timer);
  void tickBattle(battleId);
}

function stopBattleTicker(battleId: string): void {
  const t = battleTickers.get(battleId);
  if (t) clearInterval(t);
  battleTickers.delete(battleId);
  battleTickLocks.delete(battleId);
  battleLastEmittedLogLen.delete(battleId);
  battleLastRedisSavedAt.delete(battleId);
}

/**
 * 获取角色所在队伍的所有成员数据
 */
async function getTeamMembersData(
  userId: number,
  characterId: number,
): Promise<{
  isInTeam: boolean;
  isLeader: boolean;
  teamId: string | null;
  members: Array<{ data: CharacterData; skills: SkillData[] }>;
}> {
  // 查询角色是否在队伍中
  const memberResult = await query(
    `SELECT tm.team_id, tm.role FROM team_members tm 
     JOIN characters c ON tm.character_id = c.id 
     WHERE c.user_id = $1`,
    [userId],
  );

  if (memberResult.rows.length === 0) {
    return { isInTeam: false, isLeader: false, teamId: null, members: [] };
  }

  const { team_id: teamId, role } = memberResult.rows[0];
  const isLeader = role === "leader";

  // 获取队伍中其他成员的数据（排除自己）
  const teamMembersResult = await query(
    `SELECT tm.character_id FROM team_members tm
     WHERE tm.team_id = $1 AND tm.character_id != $2
     ORDER BY tm.role DESC, tm.joined_at ASC`,
    [teamId, characterId],
  );

  const members = await Promise.all(
    teamMembersResult.rows.map(async (row) => {
      const memberCharacterId = Number((row as any)?.character_id);
      if (!Number.isFinite(memberCharacterId) || memberCharacterId <= 0) {
        return null;
      }
      const base = await getCharacterComputedByCharacterId(memberCharacterId);
      if (!base) return null;
      const data = await attachSetBonusEffectsToCharacterData(
        memberCharacterId,
        base as CharacterData,
      );
      const skills = await getCharacterBattleSkillData(memberCharacterId);
      return { data, skills };
    }),
  );

  return {
    isInTeam: true,
    isLeader,
    teamId,
    members: members.filter(
      (x): x is { data: CharacterData; skills: SkillData[] } => x !== null,
    ),
  };
}

/**
 * 发起PVE战斗（支持组队）
 */
export async function startPVEBattle(
  userId: number,
  monsterIds: string[],
): Promise<BattleResult> {
  try {
    const characterBase = await getCharacterComputedByUserId(userId);
    if (!characterBase) {
      return { success: false, message: "角色不存在" };
    }
    const characterId = Number(characterBase.id);

    // 挂机中禁止发起战斗
    const idleReject = await rejectIfIdling(characterId);
    if (idleReject) return idleReject;

    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(
      characterId,
      characterBase as CharacterData,
    );

    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) return selfInBattleResult;
    const selfCooldown = validateBattleStartCooldown(characterId);
    if (selfCooldown) {
      return {
        success: false,
        message: selfCooldown.message,
        data: {
          reason: "battle_start_cooldown",
          retryAfterMs: selfCooldown.retryAfterMs,
          battleStartCooldownMs: selfCooldown.cooldownMs,
          nextBattleAvailableAt: selfCooldown.nextBattleAvailableAt,
        },
      };
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterIds.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    const selectedMonsterId = requestedMonsterIds[0];
    if (!selectedMonsterId) {
      return { success: false, message: "请指定战斗目标" };
    }

    const mapId = characterBase.current_map_id || "";
    const roomId = characterBase.current_room_id || "";
    if (!mapId || !roomId) {
      return { success: false, message: "角色位置异常，无法战斗" };
    }

    const room = await getRoomInMap(mapId, roomId);
    if (!room) {
      return { success: false, message: "当前房间不存在，无法战斗" };
    }

    const roomMonsterIds = uniqueStringIds(
      (Array.isArray(room.monsters) ? room.monsters : [])
        .map((m) => m?.monster_def_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    );
    const roomMonsterIdSet = new Set(roomMonsterIds);

    for (const id of requestedMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const playerSkills = await getCharacterBattleSkillData(characterId);

    // 检查是否在队伍中，获取队友数据
    const teamInfo = await getTeamMembersData(userId, character.id);
    if (teamInfo.isInTeam && !teamInfo.isLeader) {
      return { success: false, message: "组队中只有队长可以发起战斗" };
    }

    // 如果在队伍中，检查队友状态
    const validTeamMembers: Array<{
      data: CharacterData;
      skills: SkillData[];
    }> = [];
    const participantUserIds: number[] = [userId];

    if (teamInfo.isInTeam && teamInfo.members.length > 0) {
      for (const member of teamInfo.members) {
        const memberCharacterId = Number((member.data as any)?.id);
        if (
          Number.isFinite(memberCharacterId) &&
          memberCharacterId > 0 &&
          isCharacterInBattle(memberCharacterId)
        ) {
          continue;
        }
        if (
          Number.isFinite(memberCharacterId) &&
          memberCharacterId > 0 &&
          getBattleStartCooldownRemainingMs(memberCharacterId) > 0
        ) {
          continue;
        }
        // 检查队友气血
        if (member.data.qixue > 0) {
          validTeamMembers.push({
            ...member,
            data: withBattleStartResources(member.data),
          });
          participantUserIds.push(member.data.user_id);
        }
      }
    }

    try {
      await restoreBattleStartResourcesInDb(participantUserIds);
      const gameServer = getGameServer();
      for (const uid of participantUserIds) {
        if (!Number.isFinite(uid) || uid <= 0) continue;
        void gameServer.pushCharacterUpdate(uid);
      }
    } catch (error) {
      handleOptionalBattleSideEffectError("同步战前资源（普通战斗）", error);
    }

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = playerCount > 1 ? Math.min(playerCount, 5) : 2;

    let finalMonsterIds: string[] = [];
    if (playerCount <= 1) {
      const desired = randomIntInclusive(1, 2);
      finalMonsterIds = Array.from(
        { length: desired },
        () => selectedMonsterId,
      );
    } else {
      finalMonsterIds = Array.from(
        { length: maxMonsters },
        () => selectedMonsterId,
      );
    }

    for (const id of finalMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      return { success: false, message: monsterResolveResult.error };
    }
    const monsters = monsterResolveResult.monsters;
    const monsterSkillsMap = monsterResolveResult.monsterSkillsMap;

    // 生成战斗ID
    const battleId = `battle-${userId}-${Date.now()}`;

    // 创建战斗状态（传入队友数据）
    const battleState = createPVEBattle(
      battleId,
      character,
      playerSkills,
      monsters,
      monsterSkillsMap,
      validTeamMembers.length > 0 ? validTeamMembers : undefined,
    );

    // 创建战斗引擎
    const engine = new BattleEngine(battleState);

    // 开始战斗
    engine.startBattle();

    // 缓存战斗
    activeBattles.set(battleId, engine);
    // 记录战斗参与者
    battleParticipants.set(battleId, participantUserIds);
    // 先 emit battle_started 再启动 ticker，确保 battle_started 始终先于
    // tickBattle 产生的 battle_state 到达客户端，避免日志重复推送。
    emitBattleUpdate(battleId, {
      kind: "battle_started",
      battleId,
      state: engine.getState(),
    });
    startBattleTicker(battleId);

    return {
      success: true,
      message:
        playerCount > 1 ? `组队战斗开始（${playerCount}人）` : "战斗开始",
      data: {
        battleId,
        state: engine.getState(),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起战斗失败:", error);
    return { success: false, message: "发起战斗失败" };
  }
}

/**
 * 玩家行动
 */
export async function playerAction(
  userId: number,
  battleId: string,
  skillId: string,
  targetIds: string[],
): Promise<BattleResult> {
  try {
    const engine = activeBattles.get(battleId);

    if (!engine) {
      return { success: false, message: "战斗不存在或已结束" };
    }

    const state = engine.getState();

    // 验证是否是该战斗的参与者
    const participants = battleParticipants.get(battleId) || [];
    if (
      !participants.includes(userId) &&
      state.teams.attacker.odwnerId !== userId
    ) {
      return { success: false, message: "无权操作此战斗" };
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      return { success: false, message: "没有当前行动单位" };
    }
    if (currentUnit.type !== "player" || state.currentTeam !== "attacker") {
      return { success: false, message: "当前不是玩家行动回合" };
    }
    const characterId = Number(currentUnit.sourceId);
    const ownerUserId = await getUserIdByCharacterId(characterId);
    if (!ownerUserId) {
      return { success: false, message: "角色归属异常，无法行动" };
    }
    const allowedUserIds =
      participants.length > 0
        ? participants
        : Number.isFinite(state.teams.attacker.odwnerId)
          ? [state.teams.attacker.odwnerId as number]
          : [];
    if (!allowedUserIds.includes(ownerUserId)) {
      return { success: false, message: "无权操作此战斗" };
    }

    // 执行玩家行动
    const result = engine.playerAction(userId, skillId, targetIds);

    if (!result.success) {
      return { success: false, message: result.error || "行动失败" };
    }
    emitBattleUpdate(battleId, {
      kind: "battle_state",
      battleId,
      state: engine.getState(),
    });

    // 检查战斗是否结束
    const currentState = engine.getState();
    if (currentState.phase === "finished") {
      const monsters = await getBattleMonsters(engine);
      const battleResult = await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return battleResult;
    }

    return {
      success: true,
      message: "行动成功",
      data: {
        state: currentState,
      },
    };
  } catch (error) {
    console.error("玩家行动失败:", error);
    return { success: false, message: "行动失败" };
  }
}

type StartDungeonPVEBattleOptions = {
  resourceSyncClient?: QueryExecutor;
  /** 跳过战斗冷却检查（秘境推进时使用，因为秘境战斗由系统驱动，不应受手动发起的冷却限制） */
  skipCooldown?: boolean;
};

export async function startDungeonPVEBattle(
  userId: number,
  monsterDefIds: string[],
  options?: StartDungeonPVEBattleOptions,
): Promise<BattleResult> {
  try {
    const baseCharacter = await getCharacterComputedByUserId(userId);
    if (!baseCharacter) {
      return { success: false, message: "角色不存在" };
    }

    const characterId = Number(baseCharacter.id);

    // 挂机中禁止发起战斗
    const idleReject = await rejectIfIdling(characterId);
    if (idleReject) return idleReject;

    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(
      characterId,
      baseCharacter as CharacterData,
    );
    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) return selfInBattleResult;
    // 秘境推进时跳过冷却检查：秘境战斗由系统驱动，不应受手动发起战斗的冷却限制。
    // 若不跳过，auto-next 3秒定时器与服务端 3秒冷却卡在边界，可能导致
    // nextDungeonInstance 中 stage/wave 已推进但战斗创建失败，造成波次跳过。
    if (!options?.skipCooldown) {
      const selfCooldown = validateBattleStartCooldown(characterId);
      if (selfCooldown) {
        return {
          success: false,
          message: selfCooldown.message,
          data: {
            reason: "battle_start_cooldown",
            retryAfterMs: selfCooldown.retryAfterMs,
            battleStartCooldownMs: selfCooldown.cooldownMs,
            nextBattleAvailableAt: selfCooldown.nextBattleAvailableAt,
          },
        };
      }
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterDefIds.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    if (requestedMonsterIds.length === 0) {
      return { success: false, message: "请指定战斗目标" };
    }

    const playerSkills = await getCharacterBattleSkillData(characterId);

    const teamInfo = await getTeamMembersData(userId, character.id);
    if (teamInfo.isInTeam && !teamInfo.isLeader) {
      return { success: false, message: "组队中只有队长可以发起战斗" };
    }

    const validTeamMembers: Array<{
      data: CharacterData;
      skills: SkillData[];
    }> = [];
    const participantUserIds: number[] = [userId];
    if (teamInfo.isInTeam && teamInfo.members.length > 0) {
      for (const member of teamInfo.members) {
        const memberCharacterId = Number((member.data as any)?.id);
        if (
          Number.isFinite(memberCharacterId) &&
          memberCharacterId > 0 &&
          isCharacterInBattle(memberCharacterId)
        ) {
          continue;
        }
        // 秘境战斗跳过冷却检查：秘境是连续波次战斗，队友不应因冷却被过滤
        if (!options?.skipCooldown) {
          if (
            Number.isFinite(memberCharacterId) &&
            memberCharacterId > 0 &&
            getBattleStartCooldownRemainingMs(memberCharacterId) > 0
          ) {
            continue;
          }
        }
        if (member.data.qixue > 0) {
          validTeamMembers.push({
            ...member,
            data: withBattleStartResources(member.data),
          });
          participantUserIds.push(member.data.user_id);
        }
      }
    }

    try {
      await restoreBattleStartResourcesInDb(
        participantUserIds,
        options?.resourceSyncClient,
      );
      const gameServer = getGameServer();
      for (const uid of participantUserIds) {
        if (!Number.isFinite(uid) || uid <= 0) continue;
        void gameServer.pushCharacterUpdate(uid);
      }
    } catch (error) {
      handleOptionalBattleSideEffectError("同步战前资源（秘境战斗）", error);
    }

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = Math.min(
      5,
      Math.max(1, playerCount > 1 ? playerCount : 3),
    );
    const finalMonsterIds = requestedMonsterIds.slice(0, maxMonsters);

    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      return { success: false, message: monsterResolveResult.error };
    }
    const monsters = monsterResolveResult.monsters;
    const monsterSkillsMap = monsterResolveResult.monsterSkillsMap;

    const battleId = `dungeon-battle-${userId}-${Date.now()}`;
    const battleState = createPVEBattle(
      battleId,
      character,
      playerSkills,
      monsters,
      monsterSkillsMap,
      validTeamMembers.length > 0 ? validTeamMembers : undefined,
    );

    const engine = new BattleEngine(battleState);
    engine.startBattle();
    activeBattles.set(battleId, engine);
    battleParticipants.set(battleId, participantUserIds);

    // 先 emit battle_started 再启动 ticker，避免日志重复推送
    emitBattleUpdate(battleId, {
      kind: "battle_started",
      battleId,
      state: engine.getState(),
    });
    startBattleTicker(battleId);

    return {
      success: true,
      message: "战斗开始",
      data: {
        battleId,
        state: engine.getState(),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起秘境战斗失败:", error);
    return { success: false, message: "发起秘境战斗失败" };
  }
}

export async function startPVPBattle(
  userId: number,
  opponentCharacterId: number,
  battleId?: string,
): Promise<BattleResult> {
  try {
    const challengerBase = await getCharacterComputedByUserId(userId);
    if (!challengerBase) {
      return { success: false, message: "角色不存在" };
    }

    const challengerCharacterId = Number(challengerBase.id);
    if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) {
      return { success: false, message: "角色数据异常" };
    }

    // 挂机中禁止发起战斗
    const idleReject = await rejectIfIdling(challengerCharacterId);
    if (idleReject) return idleReject;

    const oppId = Number(opponentCharacterId);
    if (!Number.isFinite(oppId) || oppId <= 0) {
      return { success: false, message: "对手参数错误" };
    }

    const opponentBase = await getCharacterComputedByCharacterId(oppId);
    if (!opponentBase) {
      return { success: false, message: "对手不存在" };
    }

    const opponentUserId = Number(opponentBase.user_id);
    if (!Number.isFinite(opponentUserId) || opponentUserId <= 0) {
      return { success: false, message: "对手数据异常" };
    }

    const requestedBattleId =
      typeof battleId === "string" ? battleId.trim() : "";
    const isArenaBattle = requestedBattleId.startsWith("arena-battle-");

    const challengerInBattleResult = buildCharacterInBattleResult(
      challengerCharacterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (challengerInBattleResult) return challengerInBattleResult;
    if (!isArenaBattle) {
      const opponentInBattleResult = buildCharacterInBattleResult(
        oppId,
        "opponent_in_battle",
        "对手正在战斗中",
      );
      if (opponentInBattleResult) return opponentInBattleResult;
    }
    const challengerCooldown = validateBattleStartCooldown(
      challengerCharacterId,
    );
    if (challengerCooldown) {
      return {
        success: false,
        message: challengerCooldown.message,
        data: {
          reason: "battle_start_cooldown",
          retryAfterMs: challengerCooldown.retryAfterMs,
          battleStartCooldownMs: challengerCooldown.cooldownMs,
          nextBattleAvailableAt: challengerCooldown.nextBattleAvailableAt,
        },
      };
    }
    if (!isArenaBattle) {
      const opponentCooldown = validateBattleStartCooldown(oppId);
      if (opponentCooldown) {
        return {
          success: false,
          message: "对手刚结束战斗，暂时无法发起挑战",
          data: {
            reason: "opponent_battle_start_cooldown",
            retryAfterMs: opponentCooldown.retryAfterMs,
            battleStartCooldownMs: opponentCooldown.cooldownMs,
            nextBattleAvailableAt: opponentCooldown.nextBattleAvailableAt,
          },
        };
      }
    }

    const challenger = await attachSetBonusEffectsToCharacterData(
      challengerCharacterId,
      challengerBase as CharacterData,
    );
    const opponent = await attachSetBonusEffectsToCharacterData(
      oppId,
      opponentBase as CharacterData,
    );
    const recoveredChallenger = withBattleStartResources(challenger);
    const recoveredOpponent = withBattleStartResources(opponent);

    const challengerSkills = await getCharacterBattleSkillData(
      challengerCharacterId,
    );
    const opponentSkills = await getCharacterBattleSkillData(oppId);

    try {
      await restoreBattleStartResourcesInDb(
        isArenaBattle ? [userId] : [userId, opponentUserId],
      );
      const gameServer = getGameServer();
      if (Number.isFinite(userId) && userId > 0)
        void gameServer.pushCharacterUpdate(userId);
      if (
        !isArenaBattle &&
        Number.isFinite(opponentUserId) &&
        opponentUserId > 0
      )
        void gameServer.pushCharacterUpdate(opponentUserId);
    } catch (error) {
      handleOptionalBattleSideEffectError("同步战前资源（PVP战斗）", error);
    }

    const finalBattleId = requestedBattleId
      ? requestedBattleId
      : `pvp-battle-${userId}-${Date.now()}`;
    const battleState = createPVPBattle(
      finalBattleId,
      recoveredChallenger,
      challengerSkills,
      recoveredOpponent,
      opponentSkills,
      isArenaBattle ? { defenderUnitType: "npc" } : undefined,
    );

    const engine = new BattleEngine(battleState);
    engine.startBattle();
    activeBattles.set(finalBattleId, engine);
    battleParticipants.set(
      finalBattleId,
      isArenaBattle ? [userId] : [userId, opponentUserId],
    );

    // 先 emit battle_started 再启动 ticker，避免日志重复推送
    emitBattleUpdate(finalBattleId, {
      kind: "battle_started",
      battleId: finalBattleId,
      state: engine.getState(),
    });
    startBattleTicker(finalBattleId);

    return {
      success: true,
      message: "战斗开始",
      data: {
        battleId: finalBattleId,
        state: engine.getState(),
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起PVP战斗失败:", error);
    return { success: false, message: "发起PVP战斗失败" };
  }
}

/**
 * 结束战斗并结算奖励（支持组队分配）
 */
async function settleArenaBattleIfNeeded(
  battleId: string,
  battleResult: "attacker_win" | "defender_win" | "draw",
): Promise<void> {
  const res = await query(
    `SELECT challenger_character_id, opponent_character_id, status FROM arena_battle WHERE battle_id = $1 LIMIT 1`,
    [battleId],
  );
  if (res.rows.length === 0) return;

  const row = res.rows[0] as {
    challenger_character_id?: unknown;
    opponent_character_id?: unknown;
    status?: unknown;
  };
  if (String(row.status ?? "") === "finished") return;

  const challengerCharacterId = Number(row.challenger_character_id);
  const opponentCharacterId = Number(row.opponent_character_id);
  if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0)
    return;
  if (!Number.isFinite(opponentCharacterId) || opponentCharacterId <= 0) return;

  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING`,
    [challengerCharacterId, DEFAULT_ARENA_RATING],
  );
  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING`,
    [opponentCharacterId, DEFAULT_ARENA_RATING],
  );

  const challengerRatingRes = await query(
    `SELECT rating FROM arena_rating WHERE character_id = $1`,
    [challengerCharacterId],
  );
  const opponentRatingRes = await query(
    `SELECT rating FROM arena_rating WHERE character_id = $1`,
    [opponentCharacterId],
  );
  const challengerBefore =
    Number(challengerRatingRes.rows?.[0]?.rating ?? DEFAULT_ARENA_RATING) ||
    DEFAULT_ARENA_RATING;
  const opponentBefore =
    Number(opponentRatingRes.rows?.[0]?.rating ?? DEFAULT_ARENA_RATING) ||
    DEFAULT_ARENA_RATING;

  const challengerOutcome: ArenaBattleOutcome =
    battleResult === "attacker_win"
      ? "win"
      : battleResult === "defender_win"
        ? "lose"
        : "draw";
  const challengerDelta = calculateArenaRatingDelta({
    selfRating: challengerBefore,
    opponentRating: opponentBefore,
    outcome: challengerOutcome,
  });
  const challengerAfter = Math.max(0, challengerBefore + challengerDelta);

  const opponentOutcome: ArenaBattleOutcome =
    challengerOutcome === "win"
      ? "lose"
      : challengerOutcome === "lose"
        ? "win"
        : "draw";
  const opponentDelta = calculateArenaRatingDelta({
    selfRating: opponentBefore,
    opponentRating: challengerBefore,
    outcome: opponentOutcome,
  });
  const opponentAfter = Math.max(0, opponentBefore + opponentDelta);

  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [
      challengerCharacterId,
      challengerAfter,
      challengerOutcome === "win" ? 1 : 0,
      challengerOutcome === "lose" ? 1 : 0,
    ],
  );
  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [
      opponentCharacterId,
      opponentAfter,
      opponentOutcome === "win" ? 1 : 0,
      opponentOutcome === "lose" ? 1 : 0,
    ],
  );

  await query(
    `
      UPDATE arena_battle
      SET
        status = 'finished',
        result = $2,
        delta_score = $3,
        score_before = $4,
        score_after = $5,
        finished_at = NOW()
      WHERE battle_id = $1
        AND status <> 'finished'
    `,
    [
      battleId,
      challengerOutcome,
      challengerDelta,
      challengerBefore,
      challengerAfter,
    ],
  );
}

async function finishBattleCore(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const state = engine.getState();
  const result = engine.getResult();

  // 获取战斗参与者
  const participantUserIds = (battleParticipants.get(battleId) || []).slice();
  const participantCount = Math.max(1, participantUserIds.length);
  const isVictory = result.result === "attacker_win";
  const isDungeonBattle = battleId.startsWith("dungeon-battle-");

  // 构建参与者信息
  const participants: BattleParticipant[] = [];
  for (const participantUserId of participantUserIds) {
    const computed = await getCharacterComputedByUserId(participantUserId);
    if (!computed) continue;
    participants.push({
      userId: participantUserId,
      characterId: computed.id,
      nickname: computed.nickname,
      realm: normalizeRealmKeepingUnknown(computed.realm, computed.sub_realm),
      fuyuan: Number(computed.fuyuan ?? 1),
    });
  }

  // 使用掉落服务分发奖励
  let dropResult: DistributeResult | null = null;

  if (state.battleType === "pve") {
    if (isVictory) {
      dropResult = await battleDropService.distributeBattleRewards(
        monsters,
        participants,
        true,
        { isDungeonBattle },
      );

      for (const participantUserId of participantUserIds) {
        const computed = await getCharacterComputedByUserId(participantUserId);
        if (!computed) continue;
        const healAmount = Math.floor(computed.max_qixue * 0.3);
        await setCharacterResourcesByCharacterId(computed.id, {
          qixue: Math.min(computed.max_qixue, computed.qixue + healAmount),
          lingqi: computed.lingqi,
        });
      }

      try {
        const killCounts = new Map<string, number>();
        for (const m of monsters) {
          const id = String((m as any)?.id ?? "").trim();
          if (!id) continue;
          killCounts.set(id, (killCounts.get(id) ?? 0) + 1);
        }
        if (killCounts.size > 0) {
          for (const p of participants) {
            const characterId = Number(p.characterId);
            if (!Number.isFinite(characterId) || characterId <= 0) continue;
            for (const [monsterId, count] of killCounts.entries()) {
              await recordKillMonsterEvent(characterId, monsterId, count);
            }
          }
        }
      } catch (error) {
        handleOptionalBattleSideEffectError("记录击杀怪物事件", error);
      }
    } else if (result.result === "defender_win") {
      for (const participantUserId of participantUserIds) {
        const computed = await getCharacterComputedByUserId(participantUserId);
        if (!computed) continue;
        const loss = Math.floor(computed.max_qixue * 0.1);
        await applyCharacterResourceDeltaByCharacterId(
          computed.id,
          { qixue: -loss },
          { minQixue: 1 },
        );
      }
    }
  }

  // 构建奖励数据
  const rewardsData = dropResult
    ? {
        exp: dropResult.rewards.exp,
        silver: dropResult.rewards.silver,
        totalExp: dropResult.rewards.exp,
        totalSilver: dropResult.rewards.silver,
        participantCount,
        items: dropResult.rewards.items.map((item) => ({
          itemDefId: item.itemDefId,
          name: item.itemName,
          quantity: item.quantity,
          receiverId: item.receiverId,
        })),
        perPlayerRewards: dropResult.perPlayerRewards,
      }
    : null;

  const participantCharacterIds = participants
    .map((entry) => Math.floor(Number(entry.characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0);
  const cooldownCharacterIds =
    participantCharacterIds.length > 0
      ? participantCharacterIds
      : collectPlayerCharacterIdsFromBattleState(state);
  // 先写服务端冷却，再推送结束事件，避免“结束事件先到达 -> 客户端立即开战”竞态。
  const cooldownUntilMs =
    setBattleStartCooldownByCharacterIds(cooldownCharacterIds);

  const battleResult: BattleResult = {
    success: true,
    message:
      result.result === "attacker_win"
        ? "战斗胜利"
        : result.result === "defender_win"
          ? "战斗失败"
          : "战斗平局",
    data: {
      result: result.result,
      rounds: result.rounds,
      rewards: rewardsData,
      stats: result.stats,
      logs: result.logs,
      state,
      isTeamBattle: participantCount > 1,
      battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      nextBattleAvailableAt: cooldownUntilMs,
    },
  };

  try {
    if (state.battleType === "pvp") {
      await settleArenaBattleIfNeeded(
        battleId,
        result.result as "attacker_win" | "defender_win" | "draw",
      );
    }
  } catch (error) {
    console.warn("竞技场战斗结算失败:", error);
  }

  try {
    const gameServer = getGameServer();
    for (const participantUserId of participantUserIds) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(participantUserId, "battle:update", {
        kind: "battle_finished",
        battleId,
        ...battleResult,
      });
      void gameServer.pushCharacterUpdate(participantUserId);
    }
    if (state.battleType === "pvp") {
      for (const p of participants) {
        const characterId = Number(p.characterId);
        if (!Number.isFinite(characterId) || characterId <= 0) continue;
        const statusRes = await getArenaStatus(characterId);
        if (!statusRes.success || !statusRes.data) continue;
        gameServer.emitToUser(p.userId, "arena:update", {
          kind: "arena_status",
          status: statusRes.data,
        });
      }
    }
  } catch {
    // 忽略
  }

  activeBattles.delete(state.battleId);
  battleParticipants.delete(state.battleId);
  stopBattleTicker(state.battleId);
  finishedBattleResults.set(state.battleId, {
    result: battleResult,
    at: Date.now(),
  });
  // 从 Redis 删除战斗状态
  void removeBattleFromRedis(state.battleId);

  return battleResult;
}

async function finishBattle(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const cachedResult = getFinishedBattleResultIfFresh(battleId);
  if (cachedResult) {
    return cachedResult;
  }

  const inflightResult = finishingBattleResults.get(battleId);
  if (inflightResult) {
    return inflightResult;
  }

  const settlePromise = finishBattleCore(battleId, engine, monsters);
  finishingBattleResults.set(battleId, settlePromise);
  try {
    return await settlePromise;
  } finally {
    finishingBattleResults.delete(battleId);
  }
}

/**
 * 获取战斗状态
 */
export async function getBattleState(battleId: string): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);

  if (!engine) {
    const cachedResult = getFinishedBattleResultIfFresh(battleId);
    if (cachedResult) return cachedResult;
    return { success: false, message: "战斗不存在" };
  }

  const state = engine.getState();
  if (state.phase === "finished") {
    const monsters = await getBattleMonsters(engine);
    return await finishBattle(battleId, engine, monsters);
  }

  return {
    success: true,
    message: "获取成功",
    data: {
      state,
    },
  };
}

/**
 * 放弃战斗
 */
export async function abandonBattle(
  userId: number,
  battleId: string,
): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);

  if (!engine) {
    return { success: false, message: "战斗不存在" };
  }

  const state = engine.getState();
  const participants = (battleParticipants.get(battleId) || []).slice();
  const participantCharacterIds: number[] = [];

  if (participants.length > 1 && state.teams.attacker.odwnerId !== userId) {
    return { success: false, message: "组队战斗只有队长可以逃跑" };
  }
  if (
    participants.length <= 1 &&
    !participants.includes(userId) &&
    state.teams.attacker.odwnerId !== userId
  ) {
    return { success: false, message: "无权操作此战斗" };
  }

  // 扣除所有参与者气血作为惩罚
  for (const participantUserId of participants) {
    const computed = await getCharacterComputedByUserId(participantUserId);
    if (!computed) continue;
    participantCharacterIds.push(Math.floor(Number(computed.id)));
    const loss = Math.floor(computed.max_qixue * 0.1);
    await applyCharacterResourceDeltaByCharacterId(
      computed.id,
      { qixue: -loss },
      { minQixue: 1 },
    );
  }

  const cooldownCharacterIds = participantCharacterIds.filter(
    (characterId) => Number.isFinite(characterId) && characterId > 0,
  );
  const cooldownUntilMs = setBattleStartCooldownByCharacterIds(
    cooldownCharacterIds.length > 0
      ? cooldownCharacterIds
      : collectPlayerCharacterIdsFromBattleState(state),
  );

  // 取消冷却推送（逃跑不应触发自动战斗）
  for (const characterId of cooldownCharacterIds) {
    cancelBattleCooldown(characterId);
  }

  try {
    if (state.battleType === "pvp") {
      await settleArenaBattleIfNeeded(battleId, "defender_win");
    }
  } catch (error) {
    console.warn("放弃战斗时竞技场结算失败:", error);
  }

  try {
    const gameServer = getGameServer();
    for (const participantUserId of participants) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(participantUserId, "battle:update", {
        kind: "battle_abandoned",
        battleId,
        success: true,
        message: "已放弃战斗",
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
        nextBattleAvailableAt: cooldownUntilMs,
      });
      void gameServer.pushCharacterUpdate(participantUserId);
      if (state.battleType === "pvp") {
        const computed = await getCharacterComputedByUserId(participantUserId);
        const characterId = Number(computed?.id);
        if (Number.isFinite(characterId) && characterId > 0) {
          const statusRes = await getArenaStatus(characterId);
          if (statusRes.success && statusRes.data) {
            gameServer.emitToUser(participantUserId, "arena:update", {
              kind: "arena_status",
              status: statusRes.data,
            });
          }
        }
      }
    }
  } catch {
    // 忽略
  }

  activeBattles.delete(battleId);
  battleParticipants.delete(battleId);
  stopBattleTicker(battleId);
  finishedBattleResults.set(battleId, {
    result: { success: true, message: "已放弃战斗" },
    at: Date.now(),
  });
  // 从 Redis 删除战斗状态
  void removeBattleFromRedis(battleId);
  return {
    success: true,
    message: "已放弃战斗",
    data: {
      battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      nextBattleAvailableAt: cooldownUntilMs,
    },
  };
}

/**
 * 清理过期战斗
 */
export function cleanupExpiredBattles(): void {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30分钟

  for (const battleId of activeBattles.keys()) {
    const parts = String(battleId || "").split("-");
    let battleTime = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = Number(parts[i]);
      if (!Number.isFinite(n)) continue;
      if (n <= 0) continue;
      battleTime = Math.floor(n);
      break;
    }

    if (!Number.isFinite(battleTime) || battleTime <= 0) continue;
    if (now - battleTime > maxAge) {
      activeBattles.delete(battleId);
      battleParticipants.delete(battleId);
      stopBattleTicker(battleId);
      // 从 Redis 删除过期战斗
      void removeBattleFromRedis(battleId);
    }
  }

  for (const [battleId, cached] of finishedBattleResults.entries()) {
    if (now - cached.at > FINISHED_BATTLE_TTL_MS) {
      finishedBattleResults.delete(battleId);
    }
  }
}

// 定期清理过期战斗
const cleanupTimer = setInterval(cleanupExpiredBattles, 5 * 60 * 1000);

/**
 * 停止战斗服务（优雅关闭）
 */
export function stopBattleService(): void {
  // 停止清理定时器
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  // 停止所有战斗的 ticker
  for (const timer of battleTickers.values()) {
    clearInterval(timer);
  }
  battleTickers.clear();
}

/**
 * 检查角色是否在战斗中
 */
export function isCharacterInBattle(characterId: number): boolean {
  return findActiveBattleByCharacterId(characterId) !== null;
}

function listActiveBattleIdsByUserId(userId: number): string[] {
  const ids: string[] = [];
  if (!Number.isFinite(userId) || userId <= 0) return ids;
  for (const [battleId, participants] of battleParticipants.entries()) {
    if (!Array.isArray(participants)) continue;
    if (participants.includes(userId)) ids.push(battleId);
  }
  return ids;
}

export async function onUserJoinTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount > 1) continue;
    try {
      await abandonBattle(userId, battleId);
    } catch {
      // 忽略
    }
  }
}

/**
 * 玩家重连时同步战斗状态
 *
 * 场景：
 * - 服务器重启后从 Redis 恢复战斗
 * - 玩家重连时需要知道自己是否还在战斗中
 *
 * 数据流：
 * - 查找玩家的活跃战斗 -> 推送 battle_started 事件 -> 前端恢复战斗界面
 */
export async function syncBattleStateOnReconnect(
  userId: number,
): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;

  const gameServer = getGameServer();
  if (!gameServer) return;

  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;

    const state = engine.getState();

    // 跳过已结束的战斗
    if (state.phase === "finished") continue;

    // 推送战斗状态，让前端恢复战斗界面
    gameServer.emitToUser(userId, "battle:update", {
      kind: "battle_started",
      battleId,
      state,
    });
  }
}

export async function onUserLeaveTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount <= 1) continue;
    const participants = battleParticipants.get(battleId) || [];
    const nextParticipants = participants.filter((id) => id !== userId);
    battleParticipants.set(battleId, nextParticipants);
    try {
      const gameServer = getGameServer();
      gameServer.emitToUser(userId, "battle:update", {
        kind: "battle_abandoned",
        battleId,
        success: true,
        message: "已离开队伍，退出队伍战斗",
      });
    } catch {
      // 忽略
    }
  }
}

// ============================================
// 离线挂机系统：角色战斗快照构建
// ============================================

/**
 * 构建角色战斗快照（供 IdleSessionService 调用）
 *
 * 作用：
 *   将角色当前属性、技能列表、套装效果打包为 SessionSnapshot 所需的字段。
 *   复用 getCharacterBattleSkillData（内部函数）和 attachSetBonusEffectsToCharacterData，
 *   不重复实现属性加载逻辑。
 *
 * 输入/输出：
 *   - characterId: number — 角色 ID
 *   返回：{ baseAttrs, skills, setBonusEffects, realm } 或 null（角色不存在）
 *
 * 关键边界条件：
 *   1. 快照在 startIdleSession 时一次性生成，后续战斗均使用此快照，不随角色实时属性变化
 *   2. setBonusEffects 包含套装效果和词缀效果（与在线战斗保持一致）
 */
export async function buildCharacterBattleSnapshot(
  characterId: number,
): Promise<{
  baseAttrs: BattleAttrs;
  skills: BattleSkill[];
  setBonusEffects: BattleSetBonusEffect[];
  realm: string;
  nickname: string;
} | null> {
  const base = await getCharacterComputedByCharacterId(characterId);
  if (!base) return null;

  const characterData = await attachSetBonusEffectsToCharacterData(
    characterId,
    base as CharacterData,
  );
  const skillDataList = await getCharacterBattleSkillData(characterId);

  const baseAttrs: BattleAttrs = {
    max_qixue: characterData.max_qixue,
    max_lingqi: characterData.max_lingqi,
    wugong: characterData.wugong,
    fagong: characterData.fagong,
    wufang: characterData.wufang,
    fafang: characterData.fafang,
    sudu: characterData.sudu,
    mingzhong: characterData.mingzhong,
    shanbi: characterData.shanbi,
    zhaojia: characterData.zhaojia,
    baoji: characterData.baoji,
    baoshang: characterData.baoshang,
    kangbao: characterData.kangbao,
    zengshang: characterData.zengshang,
    zhiliao: characterData.zhiliao,
    jianliao: characterData.jianliao,
    xixue: characterData.xixue,
    lengque: characterData.lengque,
    kongzhi_kangxing: characterData.kongzhi_kangxing,
    jin_kangxing: characterData.jin_kangxing,
    mu_kangxing: characterData.mu_kangxing,
    shui_kangxing: characterData.shui_kangxing,
    huo_kangxing: characterData.huo_kangxing,
    tu_kangxing: characterData.tu_kangxing,
    qixue_huifu: characterData.qixue_huifu,
    lingqi_huifu: characterData.lingqi_huifu,
    realm: normalizeRealmKeepingUnknown(characterData.realm, null),
    element: characterData.attribute_element,
  };

  // 复用 convertSkillData 的转换逻辑（内联，因为 convertSkillData 未导出）
  const skills: BattleSkill[] = skillDataList.map((data) => ({
    id: data.id,
    name: data.name,
    source: "innate" as const,
    cost: {
      lingqi: data.cost_lingqi || 0,
      qixue: data.cost_qixue || 0,
    },
    cooldown: data.cooldown || 0,
    targetType: (data.target_type ||
      "single_enemy") as BattleSkill["targetType"],
    targetCount: data.target_count || 1,
    damageType: data.damage_type as BattleSkill["damageType"],
    element: data.element || "none",
    effects: data.effects || [],
    triggerType: "active" as const,
    aiPriority: data.ai_priority || 50,
  }));

  return {
    baseAttrs,
    skills,
    setBonusEffects: characterData.setBonusEffects ?? [],
    realm: String(characterData.realm || "凡人"),
    nickname: String(characterData.nickname || "无名修士"),
  };
}

/**
 * 解析怪物 ID 列表为战斗所需的 MonsterData[] 和 monsterSkillsMap
 *
 * 复用点：供 IdleBattleExecutor 构建战斗状态时使用，避免重复实现怪物解析逻辑。
 * 输入：怪物 ID 字符串数组
 * 输出：{ success, monsters, monsterSkillsMap } 或 { success: false, error }
 */
export function resolveMonsterDataForBattle(
  monsterIds: string[],
): OrderedMonstersResolveResult {
  return resolveOrderedMonsters(monsterIds);
}
