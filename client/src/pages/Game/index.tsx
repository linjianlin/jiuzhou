import { App, Badge, Button, Drawer, Modal, Tag, Tabs, Tooltip } from 'antd';
import { MailOutlined, SettingOutlined, LogoutOutlined, CalendarOutlined } from '@ant-design/icons';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import PlayerInfo from './modules/PlayerInfo';
import { formatSignedNumber, formatSignedPercent } from './shared/formatAttr';
import GameMap from './modules/GameMap';
import ChatPanel, { type ChatPanelHandle } from './modules/ChatPanel';
import FunctionMenu from './modules/FunctionMenu';
import RoomObjects from './modules/RoomObjects';
import InfoModal, { type InfoTarget } from './modules/InfoModal';
import BattleArea, { type BattleUnit } from './modules/BattleArea';
import TeamPanel, { type TeamMember } from './modules/TeamPanel';
import MapModal from './modules/MapModal';
import BagModal from './modules/BagModal';
import TeamModal from './modules/TeamModal';
import SkillFloatButton from './modules/SkillFloatButton';
import TechniqueModal from './modules/TechniqueModal';
import NpcTalkModal from './modules/NpcTalkModal';
import {
  getTechniqueResearchIndicatorTooltip,
  resolveTechniqueResearchIndicatorStatus,
  type TechniqueResearchStatusData,
} from './modules/TechniqueModal/researchShared';
import TaskModal from './modules/TaskModal';
import SectModal from './modules/SectModal';
import MarketModal from './modules/MarketModal';
import MonthCardModal from './modules/MonthCardModal';
import BattlePassModal from './modules/BattlePassModal';
import ArenaModal from './modules/ArenaModal';
import RankModal from './modules/RankModal';
import AchievementModal from './modules/AchievementModal';
import MailModal from './modules/MailModal';
import SettingModal from './modules/SettingModal';
import RealmModal from './modules/RealmModal';
import WarehouseModal from './modules/WarehouseModal';
import SignInModal from './modules/SignInModal';
import PartnerModal from './modules/PartnerModal';
import { useIdleBattle, IdleBattlePanel, IdleBattleStatusBar } from './modules/IdleBattle';
import type { IdleSessionDto } from './modules/IdleBattle/types';
import {
  gameSocket,
  type CharacterData,
  type MailIndicatorPayload,
  type SectIndicatorPayload,
} from '../../services/gameSocket';
import type { BattleRealtimePayload } from '../../services/battleRealtime';
import {
  acceptTaskFromNpc,
  advanceBattleSession,
  claimTaskReward,
  createDungeonInstance,
  gatherRoomResource,
  getCurrentBattleSession,
  getBattleSessionByBattleId,
  getGameHomeOverview,
  pickupRoomItem,
  SILENT_API_REQUEST_CONFIG,
  getInventoryItems,
  npcTalk,
  getSignInOverview,
  startDungeonBattleSession,
  submitTaskToNpc,
  unequipInventoryItem,
  updateCharacterAutoCastSkills,
  updateCharacterPosition,
  updateCharacterPositionKeepalive,
} from '../../services/api';
import { getUnifiedApiErrorMessage } from '../../services/api';
import type {
  BountyTaskOverviewRowDto,
  GameHomeOverviewDto,
  InventoryItemDto,
  NpcTalkResponse,
  NpcTalkTaskOption,
  RealmOverviewDto,
  TaskOverviewRowDto,
  TechniqueResearchResultStatusDto,
  BattleSessionSnapshotDto,
} from '../../services/api';
import { getMainQuestProgress, startDialogue, advanceDialogue, selectDialogueChoice, completeSection, type DialogueState, type MainQuestProgressDto } from '../../services/mainQuestApi';
import { PARTNER_FEATURE_CODE } from '../../services/feature';
import { getMyTeam, getTeamApplications, leaveTeam, type TeamApplication, type TeamInfo } from '../../services/teamApi';
import {
  IMG_GAME_HEADER_LOGO as gameHeaderLogo,
  IMG_LINGSHI as lingshi,
  IMG_TONGQIAN as tongqian,
  IMG_EQUIP_MALE as equipMale,
  IMG_EQUIP_FEMALE as equipFemale,
} from './shared/imageAssets';
import { resolveIconUrl } from './shared/resolveIcon';
import './index.scss';
import { useIsMobile } from './shared/responsive';
import { coerceAffixes } from './shared/itemMetaFormat';
import EquipmentAffixTooltipList from './shared/EquipmentAffixTooltipList';
import { attrLabel, attrOrder, percentAttrKeys } from './shared/attrDisplay';
import {
  NPC_TALK_TASK_STATUS_META,
  createNpcDialogueEntriesFromDialogueNode,
  createNpcDialogueEntriesFromLines,
  createNpcDialogueEntry,
  resolveNpcTalkMainQuestStatusLabel,
  type NpcDialogueEntry,
  type NpcTalkMainQuestStatus,
} from './modules/NpcTalkModal/shared';
import { PARTNER_FEATURE_UNLOCK_HINT, hasCharacterFeature } from './shared/featureUnlocks';
import { formatMainQuestRewardTexts } from './shared/mainQuestRewardText';
import { shouldActivateBattleSessionView } from './shared/battleSessionRestore';
import { formatTaskRewardsToText } from './shared/taskRewardText';
import { resolveRealtimeBattleViewSyncMode } from './shared/battleViewSync';
import {
  countCompletableBountyTaskOverviewRows,
  countCompletableTaskOverviewRows,
  getNextBountyTaskExpiryTs,
} from './shared/taskIndicator';
import {
  clearTaskOverviewRequestScope,
  loadSharedBountyTaskOverview,
  loadSharedTaskOverview,
} from './shared/taskOverviewRequests';
import { hydratePhoneBindingStatus, invalidatePhoneBindingStatus } from './shared/usePhoneBindingStatus';
import { useRealtimeMemberPresence } from './shared/useRealtimeMemberPresence';
import type { BattleAdvanceMode } from './modules/BattleArea/autoNextPolicy';

interface GameProps {
  onLogout?: () => void;
}

const EQUIP_SLOTS_LEFT = ['武器', '头部', '衣服', '护手'] as const;
const EQUIP_SLOTS_RIGHT = ['下装', '项链', '饰品', '法宝'] as const;

const resolveItemIcon = resolveIconUrl;

const EQUIPPED_SLOT_TO_UI_LABEL: Record<string, string> = {
  weapon: '武器',
  head: '头部',
  clothes: '衣服',
  gloves: '护手',
  pants: '下装',
  necklace: '项链',
  accessory: '饰品',
  artifact: '法宝',
};

const EQUIP_QUALITY_COLOR: Record<string, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};
const TECHNIQUE_RESEARCH_ENABLED = !import.meta.env.PROD;

const EQUIP_QUALITY_TEXT: Record<string, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const EQUIPMENT_TOOLTIP_CLASS_NAMES = {
  root: 'equipment-tooltip-overlay game-tooltip-surface-root',
  container: 'equipment-tooltip-overlay-container game-tooltip-surface-container',
} as const;

const coerceAttrRecord = (value: unknown): Record<string, number> => {
  if (!value) return {};
  let obj: unknown = value;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) out[k] = parsed;
    }
  }
  return out;
};

const renderEquipTooltip = (uiSlot: string, it: InventoryItemDto) => {
  const def = it.def;
  if (!def) return null;

  const rawQuality = String(def.quality ?? '').trim();
  const quality = rawQuality in EQUIP_QUALITY_COLOR ? rawQuality : '黄';
  const strengthenLevel = Math.max(0, Math.floor(Number(it.strengthen_level) || 0));
  const refineLevel = Math.max(0, Math.floor(Number(it.refine_level) || 0));

  const baseAttrs = coerceAttrRecord(def.base_attrs);
  const sortedAttrs = Object.entries(baseAttrs).sort(
    ([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b),
  );

  const affixes = coerceAffixes(it.affixes).sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
  const desc = String(def.long_desc ?? def.description ?? '').trim();

  return (
    <div className="equip-tooltip">
      <div className="equip-tooltip-header">
        <span className="equip-tooltip-name">{def.name}</span>
        <Tag color={EQUIP_QUALITY_COLOR[quality]}>{EQUIP_QUALITY_TEXT[quality] ?? quality}</Tag>
      </div>

      <div className="equip-tooltip-meta">
        <span>部位：{uiSlot}</span>
        <span>强化：{strengthenLevel > 0 ? `+${strengthenLevel}` : strengthenLevel}</span>
        <span>精炼：{refineLevel > 0 ? `+${refineLevel}` : refineLevel}</span>
      </div>

      <div className="equip-tooltip-section">
        <div className="equip-tooltip-section-title">属性</div>
        <div className="equip-tooltip-lines">
          {sortedAttrs.length ? (
            sortedAttrs.map(([k, v]) => (
              <div key={`attr-${k}`} className="equip-tooltip-line">
                <span className="equip-tooltip-line-k">{attrLabel[k] ?? k}</span>
                <span className="equip-tooltip-line-v">
                  {percentAttrKeys.has(k) ? formatSignedPercent(v) : formatSignedNumber(v)}
                </span>
              </div>
            ))
          ) : (
            <div className="equip-tooltip-empty">无</div>
          )}
        </div>
      </div>

      <div className="equip-tooltip-section">
        <div className="equip-tooltip-section-title">词条</div>
        <div className="equip-tooltip-lines">
          <EquipmentAffixTooltipList
            affixes={affixes}
            identified={Boolean(it.identified)}
            displayOptions={{
              normalPrefix: '词条',
              legendaryPrefix: '传奇',
              keyLabelMap: attrLabel,
              fallbackLabel: '未知',
              percentKeys: percentAttrKeys,
              formatSignedNumber,
              formatSignedPercent,
            }}
          />
        </div>
      </div>

      {desc ? <div className="equip-tooltip-desc">{desc}</div> : null}
    </div>
  );
};

const parseRatioText = (text: string) => {
  const m = text.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const cur = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(cur) || !Number.isFinite(max)) return null;
  return { cur, max };
};

const resolveCurrentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const isBattleSessionMissingError = (messageText: unknown): boolean => {
  const text = String(messageText ?? '').trim();
  return text === '战斗会话不存在' || text === '战斗会话不存在或无权访问';
};

const countUnreadTeamApplications = (
  characterId: number | null,
  teamId: string | null,
  applications: TeamApplication[],
): number => {
  if (!characterId || !teamId) return 0;
  const seenKey = `team_apps_seen_${characterId}_${teamId}`;
  const seenAtRaw = localStorage.getItem(seenKey);
  const seenAtNum = Number(seenAtRaw ?? 0);
  const seenAt = Number.isFinite(seenAtNum) ? seenAtNum : 0;
  return applications.filter((application) => (Number(application.time) || 0) > seenAt).length;
};

const resolveTrackedRoomIdsForMap = (
  currentMapId: string,
  taskList: TaskOverviewRowDto[],
  mainQuestProgress: MainQuestProgressDto | null,
): string[] => {
  if (!currentMapId) return [];

  const taskRoomIds = taskList
    .filter((task) => task.tracked === true && task.status !== 'completed' && task.mapId === currentMapId && typeof task.roomId === 'string' && task.roomId)
    .map((task) => task.roomId as string);

  const mainQuestRoomIds: string[] = [];
  if (mainQuestProgress?.tracked && mainQuestProgress.currentSection && mainQuestProgress.currentSection.status !== 'completed') {
    if (mainQuestProgress.currentSection.mapId === currentMapId && mainQuestProgress.currentSection.roomId) {
      mainQuestRoomIds.push(mainQuestProgress.currentSection.roomId);
    }
  }

  return Array.from(new Set([...taskRoomIds, ...mainQuestRoomIds]));
};

const resolveTaskIndicatorSnapshot = (
  taskRows: TaskOverviewRowDto[],
  bountyTasks: BountyTaskOverviewRowDto[],
  nowTs: number,
): { count: number; nextExpiryTs: number | null } => {
  const taskCount = countCompletableTaskOverviewRows(taskRows);
  const bountyCount = countCompletableBountyTaskOverviewRows(bountyTasks, nowTs);
  return {
    count: taskCount + bountyCount,
    nextExpiryTs: getNextBountyTaskExpiryTs(bountyTasks, nowTs),
  };
};

const mapInventoryItemsToEquippedViews = (
  items: InventoryItemDto[],
): Array<{ id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto }> => {
  return items
    .map((item) => {
      const def = item.def;
      if (!def) return null;
      const slot = String(item.equipped_slot ?? def.equip_slot ?? '').trim();
      if (!slot) return null;
      const name = String(def.name ?? '').trim() || String(def.id ?? item.item_def_id ?? '').trim();
      const icon = resolveItemIcon(def.icon);
      return {
        id: Number(item.id),
        name,
        icon,
        equippedSlot: slot,
        item,
      };
    })
    .filter((item): item is { id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto } => Boolean(item));
};

type CharacterWorldPosition = {
  mapId: string;
  roomId: string;
};

const readCharacterWorldPosition = (
  character: Pick<CharacterData, 'currentMapId' | 'currentRoomId'> | null | undefined,
): CharacterWorldPosition | null => {
  const mapId = String(character?.currentMapId ?? '').trim();
  const roomId = String(character?.currentRoomId ?? '').trim();
  if (!mapId || !roomId) return null;
  return { mapId, roomId };
};

const WorldPanelLoading: FC<{ title: string; detail: string }> = ({ title, detail }) => {
  return (
    <div className="game-position-loading">
      <div className="game-position-loading-title">{title}</div>
      <div className="game-position-loading-detail">{detail}</div>
    </div>
  );
};

const clampNum = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const randBetween = (a: number, b: number) => {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return min + Math.random() * (max - min);
};

type NpcTalkMainQuestOption = {
  sectionId: string;
  sectionName: string;
  chapterName: string;
  status: NpcTalkMainQuestStatus;
  canStartDialogue: boolean;
  canComplete: boolean;
};
type NpcTalkData = NonNullable<NpcTalkResponse['data']> & { mainQuest?: NpcTalkMainQuestOption };
type NpcTalkPhase = 'root' | 'taskDetail' | 'mainQuestDialogue';
type GatherActionUi =
  | {
    running: true;
    mapId: string;
    roomId: string;
    resourceId: string;
    resourceName: string;
    actionSec: number;
    gatherUntilMs: number;
    remaining: number;
  }
  | { running: false };

type GatherProgressHeaderProps = {
  gatherAction: Extract<GatherActionUi, { running: true }>;
  onStop: () => void;
};

const GatherProgressHeader: FC<GatherProgressHeaderProps> = memo(({ gatherAction, onStop }) => {
  const hasUntil = Number.isFinite(gatherAction.gatherUntilMs) && gatherAction.gatherUntilMs > 0;
  const actionMs = Math.max(1, Math.floor(gatherAction.actionSec * 1000));

  // 进度条使用 CSS 线性过渡，避免逐帧 React 重渲染导致观感抖动
  const [fillScale, setFillScale] = useState(0);
  const [fillTransitionMs, setFillTransitionMs] = useState(0);
  const [remainingSec, setRemainingSec] = useState(0);

  useEffect(() => {
    if (!hasUntil) {
      setFillTransitionMs(0);
      setFillScale(0);
      return;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, gatherAction.gatherUntilMs - now);
    const elapsedMs = clampNum(actionMs - remainingMs, 0, actionMs);
    const startScale = clampNum(elapsedMs / actionMs, 0, 1);

    setFillTransitionMs(0);
    setFillScale(startScale);

    const rafId = window.requestAnimationFrame(() => {
      setFillTransitionMs(remainingMs);
      setFillScale(1);
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [actionMs, gatherAction.gatherUntilMs, hasUntil]);

  useEffect(() => {
    if (!hasUntil) {
      setRemainingSec(0);
      return;
    }

    const updateRemainingSec = () => {
      const leftMs = Math.max(0, gatherAction.gatherUntilMs - Date.now());
      setRemainingSec(Math.max(0, Math.ceil(leftMs / 1000)));
    };

    updateRemainingSec();
    const timer = window.setInterval(updateRemainingSec, 200);
    return () => window.clearInterval(timer);
  }, [gatherAction.gatherUntilMs, hasUntil]);

  const ariaValueNow = Math.round(clampNum(fillScale * 100, 0, 100));

  return (
    <div className="game-header-gather" title={`采集中：${gatherAction.resourceName}（剩余${gatherAction.remaining}）`}>
      <div className="game-header-gather-label">采集中</div>
      <div className="game-header-gather-progress">
        <div
          className="game-header-gather-progress-rail"
          role="progressbar"
          aria-label="采集进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ariaValueNow}
        >
          <div
            className="game-header-gather-progress-fill"
            style={{
              transform: `scaleX(${fillScale})`,
              transitionDuration: `${fillTransitionMs}ms`,
            }}
          />
        </div>
      </div>
      <div className="game-header-gather-time">{hasUntil ? `${remainingSec}s` : '同步'}</div>
      <Button size="small" type="text" className="game-header-gather-stop" onClick={onStop}>
        停止
      </Button>
    </div>
  );
});

GatherProgressHeader.displayName = 'GatherProgressHeader';

const rollMonsterBaseAttrs = (
  baseAttrs: Record<string, number>,
  opts?: { variance?: number; multMin?: number; multMax?: number },
) => {
  const variance = clampNum(opts?.variance ?? 0.05, 0, 0.95);
  const multMin = clampNum(opts?.multMin ?? 0.9, 0.01, 999);
  const multMax = clampNum(opts?.multMax ?? 1.1, 0.01, 999);
  const overall = randBetween(multMin, multMax);

  const rolled: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseAttrs)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const perAttr = 1 + (Math.random() * 2 - 1) * variance;
    const next = Math.max(0, Math.round(n * overall * perAttr));
    rolled[k] = next;
  }

  if (typeof rolled.max_qixue === 'number') rolled.qixue = rolled.max_qixue;
  if (typeof rolled.qixue === 'number' && typeof rolled.max_qixue !== 'number') rolled.max_qixue = rolled.qixue;
  if (typeof rolled.max_lingqi === 'number') rolled.lingqi = rolled.max_lingqi;
  if (typeof rolled.lingqi === 'number' && typeof rolled.max_lingqi !== 'number') rolled.max_lingqi = rolled.lingqi;

  return rolled;
};

const pickStatRatio = (stats: Array<{ label: string; value: string | number }> | undefined, keywords: string[]) => {
  const list = stats ?? [];
  const stat = list.find((s) => keywords.some((k) => s.label.includes(k)));
  if (!stat) return null;
  if (typeof stat.value === 'number') return { cur: stat.value, max: stat.value };
  return parseRatioText(stat.value);
};

const buildEnemyUnit = (target: InfoTarget): BattleUnit => {
  const fallback: BattleUnit = {
    id: `${target.type}-${target.id}`,
    name: target.name,
    tag: target.realm || (target.type === 'monster' ? '凡兽' : '凡人'),
    hp: 31,
    maxHp: 31,
    qi: 0,
    maxQi: 0,
    monthCardActive: target.type === 'player' ? target.monthCardActive : undefined,
  };

  if (target.type !== 'monster') return fallback;

  if (target.base_attrs && Object.keys(target.base_attrs).length > 0) {
    const rolled = rollMonsterBaseAttrs(target.base_attrs, {
      variance: target.attr_variance,
      multMin: target.attr_multiplier_min,
      multMax: target.attr_multiplier_max,
    });
    const hpMax = clampNum(Number(rolled.max_qixue ?? rolled.qixue ?? fallback.maxHp), 1, 999999);
    const qiMax = clampNum(Number(rolled.max_lingqi ?? rolled.lingqi ?? fallback.maxQi), 0, 999999);
    return {
      ...fallback,
      hp: hpMax,
      maxHp: hpMax,
      qi: qiMax,
      maxQi: qiMax,
    };
  }

  const hp = pickStatRatio(target.stats, ['气血', '生命', 'HP', 'hp']);
  const qi = pickStatRatio(target.stats, ['灵气', '法力', 'MP', 'mp']);
  return {
    ...fallback,
    hp: hp?.cur ?? fallback.hp,
    maxHp: hp?.max ?? fallback.maxHp,
    qi: qi?.cur ?? fallback.qi,
    maxQi: qi?.max ?? fallback.maxQi,
  };
};

const buildAllyUnit = (character: CharacterData | null): BattleUnit => {
  const fallback: BattleUnit = {
    id: 'player-self',
    name: '我方',
    tag: '凡人',
    hp: 100,
    maxHp: 100,
    qi: 0,
    maxQi: 0,
  };
  if (!character) return fallback;
  return {
    id: `player-${character.id}`,
    name: character.nickname || '我方',
    tag: character.realm || '凡人',
    hp: character.qixue ?? fallback.hp,
    maxHp: character.maxQixue ?? fallback.maxHp,
    qi: character.lingqi ?? fallback.qi,
    maxQi: character.maxLingqi ?? fallback.maxQi,
    monthCardActive: character.monthCardActive,
  };
};

const scaleUnit = (base: BattleUnit, scale: number, suffix: string): BattleUnit => {
  const hpMax = clampNum(Math.round((Number(base.maxHp) || 1) * scale), 1, 999999);
  const qiMax = clampNum(Math.round((Number(base.maxQi) || 0) * scale), 0, 999999);
  return {
    ...base,
    id: `${base.id}-${suffix}`,
    name: `${base.name}-${suffix}`,
    hp: hpMax,
    maxHp: hpMax,
    qi: qiMax,
    maxQi: qiMax,
  };
};

const buildEnemyGroup = (target: InfoTarget): BattleUnit[] => {
  const base = buildEnemyUnit(target);
  const count = 8;
  const out: BattleUnit[] = [base];
  for (let i = 1; i < count; i += 1) {
    const scale = 0.85 + Math.random() * 0.4;
    out.push(scaleUnit(base, scale, `敌${i + 1}`));
  }
  return out;
};

const buildAllyGroup = (character: CharacterData | null): BattleUnit[] => {
  const base = buildAllyUnit(character);
  const count = 8;
  const out: BattleUnit[] = [base];
  for (let i = 1; i < count; i += 1) {
    const scale = 0.78 + Math.random() * 0.45;
    out.push({
      ...scaleUnit(base, scale, `队友${i + 1}`),
      tag: base.tag,
    });
  }
  return out;
};

const buildTeamInfoTarget = (m: TeamMember): InfoTarget => {
  return {
    type: 'player',
    id: m.id,
    name: m.name,
    title: m.title || '队员',
    gender: '-',
    realm: m.realm || '-',
    avatar: m.avatar ?? null,
    equipment: [
      { slot: '武器', name: '制式武器', quality: '普通' },
      { slot: '衣甲', name: '制式衣甲', quality: '普通' },
      { slot: '饰品', name: '队伍徽记', quality: '精良' },
    ],
    techniques: [{ name: '基础心法', level: '一重', type: '心法' }],
  };
};

const Game: FC<GameProps> = ({ onLogout }) => {
  const version = '1.0.0';
  const { message } = App.useApp();
  const messageRef = useRef(message);
  const initialCharacterPosition = readCharacterWorldPosition(gameSocket.getCharacter());

  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [isTeamLeader, setIsTeamLeader] = useState(false);
  const [teamApplicationUnread, setTeamApplicationUnread] = useState(0);
  const [sectPendingApplicationCount, setSectPendingApplicationCount] = useState(0);
  const [sectMyApplicationCount, setSectMyApplicationCount] = useState(0);
  const [currentMapId, setCurrentMapId] = useState<string>(initialCharacterPosition?.mapId ?? '');
  const [currentRoomId, setCurrentRoomId] = useState<string>(initialCharacterPosition?.roomId ?? '');
  const [hasHydratedPosition, setHasHydratedPosition] = useState<boolean>(false);
  const [trackedRoomIds, setTrackedRoomIds] = useState<string[]>([]);
  const isMobile = useIsMobile();
  const [topTab, setTopTab] = useState<'map' | 'room'>('map');
  const [mobileChatDrawerOpen, setMobileChatDrawerOpen] = useState(false);
  const [playerInfoOpen, setPlayerInfoOpen] = useState(false);
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [mapModalCategory, setMapModalCategory] = useState<'world' | 'dungeon' | 'event'>('world');
  const [bagModalOpen, setBagModalOpen] = useState(false);
  const [warehouseModalOpen, setWarehouseModalOpen] = useState(false);
  const [techniqueModalOpen, setTechniqueModalOpen] = useState(false);
  const [partnerModalOpen, setPartnerModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [sectModalOpen, setSectModalOpen] = useState(false);
  const [marketModalOpen, setMarketModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [monthCardModalOpen, setMonthCardModalOpen] = useState(false);
  const [battlePassModalOpen, setBattlePassModalOpen] = useState(false);
  const [arenaModalOpen, setArenaModalOpen] = useState(false);
  const [rankModalOpen, setRankModalOpen] = useState(false);
  const [achievementModalOpen, setAchievementModalOpen] = useState(false);
  const [achievementClaimableCount, setAchievementClaimableCount] = useState(0);
  const [taskCompletableCount, setTaskCompletableCount] = useState(0);
  const [realmModalOpen, setRealmModalOpen] = useState(false);
  const [signInModalOpen, setSignInModalOpen] = useState(false);
  const [showSignInDot, setShowSignInDot] = useState(false);
  const [showMailDot, setShowMailDot] = useState(false);
  const [techniqueIndicatorStatus, setTechniqueIndicatorStatus] = useState<TechniqueResearchResultStatusDto | null>(null);
  const [mailModalOpen, setMailModalOpen] = useState(false);
  const [settingModalOpen, setSettingModalOpen] = useState(false);
  const [homeOverviewSettled, setHomeOverviewSettled] = useState(false);
  const [homeOverviewRealmOverview, setHomeOverviewRealmOverview] = useState<RealmOverviewDto | null | undefined>(undefined);
  const [homeOverviewEquippedItems, setHomeOverviewEquippedItems] = useState<InventoryItemDto[] | null>(null);
  const [homeOverviewIdleSession, setHomeOverviewIdleSession] = useState<IdleSessionDto | null | undefined>(undefined);
  // 挂机面板 Modal 开关
  const [idleModalOpen, setIdleModalOpen] = useState(false);
  // 挂机状态 Hook（顶层单例，IdleBattlePanel 和 IdleBattleStatusBar 共享同一实例）
  const idle = useIdleBattle({
    initialSession: homeOverviewIdleSession,
    deferInitialStatusLoad: !homeOverviewSettled,
  });
  const [npcTalkOpen, setNpcTalkOpen] = useState(false);
  const [npcTalkNpcId, setNpcTalkNpcId] = useState('');
  const [npcTalkLoading, setNpcTalkLoading] = useState(false);
  const [npcTalkActionKey, setNpcTalkActionKey] = useState<string>('');
  const [npcTalkData, setNpcTalkData] = useState<NpcTalkData | null>(null);
  const [npcTalkPhase, setNpcTalkPhase] = useState<NpcTalkPhase>('root');
  const [npcDialogue, setNpcDialogue] = useState<NpcDialogueEntry[]>([]);
  const [npcTalkSelectedTaskId, setNpcTalkSelectedTaskId] = useState<string>('');
  const [mainQuestDialogueState, setMainQuestDialogueState] = useState<DialogueState | null>(null);
  const [mainQuestDialogueLoading, setMainQuestDialogueLoading] = useState(false);
  const [infoTarget, setInfoTarget] = useState<InfoTarget | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'battle'>('map');
  const [battleEnemies, setBattleEnemies] = useState<BattleUnit[]>([]);
  const [battleAllies, setBattleAllies] = useState<BattleUnit[]>([]);
  const [battleTurn, setBattleTurn] = useState(0);
  const [battleTurnSide, setBattleTurnSide] = useState<'enemy' | 'ally'>('ally');
  const [battleActionKey, setBattleActionKey] = useState('idle');
  const [battleActiveUnitId, setBattleActiveUnitId] = useState<string | null>(null);
  const [battlePhase, setBattlePhase] = useState<string | null>(null);
  const [activeBattleSession, setActiveBattleSession] = useState<BattleSessionSnapshotDto | null>(null);
  const [teamBattleId, setTeamBattleId] = useState<string | null>(null);
  const [reconnectBattleId, setReconnectBattleId] = useState<string | null>(null);
  const [battleCooldownStateVersion, setBattleCooldownStateVersion] = useState(0);
  const [autoMode, setAutoMode] = useState(true); // 默认开启自动战斗
  const taskOverviewRequestScopeKeyRef = useRef<string>(`game-task-overview-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [equippedItems, setEquippedItems] = useState<
    Array<{ id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto }>
  >([]);
  const [unequippingId, setUnequippingId] = useState<number | null>(null);
  const chatPanelRef = useRef<ChatPanelHandle | null>(null);
  const mainQuestDialogueNodeIdRef = useRef('');
  const battleSkillCasterRef = useRef<(skillId: string, targetType?: string) => Promise<boolean>>(async () => false);
  const [gatherAction, setGatherAction] = useState<GatherActionUi>({ running: false });
  const gatherActionKeyRef = useRef<string>('');
  const gatherTickTimerRef = useRef<number | null>(null);
  const sessionAutoAdvanceTimerRef = useRef<number | null>(null);
  const lastAutoAdvanceSessionKeyRef = useRef<string>('');
  const appendBattleLinesToChat = useCallback((lines: string[]) => {
    chatPanelRef.current?.appendBattleLines(lines);
  }, []);
  const hydratedPositionRef = useRef(false);
  const positionSaveTimerRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<{ mapId: string; roomId: string } | null>(null);
  const latestPositionRef = useRef<{ mapId: string; roomId: string } | null>(null);
  const lastKeepalivePositionKeyRef = useRef<string>('');
  const teamBattleAutoCloseTimerRef = useRef<number | null>(null);
  const taskIndicatorQueuedRefreshTimerRef = useRef<number | null>(null);
  const taskIndicatorExpiryTimerRef = useRef<number | null>(null);
  const latestBountyOverviewTasksRef = useRef<BountyTaskOverviewRowDto[]>([]);
  const activeBattleSessionRef = useRef<BattleSessionSnapshotDto | null>(null);
  const reconnectBattleIdRef = useRef<string | null>(null);
  const viewModeRef = useRef<'map' | 'battle'>('map');
  const hasLocalBattleTargetsRef = useRef(false);
  const pendingBattleSessionRestoreBattleIdRef = useRef<string | null>(null);
  const homeOverviewLoadingRef = useRef(false);
  const homeOverviewRequestSeqRef = useRef(0);
  const pendingHomeTaskSnapshotRef = useRef<GameHomeOverviewDto['task'] | null>(null);
  const pendingHomeMainQuestSnapshotRef = useRef<MainQuestProgressDto | null>(null);
  const inTeam = Boolean(teamInfo?.id);
  const canRenderWorldPanels = hasHydratedPosition && currentMapId.length > 0 && currentRoomId.length > 0;
  const activeSessionBattleId = activeBattleSession?.currentBattleId ?? null;
  const externalBattleId = activeSessionBattleId || (inTeam && !isTeamLeader ? teamBattleId : null) || reconnectBattleId;
  const teamPresenceMembers = useMemo(
    () => (teamInfo?.members ?? []).map((member) => ({ characterId: member.characterId })),
    [teamInfo],
  );
  const { isCharacterOnline: isTeamCharacterOnline } = useRealtimeMemberPresence(
    teamPresenceMembers,
  );

  const clearBattleAutoCloseTimer = useCallback(() => {
    if (!teamBattleAutoCloseTimerRef.current) return;
    window.clearTimeout(teamBattleAutoCloseTimerRef.current);
    teamBattleAutoCloseTimerRef.current = null;
  }, []);

  const clearSessionAutoAdvanceTimer = useCallback(() => {
    if (!sessionAutoAdvanceTimerRef.current) return;
    window.clearTimeout(sessionAutoAdvanceTimerRef.current);
    sessionAutoAdvanceTimerRef.current = null;
  }, []);

  useEffect(() => {
    activeBattleSessionRef.current = activeBattleSession;
  }, [activeBattleSession]);

  useEffect(() => {
    reconnectBattleIdRef.current = reconnectBattleId;
  }, [reconnectBattleId]);

  useEffect(() => {
    return gameSocket.onBattleCooldown(() => {
      setBattleCooldownStateVersion((prev) => prev + 1);
    });
  }, []);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    hasLocalBattleTargetsRef.current = battleEnemies.length > 0;
  }, [battleEnemies]);

  useEffect(() => {
    return () => {
      clearTaskOverviewRequestScope(taskOverviewRequestScopeKeyRef.current);
    };
  }, []);

  const activateBattleSessionContext = useCallback((session: BattleSessionSnapshotDto) => {
    clearSessionAutoAdvanceTimer();
    lastAutoAdvanceSessionKeyRef.current = '';
    clearBattleAutoCloseTimer();
    setActiveBattleSession(session);
    setTeamBattleId(null);
    setReconnectBattleId(null);
    setViewMode('battle');
    setTopTab('map');
    setInfoTarget(null);
  }, [clearBattleAutoCloseTimer, clearSessionAutoAdvanceTimer]);

  const applyBattleSessionChange = useCallback((
    session: BattleSessionSnapshotDto | null,
    options?: {
      collapseTransientBattleView?: boolean;
    },
  ) => {
    const realtime =
      session?.currentBattleId
        ? gameSocket.getLatestBattleUpdate(session.currentBattleId)
        : null;
    if (session && shouldActivateBattleSessionView({ session, realtime })) {
      activateBattleSessionContext(session);
      return;
    }
    if (options?.collapseTransientBattleView && session?.status === 'waiting_transition') {
      clearBattleAutoCloseTimer();
      setTeamBattleId(null);
      setReconnectBattleId(null);
      setViewMode('map');
      setTopTab('map');
      setInfoTarget(null);
    }
    setActiveBattleSession(session);
  }, [activateBattleSessionContext, clearBattleAutoCloseTimer]);

  const handleBattleSessionChange = useCallback((session: BattleSessionSnapshotDto | null) => {
    applyBattleSessionChange(session);
  }, [applyBattleSessionChange]);

  const restoreBattleSessionContext = useCallback(async (battleId: string): Promise<boolean> => {
    const currentSession = activeBattleSessionRef.current;
    const currentBattleId = currentSession?.currentBattleId ?? null;
    if (currentBattleId === battleId) {
      const realtime = gameSocket.getLatestBattleUpdate(battleId);
      if (
        currentSession
        && shouldActivateBattleSessionView({ session: currentSession, realtime })
        && viewModeRef.current !== 'battle'
      ) {
        activateBattleSessionContext(currentSession);
      }
      return true;
    }
    if (pendingBattleSessionRestoreBattleIdRef.current === battleId) {
      return true;
    }

    pendingBattleSessionRestoreBattleIdRef.current = battleId;
    try {
      const res = await getBattleSessionByBattleId(battleId);
      const session = res?.data?.session;
      if (!res?.success || !session || session.currentBattleId !== battleId) {
        return false;
      }
      applyBattleSessionChange(session, {
        collapseTransientBattleView: true,
      });
      return true;
    } catch (error) {
      console.error('恢复战斗会话上下文失败:', error);
      return false;
    } finally {
      if (pendingBattleSessionRestoreBattleIdRef.current === battleId) {
        pendingBattleSessionRestoreBattleIdRef.current = null;
      }
    }
  }, [activateBattleSessionContext, applyBattleSessionChange]);

  const syncRealtimeBattleView = useCallback((battleId: string) => {
    const syncMode = resolveRealtimeBattleViewSyncMode({
      battleId,
      inTeam,
      isTeamLeader,
      viewMode: viewModeRef.current,
      hasLocalBattleTargets: hasLocalBattleTargetsRef.current,
      currentSessionBattleId: activeBattleSessionRef.current?.currentBattleId ?? null,
      currentReconnectBattleId: reconnectBattleIdRef.current,
    });
    if (syncMode === 'keep_local_battle') {
      return syncMode;
    }
    if (syncMode === 'sync_team_battle') {
      setTeamBattleId(battleId);
      setReconnectBattleId(null);
    } else {
      setTeamBattleId(null);
      setReconnectBattleId(battleId);
    }
    setViewMode('battle');
    setTopTab('map');
    setInfoTarget(null);
    return syncMode;
  }, [inTeam, isTeamLeader]);

  const handleRoomObjectSelect = useCallback((target: InfoTarget) => {
    if (target.type === 'item' && target.id === 'obj-warehouse') {
      setWarehouseModalOpen(true);
      return;
    }
    setInfoTarget(target);
  }, []);
  const teamMembers = useMemo<TeamMember[]>(() => {
    const list = teamInfo?.members ?? [];
    return list.map((m) => ({
      id: String(m.characterId),
      name: m.name,
      monthCardActive: m.monthCardActive,
      title: m.role === 'leader' ? '队长' : '队员',
      realm: m.realm,
      avatar: m.avatar,
      online: isTeamCharacterOnline(m.characterId),
      hp: 0,
      maxHp: 0,
      qi: 0,
      maxQi: 0,
      role: m.role,
    }));
  }, [isTeamCharacterOnline, teamInfo]);
  const characterId = character?.id ?? null;
  const partnerUnlocked = hasCharacterFeature(character, PARTNER_FEATURE_CODE);
  const myBattleUnitId = useMemo(() => (characterId ? `player-${characterId}` : null), [characterId]);
  const isMobileBattleMode = isMobile && viewMode === 'battle';

  const applyTeamOverview = useCallback((team: {
    info: TeamInfo | null;
    role: 'leader' | 'member' | null;
    applications: TeamApplication[];
  }) => {
    setTeamInfo(team.info);

    const teamId = team.info?.id ?? null;
    const leader = Boolean(teamId && team.role === 'leader');
    setIsTeamLeader(leader);

    if (!leader || !teamId) {
      setTeamApplicationUnread(0);
      return;
    }

    setTeamApplicationUnread(countUnreadTeamApplications(characterId, teamId, team.applications));
  }, [characterId]);

  useEffect(() => {
    setMobileChatDrawerOpen(false);
  }, [isMobileBattleMode]);

  const stopGatherLoop = useCallback(() => {
    gatherActionKeyRef.current = '';
    if (gatherTickTimerRef.current) {
      window.clearTimeout(gatherTickTimerRef.current);
      gatherTickTimerRef.current = null;
    }
    setGatherAction({ running: false });
  }, []);

  useEffect(() => {
    return () => stopGatherLoop();
  }, [stopGatherLoop]);

  useEffect(() => {
    if (!gatherAction.running) return;
    if (gatherAction.mapId !== currentMapId || gatherAction.roomId !== currentRoomId) stopGatherLoop();
  }, [currentMapId, currentRoomId, gatherAction, stopGatherLoop]);

  const appendSystemChat = useCallback((content: string) => {
    const text = String(content || '').trim();
    if (!text) return;
    window.dispatchEvent(
      new CustomEvent('chat:append', {
        detail: {
          channel: 'system',
          content: text,
          senderName: '系统',
          senderTitle: '',
          timestamp: Date.now(),
        },
      }),
    );
  }, []);

  const startGatherLoop = useCallback(
    (target: InfoTarget) => {
      if (target.type !== 'item') return;
      const resourceName = String(target.name || target.id || '').trim() || target.id;
      const key = `${Date.now()}-${Math.random()}`;
      gatherActionKeyRef.current = key;
      setGatherAction({
        running: true,
        mapId: currentMapId,
        roomId: currentRoomId,
        resourceId: target.id,
        resourceName,
        actionSec: 5,
        // 先不做本地预估，等待服务端时间，避免进度条回跳导致“进度不准”
        gatherUntilMs: 0,
        remaining: Math.max(0, target.resource?.remaining ?? 0),
      });
      appendSystemChat(`【采集】采集中：${resourceName}`);

      const tick = async () => {
        if (gatherActionKeyRef.current !== key) return;
        try {
          const res = await gatherRoomResource(currentMapId, currentRoomId, target.id);
          if (gatherActionKeyRef.current !== key) return;
          if (!res?.success) throw new Error(getUnifiedApiErrorMessage(res, '采集失败'));
          const d = res.data;
          const actionSec = typeof d?.actionSec === 'number' && d.actionSec > 0 ? d.actionSec : 5;
          const cooldownSec = typeof d?.cooldownSec === 'number' && d.cooldownSec > 0 ? d.cooldownSec : actionSec;
          const remaining = typeof d?.remaining === 'number' ? Math.max(0, Math.floor(d.remaining)) : 0;
          const parsedGatherUntilMs = d?.gatherUntil ? Date.parse(d.gatherUntil) : NaN;
          const gatherUntilMs =
            Number.isFinite(parsedGatherUntilMs) && parsedGatherUntilMs > 0
              ? parsedGatherUntilMs
              : Date.now() + cooldownSec * 1000;

          if (typeof d?.qty === 'number' && d.qty > 0) {
            const qty = Math.max(1, Math.floor(d.qty));
            const itemName = resourceName;
            appendSystemChat(`【采集】${resourceName}：成功获得【${itemName}】×${qty}`);
            window.dispatchEvent(new Event('inventory:changed'));
            window.dispatchEvent(new Event('room:objects:changed'));
            gameSocket.refreshCharacter();
          }

          if (remaining <= 0) {
            stopGatherLoop();
            return;
          }

          setGatherAction((prev) => {
            if (!prev.running) return prev;
            if (prev.resourceId !== target.id || prev.mapId !== currentMapId || prev.roomId !== currentRoomId) return prev;
            return { ...prev, actionSec, gatherUntilMs, remaining };
          });

          const now = Date.now();
          const delayMs = (() => {
            if (!(Number.isFinite(gatherUntilMs) && gatherUntilMs > now)) return 80;
            const leftMs = gatherUntilMs - now;
            if (leftMs > 260) return Math.max(80, leftMs - 180);
            return 80;
          })();
          gatherTickTimerRef.current = window.setTimeout(() => void tick(), delayMs);
        } catch (error: unknown) {
          if (gatherActionKeyRef.current !== key) return;
          stopGatherLoop();
          void 0;
        }
      };

      void tick();
    },
    [appendSystemChat, currentMapId, currentRoomId, stopGatherLoop],
  );

  const loadTrackedRoomIdsByMap = useCallback(async (mapId: string) => {
    try {
      // 复用首页任务总览共享请求层，避免地图追踪与任务角标首屏重复命中同一接口。
      const taskRes = await loadSharedTaskOverview(taskOverviewRequestScopeKeyRef.current);
      const taskList = taskRes?.success && taskRes.data?.tasks ? taskRes.data.tasks : [];

      // 获取主线任务追踪的房间
      const mainQuestRes = await getMainQuestProgress();
      const mainQuestProgress = mainQuestRes?.success ? mainQuestRes.data : null;
      setTrackedRoomIds(resolveTrackedRoomIdsForMap(mapId, taskList, mainQuestProgress));
    } catch {
      setTrackedRoomIds([]);
    }
  }, []);

  const refreshTrackedRoomIds = useCallback(async () => {
    if (!hasHydratedPosition || !currentMapId) {
      setTrackedRoomIds([]);
      return;
    }
    if (!homeOverviewSettled) {
      return;
    }

    const homeTaskSnapshot = pendingHomeTaskSnapshotRef.current;
    const homeMainQuestSnapshot = pendingHomeMainQuestSnapshotRef.current;
    if (homeTaskSnapshot && homeMainQuestSnapshot) {
      pendingHomeTaskSnapshotRef.current = null;
      pendingHomeMainQuestSnapshotRef.current = null;
      setTrackedRoomIds(resolveTrackedRoomIdsForMap(currentMapId, homeTaskSnapshot.tasks, homeMainQuestSnapshot));
      return;
    }

    await loadTrackedRoomIdsByMap(currentMapId);
  }, [currentMapId, hasHydratedPosition, homeOverviewSettled, loadTrackedRoomIdsByMap]);

  useEffect(() => {
    void refreshTrackedRoomIds();
  }, [refreshTrackedRoomIds]);

  useEffect(() => {
    if (viewMode !== 'battle') {
      battleSkillCasterRef.current = async () => false;
    }
  }, [viewMode]);

  const handleAdvanceBattleSession = useCallback(async () => {
    const session = activeBattleSession;
    if (!session) {
      messageRef.current.error('推进战斗失败：缺少战斗会话');
      return;
    }

    try {
      const res = await advanceBattleSession(session.sessionId, SILENT_API_REQUEST_CONFIG);
      const nextSession = res?.data?.session ?? null;
      if (!res?.success || !nextSession) {
        void 0;
        return;
      }

      setActiveBattleSession(nextSession);
      const nextBattleId = nextSession.currentBattleId;
      if (nextBattleId) {
        clearBattleAutoCloseTimer();
        setTeamBattleId(null);
        setReconnectBattleId(null);
        setViewMode('battle');
        setTopTab('map');
        setInfoTarget(null);
        return;
      }

      if (nextSession.type === 'dungeon') {
        if (nextSession.status === 'completed') {
          messageRef.current.success('秘境已通关');
        } else if (nextSession.status === 'failed') {
          messageRef.current.error('秘境挑战失败');
        } else {
          messageRef.current.info('秘境已结束');
        }
      }

      setReconnectBattleId(null);
      setViewMode('map');
      setTopTab('map');
      setBattleTurn(0);
      setBattlePhase(null);
      setBattleActiveUnitId(null);
    } catch (error) {
      const latestSessionId = activeBattleSessionRef.current?.sessionId ?? null;
      const errorText = getUnifiedApiErrorMessage(error, '推进战斗失败');
      if (latestSessionId !== session.sessionId && isBattleSessionMissingError(errorText)) {
        return;
      }
      if (latestSessionId !== session.sessionId) {
        return;
      }
      messageRef.current.error(errorText);
    }
  }, [activeBattleSession, clearBattleAutoCloseTimer]);

  useEffect(() => {
    const session = activeBattleSession;
    const canControlSession = !inTeam || isTeamLeader;
    const latestBattleCooldown = gameSocket.getLatestBattleCooldown();
    const isSessionAdvanceCoolingDown =
      session?.type === 'pve'
      && session.nextAction === 'advance'
      && latestBattleCooldown?.active === true
      && latestBattleCooldown.characterId === characterId;
    if (
      !session
      || !session.canAdvance
      || !canControlSession
      || isSessionAdvanceCoolingDown
    ) {
      clearSessionAutoAdvanceTimer();
      lastAutoAdvanceSessionKeyRef.current = '';
      return;
    }

    const autoAdvanceKey = [
      session.sessionId,
      session.currentBattleId ?? '',
      session.status,
      session.nextAction,
      session.lastResult ?? '',
    ].join('|');

    if (lastAutoAdvanceSessionKeyRef.current === autoAdvanceKey) {
      return;
    }

    clearSessionAutoAdvanceTimer();
    lastAutoAdvanceSessionKeyRef.current = autoAdvanceKey;
    sessionAutoAdvanceTimerRef.current = window.setTimeout(() => {
      sessionAutoAdvanceTimerRef.current = null;
      void handleAdvanceBattleSession();
    }, 200);

    return () => {
      clearSessionAutoAdvanceTimer();
    };
  }, [
    activeBattleSession,
    battleCooldownStateVersion,
    characterId,
    clearSessionAutoAdvanceTimer,
    handleAdvanceBattleSession,
    inTeam,
    isTeamLeader,
  ]);

  const allowAutoNextBattle = useMemo(() => {
    if (!activeBattleSession?.canAdvance) return false;
    return !inTeam || isTeamLeader;
  }, [activeBattleSession?.canAdvance, inTeam, isTeamLeader]);

  const battleAdvanceMode = useMemo<BattleAdvanceMode>(() => {
    if (activeBattleSession?.canAdvance && (!inTeam || isTeamLeader)) {
      if (activeBattleSession.type === 'pve' && activeBattleSession.nextAction === 'advance') {
        return 'auto_session_cooldown';
      }
      return 'auto_session';
    }
    if (activeSessionBattleId || reconnectBattleId || (inTeam && !isTeamLeader && teamBattleId)) {
      return 'wait_external';
    }
    return 'auto_local_retry';
  }, [
    activeBattleSession?.canAdvance,
    activeSessionBattleId,
    inTeam,
    isTeamLeader,
    reconnectBattleId,
    teamBattleId,
  ]);

  const battleOnNext = useMemo(() => {
    if (!activeBattleSession?.canAdvance) return undefined;
    if (inTeam && !isTeamLeader) return undefined;
    return handleAdvanceBattleSession;
  }, [activeBattleSession?.canAdvance, handleAdvanceBattleSession, inTeam, isTeamLeader]);

  /**
   * 控制 BattleArea 是否允许“无 externalBattleId 时本地自动开战”。
   *
   * 设计目的：
   * - 普通地图点击怪物进入战斗时，需要本地自动调用 `/battle/start`。
   * - 秘境/竞技场/重连/队友战斗接管场景必须等待 externalBattleId，
   *   否则会误用普通 PVE 开战接口，触发“战斗目标不在当前房间”。
   *
   * 关键边界条件：
   * - 只要任一外部战斗上下文存在（实例、战斗ID、重连ID），就禁止本地自动开战。
   * - 该开关只影响 BattleArea 的自动开战分支，不影响已存在 battleId 的状态拉取与行动请求。
   */
  const allowLocalBattleStart = useMemo(() => {
    const hasSessionContext = Boolean(activeBattleSession?.currentBattleId);
    const hasReconnectContext = Boolean(reconnectBattleId);
    const hasTeamReplayContext = Boolean(inTeam && !isTeamLeader && teamBattleId);
    return !(hasSessionContext || hasReconnectContext || hasTeamReplayContext);
  }, [activeBattleSession?.currentBattleId, inTeam, isTeamLeader, reconnectBattleId, teamBattleId]);

  const bindBattleSkillCaster = useCallback((caster: (skillId: string, targetType?: string) => Promise<boolean>) => {
    battleSkillCasterRef.current = caster;
  }, []);

  const handleBattleTurnChange = useCallback(
    (turnCount: number, turnSide: 'enemy' | 'ally', actionKey: string, activeUnitId: string | null, phase: string | null) => {
      setBattleTurn((prev) => (prev === turnCount ? prev : turnCount));
      setBattleTurnSide((prev) => (prev === turnSide ? prev : turnSide));
      setBattleActionKey((prev) => (prev === actionKey ? prev : actionKey));
      setBattleActiveUnitId((prev) => (prev === activeUnitId ? prev : activeUnitId));
      setBattlePhase((prev) => (prev === phase ? prev : phase));
    },
    [],
  );

  const handleBattleEscape = useCallback(() => {
    clearSessionAutoAdvanceTimer();
    lastAutoAdvanceSessionKeyRef.current = '';
    setViewMode('map');
    setBattleTurn(0);
    setBattlePhase(null);
    setBattleActiveUnitId(null);
    setActiveBattleSession(null);
    setReconnectBattleId(null);
  }, [clearSessionAutoAdvanceTimer]);

  const handleBattleCastSkill = useCallback((skillId: string, targetType?: string) => {
    return battleSkillCasterRef.current(skillId, targetType);
  }, []);

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  const resetNpcTalkState = useCallback(() => {
    setNpcTalkNpcId('');
    setNpcTalkData(null);
    setNpcTalkActionKey('');
    setNpcTalkSelectedTaskId('');
    setNpcTalkPhase('root');
    setNpcDialogue([]);
    setMainQuestDialogueState(null);
    setMainQuestDialogueLoading(false);
    mainQuestDialogueNodeIdRef.current = '';
  }, []);

  const resetMainQuestDialogueFlow = useCallback(() => {
    setNpcTalkPhase('root');
    setMainQuestDialogueState(null);
    setMainQuestDialogueLoading(false);
    mainQuestDialogueNodeIdRef.current = '';
  }, []);

  const closeNpcTalk = useCallback(() => {
    setNpcTalkOpen(false);
    resetNpcTalkState();
  }, [resetNpcTalkState]);

  const refreshNpcTalk = useCallback(async (npcId: string): Promise<NpcTalkData | null> => {
    const nid = (npcId || '').trim();
    if (!nid) return null;
    setNpcTalkLoading(true);
    try {
      const res = await npcTalk(nid);
      if (!res?.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '对话失败'));
      const data: NpcTalkData = res.data;
      setNpcTalkData(data);
      return data;
    } catch {
      void 0;
      return null;
    } finally {
      setNpcTalkLoading(false);
    }
  }, []);

  const appendNpcDialogue = useCallback((role: NpcDialogueEntry['role'], text: string, speaker?: string) => {
    const entry = createNpcDialogueEntry({ role, text, speaker });
    if (!entry) return;
    setNpcDialogue((prev) => [...prev, entry]);
  }, []);

  const appendNpcDialogueEntries = useCallback((entries: NpcDialogueEntry[]) => {
    if (entries.length === 0) return;
    setNpcDialogue((prev) => [...prev, ...entries]);
  }, []);

  const syncMainQuestDialogueNode = useCallback((dialogueState: DialogueState | null) => {
    const node = dialogueState?.currentNode;
    if (!node) return;
    if (node.id === mainQuestDialogueNodeIdRef.current) return;
    const entries = createNpcDialogueEntriesFromDialogueNode(node);
    if (entries.length === 0) return;
    mainQuestDialogueNodeIdRef.current = node.id;
    appendNpcDialogueEntries(entries);
  }, [appendNpcDialogueEntries]);

  const openNpcTalk = useCallback(async (npcId: string) => {
    setNpcTalkNpcId(npcId);
    setNpcTalkOpen(true);
    setNpcTalkData(null);
    setNpcTalkActionKey('');
    setNpcTalkSelectedTaskId('');
    setNpcTalkPhase('root');
    setNpcDialogue([]);
    setMainQuestDialogueState(null);
    setMainQuestDialogueLoading(false);
    mainQuestDialogueNodeIdRef.current = '';
    const data = await refreshNpcTalk(npcId);
    setNpcDialogue(createNpcDialogueEntriesFromLines(data?.lines ?? [], '……'));
  }, [refreshNpcTalk]);

  const finalizeMainQuestDialogue = useCallback(async () => {
    await refreshNpcTalk(npcTalkNpcId);
    await refreshTrackedRoomIds();
    resetMainQuestDialogueFlow();
    window.dispatchEvent(new Event('room:objects:changed'));
  }, [npcTalkNpcId, refreshNpcTalk, refreshTrackedRoomIds, resetMainQuestDialogueFlow]);

  const npcTalkBusyText = useMemo(() => {
    if (mainQuestDialogueLoading) return '对方正在整理回应……';
    if (npcTalkActionKey) return '正在确认委托结果……';
    if (npcTalkLoading) {
      return npcDialogue.length > 0 ? '正在同步最新对话……' : '正在接入对话……';
    }
    return null;
  }, [mainQuestDialogueLoading, npcDialogue.length, npcTalkActionKey, npcTalkLoading]);

  const buildTaskNpcLine = useCallback((t: NpcTalkTaskOption): string => {
    const title = String(t.title || '').trim() || '这件事';
    if (t.status === 'available') return `我这里正好有个委托：「${title}」。你可愿意接下？`;
    if (t.status === 'turnin') return `你可完成了「${title}」？若已完成，便交予我结算。`;
    if (t.status === 'claimable') return `辛苦了，「${title}」办得不错。来，这是你的报酬。`;
    if (t.status === 'accepted') return `「${title}」还在进行中，按要求完成后再来找我。`;
    if (t.status === 'locked') return `此事尚未到时机，你再等等。`;
    return `「${title}」此事已了。`;
  }, []);

  const refreshEquippedItems = useCallback(async () => {
    try {
      const res = await getInventoryItems('equipped', 1, 200);
      if (!res.success || !res.data) throw new Error(getUnifiedApiErrorMessage(res, '获取已穿戴物品失败'));
      setEquippedItems(mapInventoryItemsToEquippedViews(res.data.items ?? []));
    } catch {
      setEquippedItems([]);
    }
  }, []);

  useEffect(() => {
    if (!characterId) {
      setEquippedItems([]);
      return;
    }
    if (!homeOverviewSettled) {
      return;
    }
    if (homeOverviewEquippedItems !== null) {
      setEquippedItems(mapInventoryItemsToEquippedViews(homeOverviewEquippedItems));
      return;
    }
    void refreshEquippedItems();
  }, [characterId, homeOverviewEquippedItems, homeOverviewSettled, refreshEquippedItems]);

  useEffect(() => {
    const handler = () => {
      void refreshEquippedItems();
    };
    window.addEventListener('inventory:changed', handler);
    return () => window.removeEventListener('inventory:changed', handler);
  }, [refreshEquippedItems]);

  const equippedByUiSlot = useMemo(() => {
    const m = new Map<string, { id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto }>();
    for (const it of equippedItems) {
      const uiSlot = EQUIPPED_SLOT_TO_UI_LABEL[it.equippedSlot];
      if (!uiSlot) continue;
      m.set(uiSlot, it);
    }
    return m;
  }, [equippedItems]);

  const handleUnequipFromPanel = useCallback(
    async (it: { id: number; name: string }) => {
      if (unequippingId != null) return;
      setUnequippingId(it.id);
      try {
        const res = await unequipInventoryItem(it.id, 'bag');
        if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '卸下失败'));
        messageRef.current.success(res.message || '卸下成功');
        window.dispatchEvent(new Event('inventory:changed'));
      } catch (error: unknown) {
        void 0;
      } finally {
        setUnequippingId(null);
      }
    },
    [unequippingId],
  );

  // 订阅角色数据
  useEffect(() => {
    gameSocket.connect();
    const unsubscribe = gameSocket.onCharacterUpdate((data) => {
      setCharacter(data);
      if (data && typeof data.autoCastSkills === 'boolean') {
        setAutoMode(data.autoCastSkills);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleAutoModeChange = useCallback(
    (next: boolean) => {
      setAutoMode(next);
      void (async () => {
        const res = await updateCharacterAutoCastSkills(next);
        if (!res.success) {
          setAutoMode(!next);
          void 0;
        }
      })();
    },
    [],
  );

  const refreshTeamData = useCallback(async () => {
    if (!characterId) return;
    try {
      const res = await getMyTeam(characterId, SILENT_API_REQUEST_CONFIG);
      if (!res.success) {
        applyTeamOverview({ info: null, role: null, applications: [] });
        return;
      }

      const nextTeamId = res.data?.id ?? null;
      if (!nextTeamId || res.role !== 'leader') {
        applyTeamOverview({
          info: res.data ?? null,
          role: res.role === 'leader' ? 'leader' : res.role === 'member' ? 'member' : null,
          applications: [],
        });
        return;
      }

      const appsRes = await getTeamApplications(nextTeamId, characterId, SILENT_API_REQUEST_CONFIG);
      if (!appsRes.success) {
        applyTeamOverview({
          info: res.data ?? null,
          role: 'leader',
          applications: [],
        });
        return;
      }

      applyTeamOverview({
        info: res.data ?? null,
        role: 'leader',
        applications: appsRes.data ?? [],
      });
    } catch {
      applyTeamOverview({ info: null, role: null, applications: [] });
    }
  }, [applyTeamOverview, characterId]);

  const applySectIndicator = useCallback((payload: SectIndicatorPayload) => {
    setSectMyApplicationCount(Math.max(0, Math.floor(payload.myPendingApplicationCount)));
    setSectPendingApplicationCount(
      payload.canManageApplications ? Math.max(0, Math.floor(payload.sectPendingApplicationCount)) : 0
    );
  }, []);

  const applyMailIndicator = useCallback((payload: MailIndicatorPayload) => {
    const unreadCount = Math.max(0, Math.floor(Number(payload.unreadCount) || 0));
    setShowMailDot(unreadCount > 0);
  }, []);

  const applyTechniqueResearchStatus = useCallback((status: TechniqueResearchStatusData | null) => {
    setTechniqueIndicatorStatus(resolveTechniqueResearchIndicatorStatus(status));
  }, []);

  useEffect(() => {
    if (!characterId) {
      applyTeamOverview({ info: null, role: null, applications: [] });
      return;
    }
    const unsubscribe = gameSocket.onTeamUpdate(() => {
      void refreshTeamData();
    });
    return unsubscribe;
  }, [applyTeamOverview, characterId, refreshTeamData]);

  useEffect(() => {
    if (!characterId) {
      setSectPendingApplicationCount(0);
      setSectMyApplicationCount(0);
      return;
    }

    const unsubscribe = gameSocket.onSectUpdate((payload) => {
      applySectIndicator(payload);
    });
    return unsubscribe;
  }, [applySectIndicator, characterId]);

  useEffect(() => {
    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((data: BattleRealtimePayload) => {
      const kind = data.kind;
      const battleId = data.battleId;
      const currentSessionBattleId = activeBattleSessionRef.current?.currentBattleId ?? null;
      if (!battleId) return;

      if (kind === 'battle_started' || kind === 'battle_state') {
        clearBattleAutoCloseTimer();
        if (battleId === currentSessionBattleId && viewModeRef.current === 'battle') {
          return;
        }
        const syncMode = syncRealtimeBattleView(battleId);
        if (syncMode === 'sync_reconnect_battle') {
          void restoreBattleSessionContext(battleId);
        }
        return;
      }

      if (kind === 'battle_abandoned') {
        clearBattleAutoCloseTimer();
        if (battleId === currentSessionBattleId) {
          setActiveBattleSession(null);
        }
        setTeamBattleId(null);
        setReconnectBattleId(null);
        setViewMode('map');
        setTopTab('map');
        setInfoTarget(null);
        return;
      }

      if (kind === 'battle_finished') {
        clearBattleAutoCloseTimer();
        if (battleId === currentSessionBattleId && viewModeRef.current === 'battle') {
          return;
        }
        const syncMode = syncRealtimeBattleView(battleId);
        if (syncMode === 'sync_reconnect_battle') {
          void restoreBattleSessionContext(battleId);
        }
        if (syncMode === 'keep_local_battle') {
          return;
        }
        teamBattleAutoCloseTimerRef.current = window.setTimeout(() => {
          setTeamBattleId(null);
          setReconnectBattleId(null);
          setViewMode('map');
        }, 6000);
      }
    });
    return () => {
      clearBattleAutoCloseTimer();
      unsub();
    };
  }, [clearBattleAutoCloseTimer, restoreBattleSessionContext, syncRealtimeBattleView]);

  useEffect(() => {
    if (!characterId) return;
    if (activeBattleSessionRef.current || reconnectBattleIdRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await getCurrentBattleSession();
        const session = res?.data?.session ?? null;
        if (cancelled || !res?.success || !session) {
          return;
        }
        handleBattleSessionChange(session);
      } catch {
        void 0;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [characterId, handleBattleSessionChange]);

  const onLeaveTeam = useCallback(async () => {
    if (!characterId) return;
    try {
      const res = await leaveTeam(characterId);
      if (!res.success) {
        void 0;
        return;
      }
      messageRef.current.success(res.message || '已退出队伍');
      clearBattleAutoCloseTimer();
      setTeamBattleId(null);
      setReconnectBattleId(null);
      setActiveBattleSession(null);
      setViewMode('map');
      setTopTab('map');
      setBattleTurn(0);
      setBattlePhase(null);
      setBattleActiveUnitId(null);
      void refreshTeamData();
    } catch {
      void 0;
    }
  }, [characterId, clearBattleAutoCloseTimer, refreshTeamData]);

  useEffect(() => {
    if (!character || hydratedPositionRef.current) return;
    const position = readCharacterWorldPosition(character);
    if (!position) return;
    setCurrentMapId(position.mapId);
    setCurrentRoomId(position.roomId);
    setHasHydratedPosition(true);
    hydratedPositionRef.current = true;
  }, [character]);

  const savePosition = useCallback((mapId: string, roomId: string) => {
    const nextMapId = String(mapId || '').trim();
    const nextRoomId = String(roomId || '').trim();
    if (!nextMapId || !nextRoomId) return;
    void updateCharacterPosition(nextMapId, nextRoomId, SILENT_API_REQUEST_CONFIG).catch(() => undefined);
  }, []);

  const flushPendingPosition = useCallback((keepalive: boolean) => {
    const latest = latestPositionRef.current;
    if (!latest) return;
    if (positionSaveTimerRef.current) {
      window.clearTimeout(positionSaveTimerRef.current);
      positionSaveTimerRef.current = null;
    }

    pendingPositionRef.current = null;
    const nextMapId = String(latest.mapId || '').trim();
    const nextRoomId = String(latest.roomId || '').trim();
    if (!nextMapId || !nextRoomId) return;

    const key = `${nextMapId}@@${nextRoomId}`;
    if (keepalive) {
      if (key === lastKeepalivePositionKeyRef.current) return;
      lastKeepalivePositionKeyRef.current = key;
      updateCharacterPositionKeepalive(nextMapId, nextRoomId);
    }
    else void updateCharacterPosition(nextMapId, nextRoomId, SILENT_API_REQUEST_CONFIG).catch(() => undefined);
  }, []);

  const scheduleSavePosition = useCallback((mapId: string, roomId: string) => {
    latestPositionRef.current = { mapId, roomId };
    pendingPositionRef.current = { mapId, roomId };
    if (positionSaveTimerRef.current) {
      window.clearTimeout(positionSaveTimerRef.current);
    }
    positionSaveTimerRef.current = window.setTimeout(() => {
      const pending = pendingPositionRef.current;
      pendingPositionRef.current = null;
      positionSaveTimerRef.current = null;
      if (!pending) return;
      savePosition(pending.mapId, pending.roomId);
    }, 0);
  }, [savePosition]);

  useEffect(() => {
    return () => {
      flushPendingPosition(true);
    };
  }, [flushPendingPosition]);

  useEffect(() => {
    const onPageHide = () => flushPendingPosition(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingPosition(true);
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flushPendingPosition]);

  const refreshSignInDot = useCallback(async () => {
    try {
      const res = await getSignInOverview(resolveCurrentMonth());
      if (!res.success || !res.data) return;
      setShowSignInDot(!res.data.signedToday);
    } catch {
      setShowSignInDot(false);
    }
  }, []);

  useEffect(() => {
    if (!characterId) {
      setShowMailDot(false);
      return;
    }

    return gameSocket.onMailUpdate((payload) => {
      applyMailIndicator(payload);
    });
  }, [applyMailIndicator, characterId]);

  useEffect(() => {
    if (!characterId) {
      setAchievementClaimableCount(0);
      return;
    }

    return gameSocket.onAchievementUpdate((payload) => {
      if (payload.characterId !== characterId) return;
      const claimableCount = Math.max(0, Math.floor(Number(payload.claimableCount) || 0));
      setAchievementClaimableCount(claimableCount);
    });
  }, [characterId]);

  useEffect(() => {
    if (!TECHNIQUE_RESEARCH_ENABLED) {
      setTechniqueIndicatorStatus(null);
      return undefined;
    }
    if (!characterId) {
      setTechniqueIndicatorStatus(null);
      return undefined;
    }

    return gameSocket.onTechniqueResearchStatusUpdate((payload) => {
      if (payload.characterId !== characterId) return;
      applyTechniqueResearchStatus(payload.status);
    });
  }, [applyTechniqueResearchStatus, characterId]);

  const clearTaskIndicatorQueuedRefreshTimer = useCallback(() => {
    if (taskIndicatorQueuedRefreshTimerRef.current == null) return;
    window.clearTimeout(taskIndicatorQueuedRefreshTimerRef.current);
    taskIndicatorQueuedRefreshTimerRef.current = null;
  }, []);

  const clearTaskIndicatorExpiryTimer = useCallback(() => {
    if (taskIndicatorExpiryTimerRef.current == null) return;
    window.clearTimeout(taskIndicatorExpiryTimerRef.current);
    taskIndicatorExpiryTimerRef.current = null;
  }, []);

  const applyTaskIndicatorSnapshot = useCallback((
    taskRows: TaskOverviewRowDto[],
    bountyTasks: BountyTaskOverviewRowDto[],
    onExpiry: () => void,
  ) => {
    const nowTs = Date.now();
    const { count, nextExpiryTs } = resolveTaskIndicatorSnapshot(taskRows, bountyTasks, nowTs);
    latestBountyOverviewTasksRef.current = bountyTasks;
    clearTaskIndicatorExpiryTimer();
    if (nextExpiryTs != null) {
      const delayMs = Math.max(0, nextExpiryTs - nowTs + 1000);
      taskIndicatorExpiryTimerRef.current = window.setTimeout(() => {
        taskIndicatorExpiryTimerRef.current = null;
        onExpiry();
      }, delayMs);
    }
    setTaskCompletableCount(count);
  }, [clearTaskIndicatorExpiryTimer]);

  const refreshTaskIndicator = useCallback(async () => {
    if (!characterId) {
      latestBountyOverviewTasksRef.current = [];
      clearTaskIndicatorExpiryTimer();
      setTaskCompletableCount(0);
      return;
    }

    const [taskResult, bountyResult] = await Promise.allSettled([
      loadSharedTaskOverview(taskOverviewRequestScopeKeyRef.current),
      loadSharedBountyTaskOverview(taskOverviewRequestScopeKeyRef.current),
    ]);

    const taskRows = taskResult.status === 'fulfilled' && taskResult.value.success && taskResult.value.data
      ? taskResult.value.data.tasks || []
      : [];
    const bountyTasks = bountyResult.status === 'fulfilled' && bountyResult.value.success && bountyResult.value.data
      ? bountyResult.value.data.tasks || []
      : [];
    applyTaskIndicatorSnapshot(taskRows, bountyTasks, () => {
      void refreshTaskIndicator();
    });
  }, [applyTaskIndicatorSnapshot, characterId, clearTaskIndicatorExpiryTimer]);

  const queueTaskIndicatorRefresh = useCallback((delayMs: number = 240) => {
    if (!characterId) return;
    clearTaskIndicatorQueuedRefreshTimer();
    taskIndicatorQueuedRefreshTimerRef.current = window.setTimeout(() => {
      taskIndicatorQueuedRefreshTimerRef.current = null;
      void refreshTaskIndicator();
    }, Math.max(0, delayMs));
  }, [characterId, clearTaskIndicatorQueuedRefreshTimer, refreshTaskIndicator]);

  const handleTaskCompletedChange = useCallback(() => {
    if (gameSocket.isSocketConnected()) return;
    void refreshTaskIndicator();
  }, [refreshTaskIndicator]);

  useEffect(() => {
    if (!characterId) return;

    const requestSeq = homeOverviewRequestSeqRef.current + 1;
    homeOverviewRequestSeqRef.current = requestSeq;
    homeOverviewLoadingRef.current = true;
    setHomeOverviewSettled(false);
    setHomeOverviewRealmOverview(undefined);
    setHomeOverviewEquippedItems(null);
    setHomeOverviewIdleSession(undefined);

    void (async () => {
      try {
        const response = await getGameHomeOverview();
        if (homeOverviewRequestSeqRef.current !== requestSeq) return;
        if (!response.success || !response.data) {
          homeOverviewLoadingRef.current = false;
          setHomeOverviewRealmOverview(null);
          setHomeOverviewIdleSession(undefined);
          pendingHomeTaskSnapshotRef.current = null;
          pendingHomeMainQuestSnapshotRef.current = null;
          setHomeOverviewSettled(true);
          return;
        }

        const overview = response.data;
        hydratePhoneBindingStatus(overview.phoneBinding);
        setShowSignInDot(!overview.signIn.signedToday);
        setAchievementClaimableCount(Math.max(0, Math.floor(overview.achievement.claimableCount)));
        setHomeOverviewRealmOverview(overview.realmOverview);
        setHomeOverviewEquippedItems(overview.equippedItems);
        setHomeOverviewIdleSession(overview.idleSession);
        applyTeamOverview(overview.team);
        pendingHomeTaskSnapshotRef.current = overview.task;
        pendingHomeMainQuestSnapshotRef.current = overview.mainQuest;
        applyTaskIndicatorSnapshot(overview.task.tasks, overview.task.bountyTasks, () => {
          void refreshTaskIndicator();
        });
        homeOverviewLoadingRef.current = false;
        setHomeOverviewSettled(true);
      } catch {
        if (homeOverviewRequestSeqRef.current !== requestSeq) return;
        homeOverviewLoadingRef.current = false;
        setHomeOverviewRealmOverview(null);
        setHomeOverviewIdleSession(undefined);
        pendingHomeTaskSnapshotRef.current = null;
        pendingHomeMainQuestSnapshotRef.current = null;
        setHomeOverviewSettled(true);
      } finally {
        if (homeOverviewRequestSeqRef.current === requestSeq) {
          homeOverviewLoadingRef.current = false;
        }
      }
    })();
  }, [
    applyTaskIndicatorSnapshot,
    applyTeamOverview,
    characterId,
    refreshTaskIndicator,
  ]);

  useEffect(() => {
    if (!characterId) {
      homeOverviewLoadingRef.current = false;
      homeOverviewRequestSeqRef.current += 1;
      pendingHomeTaskSnapshotRef.current = null;
      pendingHomeMainQuestSnapshotRef.current = null;
      setHomeOverviewSettled(false);
      setHomeOverviewRealmOverview(undefined);
      setHomeOverviewEquippedItems(null);
      setHomeOverviewIdleSession(undefined);
      invalidatePhoneBindingStatus();
      applyTeamOverview({ info: null, role: null, applications: [] });
      setAchievementClaimableCount(0);
      setShowSignInDot(false);
      setTrackedRoomIds([]);
      latestBountyOverviewTasksRef.current = [];
      clearTaskIndicatorQueuedRefreshTimer();
      clearTaskIndicatorExpiryTimer();
      setTaskCompletableCount(0);
      return;
    }

    return () => {
      clearTaskIndicatorQueuedRefreshTimer();
      clearTaskIndicatorExpiryTimer();
    };
  }, [applyTeamOverview, characterId, clearTaskIndicatorExpiryTimer, clearTaskIndicatorQueuedRefreshTimer]);

  useEffect(() => {
    if (!characterId) return;
    const unsubscribe = gameSocket.onTaskOverviewUpdate((payload) => {
      if (payload.characterId !== characterId) return;
      if (!homeOverviewSettled) return;
      queueTaskIndicatorRefresh();
    });
    return unsubscribe;
  }, [characterId, homeOverviewSettled, queueTaskIndicatorRefresh]);

  const spiritStones = character?.spiritStones || 0;
  const silver = character?.silver || 0;
  const playerName = character?.nickname || '我';
  const genderValue = String(character?.gender ?? '').trim().toLowerCase();
  const isFemale = genderValue === 'female' || genderValue === 'f' || genderValue === '女';
  const equipPortrait = isFemale ? equipFemale : equipMale;
  const functionIndicators: Record<string, { badgeCount?: number; badgeDot?: boolean; tooltip?: string }> | undefined = useMemo(() => {
    const out: Record<string, { badgeCount?: number; badgeDot?: boolean; tooltip?: string }> = {};
    if (isTeamLeader && teamApplicationUnread > 0) {
      out.team = {
        badgeCount: teamApplicationUnread,
        tooltip: `有${teamApplicationUnread}个入队申请待处理`,
      };
    }
    const sectPendingTotal = sectPendingApplicationCount + sectMyApplicationCount;
    if (sectPendingTotal > 0) {
      const tooltipParts: string[] = [];
      if (sectPendingApplicationCount > 0) {
        tooltipParts.push(`有${sectPendingApplicationCount}个入门申请待处理`);
      }
      if (sectMyApplicationCount > 0) {
        tooltipParts.push(`你有${sectMyApplicationCount}个入门申请待处理`);
      }
      out.sect = {
        badgeDot: true,
        tooltip: tooltipParts.join('；'),
      };
    }
    if (achievementClaimableCount > 0) {
      out.achievement = {
        badgeCount: achievementClaimableCount,
        tooltip: `有${achievementClaimableCount}个成就奖励可领取`,
      };
    }
    if (taskCompletableCount > 0) {
      out.task = {
        badgeCount: taskCompletableCount,
        tooltip: `有${taskCompletableCount}个任务可完成`,
      };
    }
    if (techniqueIndicatorStatus) {
      out.technique = {
        badgeDot: true,
        tooltip: getTechniqueResearchIndicatorTooltip(techniqueIndicatorStatus),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [achievementClaimableCount, isTeamLeader, sectMyApplicationCount, sectPendingApplicationCount, taskCompletableCount, teamApplicationUnread, techniqueIndicatorStatus]);

  const functionItemStates = useMemo(
    () => ({
      partner: {
        locked: !partnerUnlocked,
        tooltip: partnerUnlocked ? undefined : PARTNER_FEATURE_UNLOCK_HINT,
      },
    }),
    [partnerUnlocked],
  );

  const handleInfoAction = (action: string, target: InfoTarget) => {
    if (action === 'attack') {
      // 当前“攻击”流程只接入了 PVE（怪物）开战接口，玩家目标没有对应开战后端。
      // 若放行会进入空战斗页（回合=0、无敌方单位），看起来像“卡住”。
      if (target.type !== 'monster') {
        messageRef.current.error('当前仅支持攻击怪物目标');
        return;
      }
      if (inTeam && !isTeamLeader) {
        messageRef.current.error('组队中只有队长可以发起战斗');
        return;
      }
      setBattleEnemies(buildEnemyGroup(target));
      setBattleAllies(buildAllyGroup(character));
      setReconnectBattleId(null);
      setViewMode('battle');
      setTopTab('map');
      setInfoTarget(null);
      return;
    }
    if (action === 'gather' && target.type === 'item') {
      stopGatherLoop();
      startGatherLoop(target);
      setInfoTarget(null);
      return;
    }
    if (action === 'talk' && target.type === 'npc') {
      setInfoTarget(null);
      void openNpcTalk(target.id);
      return;
    }
    if (action === 'pm' && target.type === 'player') {
      chatPanelRef.current?.openPrivateChat(target);
      setInfoTarget(null);
    }
    if (action === 'pickup' && target.type === 'item') {
      setInfoTarget(null);
      void (async () => {
        try {
          const res = await pickupRoomItem(currentMapId, currentRoomId, target.id);
          if (!res?.success) throw new Error(getUnifiedApiErrorMessage(res, '拾取失败'));
          const qty = typeof res.data?.qty === 'number' ? Math.max(0, Math.floor(res.data.qty)) : 0;
          if (qty > 0) {
            const itemName = String(target.name || target.id || '').trim() || target.id;
            appendSystemChat(`【拾取】成功获得【${itemName}】×${qty}`);
            messageRef.current.success(res?.message || '拾取成功');
            window.dispatchEvent(new Event('inventory:changed'));
            window.dispatchEvent(new Event('room:objects:changed'));
            gameSocket.refreshCharacter();
          } else {
            messageRef.current.info(res?.message || '什么都没捡到');
          }
        } catch (e: unknown) {
          void 0;
        }
      })();
      return;
    }
  };

  return (
    <div className={`game-page${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
      <SkillFloatButton
        turn={viewMode === 'battle' ? battleTurn : undefined}
        turnSide={viewMode === 'battle' ? battleTurnSide : undefined}
        isMyTurn={viewMode === 'battle' && myBattleUnitId != null && battleActiveUnitId === myBattleUnitId}
        isBattleRunning={viewMode === 'battle' && battleTurn > 0}
        battlePhase={viewMode === 'battle' ? (battlePhase ?? undefined) : undefined}
        actionKey={viewMode === 'battle' ? battleActionKey : undefined}
        autoMode={autoMode}
        onAutoModeChange={handleAutoModeChange}
        onCastSkill={handleBattleCastSkill}
      />
      <header className="game-header">
        <div className="game-header-left">
          <img className="game-header-logo" src={gameHeaderLogo} alt="九州修仙录" />
          <div className="game-header-meta">
            <div className="game-header-title">九州修仙录</div>
            <div className="game-header-version">v{version}</div>
          </div>
        </div>

        <div className="game-header-right">
          {gatherAction.running ? <GatherProgressHeader gatherAction={gatherAction} onStop={stopGatherLoop} /> : null}
          {/* 挂机状态指示器：仅在活跃会话时显示 */}
          <IdleBattleStatusBar
            idle={idle}
            onOpenPanel={() => setIdleModalOpen(true)}
          />

          <div className="game-header-currency">
            <img className="game-header-currency-icon" src={lingshi} alt="灵石" />
            <span className="game-header-currency-value">{spiritStones.toLocaleString()}</span>
          </div>
          <div className="game-header-currency">
            <img className="game-header-currency-icon" src={tongqian} alt="银两" />
            <span className="game-header-currency-value">{silver.toLocaleString()}</span>
          </div>

          <Badge dot={showSignInDot} offset={[-2, 2]}>
            <Button
              className="game-header-icon-btn"
              type="text"
              icon={<CalendarOutlined />}
              aria-label="签到"
              onClick={() => setSignInModalOpen(true)}
            />
          </Badge>
          <Badge dot={showMailDot} offset={[-2, 2]}>
            <Button
              className="game-header-icon-btn"
              type="text"
              icon={<MailOutlined />}
              aria-label="邮箱"
              onClick={() => setMailModalOpen(true)}
            />
          </Badge>
          <Button
            className="game-header-icon-btn"
            type="text"
            icon={<SettingOutlined />}
            aria-label="设置"
            onClick={() => setSettingModalOpen(true)}
          />
          {onLogout && (
            <Button className="game-header-icon-btn" type="text" icon={<LogoutOutlined />} aria-label="退出" onClick={onLogout} />
          )}
        </div>
      </header>

      <div className="game-container">
        {!isMobile ? (
          <aside className="game-left">
            <PlayerInfo
              initialRealmOverview={homeOverviewRealmOverview}
              suspendInitialRealmOverviewLoad={!homeOverviewSettled}
            />
          </aside>
        ) : null}

        <main className={`game-center${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
          <div className={`game-map-area${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
            {isMobile ? (
              isMobileBattleMode ? (
                <div className="game-mobile-battle-page">
                  <div className="game-mobile-battle-stage">
                    <BattleArea
                      enemies={battleEnemies}
                      allies={battleAllies}
                      allowLocalStart={allowLocalBattleStart}
                      externalBattleId={externalBattleId}
                      allowAutoNext={allowAutoNextBattle}
                      advanceMode={battleAdvanceMode}
                      onNext={battleOnNext}
                      nextLabel="继续"
                      onAppendBattleLines={appendBattleLinesToChat}
                      onSessionChange={handleBattleSessionChange}
                      onBindSkillCaster={bindBattleSkillCaster}
                      onEscape={
                        !inTeam || isTeamLeader
                          ? handleBattleEscape
                          : undefined
                      }
                      onTurnChange={handleBattleTurnChange}
                    />
                  </div>
                </div>
              ) : (
                <div className={`game-top-tabs${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
                  <Tabs
                    size="small"
                    activeKey={topTab}
                    onChange={(key) => setTopTab(key as 'map' | 'room')}
                    items={[
                      {
                        key: 'map',
                        label: '地图',
                        children: (
                          <div className={`game-top-tab-panel${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
                            {viewMode === 'battle' ? (
                              <BattleArea
                                enemies={battleEnemies}
                                allies={battleAllies}
                                allowLocalStart={allowLocalBattleStart}
                                externalBattleId={externalBattleId}
                                allowAutoNext={allowAutoNextBattle}
                                advanceMode={battleAdvanceMode}
                                onNext={battleOnNext}
                                nextLabel="继续"
                                onAppendBattleLines={appendBattleLinesToChat}
                                onSessionChange={handleBattleSessionChange}
                                onBindSkillCaster={bindBattleSkillCaster}
                                onEscape={
                                  !inTeam || isTeamLeader
                                    ? handleBattleEscape
                                    : undefined
                                }
                                onTurnChange={handleBattleTurnChange}
                              />
                            ) : (
                              canRenderWorldPanels ? (
                                <GameMap
                                  currentMapId={currentMapId}
                                  currentRoomId={currentRoomId}
                                  trackedRoomIds={trackedRoomIds}
                                  onMove={(next) => {
                                    setCurrentMapId(next.mapId);
                                    setCurrentRoomId(next.roomId);
                                    scheduleSavePosition(next.mapId, next.roomId);
                                  }}
                                />
                              ) : (
                                <WorldPanelLoading
                                  title="正在同步当前位置"
                                  detail="等待角色实时数据后再加载地图，避免首屏先请求默认村庄再切换到真实位置。"
                                />
                              )
                            )}
                          </div>
                        ),
                      },
                      {
                        key: 'room',
                        label: '房间',
                        children: (
                          <div className={`game-top-tab-panel${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
                            {canRenderWorldPanels ? (
                              <RoomObjects mapId={currentMapId} roomId={currentRoomId} onSelect={handleRoomObjectSelect} />
                            ) : (
                              <WorldPanelLoading
                                title="正在同步房间信息"
                                detail="当前位置尚未完成水合，房间对象会在拿到真实地图和房间后再请求。"
                              />
                            )}
                          </div>
                        ),
                      },
                    ]}
                  />
                </div>
              )
            ) : (
              <div className="game-top-area">
                <section className="game-map-pane">
                  {viewMode === 'battle' ? (
                    <BattleArea
                      enemies={battleEnemies}
                      allies={battleAllies}
                      allowLocalStart={allowLocalBattleStart}
                      externalBattleId={externalBattleId}
                      allowAutoNext={allowAutoNextBattle}
                      advanceMode={battleAdvanceMode}
                      onNext={battleOnNext}
                      nextLabel="继续"
                      onAppendBattleLines={appendBattleLinesToChat}
                      onSessionChange={handleBattleSessionChange}
                      onBindSkillCaster={bindBattleSkillCaster}
                      onEscape={
                        !inTeam || isTeamLeader
                          ? handleBattleEscape
                          : undefined
                      }
                      onTurnChange={handleBattleTurnChange}
                    />
                  ) : (
                    canRenderWorldPanels ? (
                      <GameMap
                        currentMapId={currentMapId}
                        currentRoomId={currentRoomId}
                        trackedRoomIds={trackedRoomIds}
                        onMove={(next) => {
                          setCurrentMapId(next.mapId);
                          setCurrentRoomId(next.roomId);
                          scheduleSavePosition(next.mapId, next.roomId);
                        }}
                      />
                    ) : (
                      <WorldPanelLoading
                        title="正在同步当前位置"
                        detail="等待角色实时数据后再加载地图，避免首屏先请求默认村庄再切换到真实位置。"
                      />
                    )
                  )}
                </section>
                <aside className="game-room-pane">
                  {canRenderWorldPanels ? (
                    <RoomObjects mapId={currentMapId} roomId={currentRoomId} onSelect={handleRoomObjectSelect} />
                  ) : (
                    <WorldPanelLoading
                      title="正在同步房间信息"
                      detail="当前位置尚未完成水合，房间对象会在拿到真实地图和房间后再请求。"
                    />
                  )}
                </aside>
              </div>
            )}
          </div>
          <div className={`game-chat-area${isMobile ? ' is-mobile-drawer' : ''}${isMobile && mobileChatDrawerOpen ? ' is-open' : ''}`}>
            <div className="game-chat-left">
              <ChatPanel ref={chatPanelRef} onSelectPlayer={setInfoTarget} isMobile={isMobile} />
            </div>
            <div className="game-chat-right">
              <TeamPanel
                members={teamMembers}
                onSelectMember={(m) => setInfoTarget(buildTeamInfoTarget(m))}
                onLeaveTeam={inTeam ? onLeaveTeam : undefined}
              />
            </div>
          </div>
          {isMobile ? (
            <div
              className={`game-mobile-chat-mask${mobileChatDrawerOpen ? ' is-open' : ''}`}
              onClick={() => setMobileChatDrawerOpen(false)}
              aria-hidden
            />
          ) : null}
        </main>

        <aside className="game-right">
          <div className="game-right-top">
            <FunctionMenu
              indicators={functionIndicators}
              itemStates={functionItemStates}
              onAction={(key) => {
                if (key === 'map') {
                  setMapModalCategory('world');
                  setMapModalOpen(true);
                }
                if (key === 'dungeon') {
                  setMapModalCategory('dungeon');
                  setMapModalOpen(true);
                }
                if (key === 'bag') setBagModalOpen(true);
                if (key === 'partner') {
                  if (!partnerUnlocked) {
                    messageRef.current.info(PARTNER_FEATURE_UNLOCK_HINT);
                    return;
                  }
                  setPartnerModalOpen(true);
                }
                if (key === 'technique') setTechniqueModalOpen(true);
                if (key === 'realm') setRealmModalOpen(true);
                if (key === 'life') {
                  messageRef.current.info('百业玩法开发中，敬请期待');
                }
                if (key === 'task') {
                  setTaskModalOpen(true);
                }
                if (key === 'sect') setSectModalOpen(true);
                if (key === 'market') setMarketModalOpen(true);
                if (key === 'team') setTeamModalOpen(true);
                if (key === 'monthcard') setMonthCardModalOpen(true);
                if (key === 'battlepass') setBattlePassModalOpen(true);
                if (key === 'arena') setArenaModalOpen(true);
                if (key === 'rank') setRankModalOpen(true);
                if (key === 'achievement') {
                  setAchievementModalOpen(true);
                }
                if (key === 'idle') setIdleModalOpen(true);
                if (key === 'battle-report') setMobileChatDrawerOpen(true);
                if (key === 'character') setPlayerInfoOpen(true);
              }}
            />
          </div>
          {!isMobile ? (
            <div className="game-right-bottom">
              <div className="equip-panel">
                <div className="equip-panel-grid">
                  <div className="equip-col">
                    {EQUIP_SLOTS_LEFT.map((slot) => {
                      const equipped = equippedByUiSlot.get(slot);
                      return (
                        <Tooltip
                          key={slot}
                          title={equipped ? renderEquipTooltip(slot, equipped.item) : null}
                          placement="right"
                          classNames={EQUIPMENT_TOOLTIP_CLASS_NAMES}
                        >
                          <div
                            className={`equip-slot ${equipped ? 'has-item' : ''} ${unequippingId != null && equipped?.id === unequippingId ? 'is-busy' : ''
                              }`}
                            onContextMenu={(e) => {
                              const it = equippedByUiSlot.get(slot);
                              if (!it) return;
                              e.preventDefault();
                              void handleUnequipFromPanel(it);
                            }}
                          >
                            {equipped ? <img className="equip-slot-icon" src={equipped.icon} alt={slot} /> : null}
                            <div className="equip-slot-label">{slot}</div>
                          </div>
                        </Tooltip>
                      );
                    })}
                  </div>
                  <div className="equip-center">
                    <img className="equip-portrait" src={equipPortrait} alt="人物形象" />
                  </div>
                  <div className="equip-col">
                    {EQUIP_SLOTS_RIGHT.map((slot) => {
                      const equipped = equippedByUiSlot.get(slot);
                      return (
                        <Tooltip
                          key={slot}
                          title={equipped ? renderEquipTooltip(slot, equipped.item) : null}
                          placement="left"
                          classNames={EQUIPMENT_TOOLTIP_CLASS_NAMES}
                        >
                          <div
                            className={`equip-slot ${equipped ? 'has-item' : ''} ${unequippingId != null && equipped?.id === unequippingId ? 'is-busy' : ''
                              }`}
                            onContextMenu={(e) => {
                              const it = equippedByUiSlot.get(slot);
                              if (!it) return;
                              e.preventDefault();
                              void handleUnequipFromPanel(it);
                            }}
                          >
                            {equipped ? <img className="equip-slot-icon" src={equipped.icon} alt={slot} /> : null}
                            <div className="equip-slot-label">{slot}</div>
                          </div>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {isMobile ? (
        <Drawer
          open={playerInfoOpen}
          placement="bottom"
          size="large"
          onClose={() => setPlayerInfoOpen(false)}
          closeIcon={null}
          title={null}
          styles={{ wrapper: { height: '84dvh', maxHeight: '760px' }, body: { padding: 0 } }}
        >
          <PlayerInfo
            initialRealmOverview={homeOverviewRealmOverview}
            suspendInitialRealmOverviewLoad={!homeOverviewSettled}
          />
        </Drawer>
      ) : null}

      <InfoModal open={!!infoTarget} target={infoTarget} onClose={() => setInfoTarget(null)} onAction={handleInfoAction} />
      <NpcTalkModal
        open={npcTalkOpen}
        npcName={npcTalkData?.npcName}
        dialogue={npcDialogue}
        loading={npcTalkLoading}
        busyText={npcTalkBusyText}
        onClose={closeNpcTalk}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {npcTalkPhase === 'root' ? (
            <>
              {npcTalkData?.mainQuest && npcTalkData.mainQuest.status !== 'completed' ? (
                <Button
                  block
                  type="primary"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onClick={async () => {
                    const mq = npcTalkData.mainQuest!;
                    appendNpcDialogue('player', `关于「${mq.sectionName}」……`);
                    if (mq.canStartDialogue) {
                      setMainQuestDialogueLoading(true);
                      mainQuestDialogueNodeIdRef.current = '';
                      try {
                        const res = await startDialogue();
                        if (res?.success && res.data) {
                          setNpcTalkPhase('mainQuestDialogue');
                          setMainQuestDialogueState(res.data.dialogueState);
                          syncMainQuestDialogueNode(res.data.dialogueState);
                        } else {
                          void 0;
                        }
                      } catch {
                        void 0;
                      } finally {
                        setMainQuestDialogueLoading(false);
                      }
                    } else if (mq.canComplete) {
                      setMainQuestDialogueLoading(true);
                      try {
                        const res = await completeSection();
                        if (res?.success && res.data) {
                          const rewardTexts = formatMainQuestRewardTexts(res.data.rewards || []);
                          messageRef.current.success('主线任务完成！');
                          if (rewardTexts.length > 0) {
                            appendSystemChat(`【主线】获得奖励：${rewardTexts.join('，')}`);
                          }
                          appendNpcDialogue('npc', '做得好，继续前进吧。');
                          gameSocket.refreshCharacter();
                          window.dispatchEvent(new Event('inventory:changed'));
                          await refreshNpcTalk(npcTalkNpcId);
                          await refreshTrackedRoomIds();
                          window.dispatchEvent(new Event('room:objects:changed'));
                        } else {
                          void 0;
                        }
                      } catch {
                        void 0;
                      } finally {
                        setMainQuestDialogueLoading(false);
                      }
                    } else {
                      appendNpcDialogue('npc', '你还有任务目标未完成，先去把它们完成吧。');
                    }
                  }}
                  disabled={npcTalkLoading || mainQuestDialogueLoading}
                  loading={mainQuestDialogueLoading}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>【主线】{npcTalkData.mainQuest.sectionName}</span>
                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                      {resolveNpcTalkMainQuestStatusLabel(npcTalkData.mainQuest.status)}
                    </Tag>
                  </span>
                </Button>
              ) : null}

              {(npcTalkData?.tasks ?? []).length > 0 ? (
                (npcTalkData?.tasks ?? []).map((task) => (
                  <Button
                    key={task.taskId}
                    block
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onClick={() => {
                      setNpcTalkSelectedTaskId(task.taskId);
                      appendNpcDialogue('player', `关于「${task.title}」……`);
                      appendNpcDialogue('npc', buildTaskNpcLine(task));
                      setNpcTalkPhase('taskDetail');
                    }}
                    disabled={npcTalkLoading}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{task.title}</span>
                      <Tag color={NPC_TALK_TASK_STATUS_META[task.status].color} style={{ marginInlineEnd: 0 }}>
                        {NPC_TALK_TASK_STATUS_META[task.status].label}
                      </Tag>
                    </span>
                  </Button>
                ))
              ) : (
                !npcTalkData?.mainQuest ? <div>该 NPC 暂无可用任务</div> : null
              )}

              <Button
                block
                onClick={() => {
                  appendNpcDialogue('player', '告辞。');
                  closeNpcTalk();
                }}
                disabled={npcTalkLoading}
              >
                告辞
              </Button>
            </>
          ) : null}

          {npcTalkPhase === 'taskDetail'
            ? (() => {
              const task = (npcTalkData?.tasks ?? []).find((item) => item.taskId === npcTalkSelectedTaskId) ?? null;
              if (!task) {
                return (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button onClick={() => setNpcTalkPhase('root')}>返回</Button>
                  </div>
                );
              }

              const doAccept = async () => {
                setNpcTalkActionKey(`accept:${task.taskId}`);
                try {
                  const res = await acceptTaskFromNpc(npcTalkNpcId, task.taskId);
                  if (!res?.success) throw new Error(getUnifiedApiErrorMessage(res, '接取失败'));
                  messageRef.current.success('接取成功');
                  appendSystemChat(`【任务】已接取：${task.title}`);
                  appendNpcDialogue('npc', '好，我已为你记下。去吧。');
                  const data = await refreshNpcTalk(npcTalkNpcId);
                  if (data?.lines) {
                    await refreshTrackedRoomIds();
                    void refreshTaskIndicator();
                    window.dispatchEvent(new Event('room:objects:changed'));
                  }
                } catch {
                  void 0;
                } finally {
                  setNpcTalkActionKey('');
                }
              };

              const doSubmit = async () => {
                setNpcTalkActionKey(`submit:${task.taskId}`);
                try {
                  const res = await submitTaskToNpc(npcTalkNpcId, task.taskId);
                  if (!res?.success) throw new Error(getUnifiedApiErrorMessage(res, '提交失败'));
                  messageRef.current.success('提交成功');
                  appendSystemChat(`【任务】已提交：${task.title}`);
                  appendNpcDialogue('npc', '办得好。稍等，我为你结算。');
                  await refreshNpcTalk(npcTalkNpcId);
                  await refreshTrackedRoomIds();
                  void refreshTaskIndicator();
                  window.dispatchEvent(new Event('room:objects:changed'));
                } catch {
                  void 0;
                } finally {
                  setNpcTalkActionKey('');
                }
              };

              const doClaim = async () => {
                setNpcTalkActionKey(`claim:${task.taskId}`);
                try {
                  const res = await claimTaskReward(task.taskId);
                  if (!res?.success) throw new Error(getUnifiedApiErrorMessage(res, '领取失败'));
                  messageRef.current.success('领取成功');
                  const rewardText = formatTaskRewardsToText(res.data?.rewards);
                  appendSystemChat(`【任务】领取奖励：${task.title}${rewardText ? `（${rewardText}）` : ''}`);
                  appendNpcDialogue('npc', '收好。');
                  gameSocket.refreshCharacter();
                  await refreshNpcTalk(npcTalkNpcId);
                  await refreshTrackedRoomIds();
                  void refreshTaskIndicator();
                  window.dispatchEvent(new Event('room:objects:changed'));
                } catch {
                  void 0;
                } finally {
                  setNpcTalkActionKey('');
                }
              };

              const primaryAction =
                task.status === 'available' ? (
                  <Button type="primary" loading={npcTalkActionKey === `accept:${task.taskId}`} onClick={() => void doAccept()}>
                    接取任务
                  </Button>
                ) : task.status === 'turnin' ? (
                  <Button type="primary" loading={npcTalkActionKey === `submit:${task.taskId}`} onClick={() => void doSubmit()}>
                    提交任务
                  </Button>
                ) : task.status === 'claimable' ? (
                  <Button type="primary" loading={npcTalkActionKey === `claim:${task.taskId}`} onClick={() => void doClaim()}>
                    领取奖励
                  </Button>
                ) : null;

              return (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {primaryAction}
                  <Button onClick={() => setNpcTalkPhase('root')}>返回</Button>
                </div>
              );
            })()
            : null}

          {npcTalkPhase === 'mainQuestDialogue'
            ? (() => {
              const node = mainQuestDialogueState?.currentNode;

              const handleAdvance = async () => {
                setMainQuestDialogueLoading(true);
                try {
                  const res = await advanceDialogue();
                  if (res?.success && res.data) {
                    setMainQuestDialogueState(res.data.dialogueState);
                    syncMainQuestDialogueNode(res.data.dialogueState);
                    if (res.data.dialogueState.isComplete) {
                      await finalizeMainQuestDialogue();
                    }
                  } else {
                    void 0;
                  }
                } catch {
                  void 0;
                } finally {
                  setMainQuestDialogueLoading(false);
                }
              };

              const handleChoice = async (choiceId: string, choiceText: string) => {
                appendNpcDialogue('player', choiceText, '你');
                setMainQuestDialogueLoading(true);
                try {
                  const res = await selectDialogueChoice(choiceId);
                  if (res?.success && res.data) {
                    setMainQuestDialogueState(res.data.dialogueState);
                    syncMainQuestDialogueNode(res.data.dialogueState);
                    if (res.data.dialogueState.isComplete) {
                      await finalizeMainQuestDialogue();
                    }
                  } else {
                    void 0;
                  }
                } catch {
                  void 0;
                } finally {
                  setMainQuestDialogueLoading(false);
                }
              };

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {node?.type === 'choice' && node.choices ? (
                    <>
                      {node.choices.map((choice) => (
                        <Button
                          key={choice.id}
                          block
                          onClick={() => void handleChoice(choice.id, choice.text)}
                          disabled={mainQuestDialogueLoading}
                        >
                          {choice.text}
                        </Button>
                      ))}
                    </>
                  ) : mainQuestDialogueState?.isComplete ? (
                    <Button type="primary" block onClick={() => void finalizeMainQuestDialogue()}>
                      完成对话
                    </Button>
                  ) : (
                    <Button type="primary" block onClick={() => void handleAdvance()} loading={mainQuestDialogueLoading}>
                      继续
                    </Button>
                  )}

                  <Button onClick={resetMainQuestDialogueFlow} disabled={mainQuestDialogueLoading}>
                    返回
                  </Button>
                </div>
              );
            })()
            : null}
        </div>
      </NpcTalkModal>
      <MapModal
        open={mapModalOpen}
        onClose={() => setMapModalOpen(false)}
        initialCategory={mapModalCategory}
        dungeonNoStaminaCostEnabled={character?.dungeonNoStaminaCost === true}
        onEnter={({ mapId, roomId }) => {
          if (viewMode === 'battle') {
            messageRef.current.error('战斗中不能移动');
            return;
          }
          setCurrentMapId(mapId);
          setCurrentRoomId(roomId);
          setTopTab('map');
        }}
        onEnterDungeon={async ({ dungeonId, rank }) => {
          if (viewMode === 'battle') {
            messageRef.current.error('战斗中不能进入秘境');
            return;
          }

          clearSessionAutoAdvanceTimer();
          lastAutoAdvanceSessionKeyRef.current = '';
          setTopTab('map');
          setActiveBattleSession(null);
          setReconnectBattleId(null);

          try {
            const createRes = await createDungeonInstance(dungeonId, rank);
            if (!createRes?.success || !createRes.data?.instanceId) {
              void 0;
              return;
            }

            const instanceId = String(createRes.data.instanceId);
            const startRes = await startDungeonBattleSession(instanceId);
            const session = startRes?.data?.session;
            if (!startRes?.success || !session?.currentBattleId) {
              void 0;
              return;
            }

            setBattleEnemies([]);
            setBattleAllies(buildAllyGroup(character));
            activateBattleSessionContext(session);
            gameSocket.refreshCharacter();
          } catch (e) {
            void 0;
            setActiveBattleSession(null);
          }
        }}
      />
      <BagModal open={bagModalOpen} onClose={() => setBagModalOpen(false)} />
      <PartnerModal open={partnerModalOpen} onClose={() => setPartnerModalOpen(false)} />
      {warehouseModalOpen && (
        <WarehouseModal open={warehouseModalOpen} onClose={() => setWarehouseModalOpen(false)} />
      )}
      {techniqueModalOpen && (
        <TechniqueModal
          open={techniqueModalOpen}
          onClose={() => setTechniqueModalOpen(false)}
          onResearchIndicatorChange={setTechniqueIndicatorStatus}
        />
      )}
      {taskModalOpen && (
        <TaskModal
          open={taskModalOpen}
          onClose={() => setTaskModalOpen(false)}
          taskOverviewRequestScopeKey={taskOverviewRequestScopeKeyRef.current}
          onTrackedChange={() => {
            void (async () => {
              await refreshTrackedRoomIds();
              window.dispatchEvent(new Event('room:objects:changed'));
            })();
          }}
          onTaskCompletedChange={handleTaskCompletedChange}
        />
      )}
      {monthCardModalOpen && (
        <MonthCardModal open={monthCardModalOpen} onClose={() => setMonthCardModalOpen(false)} />
      )}
      {battlePassModalOpen && (
        <BattlePassModal open={battlePassModalOpen} onClose={() => setBattlePassModalOpen(false)} />
      )}
      {arenaModalOpen && (
        <ArenaModal
          open={arenaModalOpen}
          onClose={() => setArenaModalOpen(false)}
          character={character}
          onStartBattle={(session) => {
            setArenaModalOpen(false);
            setBattleEnemies([]);
            setBattleAllies(buildAllyGroup(character));
            activateBattleSessionContext(session);
          }}
        />
      )}
      {rankModalOpen && (
        <RankModal open={rankModalOpen} onClose={() => setRankModalOpen(false)} />
      )}
      {signInModalOpen && (
        <SignInModal
          open={signInModalOpen}
          onClose={() => {
            setSignInModalOpen(false);
            void refreshSignInDot();
          }}
          onSigned={() => setShowSignInDot(false)}
        />
      )}
      {mailModalOpen && (
        <MailModal
          open={mailModalOpen}
          onClose={() => {
            setMailModalOpen(false);
          }}
        />
      )}
      {settingModalOpen && (
        <SettingModal open={settingModalOpen} onClose={() => setSettingModalOpen(false)} />
      )}
      {achievementModalOpen && (
        <AchievementModal
          open={achievementModalOpen}
          onClose={() => setAchievementModalOpen(false)}
          onChanged={() => {
            gameSocket.refreshCharacter();
          }}
        />
      )}
      {realmModalOpen && (
        <RealmModal open={realmModalOpen} onClose={() => setRealmModalOpen(false)} character={character} />
      )}
      {marketModalOpen && (
        <MarketModal open={marketModalOpen} onClose={() => setMarketModalOpen(false)} playerName={playerName} />
      )}
      <TeamModal
        open={teamModalOpen}
        onClose={() => {
          setTeamModalOpen(false);
          window.setTimeout(() => {
            void refreshTeamData();
          }, 0);
        }}
        playerName={playerName}
      />
      {sectModalOpen && (
        <SectModal
          open={sectModalOpen}
          onClose={() => {
            setSectModalOpen(false);
          }}
          spiritStones={spiritStones}
          playerName={playerName}
        />
      )}
      {/* 挂机面板 Modal */}
      <Modal
        open={idleModalOpen}
        onCancel={() => setIdleModalOpen(false)}
        footer={null}
        title="离线挂机"
        width={560}
        centered
        destroyOnHidden
      >
        <IdleBattlePanel
          idle={idle}
        />
      </Modal>
    </div>
  );
};

export default Game;
