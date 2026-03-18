/**
 * 战斗 Redis 持久化
 *
 * 作用：
 * - 将战斗状态保存到 Redis（用于服务器重启后恢复）
 * - 从 Redis 删除已结束的战斗
 * - 恢复战斗参与者列表
 *
 * 不做什么：不管理内存状态、不操作战斗引擎。
 *
 * 复用点：ticker.ts（定期保存）、settlement.ts（结算后删除）、lifecycle.ts（恢复）
 *
 * 边界条件：
 * 1) 持久化必须脱离请求/WS 推送调用栈，避免在玩家操作接口内同步序列化大对象。
 * 2) 同一 battle 在短时间内可能连续触发多次保存，本模块只保留最新一份待写快照，避免重复 stringify。
 * 3) 只有秘境战斗允许落 Redis；普通地图战斗、PVP/竞技场都不做恢复型持久化。
 * 4) resolveRecoveredBattleParticipants 优先用 Redis 数据，缺失时从 state 反推。
 */

import { redis } from "../../../config/redis.js";
import { BattleEngine } from "../../../battle/battleEngine.js";
import type { BattleState, BattleUnit } from "../../../battle/types.js";
import {
  normalizeBattleParticipantUserIds,
  collectBattleOwnerUserIds,
  collectPlayerCharacterIdsFromBattleState,
  getUserIdByCharacterId,
} from "./state.js";

// ------ 常量 ------

export const REDIS_BATTLE_KEY_PREFIX = "battle:state:";
export const REDIS_BATTLE_STATIC_PREFIX = "battle:state:static:";
export const REDIS_BATTLE_PARTICIPANTS_PREFIX = "battle:participants:";
export const REDIS_BATTLE_TTL_SECONDS = 30 * 60; // 30 分钟

export const shouldPersistBattleToRedis = (battleId: string): boolean => {
  return battleId.startsWith("dungeon-battle-");
};

type PendingBattleRedisSave = {
  engine: BattleEngine;
  participants: number[];
};

type PersistedBattleStaticUnit = Pick<
  BattleUnit,
  | "id"
  | "name"
  | "type"
  | "sourceId"
  | "baseAttrs"
  | "skills"
  | "setBonusEffects"
  | "aiProfile"
  | "partnerSkillPolicy"
  | "isSummon"
  | "summonerId"
>;

type PersistedBattleDynamicUnit = Pick<
  BattleUnit,
  | "currentAttrs"
  | "qixue"
  | "lingqi"
  | "shields"
  | "buffs"
  | "marks"
  | "momentum"
  | "skillCooldowns"
  | "skillCooldownDiscountBank"
  | "triggeredPhaseIds"
  | "controlDiminishing"
  | "isAlive"
  | "canAct"
  | "stats"
>;

type PersistedBattleStaticTeam = {
  odwnerId?: number;
  units: PersistedBattleStaticUnit[];
};

type PersistedBattleDynamicTeam = {
  totalSpeed: number;
  units: PersistedBattleDynamicUnit[];
};

type PersistedBattleStaticState = Pick<
  BattleState,
  "battleId" | "battleType" | "cooldownTimingMode" | "firstMover" | "randomSeed"
> & {
  teams: {
    attacker: PersistedBattleStaticTeam;
    defender: PersistedBattleStaticTeam;
  };
};

type PersistedBattleDynamicState = Pick<
  BattleState,
  "roundCount" | "currentTeam" | "currentUnitId" | "phase" | "logs" | "result" | "rewards" | "randomIndex"
> & {
  teams: {
    attacker: PersistedBattleDynamicTeam;
    defender: PersistedBattleDynamicTeam;
  };
};

type PersistedBattleStaticCacheEntry = {
  unitSignature: string;
  staticStateJson: string;
};

const pendingBattleRedisSaveByBattleId = new Map<string, PendingBattleRedisSave>();
const inflightBattleRedisSaveByBattleId = new Map<string, Promise<void>>();
const scheduledBattleRedisSaveBattleIds = new Set<string>();
const persistedBattleStaticCacheByBattleId = new Map<string, PersistedBattleStaticCacheEntry>();

const clearBattleRedisSaveQueue = (battleId: string): void => {
  pendingBattleRedisSaveByBattleId.delete(battleId);
  scheduledBattleRedisSaveBattleIds.delete(battleId);
  persistedBattleStaticCacheByBattleId.delete(battleId);
};

const waitForInflightBattleRedisSave = async (battleId: string): Promise<void> => {
  const inflightSave = inflightBattleRedisSaveByBattleId.get(battleId);
  if (!inflightSave) return;
  try {
    await inflightSave;
  } catch {
    // 保存失败已在 flushQueuedBattleRedisSave 内记录，这里只负责等到落盘流程彻底结束。
  }
};

const buildPersistedBattleStaticUnit = (
  unit: BattleUnit,
): PersistedBattleStaticUnit => ({
  id: unit.id,
  name: unit.name,
  type: unit.type,
  sourceId: unit.sourceId,
  baseAttrs: unit.baseAttrs,
  skills: unit.skills,
  setBonusEffects: unit.setBonusEffects,
  aiProfile: unit.aiProfile,
  partnerSkillPolicy: unit.partnerSkillPolicy,
  isSummon: unit.isSummon,
  summonerId: unit.summonerId,
});

const buildPersistedBattleDynamicUnit = (
  unit: BattleUnit,
): PersistedBattleDynamicUnit => ({
  currentAttrs: unit.currentAttrs,
  qixue: unit.qixue,
  lingqi: unit.lingqi,
  shields: unit.shields,
  buffs: unit.buffs,
  marks: unit.marks,
  momentum: unit.momentum,
  skillCooldowns: unit.skillCooldowns,
  skillCooldownDiscountBank: unit.skillCooldownDiscountBank,
  triggeredPhaseIds: unit.triggeredPhaseIds,
  controlDiminishing: unit.controlDiminishing,
  isAlive: unit.isAlive,
  canAct: unit.canAct,
  stats: unit.stats,
});

const buildPersistedBattleStaticState = (
  state: BattleState,
): PersistedBattleStaticState => ({
  battleId: state.battleId,
  battleType: state.battleType,
  cooldownTimingMode: state.cooldownTimingMode,
  firstMover: state.firstMover,
  randomSeed: state.randomSeed,
  teams: {
    attacker: {
      odwnerId: state.teams.attacker.odwnerId,
      units: state.teams.attacker.units.map(buildPersistedBattleStaticUnit),
    },
    defender: {
      odwnerId: state.teams.defender.odwnerId,
      units: state.teams.defender.units.map(buildPersistedBattleStaticUnit),
    },
  },
});

const buildPersistedBattleDynamicState = (
  state: BattleState,
): PersistedBattleDynamicState => ({
  roundCount: state.roundCount,
  currentTeam: state.currentTeam,
  currentUnitId: state.currentUnitId,
  phase: state.phase,
  logs: state.logs,
  result: state.result,
  rewards: state.rewards,
  randomIndex: state.randomIndex,
  teams: {
    attacker: {
      totalSpeed: state.teams.attacker.totalSpeed,
      units: state.teams.attacker.units.map(buildPersistedBattleDynamicUnit),
    },
    defender: {
      totalSpeed: state.teams.defender.totalSpeed,
      units: state.teams.defender.units.map(buildPersistedBattleDynamicUnit),
    },
  },
});

const buildBattleUnitSignature = (state: BattleState): string => {
  const attackerUnitIds = state.teams.attacker.units.map((unit) => unit.id).join(",");
  const defenderUnitIds = state.teams.defender.units.map((unit) => unit.id).join(",");
  return `${attackerUnitIds}||${defenderUnitIds}`;
};

const resolvePersistedBattleStaticStateJson = (
  battleId: string,
  state: BattleState,
): string => {
  const unitSignature = buildBattleUnitSignature(state);
  const cached = persistedBattleStaticCacheByBattleId.get(battleId);
  if (cached?.unitSignature === unitSignature) {
    return cached.staticStateJson;
  }

  const staticStateJson = JSON.stringify(buildPersistedBattleStaticState(state));
  persistedBattleStaticCacheByBattleId.set(battleId, {
    unitSignature,
    staticStateJson,
  });
  return staticStateJson;
};

const persistBattleSnapshotToRedis = async (
  battleId: string,
  snapshot: PendingBattleRedisSave,
): Promise<void> => {
  const state = snapshot.engine.getState();
  const dynamicStateJson = JSON.stringify(buildPersistedBattleDynamicState(state));
  const staticStateJson = resolvePersistedBattleStaticStateJson(battleId, state);
  const tasks: Promise<unknown>[] = [
    redis.setex(
      `${REDIS_BATTLE_KEY_PREFIX}${battleId}`,
      REDIS_BATTLE_TTL_SECONDS,
      dynamicStateJson,
    ),
    redis.setex(
      `${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`,
      REDIS_BATTLE_TTL_SECONDS,
      JSON.stringify(snapshot.participants),
    ),
    redis.setex(
      `${REDIS_BATTLE_STATIC_PREFIX}${battleId}`,
      REDIS_BATTLE_TTL_SECONDS,
      staticStateJson,
    ),
  ];
  await Promise.all(tasks);
};

const scheduleQueuedBattleRedisSaveFlush = (battleId: string): void => {
  if (scheduledBattleRedisSaveBattleIds.has(battleId)) return;
  if (inflightBattleRedisSaveByBattleId.has(battleId)) return;

  scheduledBattleRedisSaveBattleIds.add(battleId);
  setImmediate(() => {
    scheduledBattleRedisSaveBattleIds.delete(battleId);
    void flushQueuedBattleRedisSave(battleId);
  });
};

const flushQueuedBattleRedisSave = async (battleId: string): Promise<void> => {
  if (inflightBattleRedisSaveByBattleId.has(battleId)) return;

  const snapshot = pendingBattleRedisSaveByBattleId.get(battleId);
  if (!snapshot) return;
  pendingBattleRedisSaveByBattleId.delete(battleId);

  const savePromise = (async () => {
    try {
      await persistBattleSnapshotToRedis(battleId, snapshot);
    } catch (error) {
      console.error("保存战斗到 Redis 失败:", error);
    }
  })();

  inflightBattleRedisSaveByBattleId.set(battleId, savePromise);
  try {
    await savePromise;
  } finally {
    inflightBattleRedisSaveByBattleId.delete(battleId);
    if (pendingBattleRedisSaveByBattleId.has(battleId)) {
      scheduleQueuedBattleRedisSaveFlush(battleId);
    }
  }
};

// ------ 保存/删除 ------

export function saveBattleToRedis(
  battleId: string,
  engine: BattleEngine,
  participants: number[],
): void {
  if (!shouldPersistBattleToRedis(battleId)) {
    clearBattleRedisSaveQueue(battleId);
    return;
  }
  pendingBattleRedisSaveByBattleId.set(battleId, {
    engine,
    participants: [...participants],
  });
  scheduleQueuedBattleRedisSaveFlush(battleId);
}

export async function removeBattleFromRedis(battleId: string): Promise<void> {
  try {
    clearBattleRedisSaveQueue(battleId);
    await waitForInflightBattleRedisSave(battleId);
    await Promise.all([
      redis.del(`${REDIS_BATTLE_KEY_PREFIX}${battleId}`),
      redis.del(`${REDIS_BATTLE_STATIC_PREFIX}${battleId}`),
      redis.del(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
    ]);
  } catch (error) {
    console.error("从 Redis 删除战斗失败:", error);
  }
}

const mergePersistedBattleUnits = (
  dynamicUnits: PersistedBattleDynamicUnit[],
  staticUnits: PersistedBattleStaticUnit[],
): BattleUnit[] => {
  if (dynamicUnits.length !== staticUnits.length) {
    throw new Error("恢复战斗失败: 静态/动态单位数量不一致");
  }

  const mergedUnits: BattleUnit[] = [];
  for (let index = 0; index < dynamicUnits.length; index++) {
    mergedUnits.push({
      ...staticUnits[index],
      ...dynamicUnits[index],
    });
  }
  return mergedUnits;
};

export const restoreBattleStateFromRedisSnapshot = (
  dynamicStateJson: string,
  staticStateJson: string,
): BattleState => {
  const dynamicState = JSON.parse(dynamicStateJson) as PersistedBattleDynamicState;
  const staticState = JSON.parse(staticStateJson) as PersistedBattleStaticState;

  return {
    battleId: staticState.battleId,
    battleType: staticState.battleType,
    cooldownTimingMode: staticState.cooldownTimingMode,
    teams: {
      attacker: {
        odwnerId: staticState.teams.attacker.odwnerId,
        totalSpeed: dynamicState.teams.attacker.totalSpeed,
        units: mergePersistedBattleUnits(
          dynamicState.teams.attacker.units,
          staticState.teams.attacker.units,
        ),
      },
      defender: {
        odwnerId: staticState.teams.defender.odwnerId,
        totalSpeed: dynamicState.teams.defender.totalSpeed,
        units: mergePersistedBattleUnits(
          dynamicState.teams.defender.units,
          staticState.teams.defender.units,
        ),
      },
    },
    roundCount: dynamicState.roundCount,
    currentTeam: dynamicState.currentTeam,
    currentUnitId: dynamicState.currentUnitId,
    phase: dynamicState.phase,
    firstMover: staticState.firstMover,
    logs: dynamicState.logs,
    result: dynamicState.result,
    rewards: dynamicState.rewards,
    randomSeed: staticState.randomSeed,
    randomIndex: dynamicState.randomIndex,
  };
};

// ------ 恢复参与者 ------

export async function resolveRecoveredBattleParticipants(
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
