/**
 * BattleSession 统一战斗会话服务。
 *
 * 作用：
 * - 为普通战斗、秘境战斗、PVP 战斗提供统一的 start/advance/query 生命周期；
 * - 把“当前 battle 结束后下一步做什么”集中在服务端单一入口。
 *
 * 不做什么：
 * - 不替代单场 battle engine；
 * - 不直接处理单个技能释放。
 *
 * 输入/输出：
 * - 输入：用户 ID、战斗类型、模式上下文。
 * - 输出：统一的 session 快照，以及当前 battle state（若存在）。
 *
 * 数据流：
 * start -> underlying battle service -> runtime session
 * advance -> resolve by session type -> runtime session update
 * query -> session snapshot + optional battle state
 *
 * 边界条件：
 * 1) session 访问权限只认 owner/participant，避免任意 battleId 反查越权。
 * 2) session 的 currentBattleId 变化必须通过 runtime 更新，禁止调用方私下维护 battleId。
 */

import crypto from 'crypto';
import { runWithDatabaseAccessAllowed } from '../../config/database.js';
import { getBattleLogCursor } from '../../battle/logStream.js';
import { getGameServer } from '../../game/gameServer.js';
import { battleParticipants } from '../battle/runtime/state.js';
import { getBattleState } from '../battle/queries.js';
import { startPVEBattle, startPVEBattleForSessionFlow } from '../battle/pve.js';
import { startPVPBattle } from '../battle/pvp.js';
import {
  nextDungeonInstance,
  startDungeonInstance,
} from '../dungeon/combat.js';
import type { DungeonInstanceStatus } from '../dungeon/types.js';
import {
  advanceTowerRun,
  endTowerRunBySession,
} from '../tower/service.js';
import type { BattleState } from '../../battle/types.js';
import type { BattleResult } from '../battle/battleTypes.js';
import {
  buildBattleAbandonedRealtimePayload,
  buildBattleRealtimePayload,
} from '../battle/runtime/realtime.js';
import {
  createBattleSessionRecord,
  deleteBattleSessionRecord,
  getBattleSessionRecord,
  getBattleSessionSnapshotByBattleId,
  hydrateBattleSessionRecord,
  listBattleSessionRecords,
  updateBattleSessionRecord,
  toBattleSessionSnapshot,
} from './runtime.js';
import type {
  BattleSessionContext,
  BattleSessionNextAction,
  BattleSessionRecord,
  BattleSessionResult,
  BattleSessionSnapshot,
  BattleSessionStatus,
  BattleSessionType,
  PveBattleSessionContext,
} from './types.js';
import {
  deletePveResumeIntentByUserId,
  getPveResumeIntentByUserId,
  upsertPveResumeIntent,
} from './pveResumeIntent.js';
import { createScopedLogger } from '../../utils/logger.js';
import {
  createSlowOperationLogger,
  type SlowLogFields,
} from '../../utils/slowOperationLogger.js';
import {
  getOnlineBattleSessionProjection,
  getOnlineBattleSessionProjectionByBattleId,
  listOnlineBattleSessionProjections,
  type OnlineBattleSessionSnapshot,
} from '../onlineBattleProjectionService.js';

const battleSessionLogger = createScopedLogger('battle.session');

type BattleSessionResponse =
  | {
    success: true;
    data: {
      session: BattleSessionSnapshot;
      state?: unknown;
      finished?: boolean;
    };
  }
  | {
    success: false;
    message: string;
  };

type AdvanceBattleSessionEndNotificationScope = 'peers_only' | 'all_participants';

type DungeonCombatSuccessData = {
  instanceId: string;
  status: DungeonInstanceStatus;
  battleId?: string;
  state?: unknown;
  finished?: boolean;
};

const DUNGEON_SESSION_SERVER_AUTO_ADVANCE_DELAY_MS = 200;
const dungeonSessionAutoAdvanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const normalizeParticipantUserIds = (
  participantUserIds: number[],
  ownerUserId: number,
): number[] => {
  const ids = new Set<number>();
  for (const raw of participantUserIds) {
    const userId = Math.floor(Number(raw));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    ids.add(userId);
  }
  ids.add(ownerUserId);
  return [...ids];
};

const clearDungeonSessionAutoAdvanceTimer = (sessionId: string): void => {
  const timer = dungeonSessionAutoAdvanceTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  dungeonSessionAutoAdvanceTimers.delete(sessionId);
};

const getParticipantUserIdsForBattle = (
  battleId: string,
  ownerUserId: number,
): number[] => {
  return normalizeParticipantUserIds(battleParticipants.get(battleId) || [], ownerUserId);
};

const normalizePveMonsterIds = (monsterIds: string[]): string[] => {
  const values = new Set<string>();
  for (const monsterId of monsterIds) {
    const normalized = String(monsterId ?? '').trim();
    if (!normalized) continue;
    values.add(normalized);
    if (values.size >= 5) break;
  }
  return [...values];
};

const getPveBattleSessionContext = (
  session: BattleSessionRecord | BattleSessionSnapshot,
): PveBattleSessionContext | null => {
  if (session.type !== 'pve') return null;
  const context = session.context;
  if (!('monsterIds' in context)) return null;
  const monsterIds = normalizePveMonsterIds(context.monsterIds);
  if (monsterIds.length <= 0) return null;
  return { monsterIds };
};

const syncPveResumeIntentForSession = async (
  session: BattleSessionRecord | BattleSessionSnapshot,
): Promise<void> => {
  const context = getPveBattleSessionContext(session);
  if (!context || !session.currentBattleId) return;
  await upsertPveResumeIntent({
    ownerUserId: session.ownerUserId,
    sessionId: session.sessionId,
    monsterIds: context.monsterIds,
    participantUserIds: normalizeParticipantUserIds(
      session.participantUserIds,
      session.ownerUserId,
    ),
    battleId: session.currentBattleId,
    updatedAt: Date.now(),
  });
};

/**
 * 异步调度普通 PVE 续战意图写入。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“用于重启后懒恢复的续战意图”移出 start/advance 的同步响应链，减少 Redis I/O 对首包时延的影响。
 * 2. 做什么：统一收口 fire-and-forget 包装，避免 start/advance/状态迁移处各自散落 `void` 调用。
 * 3. 不做什么：不改变 battle/session 的权威状态；即使这一步异步失败，也不影响当前会话已经成功推进。
 *
 * 输入/输出：
 * - 输入：PVE session 记录或快照。
 * - 输出：无同步返回；后台异步写入 Redis。
 *
 * 数据流/状态流：
 * start/advance/状态迁移 -> 本函数排队微任务 -> syncPveResumeIntentForSession -> Redis 续战意图。
 *
 * 关键边界条件与坑点：
 * 1. 这里只能用于非关键路径补偿数据；battle/session 权威状态仍必须先在内存投影完成更新。
 * 2. 异步失败只记日志，不能回退当前已成功的会话推进结果。
 */
const schedulePveResumeIntentSyncForSession = (
  session: BattleSessionRecord | BattleSessionSnapshot,
): void => {
  void Promise.resolve().then(async () => {
    try {
      await syncPveResumeIntentForSession(session);
    } catch (error) {
      battleSessionLogger.warn({
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, '异步写入 PVE 续战意图失败');
    }
  });
};

const deletePveResumeIntentForSession = async (
  session: BattleSessionRecord | BattleSessionSnapshot,
): Promise<void> => {
  if (session.type !== 'pve') return;
  await deletePveResumeIntentByUserId(session.ownerUserId);
};

const schedulePveResumeIntentDeletionForSession = (
  session: BattleSessionRecord | BattleSessionSnapshot,
): void => {
  void Promise.resolve().then(async () => {
    try {
      await deletePveResumeIntentForSession(session);
    } catch (error) {
      battleSessionLogger.warn({
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, '异步删除 PVE 续战意图失败');
    }
  });
};

const createRunningSession = (params: {
  type: BattleSessionType;
  ownerUserId: number;
  participantUserIds: number[];
  currentBattleId: string;
  context: BattleSessionContext;
}): BattleSessionRecord => {
  return createBattleSessionRecord({
    sessionId: crypto.randomUUID(),
    type: params.type,
    ownerUserId: params.ownerUserId,
    participantUserIds: normalizeParticipantUserIds(
      params.participantUserIds,
      params.ownerUserId,
    ),
    currentBattleId: params.currentBattleId,
    status: 'running',
    nextAction: 'none',
    canAdvance: false,
    lastResult: null,
    context: params.context,
  });
};

const isBattleSessionRuntimeActive = (
  session: BattleSessionRecord | BattleSessionSnapshot | OnlineBattleSessionSnapshot,
): boolean => {
  return session.status === 'running' || session.status === 'waiting_transition';
};

const shouldScheduleDungeonAutoAdvance = (
  session: BattleSessionRecord | BattleSessionSnapshot | OnlineBattleSessionSnapshot,
): boolean => {
  return (
    session.type === 'dungeon'
    && session.status === 'waiting_transition'
    && session.nextAction === 'advance'
    && session.canAdvance
  );
};

/**
 * 在线战斗 session 投影回填为 BattleSession runtime 记录。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 Redis/投影里的权威 session 快照恢复成 BattleSession runtime 记录，统一服务启动恢复与查询期懒回填。
 * 2. 做什么：在秘境 `waiting_transition` 且仍可继续时重建自动推进定时器，避免服务重启后卡死在中间态。
 * 3. 不做什么：不改写投影来源，不做权限判断，也不直接返回 battle state。
 *
 * 输入/输出：
 * - 输入：一条在线战斗 session 投影。
 * - 输出：已回填到 runtime 的 BattleSession 记录；若投影已失活则返回 null。
 *
 * 数据流/状态流：
 * - startup/query miss -> 读取在线战斗投影 -> 本函数回填 runtime -> 后续 BattleSession API 正常读取。
 *
 * 复用设计说明：
 * - 服务启动恢复、按 sessionId 查询、按 battleId 查询、当前会话查询都需要相同的“projection -> runtime”转换。
 * - 把回填和秘境自动推进重建集中在这里，能避免四条调用链各自散落 if 判断。
 * - `waiting_transition` 的推进策略是秘境高频变化点，因此定时器重建必须跟 session 回填放在同一入口。
 *
 * 关键边界条件与坑点：
 * 1. 已完成/失败/放弃的 session 不能重新挂回 runtime，否则会把终态残留重新暴露给前端。
 * 2. 只有秘境 `waiting_transition + advance` 需要重建自动推进；其他类型或 `return_to_map` 绝不能误挂定时器。
 */
const restoreBattleSessionRecordFromProjection = (
  projection: OnlineBattleSessionSnapshot,
): BattleSessionRecord | null => {
  if (!isBattleSessionRuntimeActive(projection)) {
    return null;
  }

  const existing = getBattleSessionRecord(projection.sessionId);
  if (existing) {
    if (shouldScheduleDungeonAutoAdvance(existing)) {
      scheduleDungeonSessionAutoAdvance(existing.sessionId);
    }
    return existing;
  }

  const restored = hydrateBattleSessionRecord({
    sessionId: projection.sessionId,
    type: projection.type,
    ownerUserId: projection.ownerUserId,
    participantUserIds: normalizeParticipantUserIds(
      projection.participantUserIds,
      projection.ownerUserId,
    ),
    currentBattleId: projection.currentBattleId,
    status: projection.status,
    nextAction: projection.nextAction,
    canAdvance: projection.canAdvance,
    lastResult: projection.lastResult,
    context: projection.context,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
  });

  if (shouldScheduleDungeonAutoAdvance(restored)) {
    scheduleDungeonSessionAutoAdvance(restored.sessionId);
  }
  return restored;
};

const ensureBattleSessionRecordBySessionId = async (
  sessionId: string,
): Promise<BattleSessionRecord | null> => {
  const runtimeSession = getBattleSessionRecord(sessionId);
  if (runtimeSession) {
    return runtimeSession;
  }
  const projection = await getOnlineBattleSessionProjection(sessionId);
  if (!projection) {
    return null;
  }
  return restoreBattleSessionRecordFromProjection(projection);
};

const ensureBattleSessionRecordByBattleId = async (
  battleId: string,
): Promise<BattleSessionRecord | null> => {
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (snapshot) {
    return ensureBattleSessionRecordBySessionId(snapshot.sessionId);
  }
  const projection = await getOnlineBattleSessionProjectionByBattleId(battleId);
  if (!projection) {
    return null;
  }
  return restoreBattleSessionRecordFromProjection(projection);
};

const listRestoredActiveSessionsForUser = async (
  userId: number,
): Promise<BattleSessionRecord[]> => {
  const projections = await listOnlineBattleSessionProjections();
  const sessions: BattleSessionRecord[] = [];

  for (const projection of projections) {
    const restored = restoreBattleSessionRecordFromProjection(projection);
    if (!restored) continue;
    if (!ensureSessionAccess(userId, restored)) continue;
    if (!isBattleSessionRuntimeActive(restored)) continue;
    sessions.push(restored);
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
};

/**
 * 普通 PVE 开战与 BattleSession 绑定共享入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“startPVEBattle 注册成功后，立刻把 battleId 绑定到 BattleSession”的时序收口到单一入口，避免首次开战、续战恢复、继续下一场各自重复维护并再次出现竞态。
 * 2. 做什么：确保绑定发生在 `startPVEBattle` 返回前，同步覆盖“首帧即终态 / 下一场秒结算”场景，保证后续 `battle_finished` 能拿到正确 session。
 * 3. 不做什么：不决定 session 是新建还是更新；具体创建/换绑策略由调用方传入的 `bindSession` 决定。
 *
 * 输入/输出：
 * - 输入：userId、monsterIds，以及一个“收到 battleId 后如何绑定 session”的同步回调。
 * - 输出：成功时返回底层 battle 返回值与已绑定好的 session 记录；失败时返回精确错误。
 *
 * 数据流/状态流：
 * - 调用方发起普通 PVE -> startPVEBattle 同步注册战斗 -> onBattleRegistered 立即 bindSession
 * - battle 启动回调/首帧结算随后发生时，session 已经指向最新 currentBattleId。
 *
 * 关键边界条件与坑点：
 * 1. `bindSession` 必须同步执行；若改成异步，仍会重新暴露“battle 已结束但 session 还没绑上”的老问题。
 * 2. 这里不使用兜底 fallback；成功开战但未绑定到 session 视为真正异常，直接返回失败，避免把损坏状态继续往后传。
 */
const startPveBattleAndBindSession = async (params: {
  userId: number;
  monsterIds: string[];
  startBattle?: typeof startPVEBattle;
  bindSession: (payload: {
    battleId: string;
    participantUserIds: number[];
  }) => BattleSessionRecord | null;
}): Promise<
  | {
    success: true;
    battleId: string;
    state: unknown;
    session: BattleSessionRecord;
  }
  | {
    success: false;
    message: string;
  }
> => {
  let boundSession: BattleSessionRecord | null = null;
  const battleRes = await (params.startBattle ?? startPVEBattle)(params.userId, params.monsterIds, {
    onBattleRegistered: (payload) => {
      boundSession = params.bindSession(payload);
    },
  });
  if (!battleRes.success || !battleRes.data?.battleId) {
    return { success: false, message: battleRes.message || '开启战斗失败' };
  }
  const state = battleRes.data.state;
  if (state === undefined) {
    return { success: false, message: '战斗缺少初始状态' };
  }
  if (!boundSession) {
    return { success: false, message: '战斗会话绑定失败' };
  }
  return {
    success: true,
    battleId: String(battleRes.data.battleId),
    state,
    session: boundSession,
  };
};

/**
 * 秘境开战与 BattleSession 绑定共享入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理“秘境 battle 注册成功后立刻绑定/换绑 BattleSession，并在后续流程失败时按调用方策略回滚”的时序，避免开始秘境与推进下一波各写一套竞态修复。
 * 2. 做什么：保证秘境新 battle 的 `currentBattleId` 在 `startDungeonInstance/nextDungeonInstance` 返回前就已可见，从而让首回合秒杀仍能拿到正确 session。
 * 3. 不做什么：不决定秘境投影如何提交，也不替调用方完成最终 completed/failed 收尾。
 *
 * 输入/输出：
 * - 输入：秘境开战函数、同步绑定回调，以及可选回滚回调。
 * - 输出：成功时返回原始秘境响应与已绑定 session；失败时返回精确错误。
 *
 * 数据流/状态流：
 * - dungeon start/next -> onBattleRegistered 立刻 bindSession -> 若后续流程失败则 rollbackSession -> 成功则把 response + session 交回调用方。
 *
 * 关键边界条件与坑点：
 * 1. 只有响应里真的带了 `battleId` 时才要求 `session` 已绑定；秘境最终结算 `finished=true` 不会生成新 battle，因此允许返回空 session。
 * 2. 回滚必须由调用方显式提供，保持“创建新 session”和“恢复旧 waiting_transition session”两种场景职责分离，不在这里写隐式兜底。
 */
const startDungeonBattleAndBindSession = async (params: {
  startBattle: (options?: {
    onBattleRegistered?: (payload: {
      battleId: string;
      participantUserIds: number[];
    }) => void;
  }) => Promise<
    | { success: true; data: DungeonCombatSuccessData }
    | { success: false; message: string }
  >;
  bindSession: (payload: {
    battleId: string;
    participantUserIds: number[];
  }) => BattleSessionRecord | null;
  rollbackSession?: () => void;
}): Promise<
  | {
    success: true;
    response: { success: true; data: DungeonCombatSuccessData };
    session: BattleSessionRecord | null;
  }
  | {
    success: false;
    message: string;
  }
> => {
  let boundSession: BattleSessionRecord | null = null;
  let didBindSession = false;
  const response = await params.startBattle({
    onBattleRegistered: (payload) => {
      didBindSession = true;
      boundSession = params.bindSession(payload);
    },
  });
  if (!response.success) {
    if (didBindSession) {
      params.rollbackSession?.();
    }
    return { success: false, message: response.message || '推进秘境失败' };
  }

  const nextBattleId = typeof response.data.battleId === 'string'
    ? response.data.battleId
    : '';
  if (nextBattleId && !boundSession) {
    params.rollbackSession?.();
    return { success: false, message: '战斗会话绑定失败' };
  }

  return {
    success: true,
    response,
    session: boundSession,
  };
};

const buildSessionSuccess = (
  session: BattleSessionRecord | BattleSessionSnapshot,
  state?: unknown,
  finished?: boolean,
): BattleSessionResponse => {
  const sessionSnapshot =
    'createdAt' in session ? toBattleSessionSnapshot(session) : session;
  return {
    success: true,
    data: {
      session: sessionSnapshot,
      ...(state === undefined ? {} : { state }),
      ...(finished === undefined ? {} : { finished }),
    },
  };
};

/**
 * 秘境服务端自动推进广播。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在服务端自动推进到下一波后，主动向 owner 与队员补一条携带最新 session 的权威战斗快照，去掉“必须等队长前端 HTTP 返回才能拿到新 session”的前端依赖。
 * 2. 做什么：复用 battle:update 单一入口，只补 session 与日志游标，不额外发独立的“session changed”旁路事件。
 * 3. 不做什么：不决定是否推进，也不修改 battle/session 存储；调用方必须先完成 `advanceBattleSession`。
 *
 * 输入/输出：
 * - 输入：已经更新为 running 的 BattleSession 快照，以及开战返回的 battle state。
 * - 输出：无；仅向当前会话受众发送一条 `battle_started` realtime。
 *
 * 数据流/状态流：
 * waiting_transition session -> 服务端自动 advance -> 本函数补发新 battle 快照
 * -> 客户端统一通过 battle:update 接管到下一波战斗。
 *
 * 关键边界条件与坑点：
 * 1. 这里必须携带最新 session；秘境推进现在不再依赖队长前端手动拿 HTTP 返回。
 * 2. 日志不能重置为全空全量，因此只发送当前 logCursor 的空增量，让已收到首帧的客户端保留原日志，漏帧客户端也能接上最新 battleId。
 */
const emitDungeonSessionAutoAdvanceSnapshot = (params: {
  session: BattleSessionSnapshot;
  state: unknown;
}): void => {
  if (!params.session.currentBattleId) return;
  if (!params.state || typeof params.state !== 'object') return;

  const targetUserIds = normalizeSessionAudienceUserIds([
    params.session.ownerUserId,
    ...params.session.participantUserIds,
  ]);
  if (targetUserIds.length === 0) return;

  try {
    const payload = buildBattleRealtimePayload({
      kind: 'battle_started',
      battleId: params.session.currentBattleId,
      state: params.state as object,
      logs: [],
      extras: {
        session: params.session,
        authoritative: true,
        logStart: getBattleLogCursor(params.session.currentBattleId),
        logDelta: true,
      },
    });
    const gameServer = getGameServer();
    for (const userId of targetUserIds) {
      gameServer.emitToUser(userId, 'battle:update', payload);
    }
  } catch (error) {
    battleSessionLogger.warn({
      battleId: params.session.currentBattleId,
      sessionId: params.session.sessionId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, '推送秘境自动推进快照失败');
  }
};

/**
 * 秘境波次服务端自动推进调度。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“秘境胜利后 200ms 自动推进下一波”的责任收口到服务端，避免 BattleSession 再依赖 leader 客户端定时器触发。
 * 2. 做什么：同一 session 只保留一条待执行任务；重复进入 waiting_transition 时会先清旧任务再重排，避免双重推进。
 * 3. 不做什么：不兜底处理失败结果，也不重试；推进成功与否仍以统一的 `advanceBattleSession` 逻辑为准。
 *
 * 输入/输出：
 * - 输入：waiting_transition 中的秘境 sessionId。
 * - 输出：无；到时后若 session 仍可推进，则直接调用统一 advance 入口。
 *
 * 数据流/状态流：
 * markBattleSessionFinished(attacker_win)
 * -> schedule
 * -> timeout 到时校验 session 仍是 waiting_transition
 * -> advanceBattleSession(owner)
 * -> 补发带 session 的新 battle 快照。
 *
 * 关键边界条件与坑点：
 * 1. 只有秘境胜利继续下一波才会调度；终局 cleared/failed 与其他会话类型不能误入。
 * 2. 调度执行前必须重新读取最新 session，避免用户手动推进/退出后旧定时器继续误推进。
 */
const scheduleDungeonSessionAutoAdvance = (sessionId: string): void => {
  clearDungeonSessionAutoAdvanceTimer(sessionId);
  const timer = setTimeout(async () => {
    await runWithDatabaseAccessAllowed(async () => {
      dungeonSessionAutoAdvanceTimers.delete(sessionId);
      const session = getBattleSessionRecord(sessionId);
      if (!session) return;
      if (session.type !== 'dungeon') return;
      if (session.status !== 'waiting_transition') return;
      if (session.nextAction !== 'advance' || !session.canAdvance) return;

      const advanceResult = await advanceBattleSession(session.ownerUserId, sessionId, {
        endNotificationScope: 'all_participants',
      });
      if (!advanceResult.success) return;

      const nextSession = advanceResult.data.session;
      if (!nextSession.currentBattleId || advanceResult.data.finished) return;
      emitDungeonSessionAutoAdvanceSnapshot({
        session: nextSession,
        state: advanceResult.data.state,
      });
    });
  }, DUNGEON_SESSION_SERVER_AUTO_ADVANCE_DELAY_MS);
  dungeonSessionAutoAdvanceTimers.set(sessionId, timer);
};

const getSessionFinalStatus = (
  type: BattleSessionType,
  result: BattleSessionResult,
): BattleSessionStatus => {
  if (result === 'defender_win') {
    return type === 'pvp' ? 'completed' : 'failed';
  }
  if (result === 'draw') {
    return type === 'dungeon' || type === 'tower' ? 'failed' : 'completed';
  }
  return 'completed';
};

const getWaitingTransitionPolicy = (
  type: BattleSessionType,
  result: BattleSessionResult,
): { nextAction: BattleSessionNextAction; canAdvance: boolean } => {
  if (type === 'pvp') {
    return { nextAction: 'return_to_map', canAdvance: true };
  }
  if (type === 'tower') {
    return result === 'attacker_win'
      ? { nextAction: 'advance', canAdvance: true }
      : { nextAction: 'return_to_map', canAdvance: true };
  }
  if (result === 'attacker_win') {
    return { nextAction: 'advance', canAdvance: true };
  }
  return { nextAction: 'return_to_map', canAdvance: true };
};

const ensureSessionAccess = (
  userId: number,
  session: BattleSessionRecord | null,
): session is BattleSessionRecord => {
  if (!session) return false;
  if (session.ownerUserId === userId) return true;
  return session.participantUserIds.includes(userId);
};

const normalizeSessionAudienceUserIds = (userIds: number[]): number[] => {
  const ids = new Set<number>();
  for (const raw of userIds) {
    const userId = Math.floor(Number(raw));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    ids.add(userId);
  }
  return [...ids];
};

const getBattleStateResult = (battleRes: BattleResult): BattleSessionResult => {
  const resultRaw = battleRes.data?.result;
  if (resultRaw === 'attacker_win' || resultRaw === 'defender_win' || resultRaw === 'draw') {
    return resultRaw;
  }
  return null;
};

const getBattleStatePayload = async (battleId: string): Promise<{
  ok: boolean;
  result: BattleSessionResult;
  state?: BattleState;
  message?: string;
}> => {
  const battleRes = await getBattleState(battleId);
  if (!battleRes.success) {
    return { ok: false, result: null, message: battleRes.message || '获取战斗状态失败' };
  }
  const result = getBattleStateResult(battleRes);
  return {
    ok: true,
    result,
    state: battleRes.data?.state as BattleState | undefined,
  };
};

const finalizeBattleSession = (params: {
  sessionId: string;
  patch: Pick<BattleSessionRecord, 'status' | 'currentBattleId' | 'nextAction' | 'canAdvance'>
    & Partial<Pick<BattleSessionRecord, 'lastResult'>>;
}): BattleSessionSnapshot | null => {
  clearDungeonSessionAutoAdvanceTimer(params.sessionId);
  const updated = updateBattleSessionRecord(params.sessionId, params.patch);
  if (!updated) return null;
  const snapshot = toBattleSessionSnapshot(updated);
  deleteBattleSessionRecord(params.sessionId);
  return snapshot;
};

/**
 * 广播“会话已终止，参与者应退出旧战斗页”。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 BattleSession 终态收尾后的退出广播收口到单一入口，避免普通战斗、秘境手动推进、秘境服务端自动推进各自补一套 socket 推送。
 * 2. 做什么：支持两种广播范围。
 *    `peers_only`：真实前端发起推进时，仅通知其他参与者，发起者继续以 HTTP 返回为准。
 *    `all_participants`：服务端代替前端自动推进时，包含 owner 在内的所有参与者都必须收到退出信号。
 * 3. 不做什么：不改 session/runtime 状态；调用方必须先完成 finalize，再调用本函数。
 *
 * 输入/输出：
 * - 输入：已进入终态前的 session、逻辑上的 actorUserId、给前端清场用的 battleId，以及结束广播范围。
 * - 输出：无返回值；向目标参与者发送 `battle_abandoned` 作为统一退出信号。
 *
 * 数据流/状态流：
 * - advanceBattleSession 完成终态收尾 -> 本函数读取 session 参与者 -> 目标客户端收到 `battle_abandoned` -> 前端退出旧战斗页。
 *
 * 关键边界条件与坑点：
 * 1. 广播名单必须基于 finalize 前的 session 拍快照；session 删除后再读就拿不到参与者了。
 * 2. 秘境服务端自动推进属于“后台代发”，不能沿用“排除 actorUserId”的前端语义，否则 owner 会错过最终清场广播。
 */
const notifyBattleSessionEndedUsers = (params: {
  session: BattleSessionRecord;
  actorUserId: number;
  battleId: string;
  endNotificationScope?: AdvanceBattleSessionEndNotificationScope;
}): void => {
  const targetUserIds = normalizeSessionAudienceUserIds([
    params.session.ownerUserId,
    ...params.session.participantUserIds,
  ]).filter((userId) => (
    params.endNotificationScope === 'all_participants'
      ? true
      : userId !== params.actorUserId
  ));
  if (targetUserIds.length === 0) {
    return;
  }

  try {
    const gameServer = getGameServer();
    const payload = buildBattleAbandonedRealtimePayload({
      battleId: params.battleId,
      success: true,
      message: '战斗已结束',
      authoritative: true,
    });
    for (const userId of targetUserIds) {
      gameServer.emitToUser(userId, 'battle:update', payload);
    }
  } catch (error) {
    battleSessionLogger.warn({
      battleId: params.battleId,
      actorUserId: params.actorUserId,
      sessionId: params.session.sessionId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, '推送会话终态退出事件失败');
  }
};

export const startPVEBattleSession = async (
  userId: number,
  monsterIds: string[],
): Promise<BattleSessionResponse> => {
  const normalizedMonsterIds = normalizePveMonsterIds(monsterIds);
  const startResult = await startPveBattleAndBindSession({
    userId,
    monsterIds,
    bindSession: ({ battleId, participantUserIds }) => createRunningSession({
      type: 'pve',
      ownerUserId: userId,
      participantUserIds,
      currentBattleId: battleId,
      context: {
        monsterIds: normalizedMonsterIds,
      },
    }),
  });
  if (!startResult.success) {
    return { success: false, message: startResult.message };
  }
  const { state, session } = startResult;
  schedulePveResumeIntentSyncForSession(session);
  return buildSessionSuccess(session, state);
};

export const startDungeonBattleSession = async (
  userId: number,
  instanceId: string,
): Promise<BattleSessionResponse> => {
  let createdSessionId = '';
  const dungeonStartResult = await startDungeonBattleAndBindSession({
    startBattle: (options) => startDungeonInstance(userId, instanceId, options),
    bindSession: ({ battleId, participantUserIds }) => {
      const session = createRunningSession({
        type: 'dungeon',
        ownerUserId: userId,
        participantUserIds,
        currentBattleId: battleId,
        context: { instanceId },
      });
      createdSessionId = session.sessionId;
      return session;
    },
    rollbackSession: () => {
      if (!createdSessionId) return;
      deleteBattleSessionRecord(createdSessionId);
      createdSessionId = '';
    },
  });
  if (!dungeonStartResult.success) {
    return {
      success: false,
      message: dungeonStartResult.message || '开启秘境战斗失败',
    };
  }
  const { response: dungeonRes, session } = dungeonStartResult;
  if (!session || !dungeonRes.data.battleId) {
    return { success: false, message: '开启秘境战斗失败' };
  }
  return buildSessionSuccess(session, dungeonRes.data.state);
};

export const startPVPBattleSession = async (params: {
  userId: number;
  opponentCharacterId: number;
  battleId?: string;
  mode: 'arena' | 'challenge';
}): Promise<BattleSessionResponse> => {
  const pvpRes = await startPVPBattle(
    params.userId,
    params.opponentCharacterId,
    params.battleId,
  );
  if (!pvpRes.success || !pvpRes.data?.battleId) {
    return { success: false, message: pvpRes.message || '开启 PVP 战斗失败' };
  }
  const session = createRunningSession({
    type: 'pvp',
    ownerUserId: params.userId,
    participantUserIds: getParticipantUserIdsForBattle(
      String(pvpRes.data.battleId),
      params.userId,
    ),
    currentBattleId: String(pvpRes.data.battleId),
    context: {
      opponentCharacterId: params.opponentCharacterId,
      mode: params.mode,
    },
  });
  return buildSessionSuccess(session, pvpRes.data.state);
};

export const getBattleSessionDetail = async (
  userId: number,
  sessionId: string,
): Promise<BattleSessionResponse> => {
  const session = await ensureBattleSessionRecordBySessionId(sessionId);
  if (!ensureSessionAccess(userId, session)) {
    return { success: false, message: '战斗会话不存在或无权访问' };
  }

  if (!session.currentBattleId) {
    return buildSessionSuccess(session, undefined, session.status !== 'running');
  }

  const battleStateRes = await getBattleStatePayload(session.currentBattleId);
  if (!battleStateRes.ok) {
    return buildSessionSuccess(session, undefined, session.status !== 'running');
  }
  return buildSessionSuccess(
    session,
    battleStateRes.state,
    session.status !== 'running',
  );
};

export const getBattleSessionDetailByBattleId = async (
  userId: number,
  battleId: string,
): Promise<BattleSessionResponse> => {
  const session = await ensureBattleSessionRecordByBattleId(battleId);
  if (!session) {
    return { success: false, message: '战斗会话不存在' };
  }
  if (!ensureSessionAccess(userId, session)) {
    return { success: false, message: '战斗会话不存在或无权访问' };
  }
  return getBattleSessionDetail(userId, session.sessionId);
};

export const getCurrentBattleSessionDetail = async (
  userId: number,
): Promise<BattleSessionResponse | { success: true; data: { session: null } }> => {
  let session = listBattleSessionRecords()
    .filter((candidate) => ensureSessionAccess(userId, candidate))
    .filter((candidate) => candidate.status === 'running' || candidate.status === 'waiting_transition')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  if (!session) {
    session = (await listRestoredActiveSessionsForUser(userId))[0] ?? null;
  }

  if (!session) {
    const resumeIntent = await getPveResumeIntentByUserId(userId);
    if (!resumeIntent) {
      return { success: true, data: { session: null } };
    }
    const startResult = await startPveBattleAndBindSession({
      userId,
      monsterIds: resumeIntent.monsterIds,
      bindSession: ({ battleId, participantUserIds }) => createRunningSession({
        type: 'pve',
        ownerUserId: userId,
        participantUserIds,
        currentBattleId: battleId,
        context: {
          monsterIds: normalizePveMonsterIds(resumeIntent.monsterIds),
        },
      }),
    });
    if (!startResult.success) {
      return { success: false, message: startResult.message || '恢复普通战斗失败' };
    }
    const { state, session: restoredSession } = startResult;
    schedulePveResumeIntentSyncForSession(restoredSession);
    return buildSessionSuccess(restoredSession, state);
  }

  return getBattleSessionDetail(userId, session.sessionId);
};

/**
 * 从在线战斗投影恢复 BattleSession runtime。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在服务启动后把 Redis 中仍存活的 session 投影重新挂回 BattleSession runtime，修复进程重启后秘境/塔/PVP 会话整体丢失的问题。
 * 2. 做什么：让秘境 `waiting_transition` 在恢复后立即重建自动推进任务，保证下一波仍由服务端权威推进。
 * 3. 不做什么：不恢复单场 battle engine；battle engine 仍由 battle lifecycle 自己的 Redis 恢复链负责。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：本次成功回填到 runtime 的 session 数量。
 *
 * 数据流/状态流：
 * - startup pipeline -> 在线战斗 session 投影列表 -> 本函数回填 runtime / 重建秘境自动推进 -> BattleSession API 正常可读。
 *
 * 关键边界条件与坑点：
 * 1. 只恢复 `running / waiting_transition`；终态 session 若残留在投影里也不能重新挂回。
 * 2. 启动恢复与查询期懒回填共用同一 `restoreBattleSessionRecordFromProjection`，避免两套规则漂移。
 */
export const recoverBattleSessionsFromProjection = async (): Promise<number> => {
  const projections = await listOnlineBattleSessionProjections();
  let recoveredCount = 0;

  for (const projection of projections) {
    if (!isBattleSessionRuntimeActive(projection)) {
      continue;
    }
    const existed = getBattleSessionRecord(projection.sessionId);
    const restored = restoreBattleSessionRecordFromProjection(projection);
    if (!restored || existed) {
      continue;
    }
    recoveredCount += 1;
  }

  return recoveredCount;
};

const completeSessionReturnToMap = async (
  userId: number,
  session: BattleSessionRecord,
  endNotificationScope: AdvanceBattleSessionEndNotificationScope,
): Promise<BattleSessionResponse> => {
  if (session.type === 'tower') {
    await endTowerRunBySession(session);
  }
  schedulePveResumeIntentDeletionForSession(session);
  const nextStatus = getSessionFinalStatus(session.type, session.lastResult);
  const settledBattleId = session.currentBattleId;
  const snapshot = finalizeBattleSession({
    sessionId: session.sessionId,
    patch: {
      status: nextStatus,
      currentBattleId: null,
      nextAction: 'none',
      canAdvance: false,
    },
  });
  if (!snapshot) {
    return { success: false, message: '战斗会话不存在' };
  }
  if (settledBattleId) {
    notifyBattleSessionEndedUsers({
      session,
      actorUserId: userId,
      battleId: settledBattleId,
      endNotificationScope,
    });
  }
  return buildSessionSuccess(snapshot, undefined, true);
};

export const advanceBattleSession = async (
  userId: number,
  sessionId: string,
  options?: {
    endNotificationScope?: AdvanceBattleSessionEndNotificationScope;
  },
): Promise<BattleSessionResponse> => {
  const session = getBattleSessionRecord(sessionId);
  if (!ensureSessionAccess(userId, session)) {
    return { success: false, message: '战斗会话不存在或无权访问' };
  }
  if (!session.canAdvance) {
    return { success: false, message: '当前战斗会话不可推进' };
  }
  const slowLogger = createSlowOperationLogger({
    label: 'api/battle-session/advance',
    fields: {
      userId,
      sessionId,
      sessionType: session.type,
      nextAction: session.nextAction,
    },
  });
  const flushAndReturn = (
    response: BattleSessionResponse,
    fields?: SlowLogFields,
  ): BattleSessionResponse => {
    slowLogger.flush({
      success: response.success,
      ...(fields ?? {}),
    });
    return response;
  };
  clearDungeonSessionAutoAdvanceTimer(session.sessionId);
  const endNotificationScope = options?.endNotificationScope ?? 'peers_only';

  if (session.type === 'pve') {
    if (session.nextAction === 'return_to_map') {
      const response = await completeSessionReturnToMap(userId, session, endNotificationScope);
      slowLogger.mark('completeSessionReturnToMap', {
        finished: true,
      });
      return flushAndReturn(response, {
        finished: true,
      });
    }
    const context = session.context as { monsterIds: string[] };
    const startResult = await startPveBattleAndBindSession({
      userId,
      monsterIds: context.monsterIds,
      startBattle: startPVEBattleForSessionFlow,
      bindSession: ({ battleId, participantUserIds }) => updateBattleSessionRecord(session.sessionId, {
        currentBattleId: battleId,
        participantUserIds: normalizeParticipantUserIds(
          participantUserIds,
          session.ownerUserId,
        ),
        status: 'running',
        nextAction: 'none',
        canAdvance: false,
        lastResult: null,
      }),
    });
    if (!startResult.success) {
      return flushAndReturn(
        { success: false, message: startResult.message || '开启下一场战斗失败' },
        {
          reason: 'start_pve_battle_failed',
        },
      );
    }
    const { battleId, state, session: updated } = startResult;
    slowLogger.mark('startPVEBattle', {
      battleStarted: true,
    });
    slowLogger.mark('updateBattleSessionRecord', {
      sessionUpdated: Boolean(updated),
    });
    schedulePveResumeIntentSyncForSession(updated);
    slowLogger.mark('syncPveResumeIntentForSession');
    return flushAndReturn(
      buildSessionSuccess(updated, state, false),
      {
        finished: false,
        battleId,
      },
    );
  }

  if (session.type === 'dungeon') {
    const context = session.context as { instanceId: string };
    const rollbackSession = () => {
      updateBattleSessionRecord(session.sessionId, {
        currentBattleId: session.currentBattleId,
        participantUserIds: normalizeParticipantUserIds(
          session.participantUserIds,
          session.ownerUserId,
        ),
        status: session.status,
        nextAction: session.nextAction,
        canAdvance: session.canAdvance,
        lastResult: session.lastResult,
      });
    };
    const dungeonStartResult = await startDungeonBattleAndBindSession({
      startBattle: (options) => nextDungeonInstance(userId, context.instanceId, options),
      bindSession: ({ battleId, participantUserIds }) => updateBattleSessionRecord(session.sessionId, {
        currentBattleId: battleId,
        participantUserIds: normalizeParticipantUserIds(
          participantUserIds,
          session.ownerUserId,
        ),
        status: 'running',
        nextAction: 'none',
        canAdvance: false,
        lastResult: null,
      }),
      rollbackSession,
    });
    if (!dungeonStartResult.success) {
      return flushAndReturn({
        success: false,
        message: dungeonStartResult.message || '推进秘境失败',
      }, {
        reason: 'dungeon_advance_failed',
      });
    }
    const { response: dungeonRes, session: updatedSession } = dungeonStartResult;
    slowLogger.mark('nextDungeonInstance', {
      dungeonAdvanceSuccess: dungeonRes.success,
      dungeonFinished: Boolean(dungeonRes.success && dungeonRes.data?.finished),
    });
    if (dungeonRes.data.finished || !dungeonRes.data.battleId) {
      const settledBattleId = session.currentBattleId;
      const nextStatus: BattleSessionStatus =
        dungeonRes.data.status === 'cleared' ? 'completed' : 'failed';
      const snapshot = finalizeBattleSession({
        sessionId: session.sessionId,
        patch: {
          currentBattleId: null,
          status: nextStatus,
          nextAction: 'none',
          canAdvance: false,
        },
      });
      slowLogger.mark('finalizeBattleSession', {
        sessionFinalized: Boolean(snapshot),
      });
      if (!snapshot) {
        return flushAndReturn(
          { success: false, message: '战斗会话不存在' },
          {
            reason: 'session_missing_after_dungeon_finish',
          },
        );
      }
      if (settledBattleId) {
        notifyBattleSessionEndedUsers({
          session,
          actorUserId: userId,
          battleId: settledBattleId,
          endNotificationScope,
        });
        slowLogger.mark('notifyBattleSessionEndedUsers');
      }
      return flushAndReturn(
        buildSessionSuccess(snapshot, undefined, true),
        {
          finished: true,
          dungeonStatus: dungeonRes.data.status,
        },
      );
    }
    const updated = updatedSession;
    slowLogger.mark('updateBattleSessionRecord', {
      sessionUpdated: Boolean(updated),
    });
    if (!updated) {
      return flushAndReturn(
        { success: false, message: '战斗会话不存在' },
        {
          reason: 'session_missing_after_dungeon_advance',
        },
      );
    }
    return flushAndReturn(
      buildSessionSuccess(updated, dungeonRes.data.state, false),
      {
        finished: false,
        battleId: String(dungeonRes.data.battleId),
        dungeonStatus: dungeonRes.data.status,
      },
    );
  }

  if (session.type === 'tower') {
    if (session.nextAction === 'return_to_map') {
      const response = await completeSessionReturnToMap(userId, session, endNotificationScope);
      slowLogger.mark('completeSessionReturnToMap', {
        finished: true,
      });
      return flushAndReturn(response, {
        finished: true,
      });
    }
    const response = await advanceTowerRun({
      userId,
      session,
    });
    const towerFinished =
      response.success && 'finished' in response.data
        ? Boolean(response.data.finished)
        : false;
    slowLogger.mark('advanceTowerRun', {
      finished: towerFinished,
    });
    return flushAndReturn(response, {
      finished: towerFinished,
    });
  }

  const response = await completeSessionReturnToMap(userId, session, endNotificationScope);
  slowLogger.mark('completeSessionReturnToMap', {
    finished: true,
  });
  return flushAndReturn(response, {
    finished: true,
  });
};

export const markBattleSessionFinished = async (
  battleId: string,
  result: BattleSessionResult,
): Promise<BattleSessionSnapshot | null> => {
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (!snapshot) return null;
  const session = getBattleSessionRecord(snapshot.sessionId);
  if (!session) return null;
  const policy = getWaitingTransitionPolicy(session.type, result);
  const updated = updateBattleSessionRecord(session.sessionId, {
    currentBattleId: battleId,
    status: 'waiting_transition',
    nextAction: policy.nextAction,
    canAdvance: policy.canAdvance,
    lastResult: result,
  });
  if (!updated) return null;
  if (updated.type === 'pve') {
    if (policy.nextAction === 'advance') {
      schedulePveResumeIntentSyncForSession(updated);
    } else {
      schedulePveResumeIntentDeletionForSession(updated);
    }
  }
  if (updated.type === 'dungeon' && policy.nextAction === 'advance') {
    scheduleDungeonSessionAutoAdvance(updated.sessionId);
  }
  return toBattleSessionSnapshot(updated);
};

export const markBattleSessionAbandoned = async (
  battleId: string,
): Promise<BattleSessionSnapshot | null> => {
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (!snapshot) return null;
  const session = getBattleSessionRecord(snapshot.sessionId);
  if (!session) return null;
  if (session.type === 'tower') {
    await endTowerRunBySession(session);
  }
  schedulePveResumeIntentDeletionForSession(session);
  return finalizeBattleSession({
    sessionId: snapshot.sessionId,
    patch: {
      currentBattleId: null,
      status: 'abandoned',
      nextAction: 'none',
      canAdvance: false,
    },
  });
};

/**
 * 从 battle session 中移除单个参与用户，但不影响仍留在战斗中的其他参与者。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“队员退队/被踢/被队伍战斗剔除”后的 session 参与者收缩收口到单一入口，避免 teamHooks、battleSession 各自维护 participantUserIds。
 * 2. 做什么：若目标用户恰好是 session owner，则直接把整条 session 标记为 abandoned，避免 owner 脱离后还残留一条无主会话。
 * 3. 不做什么：不改 battle runtime 的 activeBattles/battleParticipants，也不负责 socket 推送。
 *
 * 输入/输出：
 * - 输入：battleId、要移除的 userId。
 * - 输出：更新后的 session 快照；查不到 session 时返回 null。
 *
 * 数据流/状态流：
 * teamHooks / 其他退出链路 -> 本函数更新 session.participantUserIds
 * -> 后续 `/battle-session/current` 访问权限与刷新恢复统一读取新快照。
 *
 * 关键边界条件与坑点：
 * 1. owner 被移除时不能只删 participantUserIds，否则 session.ownerUserId 仍可访问旧会话，必须直接 abandoned。
 * 2. participantUserIds 需要保留 owner，避免普通成员退出时把 owner 一并误删。
 */
export const removeBattleSessionParticipantUser = async (
  battleId: string,
  userId: number,
): Promise<BattleSessionSnapshot | null> => {
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (!snapshot) return null;

  const session = getBattleSessionRecord(snapshot.sessionId);
  if (!session) return null;

  if (session.ownerUserId === userId) {
    return markBattleSessionAbandoned(battleId);
  }

  if (!session.participantUserIds.includes(userId)) {
    return toBattleSessionSnapshot(session);
  }

  const nextParticipantUserIds = normalizeParticipantUserIds(
    session.participantUserIds.filter((participantUserId) => participantUserId !== userId),
    session.ownerUserId,
  );
  const updated = updateBattleSessionRecord(session.sessionId, {
    participantUserIds: nextParticipantUserIds,
  });
  if (!updated) return null;
  schedulePveResumeIntentSyncForSession(updated);
  return toBattleSessionSnapshot(updated);
};

export const getAttachedBattleSessionSnapshot = (
  battleId: string,
): BattleSessionSnapshot | null => {
  return getBattleSessionSnapshotByBattleId(battleId);
};

/**
 * 在 waiting_transition 中主动放弃整条 BattleSession。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“战斗已结算、仍在中间态时由 owner 主动退出”的权限校验与 session 收尾集中到单一入口，避免 action/teamHooks 各自重复判断 waiting_transition。
 * 2. 做什么：返回需要广播的参与用户集合，保证 owner 放弃中间态后，其余队员也能收到统一退出事件。
 * 3. 不做什么：不直接发 socket，也不操作 activeBattles/finishedBattleResults。
 *
 * 输入/输出：
 * - 输入：battleId、userId。
 * - 输出：成功时返回 abandoned 后的 session 快照与广播用户列表；失败时返回错误信息。
 *
 * 数据流/状态流：
 * action / 其他中间态退出入口 -> 本函数校验 owner 与 waiting_transition
 * -> markBattleSessionAbandoned -> 调用方按 participantUserIds 广播 `battle_abandoned`。
 *
 * 关键边界条件与坑点：
 * 1. 只有 owner 才能终止 waiting_transition；普通队员即使还在 session.participantUserIds 里，也不能单方面结束整条会话。
 * 2. 广播名单必须在 abandoned 前拍下，否则 session 删除后就拿不到参与者了。
 */
export const abandonWaitingTransitionBattleSession = async (params: {
  battleId: string;
  userId: number;
}): Promise<{ success: true; data: { session: BattleSessionSnapshot; participantUserIds: number[] } } | { success: false; message: string }> => {
  const snapshot = getBattleSessionSnapshotByBattleId(params.battleId);
  if (!snapshot) {
    return { success: false, message: '战斗不存在' };
  }

  const session = getBattleSessionRecord(snapshot.sessionId);
  if (!session || session.currentBattleId !== params.battleId) {
    return { success: false, message: '战斗不存在' };
  }

  if (session.status !== 'waiting_transition') {
    return { success: false, message: '战斗不存在' };
  }

  if (session.ownerUserId !== params.userId) {
    return {
      success: false,
      message: session.participantUserIds.includes(params.userId) ? '组队战斗只有队长可以逃跑' : '无权操作此战斗',
    };
  }

  const participantUserIds = normalizeParticipantUserIds(
    session.participantUserIds,
    session.ownerUserId,
  );
  const abandonedSnapshot = await markBattleSessionAbandoned(params.battleId);
  if (!abandonedSnapshot) {
    return { success: false, message: '战斗不存在' };
  }

  return {
    success: true,
    data: {
      session: abandonedSnapshot,
      participantUserIds,
    },
  };
};

/**
 * 判断指定用户是否仍应接收 battleId 对应的 BattleSession realtime。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“战斗结算/重放/补发时谁还能收到 session 相关推送”收口到服务端单一权限入口，避免 settlement、teamHooks、重连同步各自重复判断。
 * 2. 做什么：优先以当前 BattleSession 访问权限为准，确保队员退队后，即使旧 battle 的完成消息晚到，也不会再收到该战斗的 finished 推送。
 * 3. 不做什么：不修改 session/battle 运行时状态，也不负责真正发 socket。
 *
 * 输入/输出：
 * - 输入：battleId、userId、fallbackUserIds。
 * - 输出：该 userId 是否仍可接收这场 battle 的 session 相关推送。
 *
 * 数据流/状态流：
 * settlement / 其他主动补发逻辑 -> 本函数读取 battleSession snapshot
 * -> 有 session 时按 owner/participant 权限判断；无 session 时退回调用方传入的原始通知名单。
 *
 * 关键边界条件与坑点：
 * 1. 退队与战斗结算可能并发，不能只信 settlement 开头拍下来的 battleParticipants 快照，必须在真正推送前再次读取最新 session。
 * 2. battle 可能没有挂 session（例如旧链路或异常清理后的短暂窗口），这时只能严格退回 fallback 名单，不能擅自扩大通知范围。
 */
export const canReceiveBattleSessionRealtime = (params: {
  battleId: string;
  userId: number;
  fallbackUserIds: number[];
}): boolean => {
  const normalizedUserId = Math.floor(Number(params.userId));
  if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
    return false;
  }

  const session = getBattleSessionSnapshotByBattleId(params.battleId);
  if (!session) {
    return normalizeSessionAudienceUserIds(params.fallbackUserIds).includes(normalizedUserId);
  }

  if (session.ownerUserId === normalizedUserId) {
    return true;
  }

  return session.participantUserIds.includes(normalizedUserId);
};

/**
 * 清理指定用户在 waiting_transition 状态下的残留会话。
 *
 * 作用：
 * - 当战斗已结算并从 activeBattles 移除，但 session 仍停在 waiting_transition 时，
 *   onUserLeaveTeam 的活跃战斗循环无法覆盖该 session（因为查不到 activeBattles）。
 * - 本函数作为补充路径，按 userId 扫描所有 waiting_transition 会话并逐一移除用户。
 *
 * 调用时机：
 * - onUserLeaveTeam 末尾调用，确保离队玩家不再被残留 session 拉回。
 *
 * 边界条件：
 * 1) 仅处理 waiting_transition 状态，不影响 running 会话（running 由活跃战斗循环处理）。
 * 2) owner 被移除时直接 abandoned 整条 session（与 removeBattleSessionParticipantUser 行为一致）。
 */
export const cleanupUserWaitingTransitionSessions = async (
  userId: number,
): Promise<Array<{
  battleId: string;
  removedUserIds: number[];
}>> => {
  const sessions = listBattleSessionRecords()
    .filter((s) => s.status === 'waiting_transition')
    .filter((s) => ensureSessionAccess(userId, s));
  const results: Array<{
    battleId: string;
    removedUserIds: number[];
  }> = [];

  for (const session of sessions) {
    const battleId = session.currentBattleId;
    if (!battleId) continue;
    if (session.ownerUserId === userId) {
      const removedUserIds = normalizeParticipantUserIds(
        session.participantUserIds,
        session.ownerUserId,
      );
      await markBattleSessionAbandoned(battleId);
      results.push({ battleId, removedUserIds });
      continue;
    }
    await removeBattleSessionParticipantUser(battleId, userId);
    results.push({ battleId, removedUserIds: [userId] });
  }
  return results;
};
