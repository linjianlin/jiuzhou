import api from './core';

export type RealmRankRowDto = {
  rank: number;
  name: string;
  realm: string;
  power: number;
};

export type SectRankRowDto = {
  rank: number;
  name: string;
  level: number;
  leader: string;
  members: number;
  memberCap: number;
  power: number;
};

export type WealthRankRowDto = {
  rank: number;
  name: string;
  realm: string;
  spiritStones: number;
  silver: number;
};

export type ArenaRankRowDto = {
  rank: number;
  name: string;
  realm: string;
  score: number;
  winCount: number;
  loseCount: number;
};

export interface RankOverviewResponse {
  success: boolean;
  message: string;
  data?: {
    realm: RealmRankRowDto[];
    sect: SectRankRowDto[];
    wealth: WealthRankRowDto[];
  };
}

export const getRankOverview = (limitPlayers: number = 50, limitSects: number = 30): Promise<RankOverviewResponse> => {
  return api.get('/rank/overview', { params: { limitPlayers, limitSects } });
};

export const getArenaRanks = (
  limit: number = 50
): Promise<{ success: boolean; message: string; data?: ArenaRankRowDto[] }> => {
  return api.get('/rank/arena', { params: { limit } });
};

export type SectPositionDto = 'leader' | 'vice_leader' | 'elder' | 'elite' | 'disciple';

export type SectDefDto = {
  id: string;
  name: string;
  leader_id: number;
  level: number;
  exp: string | number;
  funds: string | number;
  reputation: string | number;
  build_points: number;
  announcement: string | null;
  description: string | null;
  join_type: 'open' | 'apply' | 'invite';
  join_min_realm: string;
  member_count: number;
  max_members: number;
  created_at: string;
  updated_at: string;
};

export type SectMemberDto = {
  characterId: number;
  nickname: string;
  realm: string;
  position: SectPositionDto;
  contribution: number;
  weeklyContribution: number;
  joinedAt: string;
};

export type SectBuildingDto = {
  id: number;
  sect_id: string;
  building_type: string;
  level: number;
  status: string;
  upgrade_start_at: string | null;
  upgrade_end_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SectInfoDto = {
  sect: SectDefDto;
  members: SectMemberDto[];
  buildings: SectBuildingDto[];
};

export type SectListItemDto = {
  id: string;
  name: string;
  level: number;
  memberCount: number;
  maxMembers: number;
  joinType: 'open' | 'apply' | 'invite';
  joinMinRealm: string;
  announcement: string | null;
};

export interface SectSearchResponse {
  success: boolean;
  message: string;
  list?: SectListItemDto[];
  page?: number;
  limit?: number;
  total?: number;
}

export interface GetMySectResponse {
  success: boolean;
  message: string;
  data?: SectInfoDto | null;
}

export const getMySect = (): Promise<GetMySectResponse> => {
  return api.get('/sect/me');
};

export const searchSects = (keyword?: string, page: number = 1, limit: number = 20): Promise<SectSearchResponse> => {
  return api.get('/sect/search', { params: { keyword, page, limit } });
};

export const getSectInfo = (sectId: string): Promise<{ success: boolean; message: string; data?: SectInfoDto }> => {
  return api.get(`/sect/${sectId}`);
};

export const createSect = (name: string, description?: string): Promise<{ success: boolean; message: string; sectId?: string }> => {
  return api.post('/sect/create', { name, description });
};

export const applyToSect = (sectId: string, message?: string): Promise<{ success: boolean; message: string }> => {
  return api.post('/sect/apply', { sectId, message });
};

export const leaveSect = (): Promise<{ success: boolean; message: string }> => {
  return api.post('/sect/leave');
};

export const getSectBuildings = (): Promise<{ success: boolean; message: string; data?: SectBuildingDto[] }> => {
  return api.get('/sect/buildings/list');
};

export const upgradeSectBuilding = (buildingType: string): Promise<{ success: boolean; message: string }> => {
  return api.post('/sect/buildings/upgrade', { buildingType });
};

export type SectApplicationDto = {
  id: number;
  characterId: number;
  nickname: string;
  realm: string;
  message: string | null;
  createdAt: string;
};

export interface SectApplicationsResponse {
  success: boolean;
  message: string;
  data?: SectApplicationDto[];
}

export const getSectApplications = (): Promise<SectApplicationsResponse> => {
  return api.get('/sect/applications/list');
};

export const handleSectApplication = (
  applicationId: number,
  approve: boolean
): Promise<{ success: boolean; message: string }> => {
  return api.post('/sect/applications/handle', { applicationId, approve });
};

export const cancelSectApplication = (applicationId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/sect/applications/cancel', { applicationId });
};
