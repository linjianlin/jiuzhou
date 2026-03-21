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
import { getGameServer } from '../../game/gameServer.js';
import { battleParticipants } from '../battle/runtime/state.js';
import { getBattleState } from '../battle/queries.js';
import { startPVEBattle } from '../battle/pve.js';
import { startPVPBattle } from '../battle/pvp.js';
import { dungeonService } from '../dungeon/service.js';
import {
  advanceTowerRun,
  endTowerRunBySession,
} from '../tower/service.js';
import type { BattleState } from '../../battle/types.js';
import type { BattleResult } from '../battle/battleTypes.js';
import { buildBattleAbandonedRealtimePayload } from '../battle/runtime/realtime.js';
import {
  createBattleSessionRecord,
  deleteBattleSessionRecord,
  getBattleSessionRecord,
  getBattleSessionSnapshotByBattleId,
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

const deletePveResumeIntentForSession = async (
  session: BattleSessionRecord | BattleSessionSnapshot,
): Promise<void> => {
  if (session.type !== 'pve') return;
  await deletePveResumeIntentByUserId(session.ownerUserId);
};

const createRunningSession = (params: {
  type: BattleSessionType;
  ownerUserId: number;
  currentBattleId: string;
  context: BattleSessionContext;
}): BattleSessionRecord => {
  return createBattleSessionRecord({
    sessionId: crypto.randomUUID(),
    type: params.type,
    ownerUserId: params.ownerUserId,
    participantUserIds: getParticipantUserIdsForBattle(
      params.currentBattleId,
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
  const updated = updateBattleSessionRecord(params.sessionId, params.patch);
  if (!updated) return null;
  const snapshot = toBattleSessionSnapshot(updated);
  deleteBattleSessionRecord(params.sessionId);
  return snapshot;
};

/**
 * 广播“会话已终止，其他参与者应退出旧战斗页”。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 BattleSession 终态收尾后，通知其余参与者清理旧战斗视图的广播逻辑收口到单一入口，避免普通战斗/秘境各自补一套 socket 推送。
 * 2. 做什么：只通知“当前触发推进的人以外”的参与者，推进发起者继续以 HTTP 返回为准，避免同一客户端同时吃到本地返回和额外广播。
 * 3. 不做什么：不改 session/runtime 状态；调用方必须先完成 finalize，再调用本函数。
 *
 * 输入/输出：
 * - 输入：已进入终态前的 session、当前触发推进的 actorUserId，以及给前端清场用的 battleId。
 * - 输出：无返回值；仅向其余参与者发送 `battle_abandoned` 作为统一退出信号。
 *
 * 数据流/状态流：
 * - advanceBattleSession 完成终态收尾 -> 本函数读取 session 参与者 -> 其余参与者收到 `battle_abandoned` -> 前端退出旧战斗页。
 *
 * 关键边界条件与坑点：
 * 1. 广播名单必须基于 finalize 前的 session 拍快照；session 删除后再读就拿不到参与者了。
 * 2. battleId 必须沿用刚结束的那场 battle；前端是按 battleId 对齐当前视图的，不能传 null。
 */
const notifyPeerUsersSessionEnded = (params: {
  session: BattleSessionRecord;
  actorUserId: number;
  battleId: string;
}): void => {
  const targetUserIds = normalizeSessionAudienceUserIds([
    params.session.ownerUserId,
    ...params.session.participantUserIds,
  ]).filter((userId) => userId !== params.actorUserId);
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
    console.warn('[battleSession] 推送会话终态退出事件失败:', error);
  }
};

export const startPVEBattleSession = async (
  userId: number,
  monsterIds: string[],
): Promise<BattleSessionResponse> => {
  const battleRes = await startPVEBattle(userId, monsterIds);
  if (!battleRes.success || !battleRes.data?.battleId) {
    return { success: false, message: battleRes.message || '开启战斗失败' };
  }
  const session = createRunningSession({
    type: 'pve',
    ownerUserId: userId,
    currentBattleId: String(battleRes.data.battleId),
    context: {
      monsterIds: monsterIds
        .filter((monsterId) => typeof monsterId === 'string' && monsterId.length > 0)
        .slice(0, 5),
    },
  });
  await syncPveResumeIntentForSession(session);
  return buildSessionSuccess(session, battleRes.data.state);
};

export const startDungeonBattleSession = async (
  userId: number,
  instanceId: string,
): Promise<BattleSessionResponse> => {
  const dungeonRes = await dungeonService.startDungeonInstance(userId, instanceId);
  if (!dungeonRes.success || !dungeonRes.data?.battleId) {
    return {
      success: false,
      message: dungeonRes.success ? '开启秘境战斗失败' : (dungeonRes.message || '开启秘境战斗失败'),
    };
  }
  const session = createRunningSession({
    type: 'dungeon',
    ownerUserId: userId,
    currentBattleId: String(dungeonRes.data.battleId),
    context: { instanceId },
  });
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
  const session = getBattleSessionRecord(sessionId);
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
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (!snapshot) {
    return { success: false, message: '战斗会话不存在' };
  }
  const session = getBattleSessionRecord(snapshot.sessionId);
  if (!ensureSessionAccess(userId, session)) {
    return { success: false, message: '战斗会话不存在或无权访问' };
  }
  return getBattleSessionDetail(userId, snapshot.sessionId);
};

export const getCurrentBattleSessionDetail = async (
  userId: number,
): Promise<BattleSessionResponse | { success: true; data: { session: null } }> => {
  const session = listBattleSessionRecords()
    .filter((candidate) => ensureSessionAccess(userId, candidate))
    .filter((candidate) => candidate.status === 'running' || candidate.status === 'waiting_transition')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  if (!session) {
    const resumeIntent = await getPveResumeIntentByUserId(userId);
    if (!resumeIntent) {
      return { success: true, data: { session: null } };
    }
    const battleRes = await startPVEBattle(userId, resumeIntent.monsterIds);
    if (!battleRes.success || !battleRes.data?.battleId) {
      return { success: false, message: battleRes.message || '恢复普通战斗失败' };
    }
    const restoredSession = createRunningSession({
      type: 'pve',
      ownerUserId: userId,
      currentBattleId: String(battleRes.data.battleId),
      context: {
        monsterIds: normalizePveMonsterIds(resumeIntent.monsterIds),
      },
    });
    await syncPveResumeIntentForSession(restoredSession);
    return buildSessionSuccess(restoredSession, battleRes.data.state);
  }

  return getBattleSessionDetail(userId, session.sessionId);
};

const completeSessionReturnToMap = async (
  userId: number,
  session: BattleSessionRecord,
): Promise<BattleSessionResponse> => {
  if (session.type === 'tower') {
    await endTowerRunBySession(session);
  }
  await deletePveResumeIntentForSession(session);
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
    notifyPeerUsersSessionEnded({
      session,
      actorUserId: userId,
      battleId: settledBattleId,
    });
  }
  return buildSessionSuccess(snapshot, undefined, true);
};

export const advanceBattleSession = async (
  userId: number,
  sessionId: string,
): Promise<BattleSessionResponse> => {
  const session = getBattleSessionRecord(sessionId);
  if (!ensureSessionAccess(userId, session)) {
    return { success: false, message: '战斗会话不存在或无权访问' };
  }
  if (!session.canAdvance) {
    return { success: false, message: '当前战斗会话不可推进' };
  }

  if (session.type === 'pve') {
    if (session.nextAction === 'return_to_map') {
      return completeSessionReturnToMap(userId, session);
    }
    const context = session.context as { monsterIds: string[] };
    const battleRes = await startPVEBattle(userId, context.monsterIds);
    if (!battleRes.success || !battleRes.data?.battleId) {
      return { success: false, message: battleRes.message || '开启下一场战斗失败' };
    }
    const updated = updateBattleSessionRecord(session.sessionId, {
      currentBattleId: String(battleRes.data.battleId),
      participantUserIds: getParticipantUserIdsForBattle(
        String(battleRes.data.battleId),
        session.ownerUserId,
      ),
      status: 'running',
      nextAction: 'none',
      canAdvance: false,
      lastResult: null,
    });
    if (!updated) {
      return { success: false, message: '战斗会话不存在' };
    }
    await syncPveResumeIntentForSession(updated);
    return buildSessionSuccess(updated, battleRes.data.state, false);
  }

  if (session.type === 'dungeon') {
    const context = session.context as { instanceId: string };
    const dungeonRes = await dungeonService.nextDungeonInstance(userId, context.instanceId);
    if (!dungeonRes.success || !dungeonRes.data) {
      return {
        success: false,
        message: dungeonRes.success ? '推进秘境失败' : (dungeonRes.message || '推进秘境失败'),
      };
    }
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
      if (!snapshot) {
        return { success: false, message: '战斗会话不存在' };
      }
      if (settledBattleId) {
        notifyPeerUsersSessionEnded({
          session,
          actorUserId: userId,
          battleId: settledBattleId,
        });
      }
      return buildSessionSuccess(snapshot, undefined, true);
    }
    const updated = updateBattleSessionRecord(session.sessionId, {
      currentBattleId: String(dungeonRes.data.battleId),
      participantUserIds: getParticipantUserIdsForBattle(
        String(dungeonRes.data.battleId),
        session.ownerUserId,
      ),
      status: 'running',
      nextAction: 'none',
      canAdvance: false,
      lastResult: null,
    });
    if (!updated) {
      return { success: false, message: '战斗会话不存在' };
    }
    return buildSessionSuccess(updated, dungeonRes.data.state, false);
  }

  if (session.type === 'tower') {
    if (session.nextAction === 'return_to_map') {
      return completeSessionReturnToMap(userId, session);
    }
    return advanceTowerRun({
      userId,
      session,
    });
  }

  return completeSessionReturnToMap(userId, session);
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
      await syncPveResumeIntentForSession(updated);
    } else {
      await deletePveResumeIntentForSession(updated);
    }
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
  await deletePveResumeIntentForSession(session);
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
  await syncPveResumeIntentForSession(updated);
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
