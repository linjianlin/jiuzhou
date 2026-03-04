import type { AxiosRequestConfig } from 'axios';
import api from './core';

export type BattleStateDto = {
  battleId: string;
  battleType: 'pve' | 'pvp';
  teams: {
    attacker: { odwnerId?: number; units: BattleUnitDto[]; totalSpeed: number };
    defender: { odwnerId?: number; units: BattleUnitDto[]; totalSpeed: number };
  };
  roundCount: number;
  currentTeam: 'attacker' | 'defender';
  /** 当前应行动单位的 ID，null 表示当前队伍无可行动单位（回合开始/结束过渡期） */
  currentUnitId: string | null;
  phase: 'roundStart' | 'action' | 'roundEnd' | 'finished';
  firstMover: 'attacker' | 'defender';
  logs: BattleLogEntryDto[];
  result?: 'attacker_win' | 'defender_win' | 'draw';
};

export type BattleUnitDto = {
  id: string;
  name: string;
  type: 'player' | 'monster' | 'npc' | 'summon';
  qixue: number;
  lingqi: number;
  currentAttrs: { max_qixue: number; max_lingqi: number; realm?: string };
  isAlive: boolean;
};

export type BattleActionTargetHitDto = {
  index: number;
  damage: number;
  isMiss: boolean;
  isCrit: boolean;
  isParry: boolean;
  isElementBonus: boolean;
  shieldAbsorbed: number;
};

export type BattleActionTargetDto = {
  targetId: string;
  targetName: string;
  hits: BattleActionTargetHitDto[];
  damage?: number;
  heal?: number;
  resources?: BattleActionTargetResourceDto[];
  isMiss?: boolean;
  isCrit?: boolean;
  isParry?: boolean;
  isElementBonus?: boolean;
  shieldAbsorbed?: number;
  buffsApplied?: string[];
  buffsRemoved?: string[];
  marksApplied?: string[];
  marksConsumed?: string[];
  controlApplied?: string;
  controlResisted?: boolean;
};

export type BattleActionTargetResourceDto = {
  type: 'qixue' | 'lingqi';
  amount: number;
};

export type BattleLogEntryDto =
  | {
      type: 'action';
      round: number;
      actorId: string;
      actorName: string;
      skillId: string;
      skillName: string;
      targets: BattleActionTargetDto[];
    }
  | { type: 'dot'; round: number; unitId: string; unitName: string; buffName: string; damage: number }
  | { type: 'hot'; round: number; unitId: string; unitName: string; buffName: string; heal: number }
  | { type: 'buff_expire'; round: number; unitId: string; unitName: string; buffName: string }
  | { type: 'death'; round: number; unitId: string; unitName: string; killerId?: string; killerName?: string }
  | { type: 'round_start' | 'round_end'; round: number };

export interface BattleCooldownMetaDto {
  battleStartCooldownMs?: number;
  retryAfterMs?: number;
  nextBattleAvailableAt?: number;
}

export interface BattleStartResponse {
  success: boolean;
  message: string;
  data?: BattleCooldownMetaDto & {
    reason?: string;
    battleId?: string;
    state?: BattleStateDto;
    isTeamBattle?: boolean;
    teamMemberCount?: number;
  };
}

export const startPVEBattle = (monsterIds: string[]): Promise<BattleStartResponse> => {
  return api.post('/battle/start', { monsterIds });
};

export interface BattleDropItemDto {
  itemDefId: string;
  name: string;
  quantity: number;
  receiverId: number;
}

export interface BattlePerPlayerRewardDto {
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
}

export interface BattleRewardsDto {
  exp: number;
  silver: number;
  totalExp?: number;
  totalSilver?: number;
  participantCount?: number;
  items?: BattleDropItemDto[];
  perPlayerRewards?: BattlePerPlayerRewardDto[];
}

export interface BattleActionResponse {
  success: boolean;
  message: string;
  data?: BattleCooldownMetaDto & {
    state: BattleStateDto;
    result?: 'attacker_win' | 'defender_win' | 'draw';
    rewards?: BattleRewardsDto;
    isTeamBattle?: boolean;
  };
}

export const battleAction = (
  battleId: string,
  skillId: string,
  targetIds: string[],
  config?: AxiosRequestConfig,
): Promise<BattleActionResponse> => {
  return api.post('/battle/action', { battleId, skillId, targetIds }, config);
};

export interface BattleStateResponse {
  success: boolean;
  message: string;
  data?: { state: BattleStateDto; rewards?: BattleRewardsDto };
}

export const getBattleState = (battleId: string): Promise<BattleStateResponse> => {
  return api.get(`/battle/state/${battleId}`);
};

export const abandonBattle = (battleId: string): Promise<{ success: boolean; message: string; data?: BattleCooldownMetaDto }> => {
  return api.post('/battle/abandon', { battleId });
};

export type ArenaStatusDto = {
  score: number;
  winCount: number;
  loseCount: number;
  todayUsed: number;
  todayLimit: number;
  todayRemaining: number;
};

export type ArenaOpponentDto = {
  id: number;
  name: string;
  realm: string;
  power: number;
  score: number;
};

export type ArenaRecordDto = {
  id: string;
  ts: number;
  opponentName: string;
  opponentRealm: string;
  opponentPower: number;
  result: 'win' | 'lose' | 'draw';
  deltaScore: number;
  scoreAfter: number;
};

export const getArenaStatus = (): Promise<{ success: boolean; message: string; data?: ArenaStatusDto }> => {
  return api.get('/arena/status');
};

export const getArenaOpponents = (limit: number = 10): Promise<{ success: boolean; message: string; data?: ArenaOpponentDto[] }> => {
  return api.get('/arena/opponents', { params: { limit } });
};

export const getArenaRecords = (limit: number = 50): Promise<{ success: boolean; message: string; data?: ArenaRecordDto[] }> => {
  return api.get('/arena/records', { params: { limit } });
};

export const arenaMatch = (): Promise<{
  success: boolean;
  message: string;
  data?: { battleId: string; opponent: ArenaOpponentDto };
}> => {
  return api.post('/arena/match', {});
};

export const arenaChallenge = (opponentCharacterId: number): Promise<{ success: boolean; message: string; data?: { battleId: string } }> => {
  return api.post('/arena/challenge', { opponentCharacterId });
};

export type RealmRequirementStatus = 'done' | 'todo' | 'unknown';

export interface RealmRequirementView {
  id: string;
  title: string;
  detail: string;
  status: RealmRequirementStatus;
  sourceType?: string;
  sourceRef?: string;
}

export interface RealmCostView {
  id: string;
  title: string;
  detail: string;
  type: 'exp' | 'spirit_stones' | 'item';
  status?: RealmRequirementStatus;
  amount?: number;
  itemDefId?: string;
  itemName?: string;
  itemIcon?: string;
  qty?: number;
}

export interface RealmRewardView {
  id: string;
  title: string;
  detail: string;
}

export interface RealmOverviewDto {
  configPath: string | null;
  realmOrder: string[];
  currentRealm: string;
  currentIndex: number;
  nextRealm: string | null;
  exp: number;
  spiritStones: number;
  requirements: RealmRequirementView[];
  costs: RealmCostView[];
  rewards: RealmRewardView[];
  canBreakthrough: boolean;
}

export interface GetRealmOverviewResponse {
  success: boolean;
  message: string;
  data?: RealmOverviewDto;
}

export const getRealmOverview = (requestConfig?: AxiosRequestConfig): Promise<GetRealmOverviewResponse> => {
  return api.get('/realm/overview', requestConfig);
};

export interface RealmBreakthroughResult {
  success: boolean;
  message: string;
  data?: {
    fromRealm: string;
    newRealm: string;
    spentExp: number;
    spentSpiritStones: number;
    spentItems: { itemDefId: string; qty: number; name?: string; icon?: string }[];
    gainedAttributePoints: number;
    currentExp: number;
    currentSpiritStones: number;
  };
}

export const breakthroughToNextRealm = (): Promise<RealmBreakthroughResult> => {
  return api.post('/realm/breakthrough', { direction: 'next' });
};

export interface InsightOverviewDto {
  unlocked: boolean;
  unlockRealm: string;
  currentLevel: number;
  currentProgressExp: number;
  currentBonusPct: number;
  nextLevelCostExp: number;
  characterExp: number;
  costStageLevels: number;
  costStageBaseExp: number;
  bonusPctPerLevel: number;
}

export interface InsightInjectRequest {
  exp: number;
}

export interface InsightInjectResultDto {
  beforeLevel: number;
  afterLevel: number;
  afterProgressExp: number;
  actualInjectedLevels: number;
  spentExp: number;
  remainingExp: number;
  gainedBonusPct: number;
  currentBonusPct: number;
}

export interface GetInsightOverviewResponse {
  success: boolean;
  message: string;
  data?: InsightOverviewDto;
}

export interface InjectInsightResponse {
  success: boolean;
  message: string;
  data?: InsightInjectResultDto;
}

export const getInsightOverview = (
  requestConfig?: AxiosRequestConfig,
): Promise<GetInsightOverviewResponse> => {
  return api.get('/insight/overview', requestConfig);
};

export const injectInsightExp = (
  body: InsightInjectRequest,
  requestConfig?: AxiosRequestConfig,
): Promise<InjectInsightResponse> => {
  return api.post('/insight/inject', body, requestConfig);
};
