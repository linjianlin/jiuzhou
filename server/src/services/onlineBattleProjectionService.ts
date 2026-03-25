/**
 * 在线战斗投影服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把在线战斗运行期需要的角色快照、会话快照、竞技场投影、秘境投影、千层塔投影与延迟结算任务统一收口到 Redis + 内存双层投影里。
 * 2. 做什么：提供启动预热、运行时读写、重启恢复所需的单一入口，避免 battle / arena / dungeon / tower 各自散落维护 Redis key。
 * 3. 不做什么：不直接驱动单场 battle engine，不直接处理 HTTP 参数，也不在这里执行真实落库发奖。
 *
 * 输入/输出：
 * - 输入：角色 ID / 用户 ID / BattleSession 快照 / 各玩法运行时快照 / 延迟结算任务。
 * - 输出：Redis 权威投影读取结果，以及启动阶段预热统计。
 *
 * 数据流/状态流：
 * - startupPipeline -> warmupOnlineBattleProjectionService -> 预热 DB 快照到 Redis
 * - 在线战斗开始/推进/结算 -> 业务服务调用本模块读写权威投影
 * - 重启恢复 -> battle lifecycle / settlement runner 从本模块恢复 battle session / 玩法状态 / 待执行任务
 *
 * 关键边界条件与坑点：
 * 1. 在线战斗链路只允许读取这里的投影；若投影未预热完成或 key 缺失，调用方必须直接失败，不能回退 DB。
 * 2. 投影写入必须保持“内存先更新、Redis 随后覆盖”的单一方向，避免同一请求里读到旧内存和新 Redis 的分裂状态。
 */

import { query } from '../config/database.js';
import { redis } from '../config/redis.js';
import type { CharacterComputedRow } from './characterComputedService.js';
import {
  getCharacterComputedBatchByCharacterIds,
} from './characterComputedService.js';
import { getDungeonDifficultyById } from './staticConfigLoader.js';
import {
  loadCharacterBattleLoadoutsByCharacterIds,
  type CharacterBattleLoadout,
} from './battle/shared/profileCache.js';
import type { PartnerBattleMember } from './shared/partnerBattleMember.js';
import { loadActivePartnerBattleMemberMap } from './shared/partnerBattleMember.js';
import type { BattleSessionRecord, BattleSessionSnapshot } from './battleSession/types.js';
import type { ArenaRecord } from './arenaService.js';
import type {
  DungeonInstanceParticipant,
  DungeonInstanceStatus,
} from './dungeon/types.js';
import type {
  TowerBattleRuntimeRecord,
  TowerProgressRecord,
  TowerRankRow,
} from './tower/types.js';
import type {
  BattleParticipant,
  BattleRewardSettlementPlan,
  DistributeResult,
} from './battleDropService.js';
import type { BattleResult } from './battle/battleTypes.js';

const CHARACTER_KEY_PREFIX = 'online-battle:character:';
const USER_CHARACTER_KEY_PREFIX = 'online-battle:user-character:';
const TEAM_MEMBER_KEY_PREFIX = 'online-battle:team-member:';
const SESSION_KEY_PREFIX = 'online-battle:session:';
const SESSION_BATTLE_KEY_PREFIX = 'online-battle:session-battle:';
const ARENA_KEY_PREFIX = 'online-battle:arena:';
const DUNGEON_KEY_PREFIX = 'online-battle:dungeon:';
const DUNGEON_BATTLE_KEY_PREFIX = 'online-battle:dungeon-battle:';
const DUNGEON_ENTRY_KEY_PREFIX = 'online-battle:dungeon-entry:';
const TOWER_KEY_PREFIX = 'online-battle:tower:';
const TOWER_RUNTIME_KEY_PREFIX = 'online-battle:tower-runtime:';
const DEFERRED_SETTLEMENT_KEY_PREFIX = 'online-battle:settlement-task:';

const CHARACTER_INDEX_KEY = 'online-battle:index:characters';
const USER_INDEX_KEY = 'online-battle:index:users';
const SESSION_INDEX_KEY = 'online-battle:index:sessions';
const DUNGEON_INDEX_KEY = 'online-battle:index:dungeons';
const DUNGEON_ENTRY_INDEX_KEY = 'online-battle:index:dungeon-entries';
const TOWER_INDEX_KEY = 'online-battle:index:towers';
const TOWER_RUNTIME_INDEX_KEY = 'online-battle:index:tower-runtimes';
const ARENA_INDEX_KEY = 'online-battle:index:arena';
const DEFERRED_SETTLEMENT_INDEX_KEY = 'online-battle:index:settlement-tasks';
export const ONLINE_BATTLE_DEFERRED_SETTLEMENT_INDEX_KEY = DEFERRED_SETTLEMENT_INDEX_KEY;

const PROJECTION_PERSIST_BATCH_SIZE = 200;
const PROJECTION_PERSIST_CONCURRENCY = 4;
const RECENT_ARENA_RECORD_LIMIT = 50;
const MAX_DEFERRED_SETTLEMENT_ATTEMPTS = 5;
const MAX_DUNGEON_RECORDS_PRELOAD = 5000;

export type TeamMemberProjectionRecord = {
  teamId: string | null;
  role: 'leader' | 'member' | null;
  memberCharacterIds: number[];
};

export type TeamProjectionSyncRecord = {
  userId: number;
  characterId: number;
  teamId: string | null;
  role: 'leader' | 'member' | null;
  memberCharacterIds: number[];
};

export type OnlineBattleCharacterSnapshot = {
  characterId: number;
  userId: number;
  computed: CharacterComputedRow;
  loadout: CharacterBattleLoadout;
  activePartner: PartnerBattleMember | null;
  teamId: string | null;
  isTeamLeader: boolean;
};

export type OnlineBattleSessionSnapshot = BattleSessionSnapshot & {
  createdAt: number;
  updatedAt: number;
};

export type OnlineBattleProjectionRecord = {
  battleId: string;
  ownerUserId: number;
  participantUserIds: number[];
  type: 'pve' | 'pvp';
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ArenaProjectionRecord = {
  characterId: number;
  score: number;
  winCount: number;
  loseCount: number;
  todayUsed: number;
  todayLimit: number;
  todayRemaining: number;
  records: ArenaRecord[];
};

export type DungeonProjectionRecord = {
  instanceId: string;
  dungeonId: string;
  difficultyId: string;
  difficultyRank: number;
  creatorCharacterId: number;
  teamId: string | null;
  status: DungeonInstanceStatus;
  currentStage: number;
  currentWave: number;
  participants: DungeonInstanceParticipant[];
  currentBattleId: string | null;
  rewardEligibleCharacterIds: number[];
  startTime: string | null;
  endTime: string | null;
};

export type TowerProjectionRecord = TowerProgressRecord;

export type DungeonEntryCountProjectionRecord = {
  characterId: number;
  dungeonId: string;
  dailyCount: number;
  weeklyCount: number;
  totalCount: number;
  lastDailyReset: string;
  lastWeeklyReset: string;
};

type DeferredSettlementTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DeferredSettlementTaskPayload = {
  battleId: string;
  battleType: 'pve' | 'pvp';
  result: 'attacker_win' | 'defender_win' | 'draw';
  participants: BattleParticipant[];
  rewardParticipants: BattleParticipant[];
  isDungeonBattle: boolean;
  isTowerBattle: boolean;
  rewardsPreview: BattleSettlementRewardsPreview | null;
  battleRewardPlan: BattleRewardSettlementPlan | null;
  monsters: Array<{
    id: string;
    name: string;
    realm: string | null;
    expReward: number;
    silverRewardMin: number;
    silverRewardMax: number;
    dropPoolId: string | null;
    kind: string | null;
  }>;
  arenaDelta:
    | {
        challengerCharacterId: number;
        opponentCharacterId: number;
        challengerScoreAfter: number;
        challengerScoreDelta: number;
        challengerOutcome: 'win' | 'lose' | 'draw';
      }
    | null;
  dungeonContext:
    | {
        instanceId: string;
        dungeonId: string;
        difficultyId: string;
      }
    | null;
  dungeonStartConsumption:
    | {
        instanceId: string;
        dungeonId: string;
        difficultyId: string;
        creatorCharacterId: number;
        teamId: string | null;
        currentStage: number;
        currentWave: number;
        participants: DungeonInstanceParticipant[];
        currentBattleId: string;
        rewardEligibleCharacterIds: number[];
        startTime: string;
        entryCountSnapshots: DungeonEntryCountProjectionRecord[];
        staminaConsumptions: Array<{
          characterId: number;
          amount: number;
        }>;
      }
    | null;
  dungeonSettlement:
    | {
        instanceId: string;
        dungeonId: string;
        difficultyId: string;
        timeSpentSec: number;
        totalDamage: number;
        deathCount: number;
      }
    | null;
  session: OnlineBattleSessionSnapshot | null;
};

export type DeferredSettlementTask = {
  taskId: string;
  battleId: string;
  status: DeferredSettlementTaskStatus;
  attempts: number;
  maxAttempts: number;
  payload: DeferredSettlementTaskPayload;
  createdAt: number;
  updatedAt: number;
  errorMessage: string | null;
};

export type BattleSettlementRewardsPreview = {
  exp: number;
  silver: number;
  totalExp: number;
  totalSilver: number;
  participantCount: number;
  items: Array<{
    itemDefId: string;
    name: string;
    quantity: number;
    receiverId: number;
  }>;
  perPlayerRewards: Array<{
    characterId: number;
    userId: number;
    exp: number;
    silver: number;
    items: Array<{
      itemDefId: string;
      itemName: string;
      quantity: number;
      instanceIds: number[];
    }>;
  }>;
};

type WarmupSummary = {
  characterCount: number;
  arenaCount: number;
  dungeonCount: number;
  towerCount: number;
};

type ArenaRatingWarmupRow = {
  character_id: number;
  rating: number | null;
  win_count: number | null;
  lose_count: number | null;
};

type ArenaTodayUsageRow = {
  challenger_character_id: number;
  cnt: number;
};

type ArenaRecordWarmupRow = {
  battle_id: string;
  created_at: string;
  challenger_character_id: number;
  opponent_character_id: number;
  result: 'win' | 'lose' | 'draw';
  delta_score: number | null;
  score_after: number | null;
  opponent_name: string | null;
  opponent_realm: string | null;
};

type DungeonWarmupRow = {
  id: string;
  dungeon_id: string;
  difficulty_id: string;
  creator_id: number;
  team_id: string | null;
  status: DungeonInstanceStatus;
  current_stage: number;
  current_wave: number;
  participants: string;
  start_time: string | null;
  end_time: string | null;
  instance_data: string;
};

type TowerWarmupRow = {
  character_id: number;
  best_floor: number;
  next_floor: number;
  current_run_id: string | null;
  current_floor: number | null;
  current_battle_id: string | null;
  last_settled_floor: number;
  updated_at: string;
  reached_at: string | null;
};

type TeamWarmupRow = {
  user_id: number;
  character_id: number;
  team_id: string;
  role: 'leader' | 'member';
};

type DungeonEntryWarmupRow = {
  character_id: number;
  dungeon_id: string;
  daily_count: number | null;
  weekly_count: number | null;
  total_count: number | null;
  last_daily_reset: string | null;
  last_weekly_reset: string | null;
};

const characterSnapshotsByCharacterId = new Map<number, OnlineBattleCharacterSnapshot>();
const userIdToCharacterId = new Map<number, number>();
const teamProjectionByUserId = new Map<number, TeamMemberProjectionRecord>();
const sessionProjectionBySessionId = new Map<string, OnlineBattleSessionSnapshot>();
const sessionIdByBattleId = new Map<string, string>();
const arenaProjectionByCharacterId = new Map<number, ArenaProjectionRecord>();
const dungeonProjectionByInstanceId = new Map<string, DungeonProjectionRecord>();
const dungeonInstanceIdByBattleId = new Map<string, string>();
const dungeonEntryProjectionByKey = new Map<string, DungeonEntryCountProjectionRecord>();
const towerProjectionByCharacterId = new Map<number, TowerProjectionRecord>();
const towerRuntimeProjectionByBattleId = new Map<string, TowerBattleRuntimeRecord>();
const deferredSettlementTaskById = new Map<string, DeferredSettlementTask>();

let projectionReady = false;

const toInt = (value: number | string | null | undefined, fallback: number = 0): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

const clampNonNegative = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const parseJson = <T>(json: string): T => {
  return JSON.parse(json) as T;
};

const normalizeProjectionEntityIds = (ids: number[]): number[] => {
  return [...new Set(
    ids
      .map((id) => toInt(id))
      .filter((id) => id > 0),
  )];
};

const getCurrentDateText = (): string => {
  return new Date().toISOString().slice(0, 10);
};

const getCurrentWeekStartText = (): string => {
  const now = new Date();
  const weekStart = new Date(now);
  const weekday = weekStart.getDay();
  const diffToMonday = (weekday + 6) % 7;
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  return weekStart.toISOString().slice(0, 10);
};

const normalizeDungeonEntryProjection = (
  projection: DungeonEntryCountProjectionRecord,
): DungeonEntryCountProjectionRecord => {
  const currentDate = getCurrentDateText();
  const currentWeekStart = getCurrentWeekStartText();
  const lastDailyReset =
    typeof projection.lastDailyReset === 'string' && projection.lastDailyReset.length > 0
      ? projection.lastDailyReset
      : currentDate;
  const lastWeeklyReset =
    typeof projection.lastWeeklyReset === 'string' && projection.lastWeeklyReset.length > 0
      ? projection.lastWeeklyReset
      : currentWeekStart;

  return {
    ...projection,
    dailyCount: lastDailyReset === currentDate ? clampNonNegative(projection.dailyCount) : 0,
    weeklyCount: lastWeeklyReset >= currentWeekStart ? clampNonNegative(projection.weeklyCount) : 0,
    totalCount: clampNonNegative(projection.totalCount),
    lastDailyReset: currentDate,
    lastWeeklyReset: lastWeeklyReset >= currentWeekStart ? lastWeeklyReset : currentWeekStart,
  };
};

const buildCharacterKey = (characterId: number): string => `${CHARACTER_KEY_PREFIX}${characterId}`;
const buildUserCharacterKey = (userId: number): string => `${USER_CHARACTER_KEY_PREFIX}${userId}`;
const buildTeamMemberKey = (userId: number): string => `${TEAM_MEMBER_KEY_PREFIX}${userId}`;
const buildSessionKey = (sessionId: string): string => `${SESSION_KEY_PREFIX}${sessionId}`;
const buildSessionBattleKey = (battleId: string): string => `${SESSION_BATTLE_KEY_PREFIX}${battleId}`;
const buildArenaKey = (characterId: number): string => `${ARENA_KEY_PREFIX}${characterId}`;
const buildDungeonKey = (instanceId: string): string => `${DUNGEON_KEY_PREFIX}${instanceId}`;
const buildDungeonBattleKey = (battleId: string): string => `${DUNGEON_BATTLE_KEY_PREFIX}${battleId}`;
const buildDungeonEntryProjectionKey = (characterId: number, dungeonId: string): string =>
  `${DUNGEON_ENTRY_KEY_PREFIX}${characterId}:${dungeonId}`;
const buildTowerKey = (characterId: number): string => `${TOWER_KEY_PREFIX}${characterId}`;
const buildTowerRuntimeKey = (battleId: string): string => `${TOWER_RUNTIME_KEY_PREFIX}${battleId}`;
const buildDeferredSettlementKey = (taskId: string): string => `${DEFERRED_SETTLEMENT_KEY_PREFIX}${taskId}`;
export const buildOnlineBattleDeferredSettlementTaskKey = (taskId: string): string => buildDeferredSettlementKey(taskId);

const splitIntoChunks = <T>(values: T[], size: number): T[][] => {
  if (values.length <= 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const formatWarmupDuration = (durationMs: number): string => {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(2)}s`;
};

const runWarmupPhase = async <T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> => {
  const startAt = Date.now();
  const result = await task();
  console.log(`[online-battle:warmup] ${label}（耗时 ${formatWarmupDuration(Date.now() - startAt)}）`);
  return result;
};

const logWarmupPhaseDetail = (
  label: string,
  detail: string,
  durationMs: number,
): void => {
  console.log(
    `[online-battle:warmup] ${label} / ${detail}（耗时 ${formatWarmupDuration(durationMs)}）`,
  );
};

const processBatchesConcurrently = async <T>(
  values: T[],
  worker: (batch: T[]) => Promise<void>,
  options?: {
    batchSize?: number;
    concurrency?: number;
  },
): Promise<void> => {
  const batches = splitIntoChunks(
    values,
    options?.batchSize ?? PROJECTION_PERSIST_BATCH_SIZE,
  );
  for (const batchGroup of splitIntoChunks(
    batches,
    options?.concurrency ?? PROJECTION_PERSIST_CONCURRENCY,
  )) {
    await Promise.all(batchGroup.map((batch) => worker(batch)));
  }
};

const persistJson = async (key: string, value: object): Promise<void> => {
  await redis.set(key, JSON.stringify(value));
};

const persistString = async (key: string, value: string): Promise<void> => {
  await redis.set(key, value);
};

const deleteKeys = async (keys: string[]): Promise<void> => {
  if (keys.length <= 0) return;
  await redis.del(...keys);
};

const readJson = async <T>(key: string): Promise<T | null> => {
  const raw = await redis.get(key);
  if (!raw) return null;
  return parseJson<T>(raw);
};

const parseDungeonParticipants = (participantsJson: string): DungeonInstanceParticipant[] => {
  const parsed = parseJson<Array<{ userId: number; characterId: number; role: 'leader' | 'member' }>>(participantsJson);
  return parsed
    .map((entry) => ({
      userId: toInt(entry.userId),
      characterId: toInt(entry.characterId),
      role: (entry.role === 'leader' ? 'leader' : 'member') as 'leader' | 'member',
    }))
    .filter((entry) => entry.userId > 0 && entry.characterId > 0);
};

const parseDungeonInstanceData = (instanceDataJson: string): {
  currentBattleId: string | null;
  rewardEligibleCharacterIds: number[];
} => {
  const parsed = parseJson<{
    currentBattleId?: string;
    rewardEligibleCharacterIds?: number[];
  }>(instanceDataJson);
  return {
    currentBattleId:
      typeof parsed.currentBattleId === 'string' && parsed.currentBattleId.length > 0
        ? parsed.currentBattleId
        : null,
    rewardEligibleCharacterIds: Array.isArray(parsed.rewardEligibleCharacterIds)
      ? parsed.rewardEligibleCharacterIds
          .map((value) => toInt(value))
          .filter((value) => value > 0)
      : [],
  };
};

const persistCharacterSnapshot = async (
  snapshot: OnlineBattleCharacterSnapshot,
): Promise<void> => {
  characterSnapshotsByCharacterId.set(snapshot.characterId, snapshot);
  userIdToCharacterId.set(snapshot.userId, snapshot.characterId);
  await Promise.all([
    redis.sadd(CHARACTER_INDEX_KEY, String(snapshot.characterId)),
    redis.sadd(USER_INDEX_KEY, String(snapshot.userId)),
    persistJson(buildCharacterKey(snapshot.characterId), snapshot),
    persistString(buildUserCharacterKey(snapshot.userId), String(snapshot.characterId)),
  ]);
};

/**
 * 批量写入角色在线战斗快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把启动预热阶段的角色快照写 Redis 改为批量 multi，避免全量角色逐条 `sadd/set` 带来的高往返成本。
 * 2. 做什么：保持内存索引与 Redis 权威投影同一批次更新，减少预热期间中间态分裂。
 * 3. 不做什么：不改变单角色运行时写路径；普通业务更新仍走 `persistCharacterSnapshot`。
 *
 * 输入/输出：
 * - 输入：同一批已经组装完成的角色快照列表。
 * - 输出：无；副作用是同步更新内存索引与 Redis。
 *
 * 数据流/状态流：
 * warmupCharacterSnapshots -> 组装一批 snapshot -> 本函数批量写入 Redis + 内存 -> 在线战斗读链路按投影读取。
 *
 * 关键边界条件与坑点：
 * 1. 这里假设入参已完成字段校验；若把半成品 snapshot 写入 Redis，会让启动后的战斗链路直接读到坏数据。
 * 2. 只适合“预热整批写入”场景；运行时增量更新若混用本函数，容易把单角色更新日志粒度打散。
 */
const persistCharacterSnapshotsBatch = async (
  snapshots: OnlineBattleCharacterSnapshot[],
): Promise<void> => {
  if (snapshots.length <= 0) {
    return;
  }

  for (const snapshot of snapshots) {
    characterSnapshotsByCharacterId.set(snapshot.characterId, snapshot);
    userIdToCharacterId.set(snapshot.userId, snapshot.characterId);
  }

  const multi = redis.multi();
  multi.sadd(
    CHARACTER_INDEX_KEY,
    ...snapshots.map((snapshot) => String(snapshot.characterId)),
  );
  multi.sadd(
    USER_INDEX_KEY,
    ...snapshots.map((snapshot) => String(snapshot.userId)),
  );
  for (const snapshot of snapshots) {
    multi.set(buildCharacterKey(snapshot.characterId), JSON.stringify(snapshot));
    multi.set(buildUserCharacterKey(snapshot.userId), String(snapshot.characterId));
  }
  await multi.exec();
};

const persistTeamProjectionsBatch = async (
  entries: Array<{ userId: number; projection: TeamMemberProjectionRecord }>,
): Promise<void> => {
  if (entries.length <= 0) {
    return;
  }

  const multi = redis.multi();
  for (const entry of entries) {
    teamProjectionByUserId.set(entry.userId, entry.projection);
    multi.set(buildTeamMemberKey(entry.userId), JSON.stringify(entry.projection));
  }
  await multi.exec();
};

const persistTeamProjection = async (
  userId: number,
  projection: TeamMemberProjectionRecord,
): Promise<void> => {
  teamProjectionByUserId.set(userId, projection);
  await persistJson(buildTeamMemberKey(userId), projection);
};

const normalizeTeamProjectionSyncRecord = (
  record: TeamProjectionSyncRecord,
): TeamProjectionSyncRecord => {
  const userId = toInt(record.userId);
  const characterId = toInt(record.characterId);
  const teamId =
    typeof record.teamId === 'string' && record.teamId.trim().length > 0
      ? record.teamId.trim()
      : null;
  const role = record.role === 'leader' ? 'leader' : record.role === 'member' ? 'member' : null;
  const memberCharacterIds = Array.from(
    new Set(
      record.memberCharacterIds
        .map((memberCharacterId) => toInt(memberCharacterId))
        .filter((memberCharacterId) => memberCharacterId > 0),
    ),
  );

  return {
    userId,
    characterId,
    teamId,
    role,
    memberCharacterIds,
  };
};

const persistCharacterTeamSnapshot = async (
  record: TeamProjectionSyncRecord,
): Promise<void> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(record.characterId);
  if (!snapshot) {
    return;
  }

  const nextTeamId = record.teamId;
  const nextIsTeamLeader = record.role === 'leader';
  if (snapshot.teamId === nextTeamId && snapshot.isTeamLeader === nextIsTeamLeader) {
    return;
  }

  await persistCharacterSnapshot({
    ...snapshot,
    teamId: nextTeamId,
    isTeamLeader: nextIsTeamLeader,
  });
};

const persistSessionProjection = async (
  snapshot: OnlineBattleSessionSnapshot,
): Promise<void> => {
  const previous = sessionProjectionBySessionId.get(snapshot.sessionId) ?? null;
  if (previous?.currentBattleId && previous.currentBattleId !== snapshot.currentBattleId) {
    sessionIdByBattleId.delete(previous.currentBattleId);
    await redis.del(buildSessionBattleKey(previous.currentBattleId));
  }
  sessionProjectionBySessionId.set(snapshot.sessionId, snapshot);
  await redis.sadd(SESSION_INDEX_KEY, snapshot.sessionId);
  await persistJson(buildSessionKey(snapshot.sessionId), snapshot);
  if (snapshot.currentBattleId) {
    sessionIdByBattleId.set(snapshot.currentBattleId, snapshot.sessionId);
    await persistString(buildSessionBattleKey(snapshot.currentBattleId), snapshot.sessionId);
  }
};

const persistArenaProjection = async (projection: ArenaProjectionRecord): Promise<void> => {
  arenaProjectionByCharacterId.set(projection.characterId, projection);
  await Promise.all([
    redis.sadd(ARENA_INDEX_KEY, String(projection.characterId)),
    persistJson(buildArenaKey(projection.characterId), projection),
  ]);
};

const persistArenaProjectionsBatch = async (
  projections: ArenaProjectionRecord[],
): Promise<void> => {
  if (projections.length <= 0) {
    return;
  }

  const multi = redis.multi();
  multi.sadd(
    ARENA_INDEX_KEY,
    ...projections.map((projection) => String(projection.characterId)),
  );
  for (const projection of projections) {
    arenaProjectionByCharacterId.set(projection.characterId, projection);
    multi.set(buildArenaKey(projection.characterId), JSON.stringify(projection));
  }
  await multi.exec();
};

const persistDungeonProjection = async (projection: DungeonProjectionRecord): Promise<void> => {
  const previous = dungeonProjectionByInstanceId.get(projection.instanceId) ?? null;
  if (previous?.currentBattleId && previous.currentBattleId !== projection.currentBattleId) {
    dungeonInstanceIdByBattleId.delete(previous.currentBattleId);
    await redis.del(buildDungeonBattleKey(previous.currentBattleId));
  }
  dungeonProjectionByInstanceId.set(projection.instanceId, projection);
  await redis.sadd(DUNGEON_INDEX_KEY, projection.instanceId);
  await persistJson(buildDungeonKey(projection.instanceId), projection);
  if (projection.currentBattleId) {
    dungeonInstanceIdByBattleId.set(projection.currentBattleId, projection.instanceId);
    await persistString(buildDungeonBattleKey(projection.currentBattleId), projection.instanceId);
  }
};

const persistDungeonProjectionsBatch = async (
  projections: DungeonProjectionRecord[],
): Promise<void> => {
  if (projections.length <= 0) {
    return;
  }

  const multi = redis.multi();
  multi.sadd(
    DUNGEON_INDEX_KEY,
    ...projections.map((projection) => projection.instanceId),
  );
  for (const projection of projections) {
    const previous = dungeonProjectionByInstanceId.get(projection.instanceId) ?? null;
    if (previous?.currentBattleId && previous.currentBattleId !== projection.currentBattleId) {
      dungeonInstanceIdByBattleId.delete(previous.currentBattleId);
      multi.del(buildDungeonBattleKey(previous.currentBattleId));
    }
    dungeonProjectionByInstanceId.set(projection.instanceId, projection);
    multi.set(buildDungeonKey(projection.instanceId), JSON.stringify(projection));
    if (projection.currentBattleId) {
      dungeonInstanceIdByBattleId.set(projection.currentBattleId, projection.instanceId);
      multi.set(buildDungeonBattleKey(projection.currentBattleId), projection.instanceId);
    }
  }
  await multi.exec();
};

const persistDungeonEntryProjection = async (
  projection: DungeonEntryCountProjectionRecord,
): Promise<void> => {
  const normalized = normalizeDungeonEntryProjection(projection);
  const projectionKey = buildDungeonEntryProjectionKey(normalized.characterId, normalized.dungeonId);
  dungeonEntryProjectionByKey.set(projectionKey, normalized);
  await Promise.all([
    redis.sadd(DUNGEON_ENTRY_INDEX_KEY, projectionKey),
    persistJson(projectionKey, normalized),
  ]);
};

const persistDungeonEntryProjectionsBatch = async (
  projections: DungeonEntryCountProjectionRecord[],
): Promise<void> => {
  if (projections.length <= 0) {
    return;
  }

  const normalizedProjections = projections.map((projection) => normalizeDungeonEntryProjection(projection));
  const multi = redis.multi();
  multi.sadd(
    DUNGEON_ENTRY_INDEX_KEY,
    ...normalizedProjections.map((projection) => buildDungeonEntryProjectionKey(projection.characterId, projection.dungeonId)),
  );
  for (const projection of normalizedProjections) {
    const projectionKey = buildDungeonEntryProjectionKey(projection.characterId, projection.dungeonId);
    dungeonEntryProjectionByKey.set(projectionKey, projection);
    multi.set(projectionKey, JSON.stringify(projection));
  }
  await multi.exec();
};

const persistTowerProjection = async (projection: TowerProjectionRecord): Promise<void> => {
  towerProjectionByCharacterId.set(projection.characterId, projection);
  await Promise.all([
    redis.sadd(TOWER_INDEX_KEY, String(projection.characterId)),
    persistJson(buildTowerKey(projection.characterId), projection),
  ]);
};

const persistTowerProjectionsBatch = async (
  projections: TowerProjectionRecord[],
): Promise<void> => {
  if (projections.length <= 0) {
    return;
  }

  const multi = redis.multi();
  multi.sadd(
    TOWER_INDEX_KEY,
    ...projections.map((projection) => String(projection.characterId)),
  );
  for (const projection of projections) {
    towerProjectionByCharacterId.set(projection.characterId, projection);
    multi.set(buildTowerKey(projection.characterId), JSON.stringify(projection));
  }
  await multi.exec();
};

const persistTowerRuntimeProjection = async (projection: TowerBattleRuntimeRecord): Promise<void> => {
  towerRuntimeProjectionByBattleId.set(projection.battleId, projection);
  await Promise.all([
    redis.sadd(TOWER_RUNTIME_INDEX_KEY, projection.battleId),
    persistJson(buildTowerRuntimeKey(projection.battleId), projection),
  ]);
};

const persistDeferredSettlementTask = async (task: DeferredSettlementTask): Promise<void> => {
  deferredSettlementTaskById.set(task.taskId, task);
  await Promise.all([
    redis.sadd(DEFERRED_SETTLEMENT_INDEX_KEY, task.taskId),
    persistJson(buildDeferredSettlementKey(task.taskId), task),
  ]);
};

const loadCharacterSnapshotFromRedis = async (
  characterId: number,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const cached = await readJson<OnlineBattleCharacterSnapshot>(buildCharacterKey(characterId));
  if (!cached) return null;
  characterSnapshotsByCharacterId.set(characterId, cached);
  userIdToCharacterId.set(cached.userId, cached.characterId);
  return cached;
};

/**
 * 批量加载角色在线战斗快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把多角色快照 miss 时的 Redis 读取收口为单次 `mget`，避免战斗准备、秘境参与者、结算等热点链路逐个 `await`。
 * 2. 做什么：复用与单角色读取一致的内存索引回填逻辑，保证后续读取直接命中同一份快照。
 * 3. 不做什么：不做 DB 回退；Redis 没有的角色仍直接视为缺失。
 *
 * 输入/输出：
 * - 输入：已归一化的角色 ID 列表。
 * - 输出：按“请求角色 ID”组织的快照映射。
 *
 * 数据流/状态流：
 * 调用方收集 miss 角色 ID -> 本函数 `mget` 批量取 Redis -> 回填内存快照索引 -> 返回结果。
 *
 * 关键边界条件与坑点：
 * 1. 这里只接收正整数角色 ID；上游若传入脏值，会在归一化阶段被丢弃，不在这里补救。
 * 2. 返回 Map 的 key 以“请求角色 ID”为准，调用方可以继续按原始角色 ID 取值，不需要感知快照缓存细节。
 */
const loadCharacterSnapshotsByCharacterIdsFromRedis = async (
  characterIds: number[],
): Promise<Map<number, OnlineBattleCharacterSnapshot>> => {
  const result = new Map<number, OnlineBattleCharacterSnapshot>();
  if (characterIds.length <= 0) {
    return result;
  }

  const rawSnapshots = await redis.mget(
    ...characterIds.map((characterId) => buildCharacterKey(characterId)),
  );
  for (let index = 0; index < characterIds.length; index += 1) {
    const requestedCharacterId = characterIds[index]!;
    const rawSnapshot = rawSnapshots[index];
    if (typeof rawSnapshot !== 'string' || rawSnapshot.length <= 0) {
      continue;
    }

    const snapshot = parseJson<OnlineBattleCharacterSnapshot>(rawSnapshot);
    characterSnapshotsByCharacterId.set(snapshot.characterId, snapshot);
    userIdToCharacterId.set(snapshot.userId, snapshot.characterId);
    result.set(requestedCharacterId, snapshot);
  }

  return result;
};

const loadTeamProjectionFromRedis = async (
  userId: number,
): Promise<TeamMemberProjectionRecord | null> => {
  const cached = await readJson<TeamMemberProjectionRecord>(buildTeamMemberKey(userId));
  if (!cached) return null;
  teamProjectionByUserId.set(userId, cached);
  return cached;
};

const loadCharacterIdsByUserIdsFromRedis = async (
  userIds: number[],
): Promise<Map<number, number>> => {
  const result = new Map<number, number>();
  if (userIds.length <= 0) {
    return result;
  }

  const rawCharacterIds = await redis.mget(
    ...userIds.map((userId) => buildUserCharacterKey(userId)),
  );
  for (let index = 0; index < userIds.length; index += 1) {
    const userId = userIds[index]!;
    const characterId = toInt(rawCharacterIds[index]);
    if (characterId <= 0) {
      continue;
    }
    userIdToCharacterId.set(userId, characterId);
    result.set(userId, characterId);
  }

  return result;
};

const loadSessionProjectionFromRedis = async (
  sessionId: string,
): Promise<OnlineBattleSessionSnapshot | null> => {
  const cached = await readJson<OnlineBattleSessionSnapshot>(buildSessionKey(sessionId));
  if (!cached) return null;
  sessionProjectionBySessionId.set(sessionId, cached);
  if (cached.currentBattleId) {
    sessionIdByBattleId.set(cached.currentBattleId, cached.sessionId);
  }
  return cached;
};

const loadArenaProjectionFromRedis = async (
  characterId: number,
): Promise<ArenaProjectionRecord | null> => {
  const cached = await readJson<ArenaProjectionRecord>(buildArenaKey(characterId));
  if (!cached) return null;
  arenaProjectionByCharacterId.set(characterId, cached);
  return cached;
};

const loadDungeonProjectionFromRedis = async (
  instanceId: string,
): Promise<DungeonProjectionRecord | null> => {
  const cached = await readJson<DungeonProjectionRecord>(buildDungeonKey(instanceId));
  if (!cached) return null;
  dungeonProjectionByInstanceId.set(instanceId, cached);
  if (cached.currentBattleId) {
    dungeonInstanceIdByBattleId.set(cached.currentBattleId, cached.instanceId);
  }
  return cached;
};

const loadDungeonEntryProjectionFromRedis = async (
  characterId: number,
  dungeonId: string,
): Promise<DungeonEntryCountProjectionRecord | null> => {
  const projectionKey = buildDungeonEntryProjectionKey(characterId, dungeonId);
  const cached = await readJson<DungeonEntryCountProjectionRecord>(projectionKey);
  if (!cached) return null;
  const normalized = normalizeDungeonEntryProjection(cached);
  dungeonEntryProjectionByKey.set(projectionKey, normalized);
  return normalized;
};

const loadTowerProjectionFromRedis = async (
  characterId: number,
): Promise<TowerProjectionRecord | null> => {
  const cached = await readJson<TowerProjectionRecord>(buildTowerKey(characterId));
  if (!cached) return null;
  towerProjectionByCharacterId.set(characterId, cached);
  return cached;
};

const loadTowerRuntimeProjectionFromRedis = async (
  battleId: string,
): Promise<TowerBattleRuntimeRecord | null> => {
  const cached = await readJson<TowerBattleRuntimeRecord>(buildTowerRuntimeKey(battleId));
  if (!cached) return null;
  towerRuntimeProjectionByBattleId.set(battleId, cached);
  return cached;
};

const loadDeferredSettlementTaskFromRedis = async (
  taskId: string,
): Promise<DeferredSettlementTask | null> => {
  const cached = await readJson<DeferredSettlementTask>(buildDeferredSettlementKey(taskId));
  if (!cached) return null;
  deferredSettlementTaskById.set(taskId, cached);
  return cached;
};

const clearAllProjectionIndexes = async (): Promise<void> => {
  const keys = [
    CHARACTER_INDEX_KEY,
    USER_INDEX_KEY,
    SESSION_INDEX_KEY,
    DUNGEON_INDEX_KEY,
    DUNGEON_ENTRY_INDEX_KEY,
    TOWER_INDEX_KEY,
    TOWER_RUNTIME_INDEX_KEY,
    ARENA_INDEX_KEY,
    DEFERRED_SETTLEMENT_INDEX_KEY,
  ];
  await deleteKeys(keys);
};

const warmupCharacterSnapshotChunk = async (
  characterIds: number[],
): Promise<number> => {
  const computedStartAt = Date.now();
  const computedMap = await getCharacterComputedBatchByCharacterIds(characterIds);
  logWarmupPhaseDetail('角色快照预热', '角色属性计算', Date.now() - computedStartAt);
  const computedCharacterIds = [...computedMap.keys()];
  const loadoutStartAt = Date.now();
  const loadoutPromise = loadCharacterBattleLoadoutsByCharacterIds(
    computedCharacterIds,
    computedMap,
    {
      onPhase: (detail, durationMs) => {
        logWarmupPhaseDetail('角色快照预热', `战斗装配/${detail}`, durationMs);
      },
    },
  ).then((loadoutMap) => {
    logWarmupPhaseDetail('角色快照预热', '战斗装配计算', Date.now() - loadoutStartAt);
    return loadoutMap;
  });
  const activePartnerStartAt = Date.now();
  const activePartnerPromise = loadActivePartnerBattleMemberMap(computedCharacterIds)
    .then((activePartnerMap) => {
      logWarmupPhaseDetail('角色快照预热', '出战伙伴装配', Date.now() - activePartnerStartAt);
      return activePartnerMap;
    });
  const [loadoutMap, activePartnerMap] = await Promise.all([
    loadoutPromise,
    activePartnerPromise,
  ]);

  const snapshotAssembleStartAt = Date.now();
  const snapshots = computedCharacterIds
    .map((characterId) => {
      const computed = computedMap.get(characterId);
      const loadout = loadoutMap.get(characterId);
      if (!computed || !loadout) return null;

      const teamProjection = teamProjectionByUserId.get(computed.user_id) ?? {
        teamId: null,
        role: null,
        memberCharacterIds: [],
      };

      return {
        characterId: computed.id,
        userId: computed.user_id,
        computed,
        loadout,
        activePartner: activePartnerMap.get(characterId) ?? null,
        teamId: teamProjection.teamId,
        isTeamLeader: teamProjection.role === 'leader',
      } satisfies OnlineBattleCharacterSnapshot;
    })
    .filter((snapshot): snapshot is OnlineBattleCharacterSnapshot => snapshot !== null);
  logWarmupPhaseDetail('角色快照预热', '快照组装', Date.now() - snapshotAssembleStartAt);

  const persistStartAt = Date.now();
  await processBatchesConcurrently(snapshots, persistCharacterSnapshotsBatch);
  logWarmupPhaseDetail('角色快照预热', '投影写入', Date.now() - persistStartAt);

  console.log(
    `[online-battle:warmup] 角色快照预热 / 角色数 ${snapshots.length}`,
  );

  return snapshots.length;
};

const warmupCharacterSnapshots = async (): Promise<number> => {
  const queryCharacterIdsStartAt = Date.now();
  const characterIdResult = await query<{ id: number }>('SELECT id FROM characters ORDER BY id ASC');
  logWarmupPhaseDetail('角色快照预热', '角色ID查询', Date.now() - queryCharacterIdsStartAt);
  const characterIds = characterIdResult.rows
    .map((row) => toInt(row.id))
    .filter((characterId) => characterId > 0);
  return warmupCharacterSnapshotChunk(characterIds);
};

const warmupTeamProjections = async (): Promise<void> => {
  const result = await query<TeamWarmupRow>(
    `
      SELECT
        c.user_id,
        tm.character_id,
        tm.team_id,
        tm.role
      FROM team_members tm
      JOIN characters c ON c.id = tm.character_id
      ORDER BY tm.team_id ASC, tm.role DESC, tm.joined_at ASC
    `,
  );

  const memberCharacterIdsByTeamId = new Map<string, number[]>();
  for (const row of result.rows) {
    const teamId = String(row.team_id || '');
    if (!teamId) continue;
    const list = memberCharacterIdsByTeamId.get(teamId) ?? [];
    list.push(toInt(row.character_id));
    memberCharacterIdsByTeamId.set(teamId, list);
  }

  const projections: Array<{ userId: number; projection: TeamMemberProjectionRecord }> = [];
  for (const row of result.rows) {
    const userId = toInt(row.user_id);
    if (userId <= 0) continue;
    const teamId = String(row.team_id || '');
    const role = row.role === 'leader' ? 'leader' : 'member';
    projections.push({
      userId,
      projection: {
        teamId: teamId || null,
        role,
        memberCharacterIds: (memberCharacterIdsByTeamId.get(teamId) ?? []).filter((characterId) => characterId > 0),
      },
    });
  }

  await processBatchesConcurrently(projections, persistTeamProjectionsBatch);
};

const warmupArenaProjections = async (): Promise<number> => {
  const [ratingResult, todayUsageResult, recordResult] = await Promise.all([
    query<ArenaRatingWarmupRow>(
      `
        SELECT character_id, rating, win_count, lose_count
        FROM arena_rating
      `,
    ),
    query<ArenaTodayUsageRow>(
      `
        SELECT challenger_character_id, COUNT(*)::int AS cnt
        FROM arena_battle
        WHERE created_at >= date_trunc('day', NOW())
        GROUP BY challenger_character_id
      `,
    ),
    query<ArenaRecordWarmupRow>(
      `
        SELECT
          ab.battle_id,
          ab.created_at,
          ab.challenger_character_id,
          ab.opponent_character_id,
          ab.result,
          ab.delta_score,
          ab.score_after,
          c.nickname AS opponent_name,
          c.realm AS opponent_realm
        FROM arena_battle ab
        JOIN characters c ON c.id = ab.opponent_character_id
        WHERE ab.status = 'finished'
        ORDER BY ab.created_at DESC
        LIMIT $1
      `,
      [MAX_DUNGEON_RECORDS_PRELOAD],
    ),
  ]);

  const todayUsageByCharacterId = new Map<number, number>();
  for (const row of todayUsageResult.rows) {
    todayUsageByCharacterId.set(toInt(row.challenger_character_id), clampNonNegative(row.cnt));
  }

  const recordsByCharacterId = new Map<number, ArenaRecord[]>();
  for (const row of recordResult.rows) {
    const challengerCharacterId = toInt(row.challenger_character_id);
    if (challengerCharacterId <= 0) continue;
    const current = recordsByCharacterId.get(challengerCharacterId) ?? [];
    if (current.length >= RECENT_ARENA_RECORD_LIMIT) continue;
    current.push({
      id: String(row.battle_id || ''),
      ts: new Date(String(row.created_at || '')).getTime(),
      opponentName: String(row.opponent_name || ''),
      opponentRealm: String(row.opponent_realm || '凡人'),
      opponentPower: 0,
      result: row.result === 'win' || row.result === 'lose' || row.result === 'draw' ? row.result : 'draw',
      deltaScore: toInt(row.delta_score),
      scoreAfter: Math.max(1000, toInt(row.score_after, 1000)),
    });
    recordsByCharacterId.set(challengerCharacterId, current);
  }

  const characterIds = new Set<number>();
  const ratingByCharacterId = new Map<number, ArenaRatingWarmupRow>();
  for (const row of ratingResult.rows) {
    const characterId = toInt(row.character_id);
    characterIds.add(characterId);
    ratingByCharacterId.set(characterId, row);
  }
  for (const [characterId] of todayUsageByCharacterId) {
    characterIds.add(characterId);
  }

  const projections: ArenaProjectionRecord[] = [];
  for (const characterId of characterIds) {
    if (characterId <= 0) continue;
    const ratingRow = ratingByCharacterId.get(characterId) ?? null;
    const todayUsed = todayUsageByCharacterId.get(characterId) ?? 0;
    projections.push({
      characterId,
      score: Math.max(1000, toInt(ratingRow?.rating, 1000)),
      winCount: clampNonNegative(toInt(ratingRow?.win_count, 0)),
      loseCount: clampNonNegative(toInt(ratingRow?.lose_count, 0)),
      todayUsed,
      todayLimit: 20,
      todayRemaining: Math.max(0, 20 - todayUsed),
      records: recordsByCharacterId.get(characterId) ?? [],
    });
  }

  await processBatchesConcurrently(projections, persistArenaProjectionsBatch);
  return projections.length;
};

const warmupDungeonProjections = async (): Promise<number> => {
  const result = await query<DungeonWarmupRow>(
    `
      SELECT
        di.id,
        di.dungeon_id,
        di.difficulty_id,
        di.creator_id,
        di.team_id,
        di.status,
        di.current_stage,
        di.current_wave,
        di.participants::text AS participants,
        di.start_time::text AS start_time,
        di.end_time::text AS end_time,
        di.instance_data::text AS instance_data
      FROM dungeon_instance di
      WHERE di.status IN ('preparing', 'running')
    `,
  );

  const projections: DungeonProjectionRecord[] = [];
  for (const row of result.rows) {
    const instanceData = parseDungeonInstanceData(String(row.instance_data || '{}'));
    const difficultyDef = getDungeonDifficultyById(row.difficulty_id);
    projections.push({
      instanceId: row.id,
      dungeonId: row.dungeon_id,
      difficultyId: row.difficulty_id,
      difficultyRank: Math.max(1, toInt(difficultyDef?.difficulty_rank, 1)),
      creatorCharacterId: Math.max(0, toInt(row.creator_id, 0)),
      teamId: typeof row.team_id === 'string' && row.team_id.length > 0 ? row.team_id : null,
      status: row.status,
      currentStage: Math.max(1, toInt(row.current_stage, 1)),
      currentWave: Math.max(1, toInt(row.current_wave, 1)),
      participants: parseDungeonParticipants(String(row.participants || '[]')),
      currentBattleId: instanceData.currentBattleId,
      rewardEligibleCharacterIds: instanceData.rewardEligibleCharacterIds,
      startTime: row.start_time,
      endTime: row.end_time,
    });
  }

  await processBatchesConcurrently(projections, persistDungeonProjectionsBatch);
  return projections.length;
};

const warmupDungeonEntryProjections = async (): Promise<void> => {
  const result = await query<DungeonEntryWarmupRow>(
    `
      SELECT
        character_id,
        dungeon_id,
        daily_count,
        weekly_count,
        total_count,
        last_daily_reset::text AS last_daily_reset,
        last_weekly_reset::text AS last_weekly_reset
      FROM dungeon_entry_count
    `,
  );

  const projections: DungeonEntryCountProjectionRecord[] = result.rows.map((row) => ({
    characterId: toInt(row.character_id),
    dungeonId: String(row.dungeon_id || ''),
    dailyCount: clampNonNegative(toInt(row.daily_count, 0)),
    weeklyCount: clampNonNegative(toInt(row.weekly_count, 0)),
    totalCount: clampNonNegative(toInt(row.total_count, 0)),
    lastDailyReset: typeof row.last_daily_reset === 'string' && row.last_daily_reset.length > 0
      ? row.last_daily_reset
      : getCurrentDateText(),
    lastWeeklyReset: typeof row.last_weekly_reset === 'string' && row.last_weekly_reset.length > 0
      ? row.last_weekly_reset
      : getCurrentWeekStartText(),
  }));

  await processBatchesConcurrently(projections, persistDungeonEntryProjectionsBatch);
};

const warmupTowerProjections = async (): Promise<number> => {
  const result = await query<TowerWarmupRow>(
    `
      SELECT
        character_id,
        best_floor,
        next_floor,
        current_run_id,
        current_floor,
        current_battle_id,
        last_settled_floor,
        updated_at::text AS updated_at,
        reached_at::text AS reached_at
      FROM character_tower_progress
    `,
  );

  const projections: TowerProjectionRecord[] = result.rows.map((row) => ({
      characterId: toInt(row.character_id),
      bestFloor: clampNonNegative(toInt(row.best_floor, 0)),
      nextFloor: Math.max(1, toInt(row.next_floor, 1)),
      currentRunId: row.current_run_id,
      currentFloor: row.current_floor == null ? null : Math.max(1, toInt(row.current_floor, 1)),
      currentBattleId: row.current_battle_id,
      lastSettledFloor: clampNonNegative(toInt(row.last_settled_floor, 0)),
      updatedAt: row.updated_at,
      reachedAt: row.reached_at,
    }));

  await processBatchesConcurrently(projections, persistTowerProjectionsBatch);
  return projections.length;
};

export const warmupOnlineBattleProjectionService = async (): Promise<WarmupSummary> => {
  projectionReady = false;
  await clearAllProjectionIndexes();
  characterSnapshotsByCharacterId.clear();
  userIdToCharacterId.clear();
  teamProjectionByUserId.clear();
  sessionProjectionBySessionId.clear();
  sessionIdByBattleId.clear();
  arenaProjectionByCharacterId.clear();
  dungeonProjectionByInstanceId.clear();
  dungeonInstanceIdByBattleId.clear();
  dungeonEntryProjectionByKey.clear();
  towerProjectionByCharacterId.clear();
  towerRuntimeProjectionByBattleId.clear();
  deferredSettlementTaskById.clear();

  await Promise.all([
    runWarmupPhase('队伍投影预热', warmupTeamProjections),
    runWarmupPhase('秘境进入次数投影预热', warmupDungeonEntryProjections),
  ]);
  const [characterCount, arenaCount, dungeonCount, towerCount] = await Promise.all([
    runWarmupPhase('角色快照预热', warmupCharacterSnapshots),
    runWarmupPhase('竞技场投影预热', warmupArenaProjections),
    runWarmupPhase('秘境投影预热', warmupDungeonProjections),
    runWarmupPhase('千层塔投影预热', warmupTowerProjections),
  ]);
  projectionReady = true;
  return {
    characterCount,
    arenaCount,
    dungeonCount,
    towerCount,
  };
};

export const isOnlineBattleProjectionReady = (): boolean => projectionReady;

export const requireOnlineBattleProjectionReady = (): void => {
  if (!projectionReady) {
    throw new Error('在线战斗投影尚未预热完成');
  }
};

export const getOnlineBattleCharacterSnapshotByCharacterId = async (
  characterId: number,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedCharacterId = toInt(characterId);
  if (normalizedCharacterId <= 0) return null;
  const cached = characterSnapshotsByCharacterId.get(normalizedCharacterId);
  if (cached) return cached;
  return loadCharacterSnapshotFromRedis(normalizedCharacterId);
};

export const getOnlineBattleCharacterSnapshotByUserId = async (
  userId: number,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedUserId = toInt(userId);
  if (normalizedUserId <= 0) return null;
  const cachedCharacterId = userIdToCharacterId.get(normalizedUserId);
  if (cachedCharacterId) {
    return getOnlineBattleCharacterSnapshotByCharacterId(cachedCharacterId);
  }
  const rawCharacterId = await redis.get(buildUserCharacterKey(normalizedUserId));
  if (!rawCharacterId) return null;
  const characterId = toInt(rawCharacterId);
  if (characterId <= 0) return null;
  userIdToCharacterId.set(normalizedUserId, characterId);
  return getOnlineBattleCharacterSnapshotByCharacterId(characterId);
};

export const getOnlineBattleCharacterSnapshotsByCharacterIds = async (
  characterIds: number[],
): Promise<Map<number, OnlineBattleCharacterSnapshot>> => {
  requireOnlineBattleProjectionReady();
  const normalizedCharacterIds = normalizeProjectionEntityIds(characterIds);
  const result = new Map<number, OnlineBattleCharacterSnapshot>();
  const missingCharacterIds: number[] = [];

  for (const characterId of normalizedCharacterIds) {
    const cachedSnapshot = characterSnapshotsByCharacterId.get(characterId);
    if (cachedSnapshot) {
      result.set(characterId, cachedSnapshot);
      continue;
    }
    missingCharacterIds.push(characterId);
  }

  if (missingCharacterIds.length <= 0) {
    return result;
  }

  const loadedSnapshots = await loadCharacterSnapshotsByCharacterIdsFromRedis(
    missingCharacterIds,
  );
  for (const characterId of missingCharacterIds) {
    const snapshot = loadedSnapshots.get(characterId);
    if (!snapshot) continue;
    result.set(characterId, snapshot);
  }

  return result;
};

export const getOnlineBattleCharacterSnapshotsByUserIds = async (
  userIds: number[],
): Promise<Map<number, OnlineBattleCharacterSnapshot>> => {
  requireOnlineBattleProjectionReady();
  const normalizedUserIds = normalizeProjectionEntityIds(userIds);
  const result = new Map<number, OnlineBattleCharacterSnapshot>();
  const missingUserIds: number[] = [];
  const characterIdByUserId = new Map<number, number>();

  for (const userId of normalizedUserIds) {
    const cachedCharacterId = userIdToCharacterId.get(userId);
    if (cachedCharacterId && cachedCharacterId > 0) {
      characterIdByUserId.set(userId, cachedCharacterId);
      continue;
    }
    missingUserIds.push(userId);
  }

  if (missingUserIds.length > 0) {
    const loadedCharacterIds = await loadCharacterIdsByUserIdsFromRedis(missingUserIds);
    for (const userId of missingUserIds) {
      const characterId = loadedCharacterIds.get(userId);
      if (!characterId) continue;
      characterIdByUserId.set(userId, characterId);
    }
  }

  const snapshotsByCharacterId = await getOnlineBattleCharacterSnapshotsByCharacterIds(
    [...characterIdByUserId.values()],
  );
  for (const userId of normalizedUserIds) {
    const characterId = characterIdByUserId.get(userId);
    if (!characterId) continue;
    const snapshot = snapshotsByCharacterId.get(characterId);
    if (!snapshot) continue;
    result.set(userId, snapshot);
  }

  return result;
};

export const applyOnlineBattleCharacterResourceDelta = async (
  characterId: number,
  delta: { qixue?: number; lingqi?: number },
  options?: { minQixue?: number },
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const minQixue = clampNonNegative(toInt(options?.minQixue, 0));
  const nextQixue = Math.min(
    snapshot.computed.max_qixue,
    Math.max(minQixue, snapshot.computed.qixue + toInt(delta.qixue, 0)),
  );
  const nextLingqi = Math.min(
    snapshot.computed.max_lingqi,
    Math.max(0, snapshot.computed.lingqi + toInt(delta.lingqi, 0)),
  );
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      qixue: nextQixue,
      lingqi: nextLingqi,
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

export const setOnlineBattleCharacterResources = async (
  characterId: number,
  next: { qixue: number; lingqi: number },
  options?: { minQixue?: number },
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const minQixue = clampNonNegative(toInt(options?.minQixue, 0));
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      qixue: Math.min(snapshot.computed.max_qixue, Math.max(minQixue, toInt(next.qixue, snapshot.computed.qixue))),
      lingqi: Math.min(snapshot.computed.max_lingqi, Math.max(0, toInt(next.lingqi, snapshot.computed.lingqi))),
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

export const applyOnlineBattleCharacterStaminaDelta = async (
  characterId: number,
  delta: number,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      stamina: Math.min(
        snapshot.computed.stamina_max,
        Math.max(0, snapshot.computed.stamina + toInt(delta, 0)),
      ),
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

export const setOnlineBattleCharacterStamina = async (
  characterId: number,
  stamina: number,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      stamina: Math.min(snapshot.computed.stamina_max, Math.max(0, toInt(stamina, snapshot.computed.stamina))),
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

/**
 * 同步在线战斗角色的秘境免体力设置。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把角色设置页保存后的 `dungeon_no_stamina_cost` 同步到在线战斗权威快照，保证秘境开战读取到最新策略。
 * 2. 做什么：只更新秘境收益策略相关字段，不重建整份角色快照，避免业务入口再复制一遍快照拼装逻辑。
 * 3. 不做什么：不写数据库，也不推送客户端；调用方仍负责自己的落库与消息通知。
 *
 * 输入/输出：
 * - 输入：characterId、是否开启秘境免体力。
 * - 输出：更新后的在线战斗角色快照；若快照不存在则返回 `null`。
 *
 * 数据流/状态流：
 * - characterService.updateCharacterDungeonNoStaminaCostSetting 写 DB 成功后立即调用本函数；
 * - dungeon/shared/benefitPolicy 随后读取在线战斗快照中的最新 `dungeon_no_stamina_cost`；
 * - Redis 与内存快照保持同一份最新策略。
 *
 * 关键边界条件与坑点：
 * 1. 这里只同步运行时权威快照，不提供 fallback；快照不存在时由调用方决定是否忽略。
 * 2. 设置切换后必须立即覆盖旧值，不能等下次登录或预热，否则秘境入口会继续按旧策略校验。
 */
export const setOnlineBattleCharacterDungeonNoStaminaCost = async (
  characterId: number,
  enabled: boolean,
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      dungeon_no_stamina_cost: enabled,
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

/**
 * 同步在线战斗角色位置。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把角色移动后的 `current_map_id/current_room_id` 同步到在线战斗权威快照，保证普通 PVE 房间校验读取到最新位置。
 * 2. 做什么：只更新位置字段，避免业务写入方在页面移动场景里重建整份 `computed` 快照。
 * 3. 不做什么：不校验地图/房间是否存在，也不写 DB。
 *
 * 输入/输出：
 * - 输入：characterId、mapId、roomId。
 * - 输出：更新后的在线战斗角色快照；若快照不存在则返回 `null`。
 *
 * 数据流/状态流：
 * - characterService.updateCharacterPosition 成功写 DB 后立即调用本方法；
 * - 普通 PVE 开战随后通过 `getOnlineBattleCharacterSnapshotByUserId` 读取新位置；
 * - Redis 与内存快照保持同一份最新地址。
 *
 * 关键边界条件与坑点：
 * 1. 位置字段必须做 trim 后再写入，避免 `"room-1 "` 这类脏值导致房间匹配失败。
 * 2. 这里只负责权威快照同步，不做 fallback；快照缺失时由调用方决定是否继续流程。
 */
export const setOnlineBattleCharacterPosition = async (
  characterId: number,
  position: { currentMapId: string; currentRoomId: string },
): Promise<OnlineBattleCharacterSnapshot | null> => {
  const snapshot = await getOnlineBattleCharacterSnapshotByCharacterId(characterId);
  if (!snapshot) return null;
  const currentMapId = typeof position.currentMapId === 'string' ? position.currentMapId.trim() : '';
  const currentRoomId = typeof position.currentRoomId === 'string' ? position.currentRoomId.trim() : '';
  const nextSnapshot: OnlineBattleCharacterSnapshot = {
    ...snapshot,
    computed: {
      ...snapshot.computed,
      current_map_id: currentMapId,
      current_room_id: currentRoomId,
    },
  };
  await persistCharacterSnapshot(nextSnapshot);
  return nextSnapshot;
};

export const getTeamProjectionByUserId = async (
  userId: number,
): Promise<TeamMemberProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedUserId = toInt(userId);
  if (normalizedUserId <= 0) return null;
  const cached = teamProjectionByUserId.get(normalizedUserId);
  if (cached) return cached;
  return loadTeamProjectionFromRedis(normalizedUserId);
};

/**
 * 同步在线战斗队伍投影与角色队伍快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把队伍成员关系变更统一收口到一个入口，同时刷新 `teamProjectionByUserId` 与 `OnlineBattleCharacterSnapshot.teamId/isTeamLeader`。
 * 2. 做什么：显式为退队/踢出/解散成员写入“空队伍投影”，避免旧队伍残留在 Redis/内存里。
 * 3. 不做什么：不查询 DB，也不负责判断谁应该同步；调用方必须先给出最新成员关系。
 *
 * 输入/输出：
 * - 输入：一组已经根据最新队伍成员关系整理好的同步记录。
 * - 输出：无；副作用是覆盖对应用户的队伍投影，并对齐角色快照里的队伍字段。
 *
 * 数据流/状态流：
 * - teamService 在成员增删/转让后先查最新队伍成员 -> 组装 TeamProjectionSyncRecord[] -> 调用本函数。
 * - 本函数先归一化每条记录，再同步更新 Redis 队伍投影与角色快照。
 * - 后续在线战斗、组队准备、前端推送都读取同一份最新队伍状态。
 *
 * 关键边界条件与坑点：
 * 1. 退队/解散不能只删 key；必须显式写入 `teamId=null` 的空投影，否则内存和 Redis 可能继续读到旧队伍。
 * 2. `memberCharacterIds` 必须和当前队伍真实成员完全一致；这里只做字段归一化，不会替调用方纠正业务集合。
 */
export const syncOnlineBattleTeamProjectionRecords = async (
  records: TeamProjectionSyncRecord[],
): Promise<void> => {
  requireOnlineBattleProjectionReady();
  const normalizedRecordByUserId = new Map<number, TeamProjectionSyncRecord>();
  for (const record of records) {
    const normalizedRecord = normalizeTeamProjectionSyncRecord(record);
    if (normalizedRecord.userId <= 0 || normalizedRecord.characterId <= 0) {
      continue;
    }
    normalizedRecordByUserId.set(normalizedRecord.userId, normalizedRecord);
  }

  await Promise.all(
    [...normalizedRecordByUserId.values()].map(async (record) => {
      await persistTeamProjection(record.userId, {
        teamId: record.teamId,
        role: record.role,
        memberCharacterIds: record.memberCharacterIds,
      });
      await persistCharacterTeamSnapshot(record);
    }),
  );
};

export const upsertOnlineBattleSessionProjection = (session: BattleSessionRecord | OnlineBattleSessionSnapshot): void => {
  const snapshot: OnlineBattleSessionSnapshot = {
    sessionId: session.sessionId,
    type: session.type,
    ownerUserId: session.ownerUserId,
    participantUserIds: session.participantUserIds.slice(),
    currentBattleId: session.currentBattleId,
    status: session.status,
    nextAction: session.nextAction,
    canAdvance: session.canAdvance,
    lastResult: session.lastResult,
    context: session.context,
    createdAt: 'createdAt' in session ? session.createdAt : Date.now(),
    updatedAt: 'updatedAt' in session ? session.updatedAt : Date.now(),
  };
  void persistSessionProjection(snapshot);
};

export const deleteOnlineBattleSessionProjection = (sessionId: string): void => {
  const current = sessionProjectionBySessionId.get(sessionId) ?? null;
  sessionProjectionBySessionId.delete(sessionId);
  if (current?.currentBattleId) {
    sessionIdByBattleId.delete(current.currentBattleId);
  }
  void (async () => {
    const keys = [buildSessionKey(sessionId)];
    if (current?.currentBattleId) {
      keys.push(buildSessionBattleKey(current.currentBattleId));
    }
    await deleteKeys(keys);
    await redis.srem(SESSION_INDEX_KEY, sessionId);
  })();
};

export const getOnlineBattleSessionProjection = async (
  sessionId: string,
): Promise<OnlineBattleSessionSnapshot | null> => {
  requireOnlineBattleProjectionReady();
  const cached = sessionProjectionBySessionId.get(sessionId);
  if (cached) return cached;
  return loadSessionProjectionFromRedis(sessionId);
};

export const getOnlineBattleSessionProjectionByBattleId = async (
  battleId: string,
): Promise<OnlineBattleSessionSnapshot | null> => {
  requireOnlineBattleProjectionReady();
  const cachedSessionId = sessionIdByBattleId.get(battleId);
  if (cachedSessionId) {
    return getOnlineBattleSessionProjection(cachedSessionId);
  }
  const redisSessionId = await redis.get(buildSessionBattleKey(battleId));
  if (!redisSessionId) return null;
  return getOnlineBattleSessionProjection(redisSessionId);
};

export const getArenaProjection = async (
  characterId: number,
): Promise<ArenaProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedCharacterId = toInt(characterId);
  if (normalizedCharacterId <= 0) return null;
  const cached = arenaProjectionByCharacterId.get(normalizedCharacterId);
  if (cached) return cached;
  return loadArenaProjectionFromRedis(normalizedCharacterId);
};

export const listArenaProjections = (): ArenaProjectionRecord[] => {
  requireOnlineBattleProjectionReady();
  return [...arenaProjectionByCharacterId.values()];
};

export const upsertArenaProjection = async (
  projection: ArenaProjectionRecord,
): Promise<ArenaProjectionRecord> => {
  await persistArenaProjection(projection);
  return projection;
};

export const applyArenaBattleResultProjection = async (params: {
  battleId: string;
  challengerCharacterId: number;
  opponentCharacterId: number;
  challengerOutcome: 'win' | 'lose' | 'draw';
  challengerScoreDelta: number;
  challengerScoreAfter: number;
  opponentName: string;
  opponentRealm: string;
  opponentPower: number;
}): Promise<ArenaProjectionRecord | null> => {
  const projection = await getArenaProjection(params.challengerCharacterId);
  if (!projection) return null;

  const nextWinCount = projection.winCount + (params.challengerOutcome === 'win' ? 1 : 0);
  const nextLoseCount = projection.loseCount + (params.challengerOutcome === 'lose' ? 1 : 0);
  const nextTodayUsed = projection.todayUsed + 1;
  const nextRecords = [
    {
      id: params.battleId,
      ts: Date.now(),
      opponentName: params.opponentName,
      opponentRealm: params.opponentRealm,
      opponentPower: params.opponentPower,
      result: params.challengerOutcome,
      deltaScore: params.challengerScoreDelta,
      scoreAfter: params.challengerScoreAfter,
    },
    ...projection.records,
  ].slice(0, RECENT_ARENA_RECORD_LIMIT);

  const nextProjection: ArenaProjectionRecord = {
    ...projection,
    score: params.challengerScoreAfter,
    winCount: nextWinCount,
    loseCount: nextLoseCount,
    todayUsed: nextTodayUsed,
    todayRemaining: Math.max(0, projection.todayLimit - nextTodayUsed),
    records: nextRecords,
  };

  await persistArenaProjection(nextProjection);
  return nextProjection;
};

export const canArenaChallengeTodayProjection = async (
  characterId: number,
): Promise<{ allowed: boolean; remaining: number }> => {
  const projection = await getArenaProjection(characterId);
  if (!projection) {
    return { allowed: false, remaining: 0 };
  }
  return {
    allowed: projection.todayRemaining > 0,
    remaining: projection.todayRemaining,
  };
};

export const getDungeonProjection = async (
  instanceId: string,
): Promise<DungeonProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const cached = dungeonProjectionByInstanceId.get(instanceId);
  if (cached) return cached;
  return loadDungeonProjectionFromRedis(instanceId);
};

export const getDungeonProjectionByBattleId = async (
  battleId: string,
): Promise<DungeonProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const cachedInstanceId = dungeonInstanceIdByBattleId.get(battleId);
  if (cachedInstanceId) {
    return getDungeonProjection(cachedInstanceId);
  }
  const redisInstanceId = await redis.get(buildDungeonBattleKey(battleId));
  if (!redisInstanceId) return null;
  return getDungeonProjection(redisInstanceId);
};

export const upsertDungeonProjection = async (
  projection: DungeonProjectionRecord,
): Promise<DungeonProjectionRecord> => {
  await persistDungeonProjection(projection);
  return projection;
};

export const deleteDungeonProjectionsBatch = async (
  entries: Array<{ instanceId: string; currentBattleId: string | null }>,
): Promise<void> => {
  if (entries.length <= 0) {
    return;
  }

  const multi = redis.multi();
  const instanceIds: string[] = [];
  for (const entry of entries) {
    const instanceId = entry.instanceId.trim();
    if (!instanceId) continue;
    instanceIds.push(instanceId);
    dungeonProjectionByInstanceId.delete(instanceId);
    multi.del(buildDungeonKey(instanceId));

    const currentBattleId = typeof entry.currentBattleId === 'string' && entry.currentBattleId.trim().length > 0
      ? entry.currentBattleId.trim()
      : null;
    if (!currentBattleId) continue;
    dungeonInstanceIdByBattleId.delete(currentBattleId);
    multi.del(buildDungeonBattleKey(currentBattleId));
  }

  if (instanceIds.length <= 0) {
    return;
  }

  multi.srem(DUNGEON_INDEX_KEY, ...instanceIds);
  await multi.exec();
};

export const getDungeonEntryProjection = async (
  characterId: number,
  dungeonId: string,
): Promise<DungeonEntryCountProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedCharacterId = toInt(characterId);
  const normalizedDungeonId = typeof dungeonId === 'string' ? dungeonId.trim() : '';
  if (normalizedCharacterId <= 0 || normalizedDungeonId.length <= 0) return null;
  const projectionKey = buildDungeonEntryProjectionKey(normalizedCharacterId, normalizedDungeonId);
  const cached = dungeonEntryProjectionByKey.get(projectionKey);
  if (cached) return normalizeDungeonEntryProjection(cached);
  return loadDungeonEntryProjectionFromRedis(normalizedCharacterId, normalizedDungeonId);
};

export const upsertDungeonEntryProjection = async (
  projection: DungeonEntryCountProjectionRecord,
): Promise<DungeonEntryCountProjectionRecord> => {
  const normalized = normalizeDungeonEntryProjection(projection);
  await persistDungeonEntryProjection(normalized);
  return normalized;
};

export const ensureDungeonEntryProjection = async (
  characterId: number,
  dungeonId: string,
): Promise<DungeonEntryCountProjectionRecord> => {
  const existing = await getDungeonEntryProjection(characterId, dungeonId);
  if (existing) return existing;
  const created: DungeonEntryCountProjectionRecord = {
    characterId: toInt(characterId),
    dungeonId,
    dailyCount: 0,
    weeklyCount: 0,
    totalCount: 0,
    lastDailyReset: getCurrentDateText(),
    lastWeeklyReset: getCurrentWeekStartText(),
  };
  await persistDungeonEntryProjection(created);
  return created;
};

export const applyDungeonEntryProjectionIncrement = async (
  characterId: number,
  dungeonId: string,
): Promise<DungeonEntryCountProjectionRecord> => {
  const current = await ensureDungeonEntryProjection(characterId, dungeonId);
  const normalized = normalizeDungeonEntryProjection(current);
  const next: DungeonEntryCountProjectionRecord = {
    ...normalized,
    dailyCount: normalized.dailyCount + 1,
    weeklyCount: normalized.weeklyCount + 1,
    totalCount: normalized.totalCount + 1,
  };
  await persistDungeonEntryProjection(next);
  return next;
};

export const getTowerProjection = async (
  characterId: number,
): Promise<TowerProjectionRecord | null> => {
  requireOnlineBattleProjectionReady();
  const normalizedCharacterId = toInt(characterId);
  if (normalizedCharacterId <= 0) return null;
  const cached = towerProjectionByCharacterId.get(normalizedCharacterId);
  if (cached) return cached;
  return loadTowerProjectionFromRedis(normalizedCharacterId);
};

export const listTowerProjectionRecords = (): TowerProjectionRecord[] => {
  requireOnlineBattleProjectionReady();
  return [...towerProjectionByCharacterId.values()];
};

export const upsertTowerProjection = async (
  projection: TowerProjectionRecord,
): Promise<TowerProjectionRecord> => {
  await persistTowerProjection(projection);
  return projection;
};

export const ensureTowerProjection = async (
  characterId: number,
): Promise<TowerProjectionRecord> => {
  const existing = await getTowerProjection(characterId);
  if (existing) return existing;
  const created: TowerProjectionRecord = {
    characterId: toInt(characterId),
    bestFloor: 0,
    nextFloor: 1,
    currentRunId: null,
    currentFloor: null,
    currentBattleId: null,
    lastSettledFloor: 0,
    updatedAt: new Date().toISOString(),
    reachedAt: null,
  };
  await persistTowerProjection(created);
  return created;
};

export const listTowerRankProjection = async (): Promise<TowerRankRow[]> => {
  requireOnlineBattleProjectionReady();
  const projections = [...towerProjectionByCharacterId.values()]
    .sort((left, right) => {
      if (right.bestFloor !== left.bestFloor) return right.bestFloor - left.bestFloor;
      return String(left.reachedAt ?? '').localeCompare(String(right.reachedAt ?? ''));
    });

  const snapshots = await getOnlineBattleCharacterSnapshotsByCharacterIds(
    projections.map((projection) => projection.characterId),
  );
  return projections.map((projection, index) => {
    const snapshot = snapshots.get(projection.characterId);
    return {
      rank: index + 1,
      characterId: projection.characterId,
      name: snapshot?.computed.nickname ?? `修士${projection.characterId}`,
      realm: snapshot?.computed.realm ?? '凡人',
      bestFloor: projection.bestFloor,
      reachedAt: projection.reachedAt,
    };
  });
};

export const getTowerRuntimeProjection = async (
  battleId: string,
): Promise<TowerBattleRuntimeRecord | null> => {
  requireOnlineBattleProjectionReady();
  const cached = towerRuntimeProjectionByBattleId.get(battleId);
  if (cached) return cached;
  return loadTowerRuntimeProjectionFromRedis(battleId);
};

export const upsertTowerRuntimeProjection = async (
  projection: TowerBattleRuntimeRecord,
): Promise<TowerBattleRuntimeRecord> => {
  await persistTowerRuntimeProjection(projection);
  return projection;
};

export const deleteTowerRuntimeProjection = async (battleId: string): Promise<void> => {
  towerRuntimeProjectionByBattleId.delete(battleId);
  await Promise.all([
    redis.srem(TOWER_RUNTIME_INDEX_KEY, battleId),
    redis.del(buildTowerRuntimeKey(battleId)),
  ]);
};

export const upsertOnlineBattleProjectionRecord = async (
  projection: OnlineBattleProjectionRecord,
): Promise<OnlineBattleProjectionRecord> => {
  const key = `online-battle:battle:${projection.battleId}`;
  await persistJson(key, projection);
  return projection;
};

export const enqueueDeferredSettlementTask = async (
  task: DeferredSettlementTask,
): Promise<DeferredSettlementTask> => {
  await persistDeferredSettlementTask(task);
  return task;
};

export const createDeferredSettlementTask = async (
  payload: DeferredSettlementTaskPayload,
  options?: { taskId?: string },
): Promise<DeferredSettlementTask> => {
  const task: DeferredSettlementTask = {
    taskId: options?.taskId ?? payload.battleId,
    battleId: payload.battleId,
    status: 'pending',
    attempts: 0,
    maxAttempts: MAX_DEFERRED_SETTLEMENT_ATTEMPTS,
    payload,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorMessage: null,
  };
  return enqueueDeferredSettlementTask(task);
};

export const getDeferredSettlementTask = async (
  taskId: string,
): Promise<DeferredSettlementTask | null> => {
  requireOnlineBattleProjectionReady();
  const cached = deferredSettlementTaskById.get(taskId);
  if (cached) return cached;
  return loadDeferredSettlementTaskFromRedis(taskId);
};

export const listDeferredSettlementTasks = (): DeferredSettlementTask[] => {
  requireOnlineBattleProjectionReady();
  return [...deferredSettlementTaskById.values()];
};

export const listPendingDeferredSettlementTasks = (): DeferredSettlementTask[] => {
  requireOnlineBattleProjectionReady();
  return [...deferredSettlementTaskById.values()]
    .filter((task) => task.status === 'pending' || task.status === 'failed')
    .sort((left, right) => left.updatedAt - right.updatedAt);
};

export const updateDeferredSettlementTaskStatus = async (params: {
  taskId: string;
  status: DeferredSettlementTaskStatus;
  errorMessage?: string | null;
  incrementAttempt?: boolean;
}): Promise<DeferredSettlementTask | null> => {
  const current = await getDeferredSettlementTask(params.taskId);
  if (!current) return null;
  const next: DeferredSettlementTask = {
    ...current,
    status: params.status,
    attempts: params.incrementAttempt ? current.attempts + 1 : current.attempts,
    updatedAt: Date.now(),
    errorMessage: params.errorMessage ?? null,
  };
  await persistDeferredSettlementTask(next);
  return next;
};

export const deleteDeferredSettlementTask = async (taskId: string): Promise<void> => {
  deferredSettlementTaskById.delete(taskId);
  await Promise.all([
    redis.srem(DEFERRED_SETTLEMENT_INDEX_KEY, taskId),
    redis.del(buildDeferredSettlementKey(taskId)),
  ]);
};

export const loadDeferredSettlementTasksFromRedis = async (): Promise<DeferredSettlementTask[]> => {
  requireOnlineBattleProjectionReady();
  const taskIds = await redis.smembers(DEFERRED_SETTLEMENT_INDEX_KEY);
  const tasks: DeferredSettlementTask[] = [];
  for (const taskId of taskIds) {
    const task = await getDeferredSettlementTask(taskId);
    if (!task) continue;
    tasks.push(task);
  }
  return tasks;
};

export const buildBattleRewardsPreviewFromDistributeResult = (
  result: DistributeResult,
): BattleSettlementRewardsPreview => {
  return {
    exp: clampNonNegative(result.rewards.exp),
    silver: clampNonNegative(result.rewards.silver),
    totalExp: clampNonNegative(result.rewards.exp),
    totalSilver: clampNonNegative(result.rewards.silver),
    participantCount: Math.max(1, result.perPlayerRewards?.length ?? 1),
    items: (result.rewards.items ?? []).map((item) => ({
      itemDefId: item.itemDefId,
      name: item.itemName,
      quantity: clampNonNegative(item.quantity),
      receiverId: clampNonNegative(item.receiverId),
    })),
    perPlayerRewards: (result.perPlayerRewards ?? []).map((reward) => ({
      characterId: reward.characterId,
      userId: reward.userId,
      exp: clampNonNegative(reward.exp),
      silver: clampNonNegative(reward.silver),
      items: reward.items.map((item) => ({
        itemDefId: item.itemDefId,
        itemName: item.itemName,
        quantity: clampNonNegative(item.quantity),
        instanceIds: [],
      })),
    })),
  };
};

export const buildImmediateBattleResultWithProjectionPreview = (
  battleResult: BattleResult,
  rewardsPreview: BattleSettlementRewardsPreview | null,
): BattleResult => {
  if (!battleResult.data) return battleResult;
  return {
    ...battleResult,
    data: {
      ...battleResult.data,
      ...(rewardsPreview ? { rewards: rewardsPreview } : {}),
    },
  };
};
