export type AchievementTrackType = 'counter' | 'flag' | 'multi';

export type AchievementStatus = 'in_progress' | 'completed' | 'claimed';

export type AchievementRewardConfig =
  | { type: 'silver'; amount: number }
  | { type: 'spirit_stones'; amount: number }
  | { type: 'exp'; amount: number }
  | { type: 'item'; item_def_id: string; qty?: number }
  | Record<string, unknown>;

export type AchievementTargetItem =
  | string
  | {
      key?: string;
      track_key?: string;
      trackKey?: string;
      value?: number;
    };

export interface AchievementDefRow {
  id: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  points: number;
  icon: string | null;
  hidden: boolean;
  prerequisite_id: string | null;
  track_type: AchievementTrackType;
  track_key: string;
  target_value: number;
  target_list: AchievementTargetItem[];
  rewards: AchievementRewardConfig[];
  title_id: string | null;
  sort_weight: number;
  enabled: boolean;
  version: number;
}

export interface CharacterAchievementRow {
  id: number;
  character_id: number;
  achievement_id: string;
  status: AchievementStatus;
  progress: number;
  progress_data: Record<string, number | boolean | string>;
  completed_at: string | null;
  claimed_at: string | null;
  updated_at: string;
}

export type AchievementListStatusFilter = 'in_progress' | 'completed' | 'claimed' | 'claimable' | 'all';

interface AchievementProgressView {
  current: number;
  target: number;
  percent: number;
  done: boolean;
  status: AchievementStatus;
  progressData?: Record<string, number | boolean | string>;
}

export interface AchievementRewardView {
  type: 'silver' | 'spirit_stones' | 'exp' | 'item';
  amount?: number;
  itemDefId?: string;
  qty?: number;
  itemName?: string;
  itemIcon?: string | null;
}

export interface AchievementListItem {
  id: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  points: number;
  icon: string | null;
  hidden: boolean;
  status: AchievementStatus;
  claimable: boolean;
  trackType: AchievementTrackType;
  trackKey: string;
  progress: AchievementProgressView;
  rewards: AchievementRewardView[];
  titleId: string | null;
  sortWeight: number;
}

export interface AchievementPointsInfo {
  total: number;
  byCategory: {
    combat: number;
    cultivation: number;
    exploration: number;
    social: number;
    collection: number;
  };
}

export interface AchievementListResult {
  achievements: AchievementListItem[];
  total: number;
  page: number;
  limit: number;
  points: AchievementPointsInfo;
}

export interface AchievementClaimTitle {
  id: string;
  name: string;
  rarity: string;
  color: string | null;
  icon: string | null;
}

export interface ClaimAchievementResult {
  success: boolean;
  message: string;
  data?: {
    achievementId: string;
    rewards: AchievementRewardView[];
    title?: AchievementClaimTitle;
  };
}

export interface PointRewardDef {
  id: string;
  threshold: number;
  name: string;
  description: string;
  rewards: AchievementRewardView[];
  title?: AchievementClaimTitle;
  claimable: boolean;
  claimed: boolean;
}

export interface PointRewardListResult {
  totalPoints: number;
  claimedThresholds: number[];
  rewards: PointRewardDef[];
}

export interface ClaimPointRewardResult {
  success: boolean;
  message: string;
  data?: {
    threshold: number;
    rewards: AchievementRewardView[];
    title?: AchievementClaimTitle;
  };
}

export interface TitleInfo {
  id: string;
  name: string;
  description: string;
  rarity: string;
  color: string | null;
  icon: string | null;
  effects: Record<string, number>;
  isEquipped: boolean;
  obtainedAt: string;
}

export interface TitleListResult {
  titles: TitleInfo[];
  equipped: string;
}

export interface ServiceResult {
  success: boolean;
  message: string;
}
