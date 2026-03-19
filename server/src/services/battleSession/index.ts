/**
 * BattleSession 模块导出聚合。
 */

export type {
  BattleSessionContext,
  BattleSessionNextAction,
  BattleSessionRecord,
  BattleSessionResult,
  BattleSessionSnapshot,
  BattleSessionStatus,
  BattleSessionType,
} from './types.js';

export {
  advanceBattleSession,
  canReceiveBattleSessionRealtime,
  cleanupUserWaitingTransitionSessions,
  getAttachedBattleSessionSnapshot,
  getCurrentBattleSessionDetail,
  getBattleSessionDetail,
  getBattleSessionDetailByBattleId,
  markBattleSessionAbandoned,
  markBattleSessionFinished,
  removeBattleSessionParticipantUser,
  startDungeonBattleSession,
  startPVEBattleSession,
  startPVPBattleSession,
} from './service.js';
