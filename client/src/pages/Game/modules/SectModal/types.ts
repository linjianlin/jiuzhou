/**
 * 宗门弹窗共享类型定义。
 * 输入：后端宗门 DTO（services/api/rank-sect）。
 * 输出：前端面板所需的视图模型类型、面板键值、权限模型。
 * 约束：仅做类型收敛，不放业务逻辑，保证组件层无 `any`。
 */
import type {
  AppointableSectPositionDto,
  SectApplicationDto,
  SectInfoDto,
  SectLogDto,
  SectMyApplicationDto,
  SectPositionDto,
  SectQuestDto,
  SectShopItemDto,
} from '../../../../services/api';

export type SectJoinState = 'none' | 'pending' | 'joined';

export type SectPanelKey = 'hall' | 'myApplications' | 'overview' | 'members' | 'buildings' | 'shop' | 'activity' | 'manage';

export interface SectModalProps {
  open: boolean;
  onClose: () => void;
  spiritStones?: number;
  playerName?: string;
  onChanged?: () => void;
}

export interface SectListItemVm {
  id: string;
  name: string;
  level: number;
  members: number;
  memberCap: number;
  notice: string;
  joinType: 'open' | 'apply' | 'invite';
  joinMinRealm: string;
}

export interface SectJoinedSummary {
  id: string;
  name: string;
  level: number;
  leader: string;
  members: number;
  memberCap: number;
  notice: string;
  funds: number;
  buildPoints: number;
  reputation: number;
}

export interface SectMemberVm {
  characterId: number;
  nickname: string;
  realm: string;
  position: SectPositionDto;
  positionLabel: string;
  contribution: number;
  weeklyContribution: number;
  joinedAt: string;
  lastOfflineAt: string | null;
}

export interface SectBuildingVm {
  id: number;
  buildingType: string;
  name: string;
  desc: string;
  effect: string;
  nextEffect: string | null;
  level: number;
  requirement: {
    upgradable: boolean;
    maxLevel: number;
    nextLevel: number | null;
    funds: number | null;
    buildPoints: number | null;
    reason: string | null;
  };
  canAfford: boolean;
  fundsGap: number;
  buildPointsGap: number;
}

export interface SectPermissionState {
  canManageApplications: boolean;
  canUpgradeBuilding: boolean;
  canEditAnnouncement: boolean;
  canKickMember: boolean;
  canAppointPosition: boolean;
  canTransferLeader: boolean;
  canDisbandSect: boolean;
}

export interface MemberActionDraft {
  target: SectMemberVm | null;
  appointPosition: AppointableSectPositionDto;
}

export interface UseSectDataArgs {
  open: boolean;
  spiritStones: number;
  playerName: string;
  onChanged?: () => void;
}

export interface UseSectDataState {
  joinState: SectJoinState;
  activeSectId: string;
  panel: SectPanelKey;
  setPanel: (panel: SectPanelKey) => void;
  searchKeyword: string;
  setSearchKeyword: (keyword: string) => void;
  listLoading: boolean;
  myApplicationsLoading: boolean;
  applicationsLoading: boolean;
  shopLoading: boolean;
  questsLoading: boolean;
  logsLoading: boolean;
  actionLoadingKey: string | null;

  sects: SectListItemVm[];
  myApplications: SectMyApplicationDto[];
  applications: SectApplicationDto[];
  shopItems: SectShopItemDto[];
  quests: SectQuestDto[];
  logs: SectLogDto[];
  mySectInfo: SectInfoDto | null;

  joinedSect: SectJoinedSummary | null;
  members: SectMemberVm[];
  buildings: SectBuildingVm[];
  permissions: SectPermissionState;
  myMember: SectMemberVm | null;
  myContribution: number;

  createOpen: boolean;
  createName: string;
  createNotice: string;
  createCost: number;
  canAffordCreate: boolean;
  donateOpen: boolean;
  donateSpiritStonesInput: string;
  donateSummary: { canSubmit: boolean; reason: string; added: number };
  announcementOpen: boolean;
  announcementDraft: string;
  memberActionOpen: boolean;
  memberActionDraft: MemberActionDraft;

  setCreateOpen: (open: boolean) => void;
  setCreateName: (value: string) => void;
  setCreateNotice: (value: string) => void;
  setDonateOpen: (open: boolean) => void;
  setDonateSpiritStonesInput: (value: string) => void;
  setAnnouncementOpen: (open: boolean) => void;
  setAnnouncementDraft: (value: string) => void;
  setMemberActionOpen: (open: boolean) => void;
  setMemberActionDraft: (draft: MemberActionDraft) => void;

  openMemberAction: (member: SectMemberVm) => void;
  refreshList: () => Promise<void>;
  refreshMyApplications: () => Promise<void>;
  fetchApplications: () => Promise<void>;
  fetchShop: () => Promise<void>;
  fetchQuests: () => Promise<void>;
  fetchLogs: () => Promise<void>;

  applyJoin: (sectId: string) => Promise<void>;
  cancelMyApplication: (applicationId: number) => Promise<void>;
  leaveSectAction: () => Promise<void>;
  createSectAction: () => Promise<void>;
  donateAction: () => Promise<void>;
  upgradeBuildingAction: (buildingType: string) => Promise<void>;
  buyShopItemAction: (itemId: string) => Promise<void>;
  acceptQuestAction: (questId: string) => Promise<void>;
  submitQuestAction: (questId: string) => Promise<void>;
  claimQuestAction: (questId: string) => Promise<void>;
  handleApplicationAction: (applicationId: number, approve: boolean) => Promise<void>;
  updateAnnouncementAction: () => Promise<void>;
  appointPositionAction: (targetId: number, position: AppointableSectPositionDto) => Promise<void>;
  kickMemberAction: (targetId: number) => Promise<void>;
  transferLeaderAction: (targetId: number) => Promise<void>;
  disbandSectAction: () => Promise<void>;
}
