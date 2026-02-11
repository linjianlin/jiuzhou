import { App, Button, Drawer, Modal, Segmented, Spin, Tabs, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import { SERVER_BASE, getInventoryInfo, getInventoryItems, moveInventoryItem, type InventoryItemDto, type ItemDefLite } from '../../../../services/api';
import './index.scss';

type SlotSide = 'bag' | 'warehouse';

type DragPayload = {
  side: SlotSide;
  index: number;
};

type MobilePreview = {
  side: SlotSide;
  index: number;
};

const SUB_WAREHOUSE_COUNT = 5;

const ITEM_ICON_GLOB = import.meta.glob('../../../../assets/images/**/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const ITEM_ICON_BY_FILENAME: Record<string, string> = Object.fromEntries(
  Object.entries(ITEM_ICON_GLOB).map(([p, url]) => {
    const parts = p.split(/[/\\]/);
    return [parts[parts.length - 1] ?? p, url];
  }),
);

const resolveIcon = (def?: ItemDefLite | null): string => {
  const raw = (def?.icon ?? '').trim();
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

const safeParseDragPayload = (value: unknown): DragPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const side = (value as { side?: unknown }).side;
  const index = (value as { index?: unknown }).index;
  if (side !== 'bag' && side !== 'warehouse') return null;
  const n = typeof index === 'number' ? index : typeof index === 'string' ? Number(index) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return { side, index: Math.floor(n) };
};

const buildSlots = (capacity: number, items: InventoryItemDto[]): Array<InventoryItemDto | null> => {
  const cap = Math.max(0, Math.floor(capacity || 0));
  const slots: Array<InventoryItemDto | null> = Array.from({ length: cap }, () => null);
  for (const it of items) {
    const rawSlot = it.location_slot;
    const slot = rawSlot === null ? NaN : Number(rawSlot);
    if (Number.isInteger(slot) && slot >= 0 && slot < slots.length && !slots[slot]) {
      slots[slot] = it;
      continue;
    }
    const empty = findFirstEmpty(slots);
    if (empty < 0) break;
    slots[empty] = it;
  }
  return slots;
};

const findFirstEmpty = (slots: Array<InventoryItemDto | null>): number => {
  for (let i = 0; i < slots.length; i += 1) {
    if (!slots[i]) return i;
  }
  return -1;
};

const findFirstEmptyInRange = (
  slots: Array<InventoryItemDto | null>,
  start: number,
  endExclusive: number,
): number => {
  const s = Math.max(0, Math.floor(start || 0));
  const e = Math.max(s, Math.floor(endExclusive || 0));
  const end = Math.min(slots.length, e);
  for (let i = Math.min(slots.length, s); i < end; i += 1) {
    if (!slots[i]) return i;
  }
  return -1;
};

const clampSubIndex = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  if (n < 0) return 0;
  if (n >= SUB_WAREHOUSE_COUNT) return SUB_WAREHOUSE_COUNT - 1;
  return n;
};

const hasLatin = (value: string): boolean => /[A-Za-z]/.test(value);

const formatScalar = (value: unknown): string => {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return '';
    if (hasLatin(s)) return '';
    return s;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
};

const normalizeText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const translateKey = (key: string): string | null => {
  const k = key.trim();
  const m: Record<string, string> = {
    type: '类型',
    value: '数值',
    amount: '数量',
    qty: '数量',
    chance: '概率',
    duration: '持续时间',
    cooldown: '冷却',
    seconds: '秒数',
    percent: '百分比',
    desc: '描述',
    description: '描述',
    name: '名称',

    max_qixue: '气血上限',
    max_lingqi: '灵气上限',
    qixue: '气血',
    lingqi: '灵气',

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

    attack: '攻击',
    defense: '防御',
    speed: '速度',
    crit: '暴击',
    crit_rate: '暴击率',
    crit_damage: '暴击伤害',
    dodge: '闪避',
    hit: '命中',
    hp: '气血',
    mp: '灵气',
  };
  if (m[k]) return m[k];
  return null;
};

const EQUIP_ATTR_KEYS = new Set<string>([
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
]);

const PERMYRIAD_PERCENT_KEYS = new Set<string>([
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

const formatLines = (value: unknown, depth: number = 0): string[] => {
  if (value === null || value === undefined) return [];
  if (depth >= 3) {
    const inline = formatScalar(value);
    return [inline || '（内容较复杂）'];
  }
  const inline = formatScalar(value);
  if (inline) return [inline];

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const out: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      const itemInline = formatScalar(item);
      if (itemInline) {
        out.push(`${i + 1}. ${itemInline}`);
        continue;
      }
      const nested = formatLines(item, depth + 1);
      if (nested.length === 0) continue;
      out.push(`${i + 1}.`);
      out.push(...nested.map((x) => `  ${x}`));
    }
    return out;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return [];
    const out: string[] = [];
    for (const [k, v] of entries) {
      const kk = translateKey(k) ?? '';
      if (!kk) continue;
      if (EQUIP_ATTR_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
        const text = PERMYRIAD_PERCENT_KEYS.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v);
        out.push(`${kk}：${text}`);
        continue;
      }
      const vInline = formatScalar(v);
      if (vInline) {
        out.push(`${kk}：${vInline}`);
        continue;
      }
      const nested = formatLines(v, depth + 1);
      if (nested.length === 0) continue;
      out.push(`${kk}：`);
      out.push(...nested.map((x) => `  ${x}`));
    }
    return out;
  }

  return [];
};

const limitLines = (lines: string[], maxLines: number): string[] => {
  const max = Math.max(0, Math.floor(maxLines || 0));
  if (max <= 0) return [];
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), '…'];
};

const translateQuality = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    huang: '黄',
    xuan: '玄',
    di: '地',
    tian: '天',
    common: '凡',
    uncommon: '良',
    rare: '稀有',
    epic: '史诗',
    legendary: '传说',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const translateCategory = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    consumable: '消耗品',
    material: '材料',
    equipment: '装备',
    skill: '技能',
    quest: '任务',
    misc: '杂物',
    currency: '货币',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const translateUseType = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    use: '可使用',
    open: '可开启',
    equip: '可装备',
    consume: '消耗',
    none: '无',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const translateEquipSlot = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    weapon: '武器',
    helmet: '头盔',
    head: '头部',
    armor: '衣服',
    chest: '上衣',
    pants: '裤子',
    boots: '鞋子',
    gloves: '护手',
    belt: '腰带',
    ring: '戒指',
    amulet: '项链',
    necklace: '项链',
    bracelet: '手镯',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const WarehouseItemTooltip: React.FC<{ it: InventoryItemDto }> = ({ it }) => {
  const def = it.def ?? null;
  const icon = resolveIcon(def);
  const title = def?.name || '未知物品';
  const desc = normalizeText(def?.description);
  const longDesc = normalizeText(def?.long_desc);

  const qty = useMemo(() => Math.max(0, Number(it.qty || 0)), [it.qty]);
  const descText = useMemo(() => longDesc || desc, [desc, longDesc]);
  const isEquip = useMemo(() => {
    const raw = String(def?.category ?? '').trim();
    return raw === 'equipment' || raw === '装备';
  }, [def?.category]);

  const infoTags = useMemo(() => {
    const tags: string[] = [];
    const quality = translateQuality(def?.quality);
    const category = translateCategory(def?.category);
    const subCategory = translateCategory(def?.sub_category);
    const equipSlot = translateEquipSlot(def?.equip_slot);
    const useType = translateUseType(def?.use_type);
    const stackMax = def?.stack_max;

    if (quality) tags.push(quality);
    if (category) tags.push(subCategory ? `${category}/${subCategory}` : category);
    if (equipSlot) tags.push(`部位：${equipSlot}`);
    if (useType) tags.push(`类型：${useType}`);
    if (typeof stackMax === 'number' && Number.isFinite(stackMax) && stackMax > 1) tags.push(`堆叠：${stackMax}`);
    return tags;
  }, [def?.category, def?.equip_slot, def?.quality, def?.stack_max, def?.sub_category, def?.use_type]);

  const baseAttrLines = useMemo(() => limitLines(formatLines(def?.base_attrs), 10), [def?.base_attrs]);
  const effectLines = useMemo(() => limitLines(formatLines(def?.effect_defs), 10), [def?.effect_defs]);
  const equipMetaLines = useMemo(() => {
    if (!isEquip) return [];
    const s = Math.max(0, Math.floor(Number(it.strengthen_level) || 0));
    const r = Math.max(0, Math.floor(Number(it.refine_level) || 0));
    return [`强化：${s > 0 ? `+${s}` : s}`, `精炼：${r > 0 ? `+${r}` : r}`];
  }, [isEquip, it.refine_level, it.strengthen_level]);

  const affixes = useMemo(() => coerceAffixes(it.affixes), [it.affixes]);
  const affixLines = useMemo(() => {
    if (!isEquip) return [];
    if (!it.identified) return ['未鉴定'];
    const sorted = [...affixes].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
    const pickLabel = (a: EquipmentAffix): string => {
      const key = (a.attr_key ?? '').trim();
      const byKey = key ? translateKey(key) : null;
      if (byKey) return byKey;
      const byName = (a.name ?? '').trim();
      if (byName && !hasLatin(byName)) return byName;
      if (key && !hasLatin(key)) return key;
      return '';
    };

    const out: string[] = [];
    for (const a of sorted) {
      const label = pickLabel(a);
      if (!label) continue;
      const tierText = a.tier ? `T${a.tier}` : 'T-';
      const prefix = a.is_legendary ? '传奇词条' : '词条';
      const key = (a.attr_key ?? '').trim();
      const isPercent = a.apply_type === 'percent' || (key ? PERMYRIAD_PERCENT_KEYS.has(key) : false);
      const valueText = typeof a.value === 'number' ? (isPercent ? formatSignedPermyriadPercent(a.value) : formatSignedNumber(a.value)) : '';
      const descText2 = (a.description ?? '').trim();
      const extraDesc = descText2 && !hasLatin(descText2) ? `（${descText2}）` : '';
      out.push(`${prefix} ${tierText}：${label}${valueText ? ` ${valueText}` : ''}${extraDesc}`);
    }
    return out.length > 0 ? limitLines(out, 10) : ['无'];
  }, [affixes, isEquip, it.identified]);

  return (
    <div className="warehouse-tooltip">
      <div className="warehouse-tooltip-head">
        <img className="warehouse-tooltip-icon" src={icon} alt={title} />
        <div className="warehouse-tooltip-title">{title}</div>
        {qty > 1 ? <div className="warehouse-tooltip-count">x{qty}</div> : null}
      </div>

      {infoTags.length > 0 ? (
        <div className="warehouse-tooltip-tags">
          {infoTags.map((t) => (
            <span key={t} className="warehouse-tooltip-tag">
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {descText ? <div className="warehouse-tooltip-desc">{descText}</div> : null}

      {equipMetaLines.length > 0 ? (
        <div className="warehouse-tooltip-section">
          <div className="warehouse-tooltip-section-title">装备信息</div>
          <div className="warehouse-tooltip-lines">
            {equipMetaLines.map((x) => (
              <div key={x} className="warehouse-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {affixLines.length > 0 ? (
        <div className="warehouse-tooltip-section">
          <div className="warehouse-tooltip-section-title">词条</div>
          <div className="warehouse-tooltip-lines">
            {affixLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="warehouse-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {effectLines.length > 0 ? (
        <div className="warehouse-tooltip-section">
          <div className="warehouse-tooltip-section-title">效果</div>
          <div className="warehouse-tooltip-lines">
            {effectLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="warehouse-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {baseAttrLines.length > 0 ? (
        <div className="warehouse-tooltip-section">
          <div className="warehouse-tooltip-section-title">基础属性</div>
          <div className="warehouse-tooltip-lines">
            {baseAttrLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="warehouse-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};


interface WarehouseModalProps {
  open: boolean;
  onClose: () => void;
}

const WarehouseModal: React.FC<WarehouseModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 768;
  });
  const [mobileSide, setMobileSide] = useState<SlotSide>('warehouse');
  const [mobilePreview, setMobilePreview] = useState<MobilePreview | null>(null);
  const [bagCapacity, setBagCapacity] = useState(0);
  const [bagSlots, setBagSlots] = useState<Array<InventoryItemDto | null>>([]);
  const [warehouseCapacity, setWarehouseCapacity] = useState(0);
  const [warehouseSubKey, setWarehouseSubKey] = useState<string>('1');
  const [warehouseSlots, setWarehouseSlots] = useState<Array<InventoryItemDto | null>>([]);
  const dragPayloadRef = useRef<DragPayload | null>(null);

  const warehouseSubIndex = useMemo(() => clampSubIndex(Number(warehouseSubKey) - 1), [warehouseSubKey]);
  const warehouseSubRange = useMemo(() => {
    const cap = Math.max(0, Math.floor(warehouseCapacity || 0));
    const subSize = cap <= 0 ? 0 : Math.ceil(cap / SUB_WAREHOUSE_COUNT);
    const idx = clampSubIndex(warehouseSubIndex);
    const start = Math.min(cap, idx * subSize);
    const end = Math.min(cap, idx === SUB_WAREHOUSE_COUNT - 1 ? cap : start + subSize);
    return { start, end };
  }, [warehouseCapacity, warehouseSubIndex]);

  const activeWarehouseSlots = useMemo(
    () => warehouseSlots.slice(warehouseSubRange.start, warehouseSubRange.end),
    [warehouseSlots, warehouseSubRange.end, warehouseSubRange.start],
  );
  const mobilePreviewItem = useMemo(() => {
    if (!mobilePreview) return null;
    const slots = mobilePreview.side === 'bag' ? bagSlots : warehouseSlots;
    return slots[mobilePreview.index] ?? null;
  }, [bagSlots, mobilePreview, warehouseSlots]);
  const mobilePreviewSide = mobilePreview?.side ?? null;

  const fetchAllInventoryItems = useCallback(async (location: 'bag' | 'warehouse'): Promise<InventoryItemDto[]> => {
    const pageSize = 500;
    const out: InventoryItemDto[] = [];
    let page = 1;
    for (;;) {
      const res = await getInventoryItems(location, page, pageSize);
      if (!res?.success || !res.data) return out;
      const items = res.data.items ?? [];
      out.push(...items);
      const total = Number(res.data.total || 0);
      if (out.length >= total || items.length < pageSize) return out;
      page += 1;
      if (page > 50) return out;
    }
  }, []);

  const refreshAll = useCallback(async (options?: { keepLoading?: boolean }) => {
    const keepLoading = Boolean(options?.keepLoading);
    if (!keepLoading) setLoading(true);
    try {
      const [infoRes, bagItems, warehouseItems] = await Promise.all([
        getInventoryInfo(),
        fetchAllInventoryItems('bag'),
        fetchAllInventoryItems('warehouse'),
      ]);
      const nextBagCap = infoRes?.success && infoRes.data ? Number(infoRes.data.bag_capacity || 0) : 0;
      const nextWhCap = infoRes?.success && infoRes.data ? Number(infoRes.data.warehouse_capacity || 0) : 0;
      setBagCapacity(nextBagCap);
      setWarehouseCapacity(nextWhCap);
      setBagSlots(buildSlots(nextBagCap, bagItems));
      setWarehouseSlots(buildSlots(nextWhCap, warehouseItems));
    } catch (e: unknown) {
      const err = e as { message?: string };
      message.error(err.message || '加载背包/仓库失败');
      setBagSlots([]);
      setBagCapacity(0);
      setWarehouseSlots([]);
      setWarehouseCapacity(0);
    } finally {
      if (!keepLoading) setLoading(false);
    }
  }, [fetchAllInventoryItems, message]);

  useEffect(() => {
    if (!open) return;
    setMobileSide('warehouse');
    setMobilePreview(null);
    void refreshAll();
  }, [open, refreshAll]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!mobilePreview) return;
    if (mobilePreviewItem) return;
    setMobilePreview(null);
  }, [mobilePreview, mobilePreviewItem]);

  const warehouseUsed = useMemo(() => warehouseSlots.reduce((sum, it) => sum + (it ? 1 : 0), 0), [warehouseSlots]);
  const warehouseSubUsed = useMemo(
    () => activeWarehouseSlots.reduce((sum, it) => sum + (it ? 1 : 0), 0),
    [activeWarehouseSlots],
  );
  const bagUsed = useMemo(() => bagSlots.reduce((sum, it) => sum + (it ? 1 : 0), 0), [bagSlots]);

  const getSlotsBySide = useCallback(
    (side: SlotSide) => (side === 'bag' ? bagSlots : warehouseSlots),
    [bagSlots, warehouseSlots],
  );

  const moveToOtherSideFirstEmpty = useCallback(
    (from: { side: SlotSide; index: number }) => {
      if (loading) return;
      const srcSlots = getSlotsBySide(from.side);
      const it = srcSlots[from.index];
      if (!it) return;
      const toSide: SlotSide = from.side === 'bag' ? 'warehouse' : 'bag';
      const dstSlots = getSlotsBySide(toSide);
      const emptyIndex =
        toSide === 'warehouse'
          ? findFirstEmptyInRange(dstSlots, warehouseSubRange.start, warehouseSubRange.end)
          : findFirstEmpty(dstSlots);
      if (emptyIndex < 0) {
        message.error(toSide === 'warehouse' ? '当前分仓已满' : '背包已满');
        return;
      }
      setLoading(true);
      moveInventoryItem({ itemId: it.id, targetLocation: toSide, targetSlot: emptyIndex })
        .then((res) => {
          if (!res?.success) {
            message.error(res?.message || '移动失败');
            return;
          }
          void refreshAll({ keepLoading: true });
        })
        .catch((e: unknown) => {
          const err = e as { message?: string };
          message.error(err.message || '移动失败');
        })
        .finally(() => setLoading(false));
    },
    [getSlotsBySide, loading, message, refreshAll, warehouseSubRange.end, warehouseSubRange.start],
  );

  const handleDrop = useCallback(
    (to: { side: SlotSide; index: number }, rawPayload: DragPayload | null) => {
      if (loading) return;
      const payload = rawPayload;
      if (!payload) return;
      if (payload.side === to.side && payload.index === to.index) return;

      const fromSlots = getSlotsBySide(payload.side);
      const it = fromSlots[payload.index];
      if (!it) return;
      setLoading(true);
      moveInventoryItem({ itemId: it.id, targetLocation: to.side, targetSlot: to.index })
        .then((res) => {
          if (!res?.success) {
            message.error(res?.message || '移动失败');
            return;
          }
          void refreshAll({ keepLoading: true });
        })
        .catch((e: unknown) => {
          const err = e as { message?: string };
          message.error(err.message || '移动失败');
        })
        .finally(() => setLoading(false));
    },
    [getSlotsBySide, loading, message, refreshAll],
  );

  const renderSlot = (side: SlotSide, index: number, it: InventoryItemDto | null) => {
    const name = it?.def?.name ?? '';
    const qty = Math.max(0, Number(it?.qty || 0));
    const icon = resolveIcon(it?.def ?? null);
    const displayName = name || '未知物品';
    const displayQty = qty > 0 ? qty : 1;

    const node = (
      <div
        key={`${side}-${index}`}
        className={`warehouse-slot ${it ? 'has-item' : ''}`}
        role="button"
        tabIndex={0}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!it) return;
          moveToOtherSideFirstEmpty({ side, index });
        }}
        draggable={!!it}
        onDragStart={(e) => {
          if (!it) return;
          const payload: DragPayload = { side, index };
          dragPayloadRef.current = payload;
          try {
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
          } catch {
          }
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          const text = e.dataTransfer.getData('application/json');
          let parsed: DragPayload | null = null;
          if (text) {
            try {
              parsed = safeParseDragPayload(JSON.parse(text) as unknown);
            } catch {
              parsed = null;
            }
          }
          handleDrop({ side, index }, parsed ?? dragPayloadRef.current);
          dragPayloadRef.current = null;
        }}
        onClick={() => {
          if (!it) return;
          if (isMobile) {
            setMobilePreview({ side, index });
          }
        }}
        title={
          it
            ? `${displayName} x${displayQty}`
            : `${side === 'warehouse' ? index - warehouseSubRange.start + 1 : index + 1}`
        }
      >
        {it ? (
          <>
            <img className="warehouse-slot-icon" src={icon} alt={displayName} />
            {qty > 1 ? <div className="warehouse-slot-qty">x{qty}</div> : null}
          </>
        ) : (
          <div className="warehouse-slot-empty" />
        )}
      </div>
    );

    if (!it || isMobile) return node;

    return (
      <Tooltip
        overlayClassName="warehouse-item-tooltip"
        title={<WarehouseItemTooltip it={it} />}
        mouseEnterDelay={0.12}
        placement="right"
        getPopupContainer={(triggerNode) => triggerNode.closest('.warehouse-modal') ?? document.body}
      >
        {node}
      </Tooltip>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (loading) return;
        onClose();
      }}
      footer={null}
      title={null}
      centered
      width={1120}
      className="warehouse-modal"
      destroyOnHidden={false}
      maskClosable={!loading}
    >
      <Spin spinning={loading}>
        <div className={`warehouse-modal-shell ${isMobile ? `is-mobile mobile-side-${mobileSide}` : ''}`}>
          {isMobile ? (
            <div className="warehouse-mobile-toolbar">
              <Segmented
                className="warehouse-mobile-segmented"
                value={mobileSide}
                options={[
                  { value: 'warehouse', label: '仓库' },
                  { value: 'bag', label: '背包' },
                ]}
                onChange={(value) => {
                  if (value !== 'warehouse' && value !== 'bag') return;
                  setMobileSide(value);
                  setMobilePreview(null);
                }}
              />
              <Button size="small" onClick={() => void refreshAll()} disabled={loading}>
                刷新
              </Button>
            </div>
          ) : null}

          <div className="warehouse-mobile-meta">
            <span className="warehouse-mobile-meta-item">
              仓库 {warehouseUsed} / {warehouseCapacity}
            </span>
            <span className="warehouse-mobile-meta-item">
              背包 {bagUsed} / {bagCapacity}
            </span>
          </div>

          <div className="warehouse-pane warehouse-pane--warehouse">
            <div className="warehouse-pane-header is-warehouse">
              <div className="warehouse-pane-header-row">
                <div className="warehouse-pane-title">仓库</div>
                <div className="warehouse-pane-sub">总计已用 {warehouseUsed} / {warehouseCapacity} 格</div>
              </div>
              <div className="warehouse-pane-subrow">
                <Tabs
                  className="warehouse-subtabs"
                  size="middle"
                  activeKey={warehouseSubKey}
                  onChange={(k) => setWarehouseSubKey(k)}
                  tabBarGutter={10}
                  items={Array.from({ length: SUB_WAREHOUSE_COUNT }, (_, i) => ({
                    key: String(i + 1),
                    label: String(i + 1),
                  }))}
                />
                <div className="warehouse-submeta">
                  分仓已用 {warehouseSubUsed} / {warehouseSubRange.end - warehouseSubRange.start} 格
                </div>
              </div>
            </div>
            <div className="warehouse-grid">
              {activeWarehouseSlots.map((it, idx) => renderSlot('warehouse', warehouseSubRange.start + idx, it))}
            </div>
            <div className="warehouse-pane-footer">
              <div className="warehouse-hint">{isMobile ? '点击物品：查看详情/存取；拖拽：移动/交换' : '右键：放入/取出；拖拽：移动/交换'}</div>
            </div>
          </div>

          <div className="warehouse-divider" />

          <div className="warehouse-pane warehouse-pane--bag">
            <div className="warehouse-pane-header">
              <div className="warehouse-pane-title">背包</div>
              <div className="warehouse-pane-sub">已用 {bagUsed} / {bagCapacity} 格</div>
            </div>
            <div className="warehouse-grid">
              {bagSlots.map((it, idx) => renderSlot('bag', idx, it))}
            </div>
            <div className="warehouse-pane-footer">
              {isMobile ? (
                <div className="warehouse-hint">点击物品：查看详情/存取；拖拽：移动/交换</div>
              ) : (
                <Button size="small" onClick={() => void refreshAll()} disabled={loading}>
                  刷新
                </Button>
              )}
            </div>
          </div>
        </div>

        {isMobile ? (
          <Drawer
            title={mobilePreviewSide === 'bag' ? '背包物品' : '仓库物品'}
            placement="bottom"
            open={Boolean(mobilePreviewItem)}
            onClose={() => setMobilePreview(null)}
            height="56dvh"
            className="warehouse-mobile-preview-drawer"
            styles={{ body: { padding: '10px 12px 12px' } }}
          >
            {mobilePreviewItem ? (
              <div className="warehouse-mobile-preview">
                <div className="warehouse-mobile-preview-content">
                  <WarehouseItemTooltip it={mobilePreviewItem} />
                </div>
                <div className="warehouse-mobile-preview-actions">
                  <Button
                    type="primary"
                    block
                    disabled={loading}
                    onClick={() => {
                      if (!mobilePreview) return;
                      moveToOtherSideFirstEmpty(mobilePreview);
                    }}
                  >
                    {mobilePreviewSide === 'bag' ? '存入仓库' : '取回背包'}
                  </Button>
                </div>
              </div>
            ) : null}
          </Drawer>
        ) : null}
      </Spin>
    </Modal>
  );
};

export default WarehouseModal;
