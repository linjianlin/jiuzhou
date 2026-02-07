import axios from 'axios';

const normalizeBaseUrl = (raw: string): string => {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
};

const isLoopbackHostname = (hostname: string): boolean => {
  const h = String(hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
};

const resolveApiBase = (): string => {
  const fromEnv = normalizeBaseUrl((import.meta.env.VITE_API_BASE as string | undefined) ?? '');

  if (typeof window === 'undefined' || !window.location) {
    return fromEnv || 'http://localhost:6011/api';
  }

  const protocol = window.location.protocol || 'http:';
  const hostname = window.location.hostname;

  // 生产环境使用同域名，开发环境使用 6011 端口
  const isDev = isLoopbackHostname(hostname);
  const runtimeDefault = isDev
    ? `${protocol}//${hostname}:6011/api`
    : `${protocol}//${hostname}/api`;

  const base = fromEnv || runtimeDefault;

  try {
    const url = new URL(base);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(hostname)) {
      url.hostname = hostname;
      return normalizeBaseUrl(url.toString());
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    if (base.startsWith('/')) return normalizeBaseUrl(`${window.location.origin}${base}`);
    return base;
  }
};

export const API_BASE = resolveApiBase();
export const SERVER_BASE = API_BASE.replace(/\/api\/?$/, '');

// CDN 静态资源地址（可选）
// 用于动态加载的图片等资源，如物品图标、头像等
const resolveCdnBase = (): string => {
  const fromEnv = normalizeBaseUrl((import.meta.env.VITE_CDN_BASE as string | undefined) ?? '');
  // 如果未配置 CDN，则回退到 SERVER_BASE
  return fromEnv || SERVER_BASE;
};

export const CDN_BASE = resolveCdnBase();

/**
 * 解析资源 URL
 * - /uploads/* 用户上传内容 -> SERVER_BASE
 * - 其他静态资源路径 -> CDN_BASE
 * - 已经是完整 URL 的直接返回
 */
export const resolveAssetUrl = (path: string): string => {
  const raw = (path ?? '').trim();
  if (!raw) return '';
  // 已经是完整 URL
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  // 用户上传内容，必须从服务器获取
  if (raw.startsWith('/uploads/')) return `${SERVER_BASE}${raw}`;
  // 其他静态资源路径，从 CDN 获取
  if (raw.startsWith('/')) return `${CDN_BASE}${raw}`;
  // 相对路径，尝试补全
  return `${CDN_BASE}/${raw}`;
};

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器 - 添加token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const message = error.response?.data?.message || '网络错误';
    return Promise.reject({ success: false, message });
  }
);

export interface AuthResponse {
  success: boolean;
  message: string;
  data?: {
    user: {
      id: number;
      username: string;
    };
    token: string;
  };
}

export interface CharacterResponse {
  success: boolean;
  message: string;
  data?: {
    character: {
      id: number;
      nickname: string;
      gender: string;
      title: string;
      realm: string;
      sub_realm: string | null;
      spirit_stones: number;
      silver: number;
      qixue: number;
      max_qixue: number;
      wugong: number;
      wufang: number;
    };
    hasCharacter: boolean;
  };
}

// 登录
export const login = (username: string, password: string): Promise<AuthResponse> => {
  return api.post('/auth/login', { username, password });
};

// 注册
export const register = (username: string, password: string): Promise<AuthResponse> => {
  return api.post('/auth/register', { username, password });
};

// 验证会话（持久登录检查）
export interface VerifyResponse {
  success: boolean;
  message: string;
  kicked?: boolean;
  data?: { userId: number };
}

export const verifySession = (): Promise<VerifyResponse> => {
  return api.get('/auth/verify');
};

// 检查是否有角色
export const checkCharacter = (): Promise<CharacterResponse> => {
  return api.get('/character/check');
};

// 创建角色
export const createCharacter = (nickname: string, gender: 'male' | 'female'): Promise<CharacterResponse> => {
  return api.post('/character/create', { nickname, gender });
};

// 获取角色信息
export const getCharacterInfo = (): Promise<CharacterResponse> => {
  return api.get('/character/info');
};

export const updateCharacterPosition = (currentMapId: string, currentRoomId: string): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updatePosition', { currentMapId, currentRoomId });
};

export const updateCharacterPositionKeepalive = (currentMapId: string, currentRoomId: string): void => {
  const mapId = String(currentMapId || '').trim();
  const roomId = String(currentRoomId || '').trim();
  if (!mapId || !roomId) return;

  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  void fetch(`${API_BASE}/character/updatePosition`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ currentMapId: mapId, currentRoomId: roomId }),
    keepalive: true,
  }).catch(() => undefined);
};

export const updateCharacterAutoCastSkills = (enabled: boolean): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateAutoCastSkills', { enabled });
};

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

export interface SignInRecordDto {
  date: string;
  signedAt: string;
  reward: number;
  isHoliday: boolean;
  holidayName: string | null;
}

export interface SignInOverviewResponse {
  success: boolean;
  message: string;
  data?: {
    today: string;
    signedToday: boolean;
    month: string;
    monthSignedCount: number;
    streakDays: number;
    records: Record<string, SignInRecordDto>;
  };
}

export const getSignInOverview = (month?: string): Promise<SignInOverviewResponse> => {
  return api.get('/signin/overview', { params: { month } });
};

export interface DoSignInResponse {
  success: boolean;
  message: string;
  data?: {
    date: string;
    reward: number;
    isHoliday: boolean;
    holidayName: string | null;
    spiritStones: number;
  };
}

export const doSignIn = (): Promise<DoSignInResponse> => {
  return api.post('/signin/do');
};

export interface MonthCardStatusResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    name: string;
    description: string | null;
    durationDays: number;
    dailySpiritStones: number;
    priceSpiritStones: number;
    active: boolean;
    expireAt: string | null;
    daysLeft: number;
    today: string;
    lastClaimDate: string | null;
    canClaim: boolean;
    spiritStones: number;
  };
}

export const getMonthCardStatus = (monthCardId?: string): Promise<MonthCardStatusResponse> => {
  return api.get('/monthcard/status', { params: { monthCardId } });
};

export interface MonthCardBuyResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
    spiritStones: number;
  };
}

export const buyMonthCard = (monthCardId?: string): Promise<MonthCardBuyResponse> => {
  return api.post('/monthcard/buy', { monthCardId });
};

export type BattlePassTaskDto = {
  id: string;
  code: string;
  name: string;
  description: string;
  taskType: 'daily' | 'weekly' | 'season';
  condition: unknown;
  targetValue: number;
  rewardExp: number;
  rewardExtra: unknown[];
  enabled: boolean;
  sortWeight: number;
  progressValue: number;
  completed: boolean;
  claimed: boolean;
};

export type BattlePassTasksOverviewDto = {
  seasonId: string;
  daily: BattlePassTaskDto[];
  weekly: BattlePassTaskDto[];
  season: BattlePassTaskDto[];
};

export type BattlePassTasksResponse = {
  success: boolean;
  message: string;
  data?: BattlePassTasksOverviewDto;
};

export const getBattlePassTasks = (seasonId?: string): Promise<BattlePassTasksResponse> => {
  return api.get('/battlepass/tasks', { params: { seasonId } });
};

export type BattlePassStatusDto = {
  seasonId: string;
  seasonName: string;
  exp: number;
  level: number;
  maxLevel: number;
  expPerLevel: number;
  premiumUnlocked: boolean;
  claimedFreeLevels: number[];
  claimedPremiumLevels: number[];
};

export type BattlePassStatusResponse = {
  success: boolean;
  message: string;
  data?: BattlePassStatusDto;
};

export const getBattlePassStatus = (): Promise<BattlePassStatusResponse> => {
  return api.get('/battlepass/status');
};

export type BattlePassRewardItem = {
  type: string;
  currency?: string;
  amount?: number;
  itemDefId?: string;
  item_def_id?: string;
  qty?: number;
};

export type BattlePassRewardDto = {
  level: number;
  freeRewards: BattlePassRewardItem[];
  premiumRewards: BattlePassRewardItem[];
};

export type BattlePassRewardsResponse = {
  success: boolean;
  message: string;
  data?: BattlePassRewardDto[];
};

export const getBattlePassRewards = (seasonId?: string): Promise<BattlePassRewardsResponse> => {
  return api.get('/battlepass/rewards', { params: { seasonId } });
};

export type ClaimBattlePassRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    level: number;
    track: 'free' | 'premium';
    rewards: BattlePassRewardItem[];
    spiritStones?: number;
    silver?: number;
  };
};

export const claimBattlePassReward = (level: number, track: 'free' | 'premium'): Promise<ClaimBattlePassRewardResponse> => {
  return api.post('/battlepass/claim', { level, track });
};

export type TaskCategory = 'main' | 'side' | 'daily' | 'event';

export type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

export type TaskObjectiveDto = {
  id: string;
  type: string;
  text: string;
  done: number;
  target: number;
  params?: Record<string, unknown>;
};

export type TaskRewardDto =
  | { type: 'silver'; name: string; amount: number }
  | { type: 'spirit_stones'; name: string; amount: number }
  | { type: 'item'; itemDefId: string; name: string; icon: string | null; amount: number };

export type TaskOverviewRowDto = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  mapId: string | null;
  roomId: string | null;
  status: TaskStatus;
  tracked: boolean;
  description: string;
  objectives: TaskObjectiveDto[];
  rewards: TaskRewardDto[];
};

export type TaskOverviewResponse = {
  success: boolean;
  message: string;
  data?: { tasks: TaskOverviewRowDto[] };
};

export const getTaskOverview = (category?: TaskCategory): Promise<TaskOverviewResponse> => {
  return api.get('/task/overview', { params: { category } });
};

export type BountyTaskSourceType = 'daily' | 'player';

export type BountyTaskOverviewRowDto = Omit<TaskOverviewRowDto, 'category'> & {
  category: 'bounty';
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

export type BountyTaskOverviewResponse = {
  success: boolean;
  message: string;
  data?: { tasks: BountyTaskOverviewRowDto[] };
};

export const getBountyTaskOverview = (): Promise<BountyTaskOverviewResponse> => {
  return api.get('/task/bounty/overview');
};

export type SetTaskTrackedResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string; tracked: boolean };
};

export const setTaskTracked = (taskId: string, tracked: boolean): Promise<SetTaskTrackedResponse> => {
  return api.post('/task/track', { taskId, tracked });
};

export type ClaimTaskRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    taskId: string;
    rewards: Array<
      | { type: 'silver'; amount: number }
      | { type: 'spirit_stones'; amount: number }
      | { type: 'item'; itemDefId: string; qty: number; itemIds?: number[]; itemName?: string; itemIcon?: string }
    >;
  };
};

export const claimTaskReward = (taskId: string): Promise<ClaimTaskRewardResponse> => {
  return api.post('/task/claim', { taskId });
};

export type NpcTalkTaskStatus = 'locked' | 'available' | 'accepted' | 'turnin' | 'claimable' | 'claimed';

export type NpcTalkTaskOption = {
  taskId: string;
  title: string;
  category: TaskCategory;
  status: NpcTalkTaskStatus;
};

export type NpcTalkResponse = {
  success: boolean;
  message: string;
  data?: { npcId: string; npcName: string; lines: string[]; tasks: NpcTalkTaskOption[] };
};

export const npcTalk = (npcId: string): Promise<NpcTalkResponse> => {
  return api.post('/task/npc/talk', { npcId });
};

export type NpcAcceptTaskResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string };
};

export const acceptTaskFromNpc = (npcId: string, taskId: string): Promise<NpcAcceptTaskResponse> => {
  return api.post('/task/npc/accept', { npcId, taskId });
};

export type NpcSubmitTaskResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string };
};

export const submitTaskToNpc = (npcId: string, taskId: string): Promise<NpcSubmitTaskResponse> => {
  return api.post('/task/npc/submit', { npcId, taskId });
};

export type AchievementListStatus = 'in_progress' | 'completed' | 'claimed' | 'claimable' | 'all';

export type AchievementTrackType = 'counter' | 'flag' | 'multi';

export type AchievementRewardView =
  | { type: 'silver' | 'spirit_stones' | 'exp'; amount: number }
  | { type: 'item'; itemDefId: string; qty: number; itemName?: string; itemIcon?: string | null };

export type AchievementItemDto = {
  id: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  points: number;
  icon: string | null;
  hidden: boolean;
  status: 'in_progress' | 'completed' | 'claimed';
  claimable: boolean;
  trackType: AchievementTrackType;
  trackKey: string;
  progress: {
    current: number;
    target: number;
    percent: number;
    done: boolean;
    status: 'in_progress' | 'completed' | 'claimed';
    progressData?: Record<string, number | boolean | string>;
  };
  rewards: AchievementRewardView[];
  titleId: string | null;
  sortWeight: number;
};

export type AchievementPointsInfoDto = {
  total: number;
  byCategory: {
    combat: number;
    cultivation: number;
    exploration: number;
    social: number;
    collection: number;
  };
};

export type AchievementListResponse = {
  success: boolean;
  message: string;
  data?: {
    achievements: AchievementItemDto[];
    total: number;
    page: number;
    limit: number;
    points: AchievementPointsInfoDto;
  };
};

export const getAchievementList = (params?: {
  category?: string;
  status?: AchievementListStatus;
  page?: number;
  limit?: number;
}): Promise<AchievementListResponse> => {
  return api.get('/achievement/list', { params });
};

export type AchievementDetailResponse = {
  success: boolean;
  message: string;
  data?: {
    achievement: AchievementItemDto;
    progress: AchievementItemDto['progress'];
  };
};

export const getAchievementDetail = (achievementId: string): Promise<AchievementDetailResponse> => {
  return api.get(`/achievement/${achievementId}`);
};

export type ClaimAchievementResponse = {
  success: boolean;
  message: string;
  data?: {
    achievementId: string;
    rewards: AchievementRewardView[];
    title?: {
      id: string;
      name: string;
      rarity: string;
      color: string | null;
      icon: string | null;
    };
  };
};

export const claimAchievementReward = (achievementId: string): Promise<ClaimAchievementResponse> => {
  return api.post('/achievement/claim', { achievementId });
};

export type AchievementPointRewardDto = {
  id: string;
  threshold: number;
  name: string;
  description: string;
  rewards: AchievementRewardView[];
  title?: {
    id: string;
    name: string;
    rarity: string;
    color: string | null;
    icon: string | null;
  };
  claimable: boolean;
  claimed: boolean;
};

export type AchievementPointsRewardListResponse = {
  success: boolean;
  message: string;
  data?: {
    totalPoints: number;
    claimedThresholds: number[];
    rewards: AchievementPointRewardDto[];
  };
};

export const getAchievementPointsRewards = (): Promise<AchievementPointsRewardListResponse> => {
  return api.get('/achievement/points/rewards');
};

export type ClaimAchievementPointsRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    threshold: number;
    rewards: AchievementRewardView[];
    title?: {
      id: string;
      name: string;
      rarity: string;
      color: string | null;
      icon: string | null;
    };
  };
};

export const claimAchievementPointsReward = (threshold: number): Promise<ClaimAchievementPointsRewardResponse> => {
  return api.post('/achievement/points/claim', { threshold });
};

export type TitleInfoDto = {
  id: string;
  name: string;
  description: string;
  rarity: string;
  color: string | null;
  icon: string | null;
  effects: Record<string, number>;
  isEquipped: boolean;
  obtainedAt: string;
};

export type TitleListResponse = {
  success: boolean;
  message: string;
  data?: { titles: TitleInfoDto[]; equipped: string };
};

export const getTitleList = (): Promise<TitleListResponse> => {
  return api.get('/title/list');
};

export type EquipTitleResponse = {
  success: boolean;
  message: string;
};

export const equipTitle = (titleId: string): Promise<EquipTitleResponse> => {
  return api.post('/title/equip', { titleId });
};

export interface MonthCardUseItemResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
  };
}

export const activateMonthCardItem = (params?: {
  monthCardId?: string;
  itemInstanceId?: number;
}): Promise<MonthCardUseItemResponse> => {
  return api.post('/monthcard/use-item', params || {});
};

export interface MonthCardClaimResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    date: string;
    rewardSpiritStones: number;
    spiritStones: number;
  };
}

export const claimMonthCardReward = (monthCardId?: string): Promise<MonthCardClaimResponse> => {
  return api.post('/monthcard/claim', { monthCardId });
};

// 上传头像
export interface UploadResponse {
  success: boolean;
  message: string;
  avatarUrl?: string;
}

export const uploadAvatar = (file: File): Promise<UploadResponse> => {
  const formData = new FormData();
  formData.append('avatar', file);
  return api.post('/upload/avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

// 删除头像
export const deleteAvatar = (): Promise<{ success: boolean; message: string }> => {
  return api.delete('/upload/avatar');
};

// 加点接口
export interface AddPointResponse {
  success: boolean;
  message: string;
  data?: {
    attribute: string;
    newValue: number;
    remainingPoints: number;
  };
}

export const addAttributePoint = (
  attribute: 'jing' | 'qi' | 'shen',
  amount: number = 1
): Promise<AddPointResponse> => {
  return api.post('/attribute/add', { attribute, amount });
};

// 减点
export const removeAttributePoint = (
  attribute: 'jing' | 'qi' | 'shen',
  amount: number = 1
): Promise<AddPointResponse> => {
  return api.post('/attribute/remove', { attribute, amount });
};

// 批量加点
export const batchAddPoints = (points: {
  jing?: number;
  qi?: number;
  shen?: number;
}): Promise<AddPointResponse> => {
  return api.post('/attribute/batch', points);
};

// 重置属性点
export const resetAttributePoints = (): Promise<{
  success: boolean;
  message: string;
  totalPoints?: number;
}> => {
  return api.post('/attribute/reset');
};

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

export interface AreaObjectsResponse {
  success: boolean;
  message?: string;
  data?: {
    area: GridPosition;
    objects: MapObjectDto[];
  };
}

export const getAreaObjects = (area: GridPosition): Promise<AreaObjectsResponse> => {
  return api.get(`/map/area/${area}/objects`);
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

export const getEnabledMaps = (): Promise<MapsResponse> => {
  return api.get('/map/maps');
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
  monsters?: Array<{ monster_def_id: string; count: number; respawn_sec?: number }>;
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

export const getMapDetail = (mapId: string): Promise<MapDetailResponse> => {
  return api.get(`/map/${mapId}`);
};

export interface RoomObjectsResponse {
  success: boolean;
  message?: string;
  data?: { mapId: string; roomId: string; objects: MapObjectDto[] };
}

export const getRoomObjects = (mapId: string, roomId: string): Promise<RoomObjectsResponse> => {
  return api.get(`/map/${mapId}/rooms/${roomId}/objects`);
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

export const getGameTime = (): Promise<{ success: boolean; message?: string; data?: GameTimeSnapshotDto }> => {
  return api.get('/time');
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
}): Promise<DungeonListResponse> => {
  return api.get('/dungeon/list', { params });
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

export const getDungeonPreview = (dungeonId: string, rank?: number): Promise<DungeonPreviewResponse> => {
  return api.get(`/dungeon/preview/${dungeonId}`, { params: { rank } });
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

export const getInfoTargetDetail = (type: MapObjectDto['type'], id: string): Promise<InfoTargetDetailResponse> => {
  return api.get(`/info/${type}/${id}`);
};

export type BountyClaimPolicyDto = 'unique' | 'limited' | 'unlimited';
export type BountySourceTypeDto = 'daily' | 'player';

export type BountyBoardRowDto = {
  id: number;
  sourceType: BountySourceTypeDto;
  taskId: string;
  title: string;
  description: string;
  claimPolicy: BountyClaimPolicyDto;
  maxClaims: number;
  claimedCount: number;
  refreshDate: string | null;
  expiresAt: string | null;
  publishedByCharacterId: number | null;
  spiritStonesReward: number;
  silverReward: number;
  spiritStonesFee: number;
  silverFee: number;
  requiredItems: Array<{ itemDefId: string; name: string; qty: number }>;
  claimedByMe: boolean;
  myClaimStatus: string | null;
  myTaskStatus: string | null;
};

export interface BountyBoardResponse {
  success: boolean;
  message?: string;
  data?: { bounties: BountyBoardRowDto[]; today: string };
}

export const getBountyBoard = (pool: 'daily' | 'player' | 'all' = 'daily'): Promise<BountyBoardResponse> => {
  return api.get('/bounty/board', { params: { pool } });
};

export const claimBounty = (
  bountyInstanceId: number
): Promise<{ success: boolean; message?: string; data?: { bountyInstanceId: number; taskId: string } }> => {
  return api.post('/bounty/claim', { bountyInstanceId });
};

export const publishBounty = (body: {
  taskId?: string;
  title: string;
  description?: string;
  claimPolicy: BountyClaimPolicyDto;
  maxClaims?: number;
  expiresAt?: string;
  spiritStonesReward: number;
  silverReward: number;
  requiredItems: Array<{ itemDefId: string; qty: number }>;
}): Promise<{ success: boolean; message?: string; data?: { bountyInstanceId: number } }> => {
  return api.post('/bounty/publish', body);
};

export type BountyItemDefSearchRowDto = { id: string; name: string; icon: string | null; category: string | null };

export const searchBountyItemDefs = (
  keyword: string,
  limit: number = 20
): Promise<{ success: boolean; message?: string; data?: { items: BountyItemDefSearchRowDto[] } }> => {
  return api.get('/bounty/items/search', { params: { keyword, limit } });
};

export const submitBountyMaterials = (
  taskId: string
): Promise<{ success: boolean; message?: string; data?: { taskId: string } }> => {
  return api.post('/bounty/submit-materials', { taskId });
};

export type InventoryLocation = 'bag' | 'warehouse' | 'equipped';

export interface InventoryInfoData {
  bag_capacity: number;
  warehouse_capacity: number;
  bag_used: number;
  warehouse_used: number;
}

export interface InventoryInfoResponse {
  success: boolean;
  message?: string;
  data?: InventoryInfoData;
}

export interface ItemDefLite {
  id: string;
  name: string;
  icon: string | null;
  quality: string;
  category: string;
  sub_category: string | null;
  stack_max: number;
  description: string | null;
  long_desc: string | null;
  tags: unknown;
  effect_defs: unknown;
  base_attrs: unknown;
  equip_slot: string | null;
  use_type: string | null;
}

export interface InventoryItemDto {
  id: number;
  item_def_id: string;
  qty: number;
  location: InventoryLocation;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number;
  refine_level: number;
  affixes: unknown;
  identified: boolean;
  locked: boolean;
  bind_type: string;
  created_at: string;
  def?: ItemDefLite;
}

export interface InventoryItemsResponse {
  success: boolean;
  message?: string;
  data?: {
    items: InventoryItemDto[];
    total: number;
    page: number;
    pageSize: number;
  };
}

export const getInventoryInfo = (): Promise<InventoryInfoResponse> => {
  return api.get('/inventory/info');
};

export const getInventoryItems = (
  location: InventoryLocation = 'bag',
  page: number = 1,
  pageSize: number = 200
): Promise<InventoryItemsResponse> => {
  return api.get('/inventory/items', { params: { location, page, pageSize } });
};

export interface InventoryMoveResponse {
  success: boolean;
  message: string;
}

export const moveInventoryItem = (body: {
  itemId: number;
  targetLocation: 'bag' | 'warehouse';
  targetSlot?: number;
}): Promise<InventoryMoveResponse> => {
  return api.post('/inventory/move', body);
};

export interface InventoryUseResponse {
  success: boolean;
  message: string;
  effects?: unknown[];
  data?: { character: unknown };
}

export const inventoryUseItem = (body: {
  itemInstanceId?: number;
  instanceId?: number;
  itemId?: number;
  qty?: number;
}): Promise<InventoryUseResponse> => {
  return api.post('/inventory/use', body);
};

export interface InventoryEquipResponse {
  success: boolean;
  message: string;
  equippedSlot?: string;
  swappedOutItemId?: number;
  data?: { character: unknown };
}

export const equipInventoryItem = (itemId: number): Promise<InventoryEquipResponse> => {
  return api.post('/inventory/equip', { itemId });
};

export interface InventoryUnequipResponse {
  success: boolean;
  message: string;
  movedTo?: { location: 'bag' | 'warehouse'; slot: number };
  data?: { character: unknown };
}

export const unequipInventoryItem = (
  itemId: number,
  targetLocation: 'bag' | 'warehouse' = 'bag'
): Promise<InventoryUnequipResponse> => {
  return api.post('/inventory/unequip', { itemId, targetLocation });
};

export interface InventoryEnhanceResponse {
  success: boolean;
  message: string;
  data?: { strengthenLevel: number; character: unknown | null };
}

export const enhanceInventoryItem = (itemId: number): Promise<InventoryEnhanceResponse> => {
  return api.post('/inventory/enhance', { itemId });
};

export interface InventoryDisassembleResponse {
  success: boolean;
  message: string;
  rewards?: { itemDefId: string; qty: number; itemIds?: number[] };
}

export const disassembleInventoryEquipment = (itemId: number): Promise<InventoryDisassembleResponse> => {
  return api.post('/inventory/disassemble', { itemId });
};

export interface InventoryDisassembleBatchResponse {
  success: boolean;
  message: string;
  disassembledCount?: number;
  rewards?: Array<{ itemDefId: string; qty: number; itemIds?: number[] }>;
}

export const disassembleInventoryEquipmentBatch = (itemIds: number[]): Promise<InventoryDisassembleBatchResponse> => {
  return api.post('/inventory/disassemble/batch', { itemIds });
};

export interface InventoryRemoveBatchResponse {
  success: boolean;
  message: string;
  removedCount?: number;
  removedQtyTotal?: number;
}

export const removeInventoryItemsBatch = (itemIds: number[]): Promise<InventoryRemoveBatchResponse> => {
  return api.post('/inventory/remove/batch', { itemIds });
};

export const sortInventory = (location: 'bag' | 'warehouse' = 'bag'): Promise<{ success: boolean; message: string }> => {
  return api.post('/inventory/sort', { location });
};

export type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';

export interface MarketListingDto {
  id: number;
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string | null;
  subCategory: string | null;
  description: string | null;
  longDesc: string | null;
  tags: unknown;
  effectDefs: unknown;
  baseAttrs: Record<string, number>;
  equipSlot: string | null;
  equipReqRealm: string | null;
  useType: string | null;
  strengthenLevel: number;
  refineLevel: number;
  identified: boolean;
  affixes: unknown;
  qty: number;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
}

export interface MarketListingsResponse {
  success: boolean;
  message: string;
  data?: { listings: MarketListingDto[]; total: number };
}

export interface MarketMyListingsResponse {
  success: boolean;
  message: string;
  data?: { listings: MarketListingDto[]; total: number };
}

export interface MarketTradeRecordDto {
  id: number;
  type: '买入' | '卖出';
  itemDefId: string;
  name: string;
  icon: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  counterparty: string;
  time: number;
}

export interface MarketTradeRecordsResponse {
  success: boolean;
  message: string;
  data?: { records: MarketTradeRecordDto[]; total: number };
}

export const getMarketListings = (params?: {
  category?: string;
  quality?: string;
  query?: string;
  sort?: MarketSort;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  pageSize?: number;
}): Promise<MarketListingsResponse> => {
  return api.get('/market/listings', { params });
};

export const getMyMarketListings = (params?: {
  status?: 'active' | 'sold' | 'cancelled';
  page?: number;
  pageSize?: number;
}): Promise<MarketMyListingsResponse> => {
  return api.get('/market/my-listings', { params });
};

export const createMarketListing = (body: {
  itemInstanceId: number;
  qty: number;
  unitPriceSpiritStones: number;
}): Promise<{ success: boolean; message: string; data?: { listingId: number } }> => {
  return api.post('/market/list', body);
};

export const cancelMarketListing = (listingId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/cancel', { listingId });
};

export const buyMarketListing = (listingId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/market/buy', { listingId });
};

export const getMarketTradeRecords = (params?: {
  page?: number;
  pageSize?: number;
}): Promise<MarketTradeRecordsResponse> => {
  return api.get('/market/records', { params });
};

// ============================================
// 邮件相关接口
// ============================================

export interface MailAttachItem {
  item_def_id: string;
  item_name?: string;
  quality?: string;
  qty: number;
}

export interface MailDto {
  id: number;
  senderType: string;
  senderName: string;
  mailType: string;
  title: string;
  content: string;
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailAttachItem[];
  readAt: string | null;
  claimedAt: string | null;
  expireAt: string | null;
  createdAt: string;
}

export interface MailListResponse {
  success: boolean;
  message?: string;
  data?: {
    mails: MailDto[];
    total: number;
    unreadCount: number;
    unclaimedCount: number;
    page: number;
    pageSize: number;
  };
}

export interface MailUnreadResponse {
  success: boolean;
  data?: {
    unreadCount: number;
    unclaimedCount: number;
  };
}

export interface MailClaimResponse {
  success: boolean;
  message: string;
  rewards?: {
    silver?: number;
    spiritStones?: number;
    itemIds?: number[];
  };
}

export interface MailClaimAllResponse {
  success: boolean;
  message: string;
  claimedCount: number;
  rewards?: {
    silver: number;
    spiritStones: number;
    itemCount: number;
  };
}

// 获取邮件列表
export const getMailList = (page: number = 1, pageSize: number = 50): Promise<MailListResponse> => {
  return api.get('/mail/list', { params: { page, pageSize } });
};

// 获取未读数量
export const getMailUnread = (): Promise<MailUnreadResponse> => {
  return api.get('/mail/unread');
};

// 阅读邮件
export const readMail = (mailId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/mail/read', { mailId });
};

// 领取附件
export const claimMailAttachments = (mailId: number): Promise<MailClaimResponse> => {
  return api.post('/mail/claim', { mailId });
};

// 一键领取所有附件
export const claimAllMailAttachments = (): Promise<MailClaimAllResponse> => {
  return api.post('/mail/claim-all');
};

// 删除邮件
export const deleteMail = (mailId: number): Promise<{ success: boolean; message: string }> => {
  return api.post('/mail/delete', { mailId });
};

// 一键删除所有邮件
export const deleteAllMails = (onlyRead: boolean = false): Promise<{ success: boolean; message: string; deletedCount: number }> => {
  return api.post('/mail/delete-all', { onlyRead });
};

// 标记全部已读
export const markAllMailsRead = (): Promise<{ success: boolean; message: string; readCount: number }> => {
  return api.post('/mail/read-all');
};

export type TechniqueDefDto = {
  id: string;
  code: string | null;
  name: string;
  type: string;
  quality: string;
  quality_rank: number;
  max_layer: number;
  required_realm: string;
  attribute_type: string;
  attribute_element: string;
  tags: string[];
  description: string | null;
  long_desc: string | null;
  icon: string | null;
  obtain_type: string | null;
  obtain_hint: string[];
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export type TechniqueLayerDto = {
  technique_id: string;
  layer: number;
  cost_spirit_stones: number;
  cost_exp: number;
  cost_materials: unknown;
  passives: unknown;
  unlock_skill_ids: string[];
  upgrade_skill_ids: string[];
  required_realm: string | null;
  required_quest_id: string | null;
  layer_desc: string | null;
};

export type SkillDefDto = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  source_type: string;
  source_id: string | null;
  cost_lingqi: number;
  cost_qixue: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string | null;
  element: string;
  coefficient: number;
  fixed_damage: number;
  scale_attr: string;
  effects: unknown;
  trigger_type: string;
  conditions: unknown;
  ai_priority: number;
  ai_conditions: unknown;
  upgrades: unknown;
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export interface TechniqueListResponse {
  success: boolean;
  message?: string;
  data?: { techniques: TechniqueDefDto[] };
}

export const getEnabledTechniques = (): Promise<TechniqueListResponse> => {
  return api.get('/technique');
};

export interface TechniqueDetailResponse {
  success: boolean;
  message?: string;
  data?: {
    technique: TechniqueDefDto;
    layers: TechniqueLayerDto[];
    skills: SkillDefDto[];
  };
}

export const getTechniqueDetail = (techniqueId: string): Promise<TechniqueDetailResponse> => {
  return api.get(`/technique/${techniqueId}`);
};

export type CharacterTechniqueDto = {
  id: number;
  character_id: number;
  technique_id: string;
  current_layer: number;
  slot_type: 'main' | 'sub' | null;
  slot_index: number | null;
  acquired_at: string;
  technique_name?: string;
  technique_type?: string;
  technique_quality?: string;
  max_layer?: number;
  attribute_type?: string;
  attribute_element?: string;
};

export type CharacterSkillSlotDto = {
  slot_index: number;
  skill_id: string;
  skill_name?: string;
  skill_icon?: string;
};

export interface CharacterTechniqueStatusResponse {
  success: boolean;
  message: string;
  data?: {
    techniques: CharacterTechniqueDto[];
    equippedMain: CharacterTechniqueDto | null;
    equippedSubs: CharacterTechniqueDto[];
    equippedSkills: CharacterSkillSlotDto[];
    availableSkills: Array<{
      skillId: string;
      skillName: string;
      skillIcon: string;
      techniqueId: string;
      techniqueName: string;
      // 完整技能数据
      description: string | null;
      costLingqi: number;
      costQixue: number;
      cooldown: number;
      targetType: string;
      targetCount: number;
      damageType: string | null;
      element: string;
      coefficient: number;
      fixedDamage: number;
      scaleAttr: string;
    }>;
    passives: Record<string, number>;
  };
}

export const getCharacterTechniqueStatus = (characterId: number): Promise<CharacterTechniqueStatusResponse> => {
  return api.get(`/character/${characterId}/technique/status`);
};

export const learnCharacterTechnique = (
  characterId: number,
  techniqueId: string,
  obtainedFrom?: string,
  obtainedRefId?: string
): Promise<{ success: boolean; message: string; data?: unknown }> => {
  return api.post(`/character/${characterId}/technique/learn`, { techniqueId, obtainedFrom, obtainedRefId });
};

export interface TechniqueUpgradeCostResponse {
  success: boolean;
  message: string;
  data?: {
    currentLayer: number;
    maxLayer: number;
    spirit_stones: number;
    exp: number;
    materials: Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null }>;
  };
}

export const getCharacterTechniqueUpgradeCost = (characterId: number, techniqueId: string): Promise<TechniqueUpgradeCostResponse> => {
  return api.get(`/character/${characterId}/technique/${techniqueId}/upgrade-cost`);
};

export const upgradeCharacterTechnique = (
  characterId: number,
  techniqueId: string
): Promise<{ success: boolean; message: string; data?: { newLayer: number; unlockedSkills: string[]; upgradedSkills: string[] } }> => {
  return api.post(`/character/${characterId}/technique/${techniqueId}/upgrade`);
};

export const equipCharacterTechnique = (
  characterId: number,
  techniqueId: string,
  slotType: 'main' | 'sub',
  slotIndex?: number
): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/technique/equip`, { techniqueId, slotType, slotIndex });
};

export const unequipCharacterTechnique = (characterId: number, techniqueId: string): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/technique/unequip`, { techniqueId });
};

export const equipCharacterSkill = (
  characterId: number,
  skillId: string,
  slotIndex: number
): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/skill/equip`, { skillId, slotIndex });
};

export const unequipCharacterSkill = (characterId: number, slotIndex: number): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/skill/unequip`, { slotIndex });
};

export type BattleStateDto = {
  battleId: string;
  battleType: 'pve' | 'pvp';
  teams: {
    attacker: { odwnerId?: number; units: BattleUnitDto[]; totalSpeed: number };
    defender: { odwnerId?: number; units: BattleUnitDto[]; totalSpeed: number };
  };
  roundCount: number;
  currentTeam: 'attacker' | 'defender';
  currentUnitIndex: number;
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

export type BattleLogEntryDto =
  | {
      type: 'action';
      round: number;
      actorId: string;
      actorName: string;
      skillId: string;
      skillName: string;
      targets: Array<{
        targetId: string;
        targetName: string;
        damage?: number;
        heal?: number;
        isMiss?: boolean;
        isCrit?: boolean;
        isParry?: boolean;
        isElementBonus?: boolean;
        shieldAbsorbed?: number;
        buffsApplied?: string[];
        buffsRemoved?: string[];
        controlApplied?: string;
        controlResisted?: boolean;
      }>;
    }
  | { type: 'dot'; round: number; unitId: string; unitName: string; buffName: string; damage: number }
  | { type: 'hot'; round: number; unitId: string; unitName: string; buffName: string; heal: number }
  | { type: 'buff_expire'; round: number; unitId: string; unitName: string; buffName: string }
  | { type: 'death'; round: number; unitId: string; unitName: string; killerId?: string; killerName?: string }
  | { type: 'round_start' | 'round_end'; round: number };

export interface BattleStartResponse {
  success: boolean;
  message: string;
  data?: {
    battleId: string;
    state: BattleStateDto;
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
  data?: {
    state: BattleStateDto;
    result?: 'attacker_win' | 'defender_win' | 'draw';
    rewards?: BattleRewardsDto;
    isTeamBattle?: boolean;
  };
}

export const battleAction = (battleId: string, skillId: string, targetIds: string[]): Promise<BattleActionResponse> => {
  return api.post('/battle/action', { battleId, skillId, targetIds });
};

export interface BattleStateResponse {
  success: boolean;
  message: string;
  data?: { state: BattleStateDto; rewards?: BattleRewardsDto };
}

export const getBattleState = (battleId: string): Promise<BattleStateResponse> => {
  return api.get(`/battle/state/${battleId}`);
};

export const abandonBattle = (battleId: string): Promise<{ success: boolean; message: string }> => {
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

export const getRealmOverview = (): Promise<GetRealmOverviewResponse> => {
  return api.get('/realm/overview');
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

export default api;
