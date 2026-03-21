import type { AxiosRequestConfig } from 'axios';
import api from './core';
import type { BattleSessionSnapshotDto } from './battleSession';
import type { BattleStateDto } from './combat-realm';

export type TowerFloorKindDto = 'normal' | 'elite' | 'boss';

export interface TowerFloorPreviewDto {
  floor: number;
  kind: TowerFloorKindDto;
  seed: string;
  realm: string;
  monsterIds: string[];
  monsterNames: string[];
}

export interface TowerOverviewDto {
  progress: {
    bestFloor: number;
    nextFloor: number;
    currentRunId: string | null;
    currentFloor: number | null;
    lastSettledFloor: number;
  };
  activeSession: BattleSessionSnapshotDto | null;
  nextFloorPreview: TowerFloorPreviewDto;
}

export interface TowerRankRowDto {
  rank: number;
  characterId: number;
  name: string;
  realm: string;
  bestFloor: number;
  reachedAt: string | null;
}

export interface TowerOverviewResponse {
  success: boolean;
  message?: string;
  data?: TowerOverviewDto;
}

export interface TowerStartResponse {
  success: boolean;
  message?: string;
  data?: {
    session: BattleSessionSnapshotDto;
    state?: BattleStateDto;
  };
}

export const getTowerOverview = (
  requestConfig?: AxiosRequestConfig,
): Promise<TowerOverviewResponse> => {
  return api.get('/tower/overview', requestConfig);
};

export const startTowerChallenge = (
  requestConfig?: AxiosRequestConfig,
): Promise<TowerStartResponse> => {
  return api.post('/tower/challenge/start', {}, requestConfig);
};

export const getTowerRankList = (
  limit: number = 50,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message?: string; data?: TowerRankRowDto[] }> => {
  return api.get('/tower/rank', {
    ...requestConfig,
    params: {
      ...(requestConfig?.params && typeof requestConfig.params === 'object'
        ? requestConfig.params
        : {}),
      limit,
    },
  });
};
