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
import { battleParticipants } from '../battle/runtime/state.js';
import { getBattleState } from '../battle/queries.js';
import { startPVEBattle } from '../battle/pve.js';
import { startPVPBattle } from '../battle/pvp.js';
import { dungeonService } from '../dungeon/service.js';
import type { BattleState } from '../../battle/types.js';
import type { BattleResult } from '../battle/battleTypes.js';
import {
  createBattleSessionRecord,
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
} from './types.js';

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
  session: BattleSessionRecord,
  state?: unknown,
  finished?: boolean,
): BattleSessionResponse => ({
  success: true,
  data: {
    session: toBattleSessionSnapshot(session),
    ...(state === undefined ? {} : { state }),
    ...(finished === undefined ? {} : { finished }),
  },
});

const getSessionFinalStatus = (
  type: BattleSessionType,
  result: BattleSessionResult,
): BattleSessionStatus => {
  if (result === 'defender_win') {
    return type === 'pvp' ? 'completed' : 'failed';
  }
  if (result === 'draw') {
    return type === 'dungeon' ? 'failed' : 'completed';
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
    return { success: true, data: { session: null } };
  }

  return getBattleSessionDetail(userId, session.sessionId);
};

const completeSessionReturnToMap = (
  session: BattleSessionRecord,
): BattleSessionResponse => {
  const nextStatus = getSessionFinalStatus(session.type, session.lastResult);
  const updated = updateBattleSessionRecord(session.sessionId, {
    status: nextStatus,
    currentBattleId: null,
    nextAction: 'none',
    canAdvance: false,
  });
  if (!updated) {
    return { success: false, message: '战斗会话不存在' };
  }
  return buildSessionSuccess(updated, undefined, true);
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
      return completeSessionReturnToMap(session);
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
      const nextStatus: BattleSessionStatus =
        dungeonRes.data.status === 'cleared' ? 'completed' : 'failed';
      const updated = updateBattleSessionRecord(session.sessionId, {
        currentBattleId: null,
        status: nextStatus,
        nextAction: 'none',
        canAdvance: false,
      });
      if (!updated) {
        return { success: false, message: '战斗会话不存在' };
      }
      return buildSessionSuccess(updated, undefined, true);
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

  return completeSessionReturnToMap(session);
};

export const markBattleSessionFinished = (
  battleId: string,
  result: BattleSessionResult,
): BattleSessionSnapshot | null => {
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
  return updated ? toBattleSessionSnapshot(updated) : null;
};

export const markBattleSessionAbandoned = (
  battleId: string,
): BattleSessionSnapshot | null => {
  const snapshot = getBattleSessionSnapshotByBattleId(battleId);
  if (!snapshot) return null;
  const updated = updateBattleSessionRecord(snapshot.sessionId, {
    currentBattleId: null,
    status: 'abandoned',
    nextAction: 'none',
    canAdvance: false,
  });
  return updated ? toBattleSessionSnapshot(updated) : null;
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
export const removeBattleSessionParticipantUser = (
  battleId: string,
  userId: number,
): BattleSessionSnapshot | null => {
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
  return updated ? toBattleSessionSnapshot(updated) : null;
};

export const getAttachedBattleSessionSnapshot = (
  battleId: string,
): BattleSessionSnapshot | null => {
  return getBattleSessionSnapshotByBattleId(battleId);
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
export const cleanupUserWaitingTransitionSessions = (
  userId: number,
): void => {
  const sessions = listBattleSessionRecords()
    .filter((s) => s.status === 'waiting_transition')
    .filter((s) => ensureSessionAccess(userId, s));

  for (const session of sessions) {
    const battleId = session.currentBattleId;
    if (!battleId) continue;
    removeBattleSessionParticipantUser(battleId, userId);
  }
};
