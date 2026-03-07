import type { AxiosRequestConfig } from 'axios';
import api from './core';

type RequestConfig = AxiosRequestConfig;

export type GridPosition = 'NW' | 'N' | 'NE' | 'W' | 'C' | 'E' | 'SW' | 'S' | 'SE';

export interface WorldMapAreaDto {
  id: GridPosition;
  name: string;
  description: string;
  level: string;
}

export interface WorldMapResponse {
  success: boolean;
  message?: string;
  data?: {
    mapName: string;
    areas: WorldMapAreaDto[];
    connections: Array<[GridPosition, GridPosition]>;
  };
}

export const getWorldMap = (): Promise<WorldMapResponse> => {
  return api.get('/map/world');
};

export type MapObjectDto =
  | {
      type: 'npc';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'monster';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      base_attrs?: Record<string, number>;
      attr_variance?: number;
      attr_multiplier_min?: number;
      attr_multiplier_max?: number;
      stats?: Array<{ label: string; value: string | number }>;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'item';
      id: string;
      object_kind?: 'resource' | 'item' | 'board';
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      resource?: {
        collectLimit: number;
        usedCount: number;
        remaining: number;
        cooldownSec: number;
        respawnSec: number;
        cooldownUntil?: string | null;
      };
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      stats?: Array<{ label: string; value: string | number }>;
    }
  | {
      type: 'player';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      equipment?: Array<{ slot: string; name: string; quality: string }>;
      techniques?: Array<{ name: string; level: string; type: string }>;
    };

export interface MapDefLite {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  background_image: string | null;
  map_type: string;
  region: string | null;
  req_level_min: number;
  req_realm_min: string | null;
  sort_weight: number;
}

export interface MapsResponse {
  success: boolean;
  message?: string;
  data?: { maps: MapDefLite[] };
}

export const getEnabledMaps = (requestConfig?: RequestConfig): Promise<MapsResponse> => {
  return api.get('/map/maps', requestConfig);
};

export type MapRoom = {
  id: string;
  name: string;
  description?: string;
  position?: { x: number; y: number };
  room_type?: string;
  connections?: Array<{
    direction: string;
    target_room_id: string;
    target_map_id?: string;
    req_item_id?: string;
    req_realm_min?: string;
  }>;
  npcs?: string[];
  monsters?: Array<{ monster_def_id: string; count: number; respawn_sec?: number; name?: string }>;
  resources?: Array<{ resource_id: string; count: number; respawn_sec?: number; collect_limit?: number }>;
  items?: Array<{ item_def_id: string; once?: boolean; chance?: number; req_quest_id?: string }>;
  portals?: Array<{ target_map_id: string; target_room_id: string; name: string; req_realm_min?: string }>;
  events?: Array<{ event_id: string; trigger: string; once?: boolean }>;
};

export interface MapDetailResponse {
  success: boolean;
  message?: string;
  data?: { map: Record<string, unknown>; rooms: MapRoom[] };
}

export const getMapDetail = (mapId: string, requestConfig?: RequestConfig): Promise<MapDetailResponse> => {
  return api.get(`/map/${mapId}`, requestConfig);
};

export interface RoomObjectsResponse {
  success: boolean;
  message?: string;
  data?: { mapId: string; roomId: string; objects: MapObjectDto[] };
}

export const getRoomObjects = (mapId: string, roomId: string, requestConfig?: RequestConfig): Promise<RoomObjectsResponse> => {
  return api.get(`/map/${mapId}/rooms/${roomId}/objects`, requestConfig);
};

export interface GameTimeSnapshotDto {
  era_name: string;
  base_year: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  shichen: string;
  weather: string;
  scale: number;
  server_now_ms: number;
  game_elapsed_ms: number;
}

export const getGameTime = (requestConfig?: RequestConfig): Promise<{ success: boolean; message?: string; data?: GameTimeSnapshotDto }> => {
  return api.get('/time', requestConfig);
};

export interface GatherRoomResourceResponse {
  success: boolean;
  message?: string;
  data?: { itemDefId: string; qty: number; remaining: number; cooldownSec: number; actionSec?: number; gatherUntil?: string | null };
}

export const gatherRoomResource = (mapId: string, roomId: string, resourceId: string): Promise<GatherRoomResourceResponse> => {
  return api.post(`/map/${mapId}/rooms/${roomId}/resources/${resourceId}/gather`);
};

export interface PickupRoomItemResponse {
  success: boolean;
  message?: string;
  data?: { itemDefId: string; qty: number };
}

export const pickupRoomItem = (mapId: string, roomId: string, itemDefId: string): Promise<PickupRoomItemResponse> => {
  return api.post(`/map/${mapId}/rooms/${roomId}/items/${itemDefId}/pickup`);
};

export type DungeonType = 'material' | 'equipment' | 'trial' | 'challenge' | 'event';

export interface DungeonDefLite {
  id: string;
  name: string;
  type: DungeonType;
  category: string | null;
  description: string | null;
  icon: string | null;
  background: string | null;
  min_players: number;
  max_players: number;
  min_realm: string | null;
  recommended_realm: string | null;
  unlock_condition: unknown;
  daily_limit: number;
  weekly_limit: number;
  stamina_cost: number;
  time_limit_sec: number;
  revive_limit: number;
  tags: unknown;
  sort_weight: number;
  enabled: boolean;
  version: number;
}

export interface DungeonListResponse {
  success: boolean;
  message?: string;
  data?: { dungeons: DungeonDefLite[] };
}

export const getDungeonList = (params?: {
  type?: DungeonType;
  q?: string;
  realm?: string;
}, requestConfig?: RequestConfig): Promise<DungeonListResponse> => {
  return api.get('/dungeon/list', {
    ...requestConfig,
    params: { ...(requestConfig?.params ?? {}), ...params },
  });
};

export interface DungeonPreviewResponse {
  success: boolean;
  message?: string;
  data?: {
    dungeon: DungeonDefLite | null;
    difficulty: { id: string; name: string; difficulty_rank: number } | null;
    entry:
      | {
          daily_limit: number;
          weekly_limit: number;
          daily_used: number;
          weekly_used: number;
          daily_remaining: number | null;
          weekly_remaining: number | null;
        }
      | null;
    stages: Array<{
      id: string;
      stage_index: number;
      name: string | null;
      type: string;
      waves: Array<{
        wave_index: number;
        spawn_delay_sec: number;
        monsters: Array<{
          id: string;
          name: string;
          realm: string | null;
          level: number;
          avatar: string | null;
          kind: string | null;
          count: number;
          drop_pool_id: string | null;
          drop_preview: Array<{
            item: { id: string; name: string; quality: string | null; icon: string | null };
            mode: 'prob' | 'weight';
            chance: number | null;
            weight: number | null;
            qty_min: number;
            qty_max: number;
            quality_weights: Record<string, unknown> | null;
            bind_type: string | null;
          }>;
        }>;
      }>;
    }>;
    monsters: Array<{ id: string; name: string; realm: string | null; level: number; avatar: string | null; kind: string | null }>;
    drops: Array<{ id: string; name: string; quality: string | null; icon: string | null; from: string }>;
  };
}

export const getDungeonPreview = (dungeonId: string, rank?: number, requestConfig?: RequestConfig): Promise<DungeonPreviewResponse> => {
  return api.get(`/dungeon/preview/${dungeonId}`, {
    ...requestConfig,
    params: { ...(requestConfig?.params ?? {}), rank },
  });
};

export interface DungeonWeeklyTargetDto {
  id: string;
  title: string;
  description: string;
  target: number;
  current: number;
  done: boolean;
  progress: number;
}

export interface DungeonWeeklyTargetsResponse {
  success: boolean;
  message?: string;
  data?: {
    period: { weekStart: string; weekEnd: string };
    summary: { totalClears: number; targetClears: number };
    targets: DungeonWeeklyTargetDto[];
  };
}

export const getDungeonWeeklyTargets = (): Promise<DungeonWeeklyTargetsResponse> => {
  return api.get('/dungeon/weekly-targets');
};

export type DungeonInstanceStatus = 'preparing' | 'running' | 'cleared' | 'failed' | 'abandoned';

export type DungeonInstanceParticipant = {
  userId: number;
  characterId: number;
  role: 'leader' | 'member';
};

export interface CreateDungeonInstanceResponse {
  success: boolean;
  message?: string;
  data?: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] };
}

export const createDungeonInstance = (dungeonId: string, difficultyRank: number): Promise<CreateDungeonInstanceResponse> => {
  return api.post('/dungeon/instance/create', { dungeonId, difficultyRank });
};

export interface JoinDungeonInstanceResponse {
  success: boolean;
  message?: string;
  data?: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] };
}

export const joinDungeonInstance = (instanceId: string): Promise<JoinDungeonInstanceResponse> => {
  return api.post('/dungeon/instance/join', { instanceId });
};

export interface StartDungeonInstanceResponse {
  success: boolean;
  message?: string;
  data?: { instanceId: string; status: DungeonInstanceStatus; battleId: string; state: unknown };
}

export const startDungeonInstance = (instanceId: string): Promise<StartDungeonInstanceResponse> => {
  return api.post('/dungeon/instance/start', { instanceId });
};

export interface NextDungeonInstanceResponse {
  success: boolean;
  message?: string;
  data?: { instanceId: string; status: DungeonInstanceStatus; battleId?: string; state?: unknown; finished?: boolean };
}

export const nextDungeonInstance = (instanceId: string): Promise<NextDungeonInstanceResponse> => {
  return api.post('/dungeon/instance/next', { instanceId });
};

export interface GetDungeonInstanceResponse {
  success: boolean;
  message?: string;
  data?: {
    instance: {
      id: string;
      dungeonId: string;
      difficultyId: string;
      status: DungeonInstanceStatus;
      currentStage: number;
      currentWave: number;
      participants: DungeonInstanceParticipant[];
      currentBattleId: string | null;
      startTime: string | null;
      endTime: string | null;
    };
  };
}

export const getDungeonInstance = (instanceId: string): Promise<GetDungeonInstanceResponse> => {
  return api.get(`/dungeon/instance/${instanceId}`);
};

export interface InfoTargetDetailResponse {
  success: boolean;
  message?: string;
  data?: { target: MapObjectDto };
}

export const getInfoTargetDetail = (
  type: MapObjectDto['type'],
  id: string,
  requestConfig?: RequestConfig,
): Promise<InfoTargetDetailResponse> => {
  return api.get(`/info/${type}/${id}`, requestConfig);
};
