import { App, Badge, Button, Drawer, Modal, Progress, Tag, Tabs, Tooltip } from 'antd';
import { MailOutlined, SettingOutlined, LogoutOutlined, CalendarOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PlayerInfo from './modules/PlayerInfo';
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
  nextDungeonInstance,
  startDungeonInstance,
  submitTaskToNpc,
  unequipInventoryItem,
  updateCharacterAutoCastSkills,
  updateCharacterPosition,
  updateCharacterPositionKeepalive,
  SERVER_BASE,
} from '../../services/api';
import type { InventoryItemDto } from '../../services/api';
import { getMainQuestProgress, startDialogue, advanceDialogue, selectDialogueChoice, completeSection, type DialogueState } from '../../services/mainQuestApi';
import { getMyTeam, getTeamApplications, leaveTeam, type TeamInfo } from '../../services/teamApi';
import logo from '../../assets/images/logo.png';
import lingshi from '../../assets/images/ui/lingshi.png';
import tongqian from '../../assets/images/ui/tongqian.png';
import equipMale from '../../assets/images/ui/ep-n.png';
import equipFemale from '../../assets/images/ui/ep.png';
import coin01 from '../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import './index.scss';

interface GameProps {
  onLogout?: () => void;
}

const EQUIP_SLOTS_LEFT = ['武器', '头部', '衣服', '护手'] as const;
const EQUIP_SLOTS_RIGHT = ['下装', '项链', '饰品', '法宝'] as const;

const ITEM_ICON_GLOB = import.meta.glob('../../assets/images/**/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const ITEM_ICON_BY_FILENAME: Record<string, string> = Object.fromEntries(
  Object.entries(ITEM_ICON_GLOB).map(([p, url]) => {
    const parts = p.split(/[/\\]/);
    return [parts[parts.length - 1] ?? p, url];
  }),
);

const resolveItemIcon = (icon: string | null | undefined): string => {
  const raw = (icon ?? '').trim();
  if (!raw) return coin01;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/uploads/')) return `${SERVER_BASE}${raw}`;
  if (raw.startsWith('/assets/')) {
    const filename = raw.split('/').filter(Boolean).pop() ?? raw;
    return ITEM_ICON_BY_FILENAME[filename] ?? raw;
  }
  if (raw.startsWith('/')) return `${SERVER_BASE}${raw}`;
  const filename = raw.split('/').filter(Boolean).pop() ?? raw;
  return ITEM_ICON_BY_FILENAME[filename] ?? coin01;
};

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

type EquipmentAffix = {
  key?: string;
  name?: string;
  attr_key?: string;
  apply_type?: string;
  tier?: number;
  value?: number;
  is_legendary?: boolean;
  description?: string;
};

const EQUIP_QUALITY_COLOR: Record<string, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

const EQUIP_QUALITY_TEXT: Record<string, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const attrLabel: Record<string, string> = {
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

const attrOrder: Record<string, number> = Object.fromEntries(
  [
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
  ].map((k, idx) => [k, idx]),
);

const permyriadPercentKeys = new Set<string>([
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

const formatSignedNumber = (value: number): string => {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}`;
};

const formatSignedPermyriadPercent = (value: number): string => {
  const percent = value / 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  const sign = value > 0 ? '+' : '';
  return `${sign}${trimmed}%`;
};

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

const coerceAffixes = (value: unknown): EquipmentAffix[] => {
  if (!value) return [];
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map<EquipmentAffix | null>((x) => {
      if (!x || typeof x !== 'object') return null;
      const a = x as Record<string, unknown>;
      const tierNum = typeof a.tier === 'number' ? a.tier : typeof a.tier === 'string' ? Number(a.tier) : undefined;
      const valueNum = typeof a.value === 'number' ? a.value : typeof a.value === 'string' ? Number(a.value) : undefined;

      const out: EquipmentAffix = {
        key: typeof a.key === 'string' ? a.key : undefined,
        name: typeof a.name === 'string' ? a.name : undefined,
        attr_key: typeof a.attr_key === 'string' ? a.attr_key : undefined,
        apply_type: typeof a.apply_type === 'string' ? a.apply_type : undefined,
        tier: Number.isFinite(tierNum ?? NaN) ? tierNum : undefined,
        value: Number.isFinite(valueNum ?? NaN) ? valueNum : undefined,
        is_legendary: typeof a.is_legendary === 'boolean' ? a.is_legendary : undefined,
        description: typeof a.description === 'string' ? a.description : undefined,
      };
      return out;
    })
    .filter((v): v is EquipmentAffix => !!v);
};

const renderEquipTooltip = (uiSlot: string, it: InventoryItemDto): React.ReactNode => {
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
                  {permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}
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
        {it.identified ? (
          affixes.length ? (
            <div className="equip-tooltip-lines">
              {affixes.map((a, idx) => {
                const key = a.attr_key;
                const label = (key ? attrLabel[key] : undefined) ?? a.name ?? key ?? '未知';
                const tierText = a.tier ? `T${a.tier}` : 'T-';
                const prefix = a.is_legendary ? '传奇' : '词条';
                const valueText =
                  typeof a.value === 'number'
                    ? a.apply_type === 'percent' || (key ? permyriadPercentKeys.has(key) : false)
                      ? formatSignedPermyriadPercent(a.value)
                      : formatSignedNumber(a.value)
                    : '';
                return (
                  <div key={`${a.key ?? label}-${idx}`} className="equip-tooltip-affix">
                    <span className="equip-tooltip-affix-k">
                      {prefix} {tierText}：{label}
                    </span>
                    {valueText ? <span className="equip-tooltip-affix-v">{valueText}</span> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="equip-tooltip-empty">无</div>
          )
        ) : (
          <div className="equip-tooltip-empty">未鉴定</div>
        )}
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

type NpcTalkTaskStatus = 'locked' | 'available' | 'accepted' | 'turnin' | 'claimable' | 'claimed';
type NpcTalkTaskOption = { taskId: string; title: string; category: 'main' | 'side' | 'daily' | 'event'; status: NpcTalkTaskStatus };
type NpcTalkMainQuestOption = {
  sectionId: string;
  sectionName: string;
  chapterName: string;
  status: 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';
  canStartDialogue: boolean;
  canComplete: boolean;
};
type NpcTalkData = { npcId: string; npcName: string; lines: string[]; tasks: NpcTalkTaskOption[]; mainQuest?: NpcTalkMainQuestOption };
type NpcDialogueEntry = { id: string; role: 'npc' | 'player'; text: string };
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

const Game: React.FC<GameProps> = ({ onLogout }) => {
  const version = '1.0.0';
  const { message } = App.useApp();
  const messageRef = useRef(message);

  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [isTeamLeader, setIsTeamLeader] = useState(false);
  const [teamApplicationUnread, setTeamApplicationUnread] = useState(0);
  const [currentMapId, setCurrentMapId] = useState<string>('map-qingyun-village');
  const [currentRoomId, setCurrentRoomId] = useState<string>('room-village-center');
  const [trackedRoomIds, setTrackedRoomIds] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [topTab, setTopTab] = useState<'map' | 'room'>('map');
  const [playerInfoOpen, setPlayerInfoOpen] = useState(false);
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [mapModalCategory, setMapModalCategory] = useState<'world' | 'dungeon' | 'event'>('world');
  const [bagModalOpen, setBagModalOpen] = useState(false);
  const [warehouseModalOpen, setWarehouseModalOpen] = useState(false);
  const [techniqueModalOpen, setTechniqueModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [sectModalOpen, setSectModalOpen] = useState(false);
  const [marketModalOpen, setMarketModalOpen] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [monthCardModalOpen, setMonthCardModalOpen] = useState(false);
  const [battlePassModalOpen, setBattlePassModalOpen] = useState(false);
  const [arenaModalOpen, setArenaModalOpen] = useState(false);
  const [rankModalOpen, setRankModalOpen] = useState(false);
  const [achievementModalOpen, setAchievementModalOpen] = useState(false);
  const [realmModalOpen, setRealmModalOpen] = useState(false);
  const [signInModalOpen, setSignInModalOpen] = useState(false);
  const [showSignInDot, setShowSignInDot] = useState(false);
  const [mailModalOpen, setMailModalOpen] = useState(false);
  const [settingModalOpen, setSettingModalOpen] = useState(false);
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
  const [teamBattleId, setTeamBattleId] = useState<string | null>(null);
  const [dungeonBattleId, setDungeonBattleId] = useState<string | null>(null);
  const [arenaBattleId, setArenaBattleId] = useState<string | null>(null);
  const [dungeonInstanceId, setDungeonInstanceId] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(true); // 默认开启自动战斗
  const [equippedItems, setEquippedItems] = useState<
    Array<{ id: number; name: string; icon: string; equippedSlot: string; item: InventoryItemDto }>
  >([]);
  const [unequippingId, setUnequippingId] = useState<number | null>(null);
  const chatPanelRef = useRef<ChatPanelHandle | null>(null);
  const battleSkillCasterRef = useRef<(skillId: string, targetType?: string) => Promise<boolean>>(async () => false);
  const [gatherAction, setGatherAction] = useState<GatherActionUi>({ running: false });
  const [gatherNowMs, setGatherNowMs] = useState(0);
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
  const externalBattleId = arenaBattleId || dungeonBattleId || (inTeam && !isTeamLeader ? teamBattleId : null);

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
      hp: 0,
      maxHp: 0,
      qi: 0,
      maxQi: 0,
      role: m.role,
    }));
  }, [teamInfo]);
  const characterId = character?.id ?? null;
  const myBattleUnitId = useMemo(() => (characterId ? `player-${characterId}` : null), [characterId]);

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

  useEffect(() => {
    if (!gatherAction.running) {
      setGatherNowMs(0);
      return;
    }
    setGatherNowMs(Date.now());
    const timer = window.setInterval(() => setGatherNowMs(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [gatherAction.running]);

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
        gatherUntilMs: 0,
        remaining: Math.max(0, target.resource?.remaining ?? 0),
      });
      appendSystemChat(`【采集】采集中：${resourceName}`);

      const tick = async () => {
        if (gatherActionKeyRef.current !== key) return;
        try {
          const res = await gatherRoomResource(currentMapId, currentRoomId, target.id);
          if (gatherActionKeyRef.current !== key) return;
          if (!res?.success) throw new Error(res?.message || '采集失败');
          const d = res.data;
          const actionSec = typeof d?.actionSec === 'number' && d.actionSec > 0 ? d.actionSec : 5;
          const remaining = typeof d?.remaining === 'number' ? Math.max(0, Math.floor(d.remaining)) : 0;
          const gatherUntilMs = d?.gatherUntil ? Date.parse(d.gatherUntil) : 0;

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
            return { ...prev, actionSec, gatherUntilMs: Number.isFinite(gatherUntilMs) ? gatherUntilMs : 0, remaining };
          });

          const now = Date.now();
          const delayMs =
            Number.isFinite(gatherUntilMs) && gatherUntilMs > now
              ? Math.max(250, Math.min(1000, gatherUntilMs - now + 120))
              : 650;
          gatherTickTimerRef.current = window.setTimeout(() => void tick(), delayMs);
        } catch (error: unknown) {
          if (gatherActionKeyRef.current !== key) return;
          const err = error as { message?: string };
          stopGatherLoop();
          messageRef.current.error(err.message || '采集失败');
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
        messageRef.current.error(res?.message || '推进秘境失败');
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
        setViewMode('map');
        setTopTab('map');
        setBattleTurn(0);
        setBattleActiveUnitId(null);
        return;
      }

      const nextBattleId = typeof res.data.battleId === 'string' ? res.data.battleId : '';
      if (!nextBattleId) {
        messageRef.current.error('推进秘境失败：未返回战斗ID');
        return;
      }
      setDungeonBattleId(nextBattleId);
    } catch (e) {
      messageRef.current.error((e as { message?: string })?.message || '推进秘境失败');
    }
  }, [dungeonInstanceId]);

  const handleArenaNext = useCallback(async () => {
    setArenaBattleId(null);
    setViewMode('map');
    setTopTab('map');
    setBattleTurn(0);
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

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  const refreshNpcTalk = useCallback(async (npcId: string): Promise<NpcTalkData | null> => {
    const nid = (npcId || '').trim();
    if (!nid) return null;
    setNpcTalkLoading(true);
    try {
      const res = await npcTalk(nid);
      if (!res?.success || !res.data) throw new Error(res?.message || '对话失败');
      const data = res.data as unknown as NpcTalkData;
      setNpcTalkData(data);
      return data;
    } catch (e: unknown) {
      const err = e as { message?: string };
      messageRef.current.error(err.message || '对话失败');
      setNpcTalkData(null);
      return null;
    } finally {
      setNpcTalkLoading(false);
    }
  }, []);

  const appendNpcDialogue = useCallback((role: NpcDialogueEntry['role'], text: string) => {
    const t = String(text || '').trim();
    if (!t) return;
    setNpcDialogue((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, role, text: t }]);
  }, []);

  const appendNpcDialogueLines = useCallback((lines: unknown, fallback: string) => {
    const list = Array.isArray(lines) ? lines : [];
    const normalized = list.map((line) => String(line || '').trim()).filter(Boolean);
    if (normalized.length > 0) {
      setNpcDialogue((prev) => [
        ...prev,
        ...normalized.map((text) => ({ id: `${Date.now()}-${Math.random()}`, role: 'npc' as const, text })),
      ]);
      return;
    }
    appendNpcDialogue('npc', fallback);
  }, [appendNpcDialogue]);

  const statusLabel = useMemo<Record<NpcTalkTaskStatus, string>>(
    () => ({
      locked: '未解锁',
      available: '可接取',
      accepted: '进行中',
      turnin: '可提交',
      claimable: '可领取',
      claimed: '已完成',
    }),
    [],
  );

  const statusColor = useMemo<Record<NpcTalkTaskStatus, string>>(
    () => ({
      locked: 'default',
      available: 'green',
      accepted: 'blue',
      turnin: 'purple',
      claimable: 'gold',
      claimed: 'default',
    }),
    [],
  );

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
      if (!res.success || !res.data) throw new Error(res.message || '获取已穿戴物品失败');
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
        if (!res.success) throw new Error(res.message || '卸下失败');
        messageRef.current.success(res.message || '卸下成功');
        window.dispatchEvent(new Event('inventory:changed'));
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '卸下失败');
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
        if (!res?.success) {
          setAutoMode(!next);
          messageRef.current.error(res?.message || '设置保存失败');
        }
      })();
    },
    [],
  );

  const refreshTeamData = useCallback(async () => {
    if (!characterId) return;
    try {
      const res = await getMyTeam(characterId);
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

      const appsRes = await getTeamApplications(nextTeamId, characterId);
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
    gameSocket.connect();
    const unsub = gameSocket.onBattleUpdate((raw) => {
      if (!inTeam || isTeamLeader) return;
      const data = raw as { kind?: unknown; battleId?: unknown };
      const kind = typeof data?.kind === 'string' ? data.kind : '';
      const battleId = typeof data?.battleId === 'string' ? data.battleId : '';
      if (!battleId) return;

      if (kind === 'battle_started' || kind === 'battle_state') {
        if (teamBattleAutoCloseTimerRef.current) {
          window.clearTimeout(teamBattleAutoCloseTimerRef.current);
          teamBattleAutoCloseTimerRef.current = null;
        }
        setTeamBattleId(battleId);
        setViewMode('battle');
        setTopTab('map');
        setInfoTarget(null);
        return;
      }

      if (kind === 'battle_abandoned') {
        if (teamBattleAutoCloseTimerRef.current) {
          window.clearTimeout(teamBattleAutoCloseTimerRef.current);
          teamBattleAutoCloseTimerRef.current = null;
        }
        setTeamBattleId(null);
        setViewMode('map');
        setTopTab('map');
        setInfoTarget(null);
        return;
      }

      if (kind === 'battle_finished') {
        if (teamBattleAutoCloseTimerRef.current) {
          window.clearTimeout(teamBattleAutoCloseTimerRef.current);
          teamBattleAutoCloseTimerRef.current = null;
        }
        setTeamBattleId(battleId);
        setViewMode('battle');
        setTopTab('map');
        setInfoTarget(null);
        teamBattleAutoCloseTimerRef.current = window.setTimeout(() => {
          setTeamBattleId(null);
          setViewMode('map');
        }, 6000);
      }
    });
    return () => {
      if (teamBattleAutoCloseTimerRef.current) {
        window.clearTimeout(teamBattleAutoCloseTimerRef.current);
        teamBattleAutoCloseTimerRef.current = null;
      }
      unsub();
    };
  }, [inTeam, isTeamLeader]);

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
        messageRef.current.error(res.message || '退出队伍失败');
        return;
      }
      messageRef.current.success(res.message || '已退出队伍');
      if (teamBattleAutoCloseTimerRef.current) {
        window.clearTimeout(teamBattleAutoCloseTimerRef.current);
        teamBattleAutoCloseTimerRef.current = null;
      }
      setTeamBattleId(null);
      setArenaBattleId(null);
      setDungeonBattleId(null);
      setDungeonInstanceId(null);
      setViewMode('map');
      setTopTab('map');
      setBattleTurn(0);
      setBattleActiveUnitId(null);
      void refreshTeamData();
    } catch {
      messageRef.current.error('退出队伍失败');
    }
  }, [characterId, refreshTeamData]);

  useEffect(() => {
    if (!character || hydratedPositionRef.current) return;
    let cancelled = false;
    const mapId = String(character.currentMapId || '').trim();
    const roomId = String(character.currentRoomId || '').trim();
    Promise.resolve().then(() => {
      if (cancelled || hydratedPositionRef.current) return;
      if (mapId) setCurrentMapId(mapId);
      if (roomId) setCurrentRoomId(roomId);
      hydratedPositionRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [character]);

  const savePosition = useCallback((mapId: string, roomId: string) => {
    const nextMapId = String(mapId || '').trim();
    const nextRoomId = String(roomId || '').trim();
    if (!nextMapId || !nextRoomId) return;
    void updateCharacterPosition(nextMapId, nextRoomId).catch(() => undefined);
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
    else void updateCharacterPosition(nextMapId, nextRoomId).catch(() => undefined);
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

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

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

  const spiritStones = character?.spiritStones || 0;
  const silver = character?.silver || 0;
  const playerName = character?.nickname || '我';
  const genderValue = String(character?.gender ?? '').trim().toLowerCase();
  const isFemale = genderValue === 'female' || genderValue === 'f' || genderValue === '女';
  const equipPortrait = isFemale ? equipFemale : equipMale;
  const functionIndicators: Record<string, { badgeCount?: number; badgeDot?: boolean; tooltip?: string }> | undefined = useMemo(() => {
    if (!isTeamLeader || teamApplicationUnread <= 0) return undefined;
    return {
      team: {
        badgeCount: teamApplicationUnread,
        tooltip: `有${teamApplicationUnread}个入队申请待处理`,
      },
    };
  }, [isTeamLeader, teamApplicationUnread]);

  const incAchievementCounter = (counterKey: string, delta = 1) => {
    const storageKey = 'achievement_counters';
    const raw = localStorage.getItem(storageKey);
    let obj: Record<string, number> = {};
    if (raw) {
      try {
        obj = JSON.parse(raw) as Record<string, number>;
      } catch {
        obj = {};
      }
    }
    const cur = Number(obj[counterKey] ?? 0);
    const next = (Number.isFinite(cur) ? cur : 0) + delta;
    obj[counterKey] = next;
    localStorage.setItem(storageKey, JSON.stringify(obj));
  };

  const handleInfoAction = (action: string, target: InfoTarget) => {
    if (action === 'attack') {
      if (inTeam && !isTeamLeader) {
        messageRef.current.error('组队中只有队长可以发起战斗');
        return;
      }
      incAchievementCounter('battle', 1);
      setBattleEnemies(buildEnemyGroup(target));
      setBattleAllies(buildAllyGroup(character));
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
      setNpcTalkNpcId(target.id);
      setNpcTalkOpen(true);
      setNpcTalkPhase('root');
      setNpcDialogue([]);
      setNpcTalkSelectedTaskId('');
      void (async () => {
        const data = await refreshNpcTalk(target.id);
        setNpcDialogue([]);
        appendNpcDialogueLines(data?.lines, '……');
      })();
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
          if (!res?.success) throw new Error(res?.message || '拾取失败');
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
          const err = e as { message?: string };
          messageRef.current.error(err.message || '拾取失败');
        }
      })();
      return;
    }
  };

  return (
    <div className="game-page">
      <SkillFloatButton
        turn={viewMode === 'battle' ? battleTurn : undefined}
        turnSide={viewMode === 'battle' ? battleTurnSide : undefined}
        isMyTurn={viewMode === 'battle' && myBattleUnitId != null && battleActiveUnitId === myBattleUnitId}
        isBattleRunning={viewMode === 'battle' && battleTurn > 0}
        actionKey={viewMode === 'battle' ? battleActionKey : undefined}
        autoMode={autoMode}
        onAutoModeChange={handleAutoModeChange}
        onCastSkill={(skillId, targetType) => battleSkillCasterRef.current(skillId, targetType)}
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
          {gatherAction.running
            ? (() => {
                const now = gatherNowMs || Date.now();
                const actionMs = Math.max(1, Math.floor(gatherAction.actionSec * 1000));
                const hasUntil = Number.isFinite(gatherAction.gatherUntilMs) && gatherAction.gatherUntilMs > 0;
                const remainingMs = hasUntil ? Math.max(0, gatherAction.gatherUntilMs - now) : actionMs;
                const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
                const percent = hasUntil ? clampNum(((actionMs - remainingMs) / actionMs) * 100, 0, 100) : 0;
                return (
                  <div className="game-header-gather" title={`采集中：${gatherAction.resourceName}（剩余${gatherAction.remaining}）`}>
                    <div className="game-header-gather-label">采集中</div>
                    <div className="game-header-gather-progress">
                      <Progress percent={percent} showInfo={false} status="active" size={{ height: 10 }} />
                    </div>
                    <div className="game-header-gather-time">{remainingSec}s</div>
                    <Button size="small" type="text" className="game-header-gather-stop" onClick={stopGatherLoop}>
                      停止
                    </Button>
                  </div>
                );
              })()
            : null}

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
          <Button
            className="game-header-icon-btn"
            type="text"
            icon={<MailOutlined />}
            aria-label="邮箱"
            onClick={() => setMailModalOpen(true)}
          />
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

        <main className="game-center">
          <div className="game-map-area">
            {isMobile ? (
              <div className="game-top-tabs">
                <Tabs
                  size="small"
                  activeKey={topTab}
                  onChange={(key) => setTopTab(key as 'map' | 'room')}
                  items={[
                    {
                      key: 'map',
                      label: '地图',
                      children: (
                        <div className="game-top-tab-panel">
                          {viewMode === 'battle' ? (
                            <BattleArea
                              enemies={battleEnemies}
                              allies={battleAllies}
                              externalBattleId={externalBattleId}
                              allowAutoNext={allowAutoNextBattle}
                              onNext={battleOnNext}
                              nextLabel="继续"
                              onAppendBattleLines={appendBattleLinesToChat}
                              onBindSkillCaster={(caster) => {
                                battleSkillCasterRef.current = caster;
                              }}
                              onEscape={
                                !inTeam || isTeamLeader
                                  ? () => {
                                      setViewMode('map');
                                      setBattleTurn(0);
                                      setBattleActiveUnitId(null);
                                      setArenaBattleId(null);
                                      setDungeonBattleId(null);
                                      setDungeonInstanceId(null);
                                    }
                                  : undefined
                              }
                              onTurnChange={(
                                turnCount: number,
                                turnSide: 'enemy' | 'ally',
                                actionKey: string,
                                activeUnitId: string | null,
                              ) => {
                                setBattleTurn(turnCount);
                                setBattleTurnSide(turnSide);
                                setBattleActionKey(actionKey);
                                setBattleActiveUnitId(activeUnitId);
                              }}
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
                        <div className="game-top-tab-panel">
                          <RoomObjects mapId={currentMapId} roomId={currentRoomId} onSelect={handleRoomObjectSelect} />
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            ) : (
              <div className="game-top-area">
                <section className="game-map-pane">
                  {viewMode === 'battle' ? (
                    <BattleArea
                      enemies={battleEnemies}
                      allies={battleAllies}
                      externalBattleId={externalBattleId}
                      allowAutoNext={allowAutoNextBattle}
                      onNext={battleOnNext}
                      nextLabel="继续"
                      onAppendBattleLines={appendBattleLinesToChat}
                      onBindSkillCaster={(caster) => {
                        battleSkillCasterRef.current = caster;
                      }}
                      onEscape={
                        !inTeam || isTeamLeader
                          ? () => {
                              setViewMode('map');
                              setBattleTurn(0);
                              setBattleActiveUnitId(null);
                              setArenaBattleId(null);
                              setDungeonBattleId(null);
                              setDungeonInstanceId(null);
                            }
                          : undefined
                      }
                      onTurnChange={(
                        turnCount: number,
                        turnSide: 'enemy' | 'ally',
                        actionKey: string,
                        activeUnitId: string | null,
                      ) => {
                        setBattleTurn(turnCount);
                        setBattleTurnSide(turnSide);
                        setBattleActionKey(actionKey);
                        setBattleActiveUnitId(activeUnitId);
                      }}
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
          <div className="game-chat-area">
            <div className="game-chat-left">
              <ChatPanel ref={chatPanelRef} onSelectPlayer={setInfoTarget} />
            </div>
            <div className="game-chat-right">
              <TeamPanel
                members={teamMembers}
                onSelectMember={(m) => setInfoTarget(buildTeamInfoTarget(m))}
                onLeaveTeam={inTeam ? onLeaveTeam : undefined}
              />
            </div>
          </div>
        </main>

        <aside className="game-right">
          <div className="game-right-top">
            <FunctionMenu
              indicators={functionIndicators}
              onAction={(key) => {
                if (key === 'map') {
                  incAchievementCounter('mapOpen', 1);
                  setMapModalCategory('world');
                  setMapModalOpen(true);
                }
                if (key === 'dungeon') {
                  incAchievementCounter('dungeonOpen', 1);
                  setMapModalCategory('dungeon');
                  setMapModalOpen(true);
                }
                if (key === 'bag') setBagModalOpen(true);
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
                if (key === 'achievement') setAchievementModalOpen(true);
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
                          classNames={{ root: 'equipment-tooltip-overlay' }}
                        >
                          <div
                            className={`equip-slot ${equipped ? 'has-item' : ''} ${
                              unequippingId != null && equipped?.id === unequippingId ? 'is-busy' : ''
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
                          classNames={{ root: 'equipment-tooltip-overlay' }}
                        >
                          <div
                            className={`equip-slot ${equipped ? 'has-item' : ''} ${
                              unequippingId != null && equipped?.id === unequippingId ? 'is-busy' : ''
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
          styles={{ wrapper: { height: '70vh' }, body: { padding: 0 } }}
        >
          <PlayerInfo />
        </Drawer>
      ) : null}

      <InfoModal open={!!infoTarget} target={infoTarget} onClose={() => setInfoTarget(null)} onAction={handleInfoAction} />
      <Modal
        open={npcTalkOpen}
        onCancel={() => {
          setNpcTalkOpen(false);
          setNpcTalkNpcId('');
          setNpcTalkData(null);
          setNpcTalkActionKey('');
          setNpcTalkSelectedTaskId('');
          setNpcTalkPhase('root');
          setNpcDialogue([]);
          setMainQuestDialogueState(null);
        }}
        footer={null}
        centered
        width={720}
        title={npcTalkData?.npcName ? `与「${npcTalkData.npcName}」对话` : '对话'}
        destroyOnHidden
        maskClosable
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              minHeight: 120,
              maxHeight: 340,
              overflow: 'auto',
              padding: 12,
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.02)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {npcTalkLoading ? (
              <div>加载中...</div>
            ) : npcDialogue.length > 0 ? (
              npcDialogue.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    justifyContent: d.role === 'player' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      maxWidth: '86%',
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(0,0,0,0.06)',
                      background: d.role === 'player' ? 'rgba(24, 144, 255, 0.08)' : 'rgba(255,255,255,0.9)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {d.text}
                  </div>
                </div>
              ))
            ) : (
              <div>暂无对白</div>
            )}
          </div>

          <div style={{ fontWeight: 600 }}>选项</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {npcTalkPhase === 'root' ? (
              <>
                {/* 主线任务选项 */}
                {npcTalkData?.mainQuest && npcTalkData.mainQuest.status !== 'completed' && (
                  <Button
                    block
                    type="primary"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onClick={async () => {
                      const mq = npcTalkData.mainQuest!;
                      appendNpcDialogue('player', `关于「${mq.sectionName}」…`);
                      if (mq.canStartDialogue) {
                        // 开始主线对话
                        setMainQuestDialogueLoading(true);
                        try {
                          const res = await startDialogue();
                          if (res?.success && res.data) {
                            setMainQuestDialogueState(res.data.dialogueState);
                            setNpcTalkPhase('mainQuestDialogue');
                          } else {
                            messageRef.current.error(res?.message || '开始对话失败');
                          }
                        } catch {
                          messageRef.current.error('开始对话失败');
                        } finally {
                          setMainQuestDialogueLoading(false);
                        }
                      } else if (mq.canComplete) {
                        // 完成主线任务
                        setMainQuestDialogueLoading(true);
                        try {
                          const res = await completeSection();
                          if (res?.success && res.data) {
                            const rewards = res.data.rewards || [];
                            const rewardTexts: string[] = [];
                            for (const r of rewards) {
                              const rr = r as { type?: string; amount?: number; itemDefId?: string; quantity?: number };
                              if (rr.type === 'exp') rewardTexts.push(`经验 +${rr.amount}`);
                              if (rr.type === 'silver') rewardTexts.push(`银两 +${rr.amount}`);
                              if (rr.type === 'spirit_stones') rewardTexts.push(`灵石 +${rr.amount}`);
                              if (rr.type === 'item') rewardTexts.push(`物品 ${rr.itemDefId} ×${rr.quantity || 1}`);
                            }
                            messageRef.current.success('主线任务完成！');
                            if (rewardTexts.length > 0) {
                              appendSystemChat(`【主线】获得奖励：${rewardTexts.join('，')}`);
                            }
                            appendNpcDialogue('npc', '做得好，继续前进吧。');
                            gameSocket.refreshCharacter();
                            await refreshNpcTalk(npcTalkNpcId);
                            await refreshTrackedRoomIds();
                            window.dispatchEvent(new Event('room:objects:changed'));
                          } else {
                            messageRef.current.error(res?.message || '完成任务失败');
                          }
                        } catch {
                          messageRef.current.error('完成任务失败');
                        } finally {
                          setMainQuestDialogueLoading(false);
                        }
                      } else {
                        appendNpcDialogue('npc', '你还有任务目标未完成，去完成它们吧。');
                      }
                    }}
                    disabled={npcTalkLoading || mainQuestDialogueLoading}
                    loading={mainQuestDialogueLoading}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>【主线】{npcTalkData.mainQuest.sectionName}</span>
                      <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                        {npcTalkData.mainQuest.status === 'not_started' ? '可接取' :
                         npcTalkData.mainQuest.status === 'dialogue' ? '对话中' :
                         npcTalkData.mainQuest.status === 'objectives' ? '进行中' :
                         npcTalkData.mainQuest.status === 'turnin' ? '可交付' : ''}
                      </Tag>
                    </span>
                  </Button>
                )}

                {(npcTalkData?.tasks ?? []).length > 0 ? (
                  (npcTalkData?.tasks ?? []).map((t) => (
                    <Button
                      key={t.taskId}
                      block
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                      onClick={() => {
                        setNpcTalkSelectedTaskId(t.taskId);
                        appendNpcDialogue('player', `关于「${t.title}」…`);
                        appendNpcDialogue('npc', buildTaskNpcLine(t));
                        setNpcTalkPhase('taskDetail');
                      }}
                      disabled={npcTalkLoading}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>{t.title}</span>
                        <Tag color={statusColor[t.status]} style={{ marginInlineEnd: 0 }}>
                          {statusLabel[t.status]}
                        </Tag>
                      </span>
                    </Button>
                  ))
                ) : (
                  !npcTalkData?.mainQuest && <div>该NPC暂无可用任务</div>
                )}

                <Button
                  block
                  onClick={() => {
                    appendNpcDialogue('player', '告辞。');
                    setNpcTalkOpen(false);
                    setNpcTalkNpcId('');
                    setNpcTalkData(null);
                    setNpcTalkActionKey('');
                    setNpcTalkSelectedTaskId('');
                    setNpcTalkPhase('root');
                    setNpcDialogue([]);
                    setMainQuestDialogueState(null);
                  }}
                  disabled={npcTalkLoading}
                >
                  告辞
                </Button>
              </>
            ) : null}

            {npcTalkPhase === 'taskDetail' ? (
              (() => {
                const task = (npcTalkData?.tasks ?? []).find((x) => x.taskId === npcTalkSelectedTaskId) ?? null;
                if (!task) {
                  return (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Button
                        onClick={() => {
                          setNpcTalkPhase('root');
                        }}
                      >
                        返回
                      </Button>
                    </div>
                  );
                }

                const doAccept = async () => {
                  setNpcTalkActionKey(`accept:${task.taskId}`);
                  try {
                    const res = await acceptTaskFromNpc(npcTalkNpcId, task.taskId);
                    if (!res?.success) throw new Error(res?.message || '接取失败');
                    messageRef.current.success('接取成功');
                    appendSystemChat(`【任务】已接取：${task.title}`);
                    appendNpcDialogue('npc', '好，我已为你记下。去吧。');
                    const data = await refreshNpcTalk(npcTalkNpcId);
                    if (data?.lines) {
                      await refreshTrackedRoomIds();
                      window.dispatchEvent(new Event('room:objects:changed'));
                    }
                  } catch (e: unknown) {
                    const err = e as { message?: string };
                    messageRef.current.error(err.message || '接取失败');
                  } finally {
                    setNpcTalkActionKey('');
                  }
                };

                const doSubmit = async () => {
                  setNpcTalkActionKey(`submit:${task.taskId}`);
                  try {
                    const res = await submitTaskToNpc(npcTalkNpcId, task.taskId);
                    if (!res?.success) throw new Error(res?.message || '提交失败');
                    messageRef.current.success('提交成功');
                    appendSystemChat(`【任务】已提交：${task.title}`);
                    appendNpcDialogue('npc', '办得好。稍等，我为你结算。');
                    await refreshNpcTalk(npcTalkNpcId);
                    await refreshTrackedRoomIds();
                    window.dispatchEvent(new Event('room:objects:changed'));
                  } catch (e: unknown) {
                    const err = e as { message?: string };
                    messageRef.current.error(err.message || '提交失败');
                  } finally {
                    setNpcTalkActionKey('');
                  }
                };

                const doClaim = async () => {
                  setNpcTalkActionKey(`claim:${task.taskId}`);
                  try {
                    const res = await claimTaskReward(task.taskId);
                    if (!res?.success) throw new Error(res?.message || '领取失败');
                    messageRef.current.success('领取成功');
                    const rewardText = formatTaskRewardsToText(res.data?.rewards);
                    appendSystemChat(`【任务】领取奖励：${task.title}${rewardText ? `（${rewardText}）` : ''}`);
                    appendNpcDialogue('npc', '收好。');
                    gameSocket.refreshCharacter();
                    await refreshNpcTalk(npcTalkNpcId);
                    await refreshTrackedRoomIds();
                    window.dispatchEvent(new Event('room:objects:changed'));
                  } catch (e: unknown) {
                    const err = e as { message?: string };
                    messageRef.current.error(err.message || '领取失败');
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
                    <Button
                      onClick={() => {
                        setNpcTalkPhase('root');
                      }}
                    >
                      返回
                    </Button>
                  </div>
                );
              })()
            ) : null}

            {npcTalkPhase === 'mainQuestDialogue' ? (
              (() => {
                const node = mainQuestDialogueState?.currentNode;
                
                const handleAdvance = async () => {
                  setMainQuestDialogueLoading(true);
                  try {
                    const res = await advanceDialogue();
                    if (res?.success && res.data) {
                      setMainQuestDialogueState(res.data.dialogueState);
                      if (res.data.dialogueState.isComplete) {
                        // 对话完成，返回根菜单
                        await refreshNpcTalk(npcTalkNpcId);
                        await refreshTrackedRoomIds();
                        setNpcTalkPhase('root');
                        setMainQuestDialogueState(null);
                        window.dispatchEvent(new Event('room:objects:changed'));
                      }
                    } else {
                      messageRef.current.error(res?.message || '推进对话失败');
                    }
                  } catch {
                    messageRef.current.error('推进对话失败');
                  } finally {
                    setMainQuestDialogueLoading(false);
                  }
                };

                const handleChoice = async (choiceId: string) => {
                  setMainQuestDialogueLoading(true);
                  try {
                    const res = await selectDialogueChoice(choiceId);
                    if (res?.success && res.data) {
                      setMainQuestDialogueState(res.data.dialogueState);
                      if (res.data.dialogueState.isComplete) {
                        await refreshNpcTalk(npcTalkNpcId);
                        await refreshTrackedRoomIds();
                        setNpcTalkPhase('root');
                        setMainQuestDialogueState(null);
                        window.dispatchEvent(new Event('room:objects:changed'));
                      }
                    } else {
                      messageRef.current.error(res?.message || '选择失败');
                    }
                  } catch {
                    messageRef.current.error('选择失败');
                  } finally {
                    setMainQuestDialogueLoading(false);
                  }
                };

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* 对话内容 */}
                    {node && (
                      <div style={{
                        padding: 16,
                        background: 'linear-gradient(135deg, rgba(24, 144, 255, 0.05) 0%, rgba(255, 193, 7, 0.05) 100%)',
                        borderRadius: 12,
                        border: '1px solid rgba(24, 144, 255, 0.2)'
                      }}>
                        {node.type === 'narration' && (
                          <div style={{ textAlign: 'center', color: 'rgba(0,0,0,0.65)', fontStyle: 'italic', lineHeight: 1.8 }}>
                            {node.text}
                          </div>
                        )}
                        {node.type === 'npc' && (
                          <div>
                            <div style={{ fontWeight: 600, color: '#1890ff', marginBottom: 8 }}>{node.speaker}</div>
                            <div style={{ color: 'rgba(0,0,0,0.85)', lineHeight: 1.7 }}>{node.text}</div>
                          </div>
                        )}
                        {node.type === 'player' && (
                          <div>
                            <div style={{ fontWeight: 600, color: '#52c41a', marginBottom: 8 }}>你</div>
                            <div style={{ color: 'rgba(0,0,0,0.85)', lineHeight: 1.7 }}>{node.text}</div>
                          </div>
                        )}
                        {node.type === 'action' && (
                          <div style={{ textAlign: 'center', color: 'rgba(0,0,0,0.45)', fontStyle: 'italic' }}>
                            *{node.text}*
                          </div>
                        )}
                        {node.type === 'system' && (
                          <div style={{ textAlign: 'center', color: '#faad14', padding: '8px 16px', background: 'rgba(250, 173, 20, 0.1)', borderRadius: 8 }}>
                            {node.text}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 选项或继续按钮 */}
                    {node?.type === 'choice' && node.choices ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {node.choices.map((choice) => (
                          <Button
                            key={choice.id}
                            block
                            onClick={() => void handleChoice(choice.id)}
                            disabled={mainQuestDialogueLoading}
                          >
                            {choice.text}
                          </Button>
                        ))}
                      </div>
                    ) : mainQuestDialogueState?.isComplete ? (
                      <Button
                        type="primary"
                        block
                        onClick={() => {
                          setNpcTalkPhase('root');
                          setMainQuestDialogueState(null);
                          void refreshNpcTalk(npcTalkNpcId);
                          void refreshTrackedRoomIds();
                        }}
                      >
                        完成对话
                      </Button>
                    ) : (
                      <Button
                        type="primary"
                        block
                        onClick={() => void handleAdvance()}
                        loading={mainQuestDialogueLoading}
                      >
                        继续
                      </Button>
                    )}

                    <Button
                      onClick={() => {
                        setNpcTalkPhase('root');
                        setMainQuestDialogueState(null);
                      }}
                      disabled={mainQuestDialogueLoading}
                    >
                      返回
                    </Button>
                  </div>
                );
              })()
            ) : null}
          </div>
        </div>
      </Modal>
      <MapModal
        open={mapModalOpen}
        onClose={() => setMapModalOpen(false)}
        initialCategory={mapModalCategory}
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
          setBattleEnemies([]);
          setBattleAllies(buildAllyGroup(character));
          setArenaBattleId(null);
          setDungeonBattleId(null);
          setDungeonInstanceId(null);
          setViewMode('battle');

          try {
            const createRes = await createDungeonInstance(dungeonId, rank);
            if (!createRes?.success || !createRes.data?.instanceId) {
              messageRef.current.error(createRes?.message || '创建秘境失败');
              setViewMode('map');
              return;
            }

            const instanceId = String(createRes.data.instanceId);
            setDungeonInstanceId(instanceId);
            const startRes = await startDungeonInstance(instanceId);
            if (!startRes?.success || !startRes.data?.battleId) {
              messageRef.current.error(startRes?.message || '开始秘境失败');
              setViewMode('map');
              setDungeonInstanceId(null);
              return;
            }

            setDungeonBattleId(String(startRes.data.battleId));
          } catch (e) {
            messageRef.current.error((e as { message?: string })?.message || '进入秘境失败');
            setViewMode('map');
            setDungeonBattleId(null);
            setDungeonInstanceId(null);
          }
        }}
      />
      <BagModal open={bagModalOpen} onClose={() => setBagModalOpen(false)} />
      {warehouseModalOpen && (
        <WarehouseModal open={warehouseModalOpen} onClose={() => setWarehouseModalOpen(false)} />
      )}
      {techniqueModalOpen && (
        <TechniqueModal open={techniqueModalOpen} onClose={() => setTechniqueModalOpen(false)} />
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
        <MailModal open={mailModalOpen} onClose={() => setMailModalOpen(false)} />
      )}
      {settingModalOpen && (
        <SettingModal open={settingModalOpen} onClose={() => setSettingModalOpen(false)} />
      )}
      {achievementModalOpen && (
        <AchievementModal
          open={achievementModalOpen}
          onClose={() => setAchievementModalOpen(false)}
          character={character}
          inTeam={inTeam}
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
          onClose={() => setSectModalOpen(false)}
          spiritStones={spiritStones}
          playerName={playerName}
        />
      )}
    </div>
  );
};

export default Game;
