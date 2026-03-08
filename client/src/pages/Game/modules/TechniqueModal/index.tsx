import { App, Button, Modal, Table, Tag, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import { gameSocket } from '../../../../services/gameSocket';
import {
  INVENTORY_ITEMS_PAGE_SIZE_MAX,
  equipCharacterSkill,
  equipCharacterTechnique,
  exchangeTechniqueBooksForResearchPoints,
  generateTechniqueResearchDraft,
  getCharacterTechniqueStatus,
  getCharacterTechniqueUpgradeCost,
  getInventoryItems,
  getTechniqueResearchStatus,
  getTechniqueDetail,
  markTechniqueResearchResultViewed,
  publishTechniqueResearchDraft,
  type SkillDefDto,
  type TechniqueResearchResultStatusDto,
  type TechniqueDefDto,
  type TechniqueLayerDto,
  type TechniqueUpgradeCostResponse,
  type CharacterTechniqueDto,
  unequipCharacterSkill,
  unequipCharacterTechnique,
  upgradeCharacterTechnique,
} from '../../../../services/api';
import { useIsMobile } from '../../shared/responsive';
import ResearchPanel from './ResearchPanel';
import {
  TECHNIQUE_RESEARCH_STATUS_POLL_INTERVAL_MS,
  resolveTechniqueResearchIndicatorStatus,
  shouldPollTechniqueResearchStatus,
  type TechniqueResearchStatusData,
} from './researchShared';
import { getSkillInlineSummary, renderSkillInlineDetails, renderSkillTooltip } from './skillDetailShared';
import './index.scss';


type TechQuality = '黄' | '玄' | '地' | '天';

type TechniqueBonus = { label: string; value: string };

type TechniqueSkill = { 
  id: string; 
  name: string; 
  icon: string;
  // 完整技能数据用于Tooltip显示
  description?: string;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
};

type TechniqueCostItem = { id: string; name: string; icon: string; amount: number };

type TechniqueLayer = {
  layer: number;
  bonuses: TechniqueBonus[];
  skills: TechniqueSkill[];
  cost: TechniqueCostItem[];
};

type Technique = {
  id: string;
  name: string;
  quality: TechQuality;
  tags: string[];
  icon: string;
  desc: string;
  layer: number;
  layers: TechniqueLayer[];
};

type TechniquePanel = 'slots' | 'learned' | 'bonus' | 'skills' | 'research';

type SlotKey = 'main' | 'sub1' | 'sub2' | 'sub3';

type SkillSlot = { id: string; name: string; icon: string } | null;

type PassiveEntry = { key: string; value: number };

const qualityColor: Record<TechQuality, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

const qualityText: Record<TechQuality, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const TECHNIQUE_TOOLTIP_CLASS_NAMES = {
  root: 'technique-tooltip-overlay game-tooltip-surface-root',
  container: 'technique-tooltip-overlay-container game-tooltip-surface-container',
} as const;

const SKILL_TOOLTIP_CLASS_NAMES = {
  root: 'skill-tooltip-overlay game-tooltip-surface-root',
  container: 'skill-tooltip-overlay-container game-tooltip-surface-container',
} as const;

const resolveIcon = resolveIconUrl;

const mapQuality = (value: unknown): TechQuality => {
  if (value === '天' || value === '地' || value === '玄' || value === '黄') return value;
  return '黄';
};

const passiveLabel: Record<string, string> = {
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
  fuyuan: '福缘',
  shuxing_shuzhi: '属性数值',
};

const PERCENT_PASSIVE_KEYS = new Set<string>([
  'max_qixue',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
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

const normalizePassiveKey = (raw: string): string =>
  raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();

const getTechniqueUnlockedInfo = (t: Technique): { bonuses: TechniqueBonus[]; skills: TechniqueSkill[] } => {
  const unlockedLayers = t.layers.slice(0, Math.max(0, Math.min(t.layer, t.layers.length)));
  const bonusList = unlockedLayers.flatMap((lv) => lv.bonuses);
  const skillMap = new Map<string, TechniqueSkill>();
  unlockedLayers.forEach((lv) => {
    lv.skills.forEach((s) => {
      if (!skillMap.has(s.id)) skillMap.set(s.id, s);
    });
  });

  return {
    bonuses: bonusList,
    skills: Array.from(skillMap.values()),
  };
};

const renderTechniqueInlineDetails = (t: Technique): React.ReactNode => {
  const { bonuses, skills } = getTechniqueUnlockedInfo(t);
  const bonusText = bonuses.length > 0 ? bonuses.map((b) => `${b.label}${b.value}`).join(' · ') : '暂无';
  const skillText = skills.length > 0 ? skills.map((s) => s.name).join('、') : '无';

  return (
    <div className="tech-row-details">
      <div className="tech-row-detail">
        <span className="tech-row-detail-label">已解锁加成：</span>
        <span className="tech-row-detail-value">{bonusText}</span>
      </div>
      <div className="tech-row-detail">
        <span className="tech-row-detail-label">已解锁技能：</span>
        <span className="tech-row-detail-value">{skillText}</span>
      </div>
    </div>
  );
};

// 功法Tooltip内容渲染
const renderTechniqueTooltip = (t: Technique): React.ReactNode => {
  const { bonuses: unlockedBonuses, skills: unlockedSkills } = getTechniqueUnlockedInfo(t);

  return (
    <div className="technique-tooltip">
      <div className="technique-tooltip-header">
        <span className="technique-tooltip-name">{t.name}</span>
        <span className="technique-tooltip-quality" style={{ color: qualityColor[t.quality] }}>
          {qualityText[t.quality]}
        </span>
      </div>
      <div className="technique-tooltip-layer">
        修炼进度：{t.layer}层 / {t.layers.length}层
      </div>
      {t.desc && <div className="technique-tooltip-desc">{t.desc}</div>}

      {unlockedBonuses.length > 0 && (
        <div className="technique-tooltip-section">
          <div className="technique-tooltip-section-title">当前加成</div>
          <div className="technique-tooltip-bonuses">
            {unlockedBonuses.map((b, idx) => (
              <div key={idx} className="technique-tooltip-bonus">
                <span className="technique-tooltip-bonus-label">{b.label}</span>
                <span className="technique-tooltip-bonus-value">{b.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {unlockedSkills.length > 0 && (
        <div className="technique-tooltip-section">
          <div className="technique-tooltip-section-title">已解锁技能</div>
          <div className="technique-tooltip-skills">
            {unlockedSkills.map((s) => (
              <div key={s.id} className="technique-tooltip-skill">
                <img className="technique-tooltip-skill-icon" src={s.icon} alt={s.name} />
                <span className="technique-tooltip-skill-name">{s.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {t.layer === 0 && <div className="technique-tooltip-empty">尚未开始修炼</div>}
    </div>
  );
};

const formatPassiveValue = (key: string, value: number): string => {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const absPercent = abs * 100;
  const formatSigned = (n: number) => {
    const fixed = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
    return `${sign}${fixed}`;
  };
  if (PERCENT_PASSIVE_KEYS.has(key)) return `${formatSigned(absPercent)}%`;
  return formatSigned(abs);
};

const coercePassiveEntries = (raw: unknown): PassiveEntry[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const rawKey = (x as { key?: unknown }).key;
      const value = (x as { value?: unknown }).value;
      if (typeof rawKey !== 'string') return null;
      if (typeof value !== 'number') return null;
      const key = normalizePassiveKey(rawKey);
      if (!key) return null;
      return { key, value };
    })
    .filter((v): v is PassiveEntry => !!v);
};

const coerceMaterials = (
  raw: unknown,
): Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null | undefined }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const itemId = (x as { itemId?: unknown }).itemId;
      const qty = (x as { qty?: unknown }).qty;
      const itemName = (x as { itemName?: unknown }).itemName;
      const itemIcon = (x as { itemIcon?: unknown }).itemIcon;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      const out: { itemId: string; qty: number; itemName?: string; itemIcon?: string | null } = { itemId, qty };
      if (typeof itemName === 'string') out.itemName = itemName;
      if (typeof itemIcon === 'string' || itemIcon === null) out.itemIcon = itemIcon;
      return out;
    })
    .filter((v): v is { itemId: string; qty: number; itemName?: string; itemIcon?: string | null } => v !== null);
};

const buildTechniqueView = (
  ct: CharacterTechniqueDto | null,
  technique: TechniqueDefDto,
  layers: TechniqueLayerDto[],
  skills: SkillDefDto[],
): Technique => {
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  return {
    id: technique.id,
    name: technique.name,
    quality: mapQuality(technique.quality),
    tags: Array.isArray(technique.tags) ? technique.tags : [],
    icon: resolveIcon(technique.icon),
    desc: technique.long_desc || technique.description || '',
    layer: Math.max(0, ct?.current_layer ?? 0),
    layers: layers.map((lv) => {
      const passives = coercePassiveEntries(lv.passives).map((p) => ({
        label: passiveLabel[p.key] || p.key,
        value: formatPassiveValue(p.key, p.value),
      }));
      const unlockSkills = (Array.isArray(lv.unlock_skill_ids) ? lv.unlock_skill_ids : []).map((id) => {
        const def = skillMap.get(id) ?? null;
        return {
          id,
          name: def?.name ?? id,
          icon: resolveIcon(def?.icon),
          // 保存完整技能数据用于Tooltip
          description: def?.description ?? undefined,
          cost_lingqi: def?.cost_lingqi ?? undefined,
          cost_qixue: def?.cost_qixue ?? undefined,
          cooldown: def?.cooldown ?? undefined,
          target_type: def?.target_type ?? undefined,
          target_count: def?.target_count ?? undefined,
          damage_type: def?.damage_type ?? undefined,
          element: def?.element ?? undefined,
          effects: Array.isArray(def?.effects) ? def.effects : undefined,
        };
      });
      const cost: TechniqueCostItem[] = [];
      if (lv.cost_spirit_stones > 0) cost.push({ id: 'spirit_stones', name: '灵石', icon: lingshiIcon, amount: lv.cost_spirit_stones });
      if (lv.cost_exp > 0) cost.push({ id: 'exp', name: '经验', icon: tongqianIcon, amount: lv.cost_exp });
      coerceMaterials(lv.cost_materials).forEach((m) => {
        cost.push({ id: m.itemId, name: m.itemName ?? m.itemId, icon: resolveIcon(m.itemIcon ?? null), amount: m.qty });
      });
      return {
        layer: lv.layer,
        bonuses: passives,
        skills: unlockSkills,
        cost,
      };
    }),
  };
};

const slotLabels: Record<SlotKey, string> = {
  main: '主功法',
  sub1: '副功法Ⅰ',
  sub2: '副功法Ⅱ',
  sub3: '副功法Ⅲ',
};

interface TechniqueModalProps {
  open: boolean;
  onClose: () => void;
  onResearchIndicatorChange?: (resultStatus: TechniqueResearchResultStatusDto | null) => void;
}
const TECHNIQUE_RESEARCH_ENABLED = !import.meta.env.PROD;
type ResearchStatusRefreshMode = 'initial' | 'manual' | 'background';

const TechniqueModal: React.FC<TechniqueModalProps> = ({ open, onClose, onResearchIndicatorChange }) => {
  const { message } = App.useApp();
  const [characterId, setCharacterId] = useState<number | null>(() => gameSocket.getCharacter()?.id ?? null);
  const [panel, setPanel] = useState<TechniquePanel>('slots');
  const [activeSlot, setActiveSlot] = useState<SlotKey>('main');
  const [detailOpen, setDetailOpen] = useState(false);
  const [cultivateOpen, setCultivateOpen] = useState(false);
  const [activeTechId, setActiveTechId] = useState<string>('');
  const [detailTechnique, setDetailTechnique] = useState<Technique | null>(null);
  const [upgradeCost, setUpgradeCost] = useState<TechniqueUpgradeCostResponse['data'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cultivateSubmitting, setCultivateSubmitting] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<TechniqueSkill[]>([]);
  const isMobile = useIsMobile();
  const techniqueDetailCacheRef = useRef<
    Map<string, { technique: TechniqueDefDto; layers: TechniqueLayerDto[]; skills: SkillDefDto[] }>
  >(new Map());

  const [equipped, setEquipped] = useState<Record<SlotKey, string | null>>({
    main: null,
    sub1: null,
    sub2: null,
    sub3: null,
  });

  const [learned, setLearned] = useState<Technique[]>(() => []);

  const [skillSlots, setSkillSlots] = useState<SkillSlot[]>(
    Array.from({ length: 10 }).map(() => null),
  );
  const [activeSkillSlot, setActiveSkillSlot] = useState<number>(0);
  const [researchStatus, setResearchStatus] = useState<TechniqueResearchStatusData | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchRefreshing, setResearchRefreshing] = useState(false);
  const [exchangeSubmitting, setExchangeSubmitting] = useState(false);
  const [generateSubmitting, setGenerateSubmitting] = useState(false);
  const [publishSubmitting, setPublishSubmitting] = useState(false);
  const markingResearchViewedRef = useRef(false);
  const researchStatusRef = useRef<TechniqueResearchStatusData | null>(null);
  const [researchVisitToken, setResearchVisitToken] = useState(0);

  useEffect(() => {
    gameSocket.connect();
    const unsubscribe = gameSocket.onCharacterUpdate((c) => {
      setCharacterId(c?.id ?? null);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!characterId) return;
    setLoading(true);
    try {
      const statusRes = await getCharacterTechniqueStatus(characterId);
      if (!statusRes?.success || !statusRes.data) throw new Error(statusRes?.message || '获取功法状态失败');

      const techRows = statusRes.data.techniques || [];
      const techIds = techRows.map((t) => t.technique_id);

      const detailList = await Promise.all(
        techIds.map(async (id) => {
          const cached = techniqueDetailCacheRef.current.get(id);
          if (cached) return { id, detail: cached };
          const detailRes = await getTechniqueDetail(id);
          if (!detailRes?.success || !detailRes.data) return { id, detail: null };
          techniqueDetailCacheRef.current.set(id, detailRes.data);
          return { id, detail: detailRes.data };
        }),
      );
      const detailMap = new Map(detailList.map((x) => [x.id, x.detail]));

      const builtLearned = techRows
        .map((ct) => {
          const detail = detailMap.get(ct.technique_id);
          if (!detail) return null;
          return buildTechniqueView(ct, detail.technique, detail.layers, detail.skills);
        })
        .filter((v): v is Technique => !!v);

      setLearned(builtLearned);

      const nextEquipped: Record<SlotKey, string | null> = { main: null, sub1: null, sub2: null, sub3: null };
      if (statusRes.data.equippedMain) nextEquipped.main = statusRes.data.equippedMain.technique_id;
      for (const s of statusRes.data.equippedSubs || []) {
        if (s.slot_index === 1) nextEquipped.sub1 = s.technique_id;
        else if (s.slot_index === 2) nextEquipped.sub2 = s.technique_id;
        else if (s.slot_index === 3) nextEquipped.sub3 = s.technique_id;
      }
      setEquipped(nextEquipped);

      const nextSkillSlots: SkillSlot[] = Array.from({ length: 10 }).map(() => null);
      for (const s of statusRes.data.equippedSkills || []) {
        const idx = (s.slot_index || 0) - 1;
        if (idx < 0 || idx >= 10) continue;
        nextSkillSlots[idx] = {
          id: s.skill_id,
          name: s.skill_name || s.skill_id,
          icon: resolveIcon(s.skill_icon),
        };
      }
      setSkillSlots(nextSkillSlots);
      setAvailableSkills(
        (statusRes.data.availableSkills || []).map((s) => ({
          id: s.skillId,
          name: s.skillName || s.skillId,
          icon: resolveIcon(s.skillIcon),
          // 完整技能数据
          description: s.description ?? undefined,
          cost_lingqi: s.costLingqi ?? undefined,
          cost_qixue: s.costQixue ?? undefined,
          cooldown: s.cooldown ?? undefined,
          target_type: s.targetType ?? undefined,
          target_count: s.targetCount ?? undefined,
          damage_type: s.damageType ?? undefined,
          element: s.element ?? undefined,
          effects: Array.isArray(s.effects) ? s.effects : undefined,
        })),
      );

      const nextEmpty = nextSkillSlots.findIndex((x) => x === null);
      if (nextEmpty !== -1) setActiveSkillSlot(nextEmpty);
    } catch (error: unknown) {
      void 0;
      setLearned([]);
      setEquipped({ main: null, sub1: null, sub2: null, sub3: null });
      setSkillSlots(Array.from({ length: 10 }).map(() => null));
      setActiveSkillSlot(0);
      setAvailableSkills([]);
    } finally {
      setLoading(false);
    }
  }, [characterId, message]);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
  }, [open, refreshStatus]);

  useEffect(() => {
    researchStatusRef.current = researchStatus;
  }, [researchStatus]);

  const refreshResearchStatus = useCallback(async (mode: ResearchStatusRefreshMode = 'background') => {
    if (!characterId) {
      setResearchLoading(false);
      setResearchRefreshing(false);
      researchStatusRef.current = null;
      setResearchStatus(null);
      onResearchIndicatorChange?.(null);
      return;
    }
    const shouldShowBlockingLoading = mode === 'initial' && researchStatusRef.current == null;
    const shouldShowRefreshLoading = mode === 'manual';

    if (shouldShowBlockingLoading) setResearchLoading(true);
    if (shouldShowRefreshLoading) setResearchRefreshing(true);
    try {
      const statusRes = await getTechniqueResearchStatus(characterId);
      if (!statusRes?.success || !statusRes.data) {
        throw new Error(statusRes?.message || '获取研修状态失败');
      }
      researchStatusRef.current = statusRes.data;
      setResearchStatus(statusRes.data);
      onResearchIndicatorChange?.(resolveTechniqueResearchIndicatorStatus(statusRes.data));
    } catch {
      // 拉取失败时保留上一份状态，避免网络抖动误清结果提示。
    } finally {
      if (shouldShowBlockingLoading) setResearchLoading(false);
      if (shouldShowRefreshLoading) setResearchRefreshing(false);
    }
  }, [characterId, onResearchIndicatorChange]);

  useEffect(() => {
    if (!TECHNIQUE_RESEARCH_ENABLED) {
      setResearchLoading(false);
      setResearchRefreshing(false);
      researchStatusRef.current = null;
      setResearchStatus(null);
      onResearchIndicatorChange?.(null);
      return;
    }
    if (!open || panel !== 'research') return;
    const nextMode: ResearchStatusRefreshMode = researchStatusRef.current == null ? 'initial' : 'background';
    void refreshResearchStatus(nextMode);
  }, [onResearchIndicatorChange, open, panel, refreshResearchStatus]);

  useEffect(() => {
    if (!open || panel !== 'research' || !TECHNIQUE_RESEARCH_ENABLED || !characterId) return undefined;
    return gameSocket.onTechniqueResearchResult((payload) => {
      if (payload.characterId !== characterId) return;
      void refreshResearchStatus('background');
    });
  }, [characterId, open, panel, refreshResearchStatus]);

  useEffect(() => {
    if (!open || panel !== 'research') return;
    setResearchVisitToken((value) => value + 1);
  }, [open, panel]);

  useEffect(() => {
    if (
      !open ||
      panel !== 'research' ||
      !TECHNIQUE_RESEARCH_ENABLED ||
      !characterId ||
      !shouldPollTechniqueResearchStatus(researchStatus)
    ) return undefined;
    const timer = window.setInterval(() => {
      void refreshResearchStatus('background');
    }, TECHNIQUE_RESEARCH_STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [characterId, open, panel, refreshResearchStatus, researchStatus]);

  useEffect(() => {
    if (
      researchVisitToken <= 0 ||
      !open ||
      panel !== 'research' ||
      !characterId ||
      !researchStatus?.hasUnreadResult
    ) return;
    if (markingResearchViewedRef.current) return;

    markingResearchViewedRef.current = true;
    void (async () => {
      try {
        const res = await markTechniqueResearchResultViewed(characterId);
        if (res.success) {
          onResearchIndicatorChange?.(null);
          await refreshResearchStatus('background');
        }
      } finally {
        markingResearchViewedRef.current = false;
      }
    })();
  }, [
    characterId,
    onResearchIndicatorChange,
    open,
    panel,
    refreshResearchStatus,
    researchStatus?.hasUnreadResult,
    researchVisitToken,
  ]);

  const collectExchangeItems = useCallback(async (): Promise<Array<{ itemInstanceId: number; qty: number }>> => {
    if (!characterId) return [];

    const locations: Array<'bag' | 'warehouse'> = ['bag', 'warehouse'];
    const exchangeItems: Array<{ itemInstanceId: number; qty: number }> = [];

    for (const location of locations) {
      let page = 1;
      let total = 0;
      do {
        const pageRes = await getInventoryItems(location, page, INVENTORY_ITEMS_PAGE_SIZE_MAX);
        if (!pageRes?.success || !pageRes.data) break;

        const items = pageRes.data.items || [];
        total = Number(pageRes.data.total || 0);
        for (const item of items) {
          const subCategory = String(item.def?.sub_category || '');
          if (subCategory !== 'technique_book') continue;
          if (item.item_def_id === 'book-generated-technique') continue;
          if (!Number.isInteger(item.id) || item.id <= 0) continue;
          const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
          if (qty <= 0) continue;
          exchangeItems.push({ itemInstanceId: item.id, qty });
        }

        page += 1;
      } while ((page - 1) * INVENTORY_ITEMS_PAGE_SIZE_MAX < total);
    }

    return exchangeItems;
  }, [characterId]);

  const handleExchangeBooks = useCallback(async () => {
    if (!characterId || exchangeSubmitting) return;
    setExchangeSubmitting(true);
    try {
      const exchangeItems = await collectExchangeItems();
      if (exchangeItems.length <= 0) {
        message.info('背包与仓库暂无可兑换功法书');
        return;
      }

      const exchangeRes = await exchangeTechniqueBooksForResearchPoints(characterId, exchangeItems);
      if (!exchangeRes?.success || !exchangeRes.data) {
        throw new Error(exchangeRes?.message || '兑换失败');
      }

      message.success(exchangeRes.message || `已兑换${exchangeRes.data.gainedPoints}研修点`);
      await Promise.all([refreshResearchStatus('background'), refreshStatus()]);
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '兑换失败');
    } finally {
      setExchangeSubmitting(false);
    }
  }, [characterId, collectExchangeItems, exchangeSubmitting, message, refreshResearchStatus, refreshStatus]);

  const handleGenerateResearchDraft = useCallback(async () => {
    if (!characterId || generateSubmitting) return;
    setGenerateSubmitting(true);
    try {
      const generateRes = await generateTechniqueResearchDraft(characterId);
      if (!generateRes?.success || !generateRes.data) {
        throw new Error(generateRes?.message || '生成失败');
      }

      message.success(generateRes.message || '已加入洞府推演队列');
      await refreshResearchStatus('background');
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '生成失败');
    } finally {
      setGenerateSubmitting(false);
    }
  }, [characterId, generateSubmitting, message, refreshResearchStatus]);

  const resolveCopyResearchBookErrorMessage = (code?: string, fallbackMessage?: string): string => {
    if (code === 'NAME_CONFLICT') return '名称已存在，请更换';
    if (code === 'NAME_SENSITIVE') return '名称包含敏感内容，请重填';
    if (code === 'NAME_INVALID') return '名称不符合格式规则';
    if (code === 'GENERATION_NOT_READY') return '草稿尚未就绪，请先领悟';
    if (code === 'GENERATION_EXPIRED') return '草稿已过期，请重新领悟';
    return fallbackMessage || '抄写失败';
  };

  const handleCopyResearchBook = useCallback(async (generationId: string, suggestedName: string) => {
    if (!characterId || publishSubmitting) return;
    const finalName = suggestedName.trim();
    if (!finalName) {
      message.warning('草稿名称未就绪，请稍后再试');
      return;
    }

    setPublishSubmitting(true);
    try {
      const publishRes = await publishTechniqueResearchDraft(characterId, generationId, finalName);
      if (!publishRes?.success || !publishRes.data) {
        throw new Error(resolveCopyResearchBookErrorMessage(publishRes?.code, publishRes?.message));
      }

      message.success(`抄写成功，已发放《${publishRes.data.finalName}》功法书`);
      await Promise.all([refreshResearchStatus('background'), refreshStatus()]);
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '抄写失败');
    } finally {
      setPublishSubmitting(false);
    }
  }, [
    characterId,
    message,
    publishSubmitting,
    refreshResearchStatus,
    refreshStatus,
  ]);

  const layerText = (layer: number) => `${layer}层`;

  const openDetail = useCallback(
    async (id: string) => {
      setActiveTechId(id);
      const learnedTech = learned.find((x) => x.id === id) ?? null;
      if (learnedTech) {
        setDetailTechnique(learnedTech);
        setDetailOpen(true);
        return;
      }

      const cached = techniqueDetailCacheRef.current.get(id);
      if (cached) {
        setDetailTechnique(buildTechniqueView(null, cached.technique, cached.layers, cached.skills));
        setDetailOpen(true);
        return;
      }

      try {
        const detailRes = await getTechniqueDetail(id);
        if (!detailRes?.success || !detailRes.data) throw new Error(detailRes?.message || '获取功法详情失败');
        techniqueDetailCacheRef.current.set(id, detailRes.data);
        setDetailTechnique(buildTechniqueView(null, detailRes.data.technique, detailRes.data.layers, detailRes.data.skills));
        setDetailOpen(true);
      } catch {
        void 0;
      }
    },
    [learned, message],
  );

  const openCultivate = useCallback(
    async (id: string) => {
      setActiveTechId(id);
      setUpgradeCost(null);
      setCultivateOpen(true);
      if (!characterId) return;
      try {
        const costRes = await getCharacterTechniqueUpgradeCost(characterId, id);
        if (!costRes?.success || !costRes.data) return;
        setUpgradeCost(costRes.data);
      } catch {
        setUpgradeCost(null);
      }
    },
    [characterId],
  );

  const equippedTech = useMemo(() => {
    const map = new Map(learned.map((t) => [t.id, t]));
    return {
      main: equipped.main ? map.get(equipped.main) ?? null : null,
      sub1: equipped.sub1 ? map.get(equipped.sub1) ?? null : null,
      sub2: equipped.sub2 ? map.get(equipped.sub2) ?? null : null,
      sub3: equipped.sub3 ? map.get(equipped.sub3) ?? null : null,
    };
  }, [equipped, learned]);

  const equipToActiveSlot = async (techId: string) => {
    if (!characterId) return;
    const slotType = activeSlot === 'main' ? 'main' : 'sub';
    const slotIndex = activeSlot === 'sub1' ? 1 : activeSlot === 'sub2' ? 2 : activeSlot === 'sub3' ? 3 : undefined;
    try {
      const res = await equipCharacterTechnique(characterId, techId, slotType, slotIndex);
      if (!res?.success) throw new Error(res?.message || '运功失败');
      message.success(res.message || '运功成功');
      await refreshStatus();
    } catch (error: unknown) {
      void 0;
    }
  };

  const removeFromSlot = async (slot: SlotKey) => {
    if (!characterId) return;
    const techId = equipped[slot];
    if (!techId) return;
    try {
      const res = await unequipCharacterTechnique(characterId, techId);
      if (!res?.success) throw new Error(res?.message || '卸下失败');
      message.success(res.message || '卸下成功');
      await refreshStatus();
    } catch (error: unknown) {
      void 0;
    }
  };

  const equipSkillToSlot = async (skillId: string) => {
    if (!characterId) return;
    const s = availableSkills.find((x) => x.id === skillId);
    if (!s) return;
    const idx0 = Number.isFinite(activeSkillSlot) ? activeSkillSlot : 0;
    const slotIndex = idx0 + 1;
    try {
      const res = await equipCharacterSkill(characterId, s.id, slotIndex);
      if (!res?.success) throw new Error(res?.message || '装备技能失败');
      message.success(res.message || '装备成功');
      await refreshStatus();
    } catch (error: unknown) {
      void 0;
    }
  };

  const clearSkillSlot = async (idx: number) => {
    if (!characterId) return;
    const slotIndex = idx + 1;
    try {
      const res = await unequipCharacterSkill(characterId, slotIndex);
      if (!res?.success) throw new Error(res?.message || '卸下技能失败');
      message.success(res.message || '已清空');
      await refreshStatus();
    } catch (error: unknown) {
      void 0;
    }
  };

  const equippedSlotByTechId = useMemo(() => {
    const m = new Map<string, SlotKey>();
    (Object.keys(equipped) as SlotKey[]).forEach((k) => {
      const id = equipped[k];
      if (id) m.set(id, k);
    });
    return m;
  }, [equipped]);

  const leftItems: Array<{ key: TechniquePanel; label: string }> = [
    { key: 'slots', label: '功法栏' },
    { key: 'learned', label: '已学功法' },
    { key: 'bonus', label: '功法加成' },
    { key: 'skills', label: isMobile ? '技能' : '技能配置' },
  ];
  if (TECHNIQUE_RESEARCH_ENABLED) {
    leftItems.push({ key: 'research', label: '洞府研修' });
  }

  const renderSlotCard = (k: SlotKey) => {
    const t = equippedTech[k];
    const content = (
      <div
        key={k}
        className={`tech-slot ${k === activeSlot ? 'is-active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setActiveSlot(k)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setActiveSlot(k);
        }}
      >
        <div className="tech-slot-label">{slotLabels[k]}</div>
        <div className="tech-slot-card">
          <div className="tech-slot-meta">
            <div className="tech-slot-name">
              {t ? `${t.name}（${layerText(t.layer)}/${layerText(t.layers.length)}）` : '未装备'}
            </div>
            <div className="tech-slot-tags">
              {t ? <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag> : <Tag>未装配</Tag>}
              {(t?.tags ?? []).slice(0, 2).map((x) => (
                <Tag key={x} color="default">
                  {x}
                </Tag>
              ))}
            </div>
          </div>
          <Button
            size="small"
            className={`tech-slot-remove ${t ? '' : 'is-placeholder'}`}
            onClick={(e) => {
              e.stopPropagation();
              removeFromSlot(k);
            }}
          >
            卸下
          </Button>
        </div>
        <div className="tech-slot-hint">{t ? '点击下方功法可替换' : '点击下方功法运功装备到此栏位'}</div>
      </div>
    );

    if (isMobile || !t) return content;

    return (
      <Tooltip key={k} title={renderTechniqueTooltip(t)} placement="right" classNames={TECHNIQUE_TOOLTIP_CLASS_NAMES}>
        {content}
      </Tooltip>
    );
  };

  const renderSlotLearnedList = () => (
    <div className="tech-learned-list">
      {learned.map((t) => {
        const equippedSlot = equippedSlotByTechId.get(t.id) ?? null;
        const content = (
          <div className="tech-row">
            <div className="tech-row-main">
              <div className="tech-row-name">{t.name}</div>
              <div className="tech-row-tags">
                <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                <Tag color="default">
                  {layerText(t.layer)}/{layerText(t.layers.length)}
                </Tag>
                {equippedSlot ? <Tag color="blue">{slotLabels[equippedSlot]}</Tag> : null}
                {t.tags.map((x) => (
                  <Tag key={x} color="default">
                    {x}
                  </Tag>
                ))}
              </div>
              <div className="tech-row-desc">{t.desc || '暂无描述'}</div>
              {renderTechniqueInlineDetails(t)}
            </div>
            {equippedSlot ? (
              <Button size="small" danger onClick={() => removeFromSlot(equippedSlot)}>
                取消运功
              </Button>
            ) : (
              <Button size="small" type="primary" onClick={() => equipToActiveSlot(t.id)}>
                运功
              </Button>
            )}
          </div>
        );

        if (isMobile) return <div key={t.id}>{content}</div>;

        return (
          <Tooltip key={t.id} title={renderTechniqueTooltip(t)} placement="right" classNames={TECHNIQUE_TOOLTIP_CLASS_NAMES}>
            {content}
          </Tooltip>
        );
      })}
    </div>
  );

  const renderSlotsPanel = () => {
    const slotKeys = Object.keys(slotLabels) as SlotKey[];

    if (isMobile) {
      return (
        <div className="tech-pane">
          <div className="tech-pane-scroll tech-pane-mobile-scroll">
            <div className="tech-mobile-slot-tabs">
              {slotKeys.map((k) => (
                <Button
                  key={k}
                  size="small"
                  type={k === activeSlot ? 'primary' : 'default'}
                  className="tech-mobile-slot-tab"
                  onClick={() => setActiveSlot(k)}
                >
                  {slotLabels[k]}
                </Button>
              ))}
            </div>

            <div className="tech-slots tech-slots-focus">
              {renderSlotCard(activeSlot)}
            </div>

            <div className="tech-subtitle">已学功法（当前栏位：{slotLabels[activeSlot]}）</div>
            {renderSlotLearnedList()}
          </div>
        </div>
      );
    }

    return (
      <div className="tech-pane">
        <div className="tech-pane-top">
          <div className="tech-slots">{slotKeys.map((k) => renderSlotCard(k))}</div>
        </div>

        <div className="tech-pane-bottom">
          <div className="tech-subtitle">已学功法（当前栏位：{slotLabels[activeSlot]}）</div>
          {renderSlotLearnedList()}
        </div>
      </div>
    );
  };

  const renderLearnedPanel = () => (
    <div className="tech-pane">
      <div className="tech-pane-scroll">
        <div className="tech-subtitle">已学功法</div>
        <div className="tech-learned-list">
          {learned.map((t) => {
            const content = (
              <div className="tech-row">
                <div className="tech-row-main">
                  <div className="tech-row-name">{t.name}</div>
                  <div className="tech-row-tags">
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                    <Tag color="default">
                      {layerText(t.layer)}/{layerText(t.layers.length)}
                    </Tag>
                    {t.tags.map((x) => (
                      <Tag key={x} color="default">
                        {x}
                      </Tag>
                    ))}
                  </div>
                  <div className="tech-row-desc">{t.desc || '暂无描述'}</div>
                  {renderTechniqueInlineDetails(t)}
                </div>
                <div className="tech-row-actions">
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => openDetail(t.id)}
                  >
                    详情
                  </Button>
                  <Button size="small" onClick={() => openCultivate(t.id)}>
                    修炼
                  </Button>
                </div>
              </div>
            );

            if (isMobile) return <div key={t.id}>{content}</div>;

            return (
              <Tooltip key={t.id} title={renderTechniqueTooltip(t)} placement="right" classNames={TECHNIQUE_TOOLTIP_CLASS_NAMES}>
                {content}
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderBonusPanel = () => {
    const rows = learned.map((t) => {
      let role: string = '未装配';
      if (equipped.main === t.id) role = '主功法';
      if (equipped.sub1 === t.id || equipped.sub2 === t.id || equipped.sub3 === t.id) role = '副功法';
      return {
        id: t.id,
        name: t.name,
        quality: t.quality,
        role,
        bonuses: t.layers
          .slice(0, Math.max(0, Math.min(t.layer, t.layers.length)))
          .flatMap((lv) => lv.bonuses),
      };
    });

    return (
      <div className="tech-pane">
        <div className="tech-pane-scroll">
          <div className="tech-subtitle">功法加成（主功法 100%，副功法 30%）</div>
          <Table
            size="small"
            rowKey={(row) => row.id}
            pagination={false}
            className="tech-table"
            columns={[
              {
                title: '功法',
                dataIndex: 'name',
                key: 'name',
                render: (_: string, row: (typeof rows)[number]) => (
                  <div className="tech-table-name">
                    <span className="tech-table-name-text">{row.name}</span>
                    <Tag color={qualityColor[row.quality]}>{qualityText[row.quality]}</Tag>
                  </div>
                ),
              },
              {
                title: '装配',
                dataIndex: 'role',
                key: 'role',
                width: 90,
                render: (value: string) => <span className="tech-table-role">{value}</span>,
              },
              {
                title: '属性',
                dataIndex: 'bonuses',
                key: 'bonuses',
                render: (list: TechniqueBonus[]) => (
                  <div className="tech-bonus-lines">
                    {list.length ? (
                      list.map((b) => (
                        <div key={`${b.label}-${b.value}`} className="tech-bonus-line">
                          <span className="tech-bonus-k">{b.label}</span>
                          <span className="tech-bonus-v">{b.value}</span>
                        </div>
                      ))
                    ) : (
                      <div className="tech-empty">无</div>
                    )}
                  </div>
                ),
              },
            ]}
            dataSource={rows}
          />
        </div>
      </div>
    );
  };

  const renderSkillsPanel = () => {
    const activeSlotSkill = skillSlots[activeSkillSlot] ?? null;

    if (isMobile) {
      return (
        <div className="tech-pane">
          <div className="tech-pane-scroll tech-pane-mobile-scroll">
            <div className="tech-subtitle">技能栏（当前：{activeSkillSlot + 1}号位）</div>
            <div className="skill-slots-mobile-tabs">
              {skillSlots.map((slot, idx) => (
                <Button
                  key={`slot-tab-${idx}`}
                  size="small"
                  type={idx === activeSkillSlot ? 'primary' : 'default'}
                  className="skill-slot-mobile-tab"
                  onClick={() => setActiveSkillSlot(idx)}
                >
                  {idx + 1}
                  {slot ? '●' : ''}
                </Button>
              ))}
            </div>

            <div className="skill-slot-mobile-active">
              <div className="skill-slot-mobile-active-main">
                <div className="skill-slot-mobile-active-title">{activeSlotSkill ? activeSlotSkill.name : '当前栏位未装配'}</div>
                <div className="skill-slot-mobile-active-sub">点击下方技能可装备到当前栏位</div>
              </div>
              <Button
                size="small"
                className={`skill-slot-mobile-clear ${activeSlotSkill ? '' : 'is-placeholder'}`}
                onClick={() => clearSkillSlot(activeSkillSlot)}
              >
                清空
              </Button>
            </div>

            <div className="tech-subtitle">技能库（点击装备）</div>
            <div className="skill-list-mobile">
              {availableSkills.map((s) => (
                <div key={s.id} className="skill-item-mobile">
                  <img className="skill-item-mobile-icon" src={s.icon} alt={s.name} />
                  <div className="skill-item-mobile-main">
                    <div className="skill-item-mobile-name">{s.name}</div>
                    <div className="skill-item-mobile-summary">{renderSkillInlineDetails(s)}</div>
                  </div>
                  <Button
                    size="small"
                    type="primary"
                    className="skill-item-mobile-action"
                    onClick={() => equipSkillToSlot(s.id)}
                  >
                    装备
                  </Button>
                </div>
              ))}
              {availableSkills.length === 0 ? <div className="tech-empty">暂无技能</div> : null}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="tech-pane">
        <div className="tech-pane-top">
          <div className="tech-subtitle">技能栏</div>
          <div className="skill-slots">
            {skillSlots.map((s, idx) => (
              <div
                key={`slot-${idx}`}
                className={`skill-slot ${idx === activeSkillSlot ? 'is-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setActiveSkillSlot(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveSkillSlot(idx);
                }}
              >
                <div className="skill-slot-index">{idx + 1}</div>
                {s ? <img className="skill-slot-icon" src={s.icon} alt={s.name} /> : <div className="skill-slot-empty" />}
                <Button
                  size="small"
                  className={`skill-slot-clear ${s ? '' : 'is-placeholder'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    clearSkillSlot(idx);
                  }}
                >
                  清空
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="tech-pane-bottom">
          <div className="tech-subtitle">技能库（点击按顺序装备）</div>
          <div className="skill-list">
            {availableSkills.map((s) => (
              <div key={s.id} className="skill-item">
                <div className="skill-item-header">
                  <img className="skill-item-icon" src={s.icon} alt={s.name} />
                  <div className="skill-item-name">{s.name}</div>
                </div>
                <div className="skill-item-summary">{renderSkillInlineDetails(s)}</div>
                <Button
                  size="small"
                  type="primary"
                  className="skill-item-action"
                  onClick={() => equipSkillToSlot(s.id)}
                >
                  装备
                </Button>
              </div>
            ))}
            {availableSkills.length === 0 ? <div className="tech-empty">暂无技能</div> : null}
          </div>
        </div>
      </div>
    );
  };

  const renderResearchPanel = () => {
    return (
      <ResearchPanel
        status={researchStatus}
        loading={researchLoading}
        refreshing={researchRefreshing}
        exchangeSubmitting={exchangeSubmitting}
        generateSubmitting={generateSubmitting}
        publishSubmitting={publishSubmitting}
        onExchangeBooks={() => void handleExchangeBooks()}
        onGenerateDraft={() => void handleGenerateResearchDraft()}
        onRefresh={() => void refreshResearchStatus('manual')}
        onCopyResearchBook={(generationId, suggestedName) => void handleCopyResearchBook(generationId, suggestedName)}
      />
    );
  };


  const panelContent = () => {
    if (loading) {
      return (
        <div className="tech-pane">
          <div className="tech-empty">加载中...</div>
        </div>
      );
    }
    if (panel === 'slots') return renderSlotsPanel();
    if (panel === 'learned') return renderLearnedPanel();
    if (panel === 'bonus') return renderBonusPanel();
    if (panel === 'research' && TECHNIQUE_RESEARCH_ENABLED) return renderResearchPanel();
    return renderSkillsPanel();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width="min(1080px, calc(100vw - 16px))"
      className="tech-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setPanel('slots');
        setActiveSlot('main');
        setDetailOpen(false);
        setCultivateOpen(false);
        setActiveTechId('');
        setDetailTechnique(null);
        setUpgradeCost(null);
      }}
    >
      <div className="tech-modal-shell">
        <div className="tech-modal-left">
          <div className="tech-left-title">
            <img className="tech-left-icon" src={coin01} alt="功法" />
            <div className="tech-left-name">功法</div>
          </div>
          <div className="tech-left-list">
            {leftItems.map((it) => (
              <Button
                key={it.key}
                type={panel === it.key ? 'primary' : 'default'}
                className="tech-left-item"
                onClick={() => setPanel(it.key)}
              >
                {it.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="tech-modal-right">{panelContent()}</div>
      </div>

      <Modal
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        title="功法详情"
        centered
        width="min(720px, calc(100vw - 16px))"
        className="tech-submodal"
        destroyOnHidden
      >
        {(() => {
          const t = detailTechnique ?? null;
          if (!t) return <div className="tech-empty">未找到功法</div>;
          const layerRows = t.layers.map((lv) => ({
            layer: lv.layer,
            unlocked: lv.layer <= t.layer,
            bonuses: lv.bonuses,
            skills: lv.skills,
          }));
          return (
            <div className="tech-detail">
              <div className="tech-detail-header">
                <img className="tech-detail-icon" src={t.icon} alt={t.name} />
                <div className="tech-detail-meta">
                  <div className="tech-detail-name">
                    <span>{t.name}</span>
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                    <Tag color="default">
                      {layerText(t.layer)}/{layerText(t.layers.length)}
                    </Tag>
                  </div>
                  <div className="tech-detail-tags">
                    {t.tags.map((x) => (
                      <Tag key={x} color="default">
                        {x}
                      </Tag>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tech-detail-desc">{t.desc}</div>
              <div className="tech-detail-section-title">层数加成与技能</div>
              {isMobile ? (
                <div className="tech-layer-mobile-list">
                  {layerRows.map((row) => (
                    <div key={`layer-${row.layer}`} className={`tech-layer-mobile-item ${row.unlocked ? 'is-unlocked' : ''}`}>
                      <div className="tech-layer-mobile-head">
                        <div className="tech-layer-mobile-title">第{row.layer}层</div>
                        <Tag color={row.unlocked ? 'green' : 'default'}>{row.unlocked ? '已解锁' : '未解锁'}</Tag>
                      </div>

                      <div className="tech-layer-mobile-section">
                        <div className="tech-layer-mobile-label">加成</div>
                        {row.bonuses.length ? (
                          <div className="tech-layer-cell">
                            {row.bonuses.map((b) => (
                              <div key={`${row.layer}-${b.label}-${b.value}`} className="tech-layer-cell-line">
                                <span className="tech-layer-cell-k">{b.label}</span>
                                <span className="tech-layer-cell-v">{b.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="tech-layer-cell-empty">无</span>
                        )}
                      </div>

                      <div className="tech-layer-mobile-section">
                        <div className="tech-layer-mobile-label">技能</div>
                        {row.skills.length ? (
                          <div className="tech-layer-mobile-skills">
                            {row.skills.map((s) => (
                              <div key={`${row.layer}-${s.id}`} className="tech-layer-mobile-skill">
                                <div className="tech-layer-mobile-skill-top">
                                  <img className="tech-layer-mobile-skill-icon" src={s.icon} alt={s.name} />
                                  <span className="tech-layer-mobile-skill-name">{s.name}</span>
                                </div>
                                <div className="tech-layer-mobile-skill-desc">{getSkillInlineSummary(s)}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="tech-layer-cell-empty">无</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Table
                  size="small"
                  rowKey={(row) => String(row.layer)}
                  pagination={false}
                  className="tech-layer-table"
                  columns={[
                    {
                      title: '层数',
                      dataIndex: 'layer',
                      key: 'layer',
                      width: 70,
                      render: (v: number) => `第${v}层`,
                    },
                    {
                      title: '状态',
                      dataIndex: 'unlocked',
                      key: 'unlocked',
                      width: 86,
                      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '已解锁' : '未解锁'}</Tag>,
                    },
                    {
                      title: '加成',
                      dataIndex: 'bonuses',
                      key: 'bonuses',
                      render: (list: TechniqueBonus[]) => (
                        <div className="tech-layer-cell">
                          {list.length ? (
                            list.map((b) => (
                              <div key={`${b.label}-${b.value}`} className="tech-layer-cell-line">
                                <span className="tech-layer-cell-k">{b.label}</span>
                                <span className="tech-layer-cell-v">{b.value}</span>
                              </div>
                            ))
                          ) : (
                            <span className="tech-layer-cell-empty">无</span>
                          )}
                        </div>
                      ),
                    },
                    {
                      title: '解锁技能',
                      dataIndex: 'skills',
                      key: 'skills',
                      render: (list: TechniqueSkill[]) => (
                        <div className="tech-layer-skill-cell">
                          {list.length ? (
                            list.map((s) => (
                              <Tooltip key={s.id} title={renderSkillTooltip(s)} placement="top" classNames={SKILL_TOOLTIP_CLASS_NAMES}>
                                <div className="tech-layer-skill-pill">
                                  <img className="tech-layer-skill-pill-icon" src={s.icon} alt={s.name} />
                                  <span className="tech-layer-skill-pill-name">{s.name}</span>
                                </div>
                              </Tooltip>
                            ))
                          ) : (
                            <span className="tech-layer-cell-empty">无</span>
                          )}
                        </div>
                      ),
                    },
                  ]}
                  dataSource={layerRows}
                />
              )}
            </div>
          );
        })()}
      </Modal>

      <Modal
        open={cultivateOpen}
        onCancel={() => setCultivateOpen(false)}
        title="功法修炼"
        centered
        width="min(640px, calc(100vw - 16px))"
        className="tech-submodal"
        destroyOnHidden
        okText="确认修炼"
        cancelText="取消"
        onOk={async () => {
          const id = activeTechId;
          if (!id) return;
          if (!characterId) return;
          if (cultivateSubmitting) return;
          setCultivateSubmitting(true);
          try {
            const res = await upgradeCharacterTechnique(characterId, id);
            if (!res?.success) throw new Error(res?.message || '修炼失败');
            message.success(res.message || '修炼成功');
            await refreshStatus();
            const costRes = await getCharacterTechniqueUpgradeCost(characterId, id);
            if (costRes?.success && costRes.data) setUpgradeCost(costRes.data);
          } catch (error: unknown) {
            void 0;
          } finally {
            setCultivateSubmitting(false);
          }
        }}
        okButtonProps={{
          loading: cultivateSubmitting,
          disabled: (() => {
            const t = learned.find((x) => x.id === activeTechId);
            if (!t) return true;
            return t.layer >= t.layers.length;
          })(),
        }}
      >
        {(() => {
          const t = learned.find((x) => x.id === activeTechId) ?? null;
          if (!t) return <div className="tech-empty">未找到功法</div>;
          const nextLayer = Math.min(t.layer + 1, t.layers.length);
          const next = t.layers.find((lv) => lv.layer === nextLayer) ?? null;
          const maxed = t.layer >= t.layers.length;
          const unlockBonuses = next?.bonuses ?? [];
          const unlockSkills = next?.skills ?? [];
          const cost: TechniqueCostItem[] = [];
          const costData = upgradeCost;
          if (costData) {
            if (costData.spirit_stones > 0) cost.push({ id: 'spirit_stones', name: '灵石', icon: lingshiIcon, amount: costData.spirit_stones });
            if (costData.exp > 0) cost.push({ id: 'exp', name: '经验', icon: tongqianIcon, amount: costData.exp });
            (costData.materials || []).forEach((m) => {
              cost.push({ id: m.itemId, name: m.itemName ?? m.itemId, icon: resolveIcon(m.itemIcon ?? null), amount: m.qty });
            });
          } else {
            (next?.cost ?? []).forEach((c) => cost.push(c));
          }
          return (
            <div className="tech-cultivate">
              <div className="tech-cultivate-header">
                <img className="tech-cultivate-icon" src={t.icon} alt={t.name} />
                <div className="tech-cultivate-meta">
                  <div className="tech-cultivate-name">
                    <span>{t.name}</span>
                    <Tag color={qualityColor[t.quality]}>{qualityText[t.quality]}</Tag>
                  </div>
                  <div className="tech-cultivate-layer">
                    当前：{layerText(t.layer)}/{layerText(t.layers.length)} {maxed ? '（已满）' : ''}
                  </div>
                </div>
              </div>

              {!maxed ? (
                <>
                  <div className="tech-detail-section-title">升级消耗</div>
                  <div className="tech-cost-list">
                    {cost.map((c) => (
                      <div key={`${t.id}-cost-${c.id}`} className="tech-cost-item">
                        <img className="tech-cost-icon" src={c.icon} alt={c.name} />
                        <div className="tech-cost-name">{c.name}</div>
                        <div className="tech-cost-amount">×{c.amount.toLocaleString()}</div>
                      </div>
                    ))}
                    {cost.length === 0 ? <div className="tech-empty">无</div> : null}
                  </div>
                  <div className="tech-detail-section-title">本次解锁</div>
                  <div className="tech-cultivate-unlock">
                    <div className="tech-cultivate-unlock-title">加成（第 {nextLayer} 层）</div>
                    <div className="tech-layer-bonuses">
                      {unlockBonuses.map((b) => (
                        <div key={`${t.id}-unlock-${nextLayer}-${b.label}-${b.value}`} className="tech-layer-bonus">
                          <div className="tech-layer-bonus-k">{b.label}</div>
                          <div className="tech-layer-bonus-v">{b.value}</div>
                        </div>
                      ))}
                      {unlockBonuses.length === 0 ? <div className="tech-empty">无</div> : null}
                    </div>
                    <div className="tech-cultivate-unlock-title">技能（第 {nextLayer} 层）</div>
                    <div className="tech-layer-skills">
                      {unlockSkills.map((s) => (
                        <Tooltip key={`${t.id}-unlock-s-${s.id}`} title={renderSkillTooltip(s)} placement="top" classNames={SKILL_TOOLTIP_CLASS_NAMES}>
                          <div className="tech-layer-skill">
                            <img className="tech-layer-skill-icon" src={s.icon} alt={s.name} />
                            <div className="tech-layer-skill-name">{s.name}</div>
                          </div>
                        </Tooltip>
                      ))}
                      {unlockSkills.length === 0 ? <div className="tech-empty">无</div> : null}
                    </div>
                  </div>
                </>
              ) : (
                <div className="tech-empty">已修炼至满层，无可提升内容</div>
              )}
            </div>
          );
        })()}
      </Modal>
    </Modal>
  );
};

export default TechniqueModal;
