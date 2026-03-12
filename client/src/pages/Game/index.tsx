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
  TECHNIQUE_RESEARCH_STATUS_POLL_INTERVAL_MS,
  getTechniqueResearchIndicatorTooltip,
  resolveTechniqueResearchIndicatorStatus,
  shouldPollTechniqueResearchStatus,
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
import { gameSocket, type CharacterData } from '../../services/gameSocket';
import {
  acceptTaskFromNpc,
  claimTaskReward,
  createDungeonInstance,
  gatherRoomResource,
  pickupRoomItem,
  getInventoryItems,
  getTaskOverview,
  npcTalk,
  getSignInOverview,
  getAchievementList,
  getMySect,
  getMySectApplications,
  getMailUnread,
  getTechniqueResearchStatus,
  getSectApplications,
  nextDungeonInstance,
  startDungeonInstance,
  submitTaskToNpc,
  unequipInventoryItem,
  updateCharacterAutoCastSkills,
  updateCharacterPosition,
  updateCharacterPositionKeepalive,
} from '../../services/api';
import { getUnifiedApiErrorMessage } from '../../services/api';
import type { InventoryItemDto, NpcTalkResponse, NpcTalkTaskOption, TechniqueResearchResultStatusDto } from '../../services/api';
import { getMainQuestProgress, startDialogue, advanceDialogue, selectDialogueChoice, completeSection, type DialogueState } from '../../services/mainQuestApi';
import { PARTNER_FEATURE_CODE } from '../../services/feature';
import { getMyTeam, getTeamApplications, leaveTeam, type TeamInfo } from '../../services/teamApi';
import { IMG_LOGO as logo, IMG_LINGSHI as lingshi, IMG_TONGQIAN as tongqian, IMG_EQUIP_MALE as equipMale, IMG_EQUIP_FEMALE as equipFemale } from './shared/imageAssets';
import { resolveIconUrl } from './shared/resolveIcon';
import './index.scss';
import { useIsMobile } from './shared/responsive';
import { coerceAffixes } from './shared/itemMetaFormat';
import EquipmentAffixTooltipList from './shared/EquipmentAffixTooltipList';
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
const SILENT_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;
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

const RATING_SUFFIX = '_rating';

const RATING_BASE_ATTR_KEYS = [
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
] as const;

const RATING_BASE_ATTR_KEY_SET = new Set<string>(RATING_BASE_ATTR_KEYS);

const attrLabelBase: Record<string, string> = {
  jing: '精',
  qi: '气',
  shen: '神',
  max_qixue: '气血上限',
  max_lingqi: '灵气上限',
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  mingzhong: '命中',
  shanbi: '闪避',
  zhaojia: '招架',
  baoji: '暴击',
  baoshang: '暴伤',
  kangbao: '抗暴',
  zengshang: '增伤',
  zhiliao: '治疗',
  jianliao: '减疗',
  xixue: '吸血',
  lengque: '冷却',
  sudu: '速度',
  qixue_huifu: '气血恢复',
  lingqi_huifu: '灵气恢复',
  kongzhi_kangxing: '控制抗性',
  jin_kangxing: '金抗性',
  mu_kangxing: '木抗性',
  shui_kangxing: '水抗性',
  huo_kangxing: '火抗性',
  tu_kangxing: '土抗性',
  fuyuan: '福源',
  shuxing_shuzhi: '属性数值',
};

const ratingAttrLabelEntries = RATING_BASE_ATTR_KEYS.map((key) => {
  const baseLabel = attrLabelBase[key] ?? key;
  return [`${key}${RATING_SUFFIX}`, `${baseLabel}等级`] as const;
});

const attrLabel: Record<string, string> = {
  ...attrLabelBase,
  ...Object.fromEntries(ratingAttrLabelEntries),
};

const attrOrderBase = [
  'max_qixue',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'sudu',
  'qixue_huifu',
  'lingqi_huifu',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'fuyuan',
  'shuxing_shuzhi',
] as const;

const attrOrderKeys = attrOrderBase.flatMap((key) =>
  RATING_BASE_ATTR_KEY_SET.has(key) ? [key, `${key}${RATING_SUFFIX}`] : [key],
);

const attrOrder: Record<string, number> = Object.fromEntries(
  attrOrderKeys.map((k, idx) => [k, idx]),
);

const percentAttrKeys = new Set<string>([
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

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

  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [isTeamLeader, setIsTeamLeader] = useState(false);
  const [teamApplicationUnread, setTeamApplicationUnread] = useState(0);
  const [sectPendingApplicationCount, setSectPendingApplicationCount] = useState(0);
  const [sectMyApplicationCount, setSectMyApplicationCount] = useState(0);
  const [currentMapId, setCurrentMapId] = useState<string>('map-qingyun-village');
  const [currentRoomId, setCurrentRoomId] = useState<string>('room-village-center');
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
  const [realmModalOpen, setRealmModalOpen] = useState(false);
  const [signInModalOpen, setSignInModalOpen] = useState(false);
  const [showSignInDot, setShowSignInDot] = useState(false);
  const [showMailDot, setShowMailDot] = useState(false);
  const [techniqueIndicatorStatus, setTechniqueIndicatorStatus] = useState<TechniqueResearchResultStatusDto | null>(null);
  const [techniqueResearchPending, setTechniqueResearchPending] = useState(false);
  const [mailModalOpen, setMailModalOpen] = useState(false);
  const [settingModalOpen, setSettingModalOpen] = useState(false);
  // 挂机面板 Modal 开关
  const [idleModalOpen, setIdleModalOpen] = useState(false);
  // 挂机状态 Hook（顶层单例，IdleBattlePanel 和 IdleBattleStatusBar 共享同一实例）
  const idle = useIdleBattle();
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
  const [teamBattleId, setTeamBattleId] = useState<string | null>(null);
  const [reconnectBattleId, setReconnectBattleId] = useState<string | null>(null);
  const [dungeonBattleId, setDungeonBattleId] = useState<string | null>(null);
  const [arenaBattleId, setArenaBattleId] = useState<string | null>(null);
  const [dungeonInstanceId, setDungeonInstanceId] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(true); // 默认开启自动战斗
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
  const appendBattleLinesToChat = useCallback((lines: string[]) => {
    chatPanelRef.current?.appendBattleLines(lines);
  }, []);
  const hydratedPositionRef = useRef(false);
  const positionSaveTimerRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<{ mapId: string; roomId: string } | null>(null);
  const latestPositionRef = useRef<{ mapId: string; roomId: string } | null>(null);
  const lastKeepalivePositionKeyRef = useRef<string>('');
  const teamBattleAutoCloseTimerRef = useRef<number | null>(null);
  const inTeam = Boolean(teamInfo?.id);
  const externalBattleId = arenaBattleId || dungeonBattleId || (inTeam && !isTeamLeader ? teamBattleId : null) || reconnectBattleId;

  const clearBattleAutoCloseTimer = useCallback(() => {
    if (!teamBattleAutoCloseTimerRef.current) return;
    window.clearTimeout(teamBattleAutoCloseTimerRef.current);
    teamBattleAutoCloseTimerRef.current = null;
  }, []);

  const syncRealtimeBattleView = useCallback((battleId: string) => {
    if (inTeam && !isTeamLeader) {
      setTeamBattleId(battleId);
    } else {
      setTeamBattleId(null);
      setReconnectBattleId(battleId);
    }
    setViewMode('battle');
    setTopTab('map');
    setInfoTarget(null);
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
      title: m.role === 'leader' ? '队长' : '队员',
      realm: m.realm,
      avatar: m.avatar,
      online: Boolean(m.online),
      hp: 0,
      maxHp: 0,
      qi: 0,
      maxQi: 0,
      role: m.role,
    }));
  }, [teamInfo]);
  const characterId = character?.id ?? null;
  const partnerUnlocked = hasCharacterFeature(character, PARTNER_FEATURE_CODE);
  const myBattleUnitId = useMemo(() => (characterId ? `player-${characterId}` : null), [characterId]);
  const isMobileBattleMode = isMobile && viewMode === 'battle';

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

  const refreshTrackedRoomIds = useCallback(async () => {
    try {
      // 获取普通任务追踪的房间
      const taskRes = await getTaskOverview();
      const taskList = taskRes?.success && taskRes.data?.tasks ? taskRes.data.tasks : [];
      const taskRoomIds = taskList
        .filter((t) => t.tracked === true && t.status !== 'completed' && t.mapId === currentMapId && typeof t.roomId === 'string' && t.roomId)
        .map((t) => t.roomId as string);

      // 获取主线任务追踪的房间
      const mainQuestRes = await getMainQuestProgress();
      const mainQuestRoomIds: string[] = [];
      if (mainQuestRes?.success && mainQuestRes.data) {
        const { tracked, currentSection } = mainQuestRes.data;
        if (tracked && currentSection && currentSection.status !== 'completed') {
          if (currentSection.mapId === currentMapId && currentSection.roomId) {
            mainQuestRoomIds.push(currentSection.roomId);
          }
        }
      }

      const roomIds = Array.from(new Set([...taskRoomIds, ...mainQuestRoomIds]));
      setTrackedRoomIds(roomIds);
    } catch {
      setTrackedRoomIds([]);
    }
  }, [currentMapId]);

  useEffect(() => {
    void refreshTrackedRoomIds();
  }, [refreshTrackedRoomIds]);

  useEffect(() => {
    if (viewMode !== 'battle') {
      battleSkillCasterRef.current = async () => false;
    }
  }, [viewMode]);

  const handleDungeonNext = useCallback(async () => {
    if (!dungeonInstanceId) return;
    try {
      const res = await nextDungeonInstance(dungeonInstanceId);
      if (!res?.success || !res.data) {
        void 0;
        return;
      }

      const finished = Boolean(res.data.finished);
      const status = res.data.status;
      if (finished) {
        if (status === 'cleared') {
          messageRef.current.success('秘境已通关');
        } else if (status === 'failed') {
          messageRef.current.error('秘境挑战失败');
        } else {
          messageRef.current.info('秘境已结束');
        }

        setDungeonBattleId(null);
        setDungeonInstanceId(null);
        setReconnectBattleId(null);
        setViewMode('map');
        setTopTab('map');
        setBattleTurn(0);
        setBattlePhase(null);
        setBattleActiveUnitId(null);
        return;
      }

      const nextBattleId = typeof res.data.battleId === 'string' ? res.data.battleId : '';
      if (!nextBattleId) {
        messageRef.current.error('推进秘境失败：未返回战斗ID');
        return;
      }
      clearBattleAutoCloseTimer();
      setDungeonBattleId(nextBattleId);
      setReconnectBattleId(null);
      setViewMode('battle');
      setTopTab('map');
      setInfoTarget(null);
    } catch (e) {
      void 0;
    }
  }, [clearBattleAutoCloseTimer, dungeonInstanceId]);

  const handleArenaNext = useCallback(async () => {
    setArenaBattleId(null);
    setReconnectBattleId(null);
    setViewMode('map');
    setTopTab('map');
    setBattleTurn(0);
    setBattlePhase(null);
    setBattleActiveUnitId(null);
  }, []);

  const allowAutoNextBattle = useMemo(() => {
    if (dungeonBattleId) return !inTeam || isTeamLeader;
    return !inTeam || isTeamLeader;
  }, [dungeonBattleId, inTeam, isTeamLeader]);

  const battleOnNext = useMemo(() => {
    if (dungeonBattleId) {
      if (!dungeonInstanceId) return undefined;
      if (inTeam && !isTeamLeader) return undefined;
      return handleDungeonNext;
    }
    if (arenaBattleId) {
      if (inTeam && !isTeamLeader) return undefined;
      return handleArenaNext;
    }
    return undefined;
  }, [arenaBattleId, dungeonBattleId, dungeonInstanceId, handleArenaNext, handleDungeonNext, inTeam, isTeamLeader]);

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
    const hasDungeonContext = Boolean(dungeonInstanceId || dungeonBattleId);
    const hasArenaContext = Boolean(arenaBattleId);
    const hasReconnectContext = Boolean(reconnectBattleId);
    const hasTeamReplayContext = Boolean(inTeam && !isTeamLeader && teamBattleId);
    return !(hasDungeonContext || hasArenaContext || hasReconnectContext || hasTeamReplayContext);
  }, [arenaBattleId, dungeonBattleId, dungeonInstanceId, inTeam, isTeamLeader, reconnectBattleId, teamBattleId]);

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
    // 仅当当前确有秘境 battleId 时才视为“主动退出秘境”，避免开战前失败分支误清空实例。
    const shouldClearDungeonInstance = Boolean(dungeonBattleId);
    setViewMode('map');
    setBattleTurn(0);
    setBattlePhase(null);
    setBattleActiveUnitId(null);
    setArenaBattleId(null);
    setDungeonBattleId(null);
    if (shouldClearDungeonInstance) {
      setDungeonInstanceId(null);
    }
    setReconnectBattleId(null);
  }, [dungeonBattleId]);

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

  const formatTaskRewardsToText = useCallback((rewards: unknown): string => {
    const list = Array.isArray(rewards) ? rewards : [];
    const parts: string[] = [];
    for (const r of list) {
      const type = (r as { type?: unknown })?.type;
      if (type === 'silver') {
        const amount = Math.max(0, Math.floor(Number((r as { amount?: unknown })?.amount) || 0));
        if (amount > 0) parts.push(`银两 +${amount.toLocaleString()}`);
      } else if (type === 'spirit_stones') {
        const amount = Math.max(0, Math.floor(Number((r as { amount?: unknown })?.amount) || 0));
        if (amount > 0) parts.push(`灵石 +${amount.toLocaleString()}`);
      } else if (type === 'item') {
        const itemDefId = String((r as { itemDefId?: unknown })?.itemDefId ?? '').trim();
        const itemName = String((r as { itemName?: unknown })?.itemName ?? '').trim();
        const qty = Math.max(1, Math.floor(Number((r as { qty?: unknown })?.qty) || 1));
        const name = itemName || itemDefId;
        if (name) parts.push(`物品「${name}」×${qty.toLocaleString()}`);
      }
    }
    return parts.join('，');
  }, []);

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
      const list = (res.data.items ?? [])
        .map((it: InventoryItemDto) => {
          const def = it.def;
          if (!def) return null;
          const slot = String(it.equipped_slot ?? def.equip_slot ?? '').trim();
          if (!slot) return null;
          const name = String(def.name ?? '').trim() || String(def.id ?? it.item_def_id ?? '').trim();
          const icon = resolveItemIcon(def.icon);
          return { id: Number(it.id), name, icon, equippedSlot: slot, item: it };
        })
        .filter((x): x is { id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto } => Boolean(x));
      setEquippedItems(list);
    } catch {
      setEquippedItems([]);
    }
  }, []);

  useEffect(() => {
    if (!characterId) {
      setEquippedItems([]);
      return;
    }
    void refreshEquippedItems();
  }, [characterId, refreshEquippedItems]);

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
      const res = await getMyTeam(characterId, SILENT_REQUEST_CONFIG);
      if (!res.success) {
        setTeamInfo(null);
        setIsTeamLeader(false);
        setTeamApplicationUnread(0);
        return;
      }

      setTeamInfo(res.data ?? null);

      const nextTeamId = res.data?.id ?? null;
      const leader = Boolean(nextTeamId && res.role === 'leader');
      setIsTeamLeader(leader);

      if (!leader || !nextTeamId) {
        setTeamApplicationUnread(0);
        return;
      }

      const appsRes = await getTeamApplications(nextTeamId, characterId, SILENT_REQUEST_CONFIG);
      if (!appsRes.success) {
        setTeamApplicationUnread(0);
        return;
      }

      const list = appsRes.data ?? [];
      const seenKey = `team_apps_seen_${characterId}_${nextTeamId}`;
      const seenAtRaw = localStorage.getItem(seenKey);
      const seenAtNum = Number(seenAtRaw ?? 0);
      const seenAt = Number.isFinite(seenAtNum) ? seenAtNum : 0;
      const unread = list.filter((a) => (Number(a.time) || 0) > seenAt).length;
      setTeamApplicationUnread(unread);
    } catch {
      setTeamApplicationUnread(0);
    }
  }, [characterId]);

  const refreshSectIndicator = useCallback(async () => {
    if (!characterId) {
      setSectPendingApplicationCount(0);
      setSectMyApplicationCount(0);
      return;
    }

    try {
      const [mySectRes, myAppsRes] = await Promise.all([
        getMySect(SILENT_REQUEST_CONFIG),
        getMySectApplications(SILENT_REQUEST_CONFIG),
      ]);
      const mySectInfo = mySectRes.success ? (mySectRes.data ?? null) : null;
      const myPendingApplications = myAppsRes.success && myAppsRes.data ? Math.max(0, Math.floor(myAppsRes.data.length)) : 0;
      setSectMyApplicationCount(myPendingApplications);

      if (!mySectInfo) {
        setSectPendingApplicationCount(0);
        return;
      }

      const myMember = mySectInfo.members.find((m) => m.characterId === characterId);
      const canManageApplications =
        myMember?.position === 'leader' || myMember?.position === 'vice_leader' || myMember?.position === 'elder';
      if (!canManageApplications) {
        setSectPendingApplicationCount(0);
        return;
      }

      const appsRes = await getSectApplications(SILENT_REQUEST_CONFIG);
      if (!appsRes.success || !appsRes.data) {
        setSectPendingApplicationCount(0);
        return;
      }
      setSectPendingApplicationCount(Math.max(0, Math.floor(appsRes.data.length)));
    } catch {
      setSectPendingApplicationCount(0);
      setSectMyApplicationCount(0);
    }
  }, [characterId]);

  useEffect(() => {
    if (!characterId) return;
    const t = window.setTimeout(() => {
      void refreshTeamData();
    }, 0);
    const unsubscribe = gameSocket.onTeamUpdate(() => {
      void refreshTeamData();
    });
    return () => {
      window.clearTimeout(t);
      unsubscribe();
    };
  }, [characterId, refreshTeamData]);

  useEffect(() => {
    if (!characterId) {
      setSectPendingApplicationCount(0);
      setSectMyApplicationCount(0);
      return;
    }

    const runRefresh = () => {
      void refreshSectIndicator();
    };

    const t = window.setTimeout(runRefresh, 0);
    const pollTimer = window.setInterval(runRefresh, 30000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runRefresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearTimeout(t);
      window.clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [characterId, refreshSectIndicator]);

  useEffect(() => {
    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((raw) => {
      const data = raw as { kind?: unknown; battleId?: unknown };
      const kind = typeof data?.kind === 'string' ? data.kind : '';
      const battleId = typeof data?.battleId === 'string' ? data.battleId : '';
      if (!battleId) return;

      if (kind === 'battle_started' || kind === 'battle_state') {
        clearBattleAutoCloseTimer();
        syncRealtimeBattleView(battleId);
        return;
      }

      if (kind === 'battle_abandoned') {
        clearBattleAutoCloseTimer();
        setTeamBattleId(null);
        setReconnectBattleId(null);
        setViewMode('map');
        setTopTab('map');
        setInfoTarget(null);
        return;
      }

      if (kind === 'battle_finished') {
        clearBattleAutoCloseTimer();
        syncRealtimeBattleView(battleId);
        if (battleId === dungeonBattleId) {
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
  }, [clearBattleAutoCloseTimer, dungeonBattleId, syncRealtimeBattleView]);

  useEffect(() => {
    if (!characterId) return;
    const timer = window.setInterval(() => {
      void refreshTeamData();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [characterId, refreshTeamData]);

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
      setArenaBattleId(null);
      setDungeonBattleId(null);
      setDungeonInstanceId(null);
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
    const mapId = String(character.currentMapId || '').trim();
    const roomId = String(character.currentRoomId || '').trim();
    if (!hydratedPositionRef.current) {
      if (mapId) setCurrentMapId(mapId);
      if (roomId) setCurrentRoomId(roomId);
      hydratedPositionRef.current = true;
    }
  }, [character]);

  const savePosition = useCallback((mapId: string, roomId: string) => {
    const nextMapId = String(mapId || '').trim();
    const nextRoomId = String(roomId || '').trim();
    if (!nextMapId || !nextRoomId) return;
    void updateCharacterPosition(nextMapId, nextRoomId, SILENT_REQUEST_CONFIG).catch(() => undefined);
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
    else void updateCharacterPosition(nextMapId, nextRoomId, SILENT_REQUEST_CONFIG).catch(() => undefined);
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
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const res = await getSignInOverview(month);
      if (!res.success || !res.data) return;
      setShowSignInDot(!res.data.signedToday);
    } catch {
      setShowSignInDot(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshSignInDot();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refreshSignInDot]);

  /**
   * 刷新邮箱未读红点。
   *
   * 设计说明：
   * - 顶部入口只展示“未读邮件”状态，不复用附件未领计数，避免红点语义混淆。
   * - 统一通过 `/mail/unread` 读取，避免在主界面重复拉取整页邮件列表。
   */
  const refreshMailDot = useCallback(async () => {
    try {
      const res = await getMailUnread();
      if (!res.success || !res.data) {
        setShowMailDot(false);
        return;
      }
      const unreadCount = Math.max(0, Math.floor(Number(res.data.unreadCount) || 0));
      setShowMailDot(unreadCount > 0);
    } catch {
      setShowMailDot(false);
    }
  }, []);

  // 进入游戏后立即拉取一次邮件红点状态。
  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshMailDot();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refreshMailDot]);

  // 轻量轮询，确保不打开邮箱时也能看到新邮件红点。
  useEffect(() => {
    if (!characterId) return;
    const timer = window.setInterval(() => {
      void refreshMailDot();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [characterId, refreshMailDot]);

  const refreshTechniqueIndicator = useCallback(async () => {
    if (!TECHNIQUE_RESEARCH_ENABLED) {
      setTechniqueIndicatorStatus(null);
      setTechniqueResearchPending(false);
      return;
    }
    if (!characterId) {
      setTechniqueIndicatorStatus(null);
      setTechniqueResearchPending(false);
      return;
    }
    try {
      const res = await getTechniqueResearchStatus(characterId);
      if (!res.success || !res.data) {
        return;
      }
      setTechniqueResearchPending(shouldPollTechniqueResearchStatus(res.data));
      const nextStatus = resolveTechniqueResearchIndicatorStatus(res.data);
      if (!nextStatus) {
        setTechniqueIndicatorStatus(null);
        return;
      }
      setTechniqueIndicatorStatus(nextStatus);
    } catch {
      // 保留现有红点，等待下次成功同步，避免瞬时失败误清提醒。
    }
  }, [characterId]);

  useEffect(() => {
    if (!TECHNIQUE_RESEARCH_ENABLED) return undefined;
    const t = window.setTimeout(() => {
      void refreshTechniqueIndicator();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refreshTechniqueIndicator]);

  useEffect(() => {
    if (!TECHNIQUE_RESEARCH_ENABLED || !characterId || !techniqueResearchPending) return undefined;
    const timer = window.setInterval(() => {
      void refreshTechniqueIndicator();
    }, TECHNIQUE_RESEARCH_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [characterId, refreshTechniqueIndicator, techniqueResearchPending]);

  useEffect(() => {
    if (!TECHNIQUE_RESEARCH_ENABLED) return undefined;
    if (!characterId) return undefined;
    return gameSocket.onTechniqueResearchResult((payload) => {
      if (payload.characterId !== characterId) return;
      setTechniqueResearchPending(false);
      setTechniqueIndicatorStatus(payload.status);
      void refreshTechniqueIndicator();
    });
  }, [characterId, refreshTechniqueIndicator]);

  const refreshAchievementIndicator = useCallback(async () => {
    try {
      const res = await getAchievementList({ status: 'claimable', page: 1, limit: 1 });
      if (!res.success || !res.data) {
        setAchievementClaimableCount(0);
        return;
      }
      const total = typeof res.data.total === 'number' ? Math.max(0, Math.floor(res.data.total)) : 0;
      setAchievementClaimableCount(total);
    } catch {
      setAchievementClaimableCount(0);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshAchievementIndicator();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refreshAchievementIndicator]);

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
    if (techniqueIndicatorStatus) {
      out.technique = {
        badgeDot: true,
        tooltip: getTechniqueResearchIndicatorTooltip(techniqueIndicatorStatus),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [achievementClaimableCount, isTeamLeader, sectMyApplicationCount, sectPendingApplicationCount, teamApplicationUnread, techniqueIndicatorStatus]);

  const functionItemStates = useMemo(
    () => ({
      partner: {
        locked: !partnerUnlocked,
        tooltip: partnerUnlocked ? '查看伙伴总览、升级与功法' : PARTNER_FEATURE_UNLOCK_HINT,
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
          <img className="game-header-logo" src={logo} alt="九州修仙录" />
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
            <PlayerInfo />
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
                      onNext={battleOnNext}
                      nextLabel="继续"
                      onAppendBattleLines={appendBattleLinesToChat}
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
                                onNext={battleOnNext}
                                nextLabel="继续"
                                onAppendBattleLines={appendBattleLinesToChat}
                                onBindSkillCaster={bindBattleSkillCaster}
                                onEscape={
                                  !inTeam || isTeamLeader
                                    ? handleBattleEscape
                                    : undefined
                                }
                                onTurnChange={handleBattleTurnChange}
                              />
                            ) : (
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
                            )}
                          </div>
                        ),
                      },
                      {
                        key: 'room',
                        label: '房间',
                        children: (
                          <div className={`game-top-tab-panel${isMobileBattleMode ? ' is-mobile-battle' : ''}`}>
                            <RoomObjects mapId={currentMapId} roomId={currentRoomId} onSelect={handleRoomObjectSelect} />
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
                      onNext={battleOnNext}
                      nextLabel="继续"
                      onAppendBattleLines={appendBattleLinesToChat}
                      onBindSkillCaster={bindBattleSkillCaster}
                      onEscape={
                        !inTeam || isTeamLeader
                          ? handleBattleEscape
                          : undefined
                      }
                      onTurnChange={handleBattleTurnChange}
                    />
                  ) : (
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
                  )}
                </section>
                <aside className="game-room-pane">
                  <RoomObjects mapId={currentMapId} roomId={currentRoomId} onSelect={handleRoomObjectSelect} />
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
                if (key === 'task') setTaskModalOpen(true);
                if (key === 'sect') setSectModalOpen(true);
                if (key === 'market') setMarketModalOpen(true);
                if (key === 'team') setTeamModalOpen(true);
                if (key === 'monthcard') setMonthCardModalOpen(true);
                if (key === 'battlepass') setBattlePassModalOpen(true);
                if (key === 'arena') setArenaModalOpen(true);
                if (key === 'rank') setRankModalOpen(true);
                if (key === 'achievement') {
                  setAchievementModalOpen(true);
                  void refreshAchievementIndicator();
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
          <PlayerInfo />
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

          setTopTab('map');
          setArenaBattleId(null);
          setDungeonBattleId(null);
          setDungeonInstanceId(null);
          setReconnectBattleId(null);

          try {
            const createRes = await createDungeonInstance(dungeonId, rank);
            if (!createRes?.success || !createRes.data?.instanceId) {
              void 0;
              return;
            }

            const instanceId = String(createRes.data.instanceId);
            const startRes = await startDungeonInstance(instanceId);
            if (!startRes?.success || !startRes.data?.battleId) {
              void 0;
              return;
            }

            setBattleEnemies([]);
            setBattleAllies(buildAllyGroup(character));
            setDungeonInstanceId(instanceId);
            setDungeonBattleId(String(startRes.data.battleId));
            setReconnectBattleId(null);
            setViewMode('battle');
            gameSocket.refreshCharacter();
          } catch (e) {
            void 0;
            setDungeonBattleId(null);
            setDungeonInstanceId(null);
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
          onTrackedChange={() => {
            void (async () => {
              await refreshTrackedRoomIds();
              window.dispatchEvent(new Event('room:objects:changed'));
            })();
          }}
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
          onStartBattle={(battleId) => {
            setArenaModalOpen(false);
            setTopTab('map');
            setBattleEnemies([]);
            setBattleAllies(buildAllyGroup(character));
            setDungeonBattleId(null);
            setDungeonInstanceId(null);
            setReconnectBattleId(null);
            setArenaBattleId(String(battleId));
            setViewMode('battle');
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
            void refreshMailDot();
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
            void refreshAchievementIndicator();
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
            window.setTimeout(() => {
              void refreshSectIndicator();
            }, 0);
          }}
          spiritStones={spiritStones}
          playerName={playerName}
          onChanged={() => {
            void refreshSectIndicator();
          }}
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
