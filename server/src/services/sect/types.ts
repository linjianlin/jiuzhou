export type SectPosition = 'leader' | 'vice_leader' | 'elder' | 'elite' | 'disciple';

type SectJoinType = 'open' | 'apply' | 'invite';

export interface SectDefRow {
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
  icon: string | null;
  join_type: SectJoinType;
  join_min_realm: string;
  member_count: number;
  max_members: number;
  created_at: string;
  updated_at: string;
}

export interface SectBuildingRow {
  id: number;
  sect_id: string;
  building_type: string;
  level: number;
  status: string;
  upgrade_start_at: string | null;
  upgrade_end_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SectApplicationRow {
  id: number;
  sect_id: string;
  character_id: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
  handled_at: string | null;
  handled_by: number | null;
}

export interface Result {
  success: boolean;
  message: string;
}

export interface CreateResult extends Result {
  sectId?: string;
}

export interface DonateResult extends Result {
  addedFunds?: number;
  addedContribution?: number;
}

export interface BuyResult extends Result {
  itemDefId?: string;
  qty?: number;
  itemIds?: number[];
}

export interface SectInfo {
  sect: SectDefRow;
  members: Array<{
    characterId: number;
    nickname: string;
    realm: string;
    position: SectPosition;
    contribution: number;
    weeklyContribution: number;
    joinedAt: string;
  }>;
  buildings: SectBuildingRow[];
}

export interface SectBonuses {
  attrBonus: Record<string, number>;
  expBonus: number;
  dropBonus: number;
  craftBonus: number;
}

export interface SectQuest {
  id: string;
  name: string;
  type: 'daily' | 'weekly' | 'special';
  target: string;
  required: number;
  reward: { contribution: number; buildPoints: number; funds: number };
  status: 'not_accepted' | 'in_progress' | 'completed';
  progress: number;
}

export interface ShopItem {
  id: string;
  name: string;
  costContribution: number;
  itemDefId: string;
  qty: number;
  limitDaily?: number;
}

interface SectListItem {
  id: string;
  name: string;
  level: number;
  memberCount: number;
  maxMembers: number;
  joinType: SectJoinType;
  joinMinRealm: string;
  announcement: string | null;
}

export interface SectListResult extends Result {
  list?: SectListItem[];
  page?: number;
  limit?: number;
  total?: number;
}
