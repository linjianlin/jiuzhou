import type { AxiosRequestConfig } from 'axios';
import api from './core';
import type { BattleStateDto } from './combat-realm';

export type BattleSessionTypeDto = 'pve' | 'dungeon' | 'pvp' | 'tower';

export type BattleSessionStatusDto =
  | 'running'
  | 'waiting_transition'
  | 'completed'
  | 'failed'
  | 'abandoned';

export type BattleSessionNextActionDto = 'none' | 'advance' | 'return_to_map';

export interface BattleSessionSnapshotDto {
  sessionId: string;
  type: BattleSessionTypeDto;
  ownerUserId: number;
  participantUserIds: number[];
  currentBattleId: string | null;
  status: BattleSessionStatusDto;
  nextAction: BattleSessionNextActionDto;
  canAdvance: boolean;
  lastResult: 'attacker_win' | 'defender_win' | 'draw' | null;
  context:
    | { monsterIds: string[] }
    | { instanceId: string }
    | { opponentCharacterId: number; mode: 'arena' | 'challenge' }
    | { runId: string; floor: number };
}

export interface BattleSessionResponse {
  success: boolean;
  message?: string;
  data?: {
    session: BattleSessionSnapshotDto;
    state?: BattleStateDto;
    finished?: boolean;
  };
}

export interface CurrentBattleSessionResponse {
  success: boolean;
  message?: string;
  data?: {
    session: BattleSessionSnapshotDto | null;
    state?: BattleStateDto;
    finished?: boolean;
  };
}

export const startPveBattleSession = (
  monsterIds: string[],
  requestConfig?: AxiosRequestConfig,
): Promise<BattleSessionResponse> => {
  return api.post('/battle-session/start', {
    type: 'pve',
    monsterIds,
  }, requestConfig);
};

export const startDungeonBattleSession = (
  instanceId: string,
  requestConfig?: AxiosRequestConfig,
): Promise<BattleSessionResponse> => {
  return api.post('/battle-session/start', {
    type: 'dungeon',
    instanceId,
  }, requestConfig);
};

export const startPvpBattleSession = (params: {
  opponentCharacterId: number;
  mode: 'arena' | 'challenge';
  battleId?: string;
}, requestConfig?: AxiosRequestConfig): Promise<BattleSessionResponse> => {
  return api.post('/battle-session/start', {
    type: 'pvp',
    opponentCharacterId: params.opponentCharacterId,
    mode: params.mode,
    ...(params.battleId ? { battleId: params.battleId } : {}),
  }, requestConfig);
};

export const advanceBattleSession = (
  sessionId: string,
  requestConfig?: AxiosRequestConfig,
): Promise<BattleSessionResponse> => {
  return api.post(`/battle-session/${encodeURIComponent(sessionId)}/advance`, {}, requestConfig);
};

export const getBattleSession = (sessionId: string): Promise<BattleSessionResponse> => {
  return api.get(`/battle-session/${encodeURIComponent(sessionId)}`);
};

export const getBattleSessionByBattleId = (battleId: string): Promise<BattleSessionResponse> => {
  return api.get(`/battle-session/by-battle/${encodeURIComponent(battleId)}`);
};

export const getCurrentBattleSession = (): Promise<CurrentBattleSessionResponse> => {
  return api.get('/battle-session/current');
};
