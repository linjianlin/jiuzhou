import { App, Button, Input, Modal, Pagination, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import { formatSignedNumber, formatSignedPercent } from '../../shared/formatAttr';
import {
  buyMarketListing,
  cancelMarketListing,
  createMarketListing,
  getInventoryItems,
  getMarketListings,
  getMarketTradeRecords,
  getMyMarketListings,
  SERVER_BASE,
} from '../../../../services/api';
import type { InventoryItemDto, ItemDefLite, MarketListingDto, MarketTradeRecordDto } from '../../../../services/api';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import { useIsMobile } from '../../shared/responsive';
import { buildEquipmentAffixDisplayText, type EquipmentAffixTextInput } from '../../shared/equipmentAffixText';
import './index.scss';

type MarketPanel = 'market' | 'my' | 'list' | 'records';

type ItemQuality = '黄' | '玄' | '地' | '天';

type MarketCategory = 'all' | 'consumable' | 'material' | 'gem' | 'equipment' | 'skillbook' | 'other';

type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';

type BagItem = {
  id: number;
  itemDefId: string;
  name: string;
  icon: string;
  quality: ItemQuality;
  category: Exclude<MarketCategory, 'all'>;
  qty: number;
  desc: string;
  stackMax: number;
};

type ListingItem = {
  id: number;
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string;
  quality: ItemQuality;
  category: Exclude<MarketCategory, 'all'>;
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
  unitPrice: number;
  seller: string;
  sellerCharacterId: number;
  listedAt: number;
};

type TradeRecordType = '买入' | '卖出';

type TradeRecord = {
  id: number;
  type: TradeRecordType;
  itemDefId: string;
  name: string;
  icon: string;
  qty: number;
  unitPrice: number;
  counterparty: string;
  time: number;
};

const categoryText: Record<MarketCategory, string> = {
  all: '全部',
  consumable: '丹药',
  material: '材料',
  gem: '宝石',
  equipment: '装备',
  skillbook: '功法',
  other: '其他',
};

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

const resolveIcon = (icon: string | null | undefined): string => {
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

const hasLatin = (value: string): boolean => /[A-Za-z]/.test(value);

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
  };
  if (m[k]) return m[k];
  return null;
};

const PERCENT_ATTR_KEYS = new Set<string>([
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

type EquipmentAffix = EquipmentAffixTextInput;

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
      const modifiersRaw = Array.isArray(a.modifiers) ? a.modifiers : [];
      const modifiers: Array<{ attr_key: string; value: number }> = [];
      const seenModifierKeys = new Set<string>();
      for (const row of modifiersRaw) {
        if (!row || typeof row !== 'object') continue;
        const modifier = row as Record<string, unknown>;
        const attrKey = typeof modifier.attr_key === 'string' ? modifier.attr_key.trim() : '';
        const modifierValue =
          typeof modifier.value === 'number'
            ? modifier.value
            : typeof modifier.value === 'string'
              ? Number(modifier.value)
              : NaN;
        if (!attrKey || seenModifierKeys.has(attrKey) || !Number.isFinite(modifierValue)) continue;
        seenModifierKeys.add(attrKey);
        modifiers.push({ attr_key: attrKey, value: modifierValue });
      }

      const out: EquipmentAffix = {
        key: typeof a.key === 'string' ? a.key : undefined,
        name: typeof a.name === 'string' ? a.name : undefined,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
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

      if (typeof v === 'number' && Number.isFinite(v) && PERCENT_ATTR_KEYS.has(k)) {
        out.push(`${kk}：${formatSignedPercent(v)}`);
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        out.push(`${kk}：${formatSignedNumber(v)}`);
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
    accessory: '饰品',
    artifact: '法宝',
  };
  if (m[raw]) return m[raw];
  return '';
};

const translateUseType = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    instant: '立即生效',
    open: '可开启',
    equip: '可装备',
    passive: '被动',
    none: '无',
  };
  if (m[raw]) return m[raw];
  return '';
};

const qualityDesc: Record<ItemQuality, string> = {
  黄: '黄品',
  玄: '玄品',
  地: '地品',
  天: '天品',
};

const MarketItemTooltipContent: React.FC<{ row: ListingItem }> = ({ row }) => {
  const desc = useMemo(() => {
    const longDesc = normalizeText(row.longDesc);
    const shortDesc = normalizeText(row.description);
    return longDesc || shortDesc;
  }, [row.description, row.longDesc]);

  const isEquip = row.category === 'equipment';

  const infoTags = useMemo(() => {
    const tags: string[] = [];
    tags.push(qualityDesc[row.quality]);
    tags.push(categoryText[row.category]);
    const equipSlot = translateEquipSlot(row.equipSlot);
    if (equipSlot) tags.push(`部位：${equipSlot}`);
    const useType = translateUseType(row.useType);
    if (useType) tags.push(`类型：${useType}`);
    const req = normalizeText(row.equipReqRealm);
    if (req) tags.push(`需求：${req}`);
    return tags;
  }, [row.category, row.equipReqRealm, row.equipSlot, row.quality, row.useType]);

  const equipMetaLines = useMemo(() => {
    if (!isEquip) return [];
    const s = Math.max(0, Math.floor(Number(row.strengthenLevel) || 0));
    const r = Math.max(0, Math.floor(Number(row.refineLevel) || 0));
    return [`强化：${s > 0 ? `+${s}` : s}`, `精炼：${r > 0 ? `+${r}` : r}`];
  }, [isEquip, row.refineLevel, row.strengthenLevel]);

  const baseAttrLines = useMemo(() => {
    if (!isEquip) return [];
    const attrs = row.baseAttrs ?? {};
    const entries = Object.entries(attrs).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v !== 0);
    entries.sort(([a], [b]) => a.localeCompare(b));
    const lines = entries.map(([k, v]) => {
      const label = translateKey(k) ?? (hasLatin(k) ? '' : k);
      if (!label) return '';
      const text = PERCENT_ATTR_KEYS.has(k) ? formatSignedPercent(v) : formatSignedNumber(v);
      return `${label}：${text}`;
    });
    return limitLines(lines.filter(Boolean), 10);
  }, [isEquip, row.baseAttrs]);

  const affixes = useMemo(() => coerceAffixes(row.affixes), [row.affixes]);
  const affixLines = useMemo(() => {
    if (!isEquip) return [];
    if (!row.identified) return ['未鉴定'];
    const sorted = [...affixes].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));

    const out: string[] = [];
    for (const a of sorted) {
      const displayText = buildEquipmentAffixDisplayText(a, {
        normalPrefix: '词条',
        legendaryPrefix: '传奇词条',
        keyTranslator: translateKey,
        rejectLatinLabel: true,
        percentKeys: PERCENT_ATTR_KEYS,
        formatSignedNumber,
        formatSignedPercent,
      });
      if (!displayText) continue;
      out.push(displayText.fullText);
    }
    return out.length > 0 ? limitLines(out, 10) : ['无'];
  }, [affixes, isEquip, row.identified]);

  const effectLines = useMemo(() => limitLines(formatLines(row.effectDefs), 10), [row.effectDefs]);

  return (
    <div className="market-tooltip">
      <div className="market-tooltip-head">
        <img className="market-tooltip-icon" src={row.icon} alt={row.name} />
        <div className="market-tooltip-title">{row.name}</div>
        {row.qty > 1 ? <div className="market-tooltip-count">x{row.qty}</div> : null}
      </div>

      {infoTags.length > 0 ? (
        <div className="market-tooltip-tags">
          {infoTags.map((t) => (
            <span key={t} className="market-tooltip-tag">
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {desc ? <div className="market-tooltip-desc">{desc}</div> : null}

      {equipMetaLines.length > 0 ? (
        <div className="market-tooltip-section">
          <div className="market-tooltip-section-title">装备信息</div>
          <div className="market-tooltip-lines">
            {equipMetaLines.map((x) => (
              <div key={x} className="market-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {affixLines.length > 0 ? (
        <div className="market-tooltip-section">
          <div className="market-tooltip-section-title">词条</div>
          <div className="market-tooltip-lines">
            {affixLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="market-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {effectLines.length > 0 ? (
        <div className="market-tooltip-section">
          <div className="market-tooltip-section-title">效果</div>
          <div className="market-tooltip-lines">
            {effectLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="market-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {baseAttrLines.length > 0 ? (
        <div className="market-tooltip-section">
          <div className="market-tooltip-section-title">基础属性</div>
          <div className="market-tooltip-lines">
            {baseAttrLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="market-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const normalizeQuality = (value: unknown): ItemQuality => {
  if (value === '天' || value === '地' || value === '玄' || value === '黄') return value;
  return '黄';
};

const buildBagItem = (it: InventoryItemDto): BagItem | null => {
  const def: ItemDefLite | undefined = it.def;
  if (!def) return null;

  const name = String(def.name ?? '').trim();
  if (!name) return null;

  const icon = resolveIcon(def.icon);
  const rawQuality =
    typeof it.quality === 'string' && it.quality.trim().length > 0
      ? it.quality.trim()
      : def.quality;
  const quality = normalizeQuality(rawQuality);
  const category: Exclude<MarketCategory, 'all'> =
    def.category === 'consumable' ||
      def.category === 'material' ||
      def.category === 'gem' ||
      def.category === 'equipment' ||
      def.category === 'skillbook'
      ? def.category
      : 'other';
  const desc = String(def.description ?? def.long_desc ?? '').trim();
  const qty = Number(it.qty) || 0;
  const stackMax = Number(def.stack_max) || 1;

  return {
    id: Number(it.id),
    itemDefId: String(def.id ?? it.item_def_id ?? ''),
    name,
    icon,
    quality,
    category,
    qty,
    desc,
    stackMax,
  };
};

const buildListingItem = (dto: MarketListingDto): ListingItem => {
  const quality = normalizeQuality(dto.quality);
  const category: Exclude<MarketCategory, 'all'> =
    dto.category === 'consumable' ||
      dto.category === 'material' ||
      dto.category === 'gem' ||
      dto.category === 'equipment' ||
      dto.category === 'skillbook'
      ? dto.category
      : 'other';
  return {
    id: Number(dto.id),
    itemInstanceId: Number(dto.itemInstanceId) || 0,
    itemDefId: String(dto.itemDefId ?? ''),
    name: String(dto.name ?? ''),
    icon: resolveIcon(dto.icon),
    quality,
    category,
    subCategory: dto.subCategory === null || dto.subCategory === undefined ? null : String(dto.subCategory),
    description: dto.description === null || dto.description === undefined ? null : String(dto.description),
    longDesc: dto.longDesc === null || dto.longDesc === undefined ? null : String(dto.longDesc),
    tags: dto.tags ?? null,
    effectDefs: dto.effectDefs ?? null,
    baseAttrs: dto.baseAttrs && typeof dto.baseAttrs === 'object' ? (dto.baseAttrs as Record<string, number>) : {},
    equipSlot: dto.equipSlot === null || dto.equipSlot === undefined ? null : String(dto.equipSlot),
    equipReqRealm: dto.equipReqRealm === null || dto.equipReqRealm === undefined ? null : String(dto.equipReqRealm),
    useType: dto.useType === null || dto.useType === undefined ? null : String(dto.useType),
    strengthenLevel: Math.max(0, Math.floor(Number(dto.strengthenLevel) || 0)),
    refineLevel: Math.max(0, Math.floor(Number(dto.refineLevel) || 0)),
    identified: Boolean(dto.identified),
    affixes: dto.affixes ?? [],
    qty: Number(dto.qty) || 0,
    unitPrice: Number(dto.unitPriceSpiritStones) || 0,
    seller: String(dto.sellerName ?? ''),
    sellerCharacterId: Number(dto.sellerCharacterId) || 0,
    listedAt: Number(dto.listedAt) || 0,
  };
};

const buildTradeRecord = (dto: MarketTradeRecordDto): TradeRecord => {
  return {
    id: Number(dto.id),
    type: dto.type === '卖出' ? '卖出' : '买入',
    itemDefId: String(dto.itemDefId ?? ''),
    name: String(dto.name ?? ''),
    icon: resolveIcon(dto.icon),
    qty: Number(dto.qty) || 0,
    unitPrice: Number(dto.unitPriceSpiritStones) || 0,
    counterparty: String(dto.counterparty ?? ''),
    time: Number(dto.time) || 0,
  };
};

const parseMaybeNumber = (v: string) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
};

interface MarketModalProps {
  open: boolean;
  onClose: () => void;
  playerName?: string;
}

const MarketModal: React.FC<MarketModalProps> = ({ open, onClose, playerName = '我' }) => {
  const { message } = App.useApp();
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  const [character, setCharacter] = useState<CharacterData | null>(gameSocket.getCharacter());
  const characterId = character?.id ?? null;

  useEffect(() => {
    const unsubscribe = gameSocket.onCharacterUpdate((data) => {
      setCharacter(data);
    });
    return () => unsubscribe();
  }, []);

  const [panel, setPanel] = useState<MarketPanel>('market');
  const isMobile = useIsMobile();
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);

  const [category, setCategory] = useState<MarketCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MarketSort>('timeDesc');
  const [quality, setQuality] = useState<ItemQuality | 'all'>('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');

  const pageSize = 8;
  const [marketPage, setMarketPage] = useState(1);
  const [myPage, setMyPage] = useState(1);
  const [recordPage, setRecordPage] = useState(1);

  const [bagLoading, setBagLoading] = useState(false);
  const [bagItems, setBagItems] = useState<BagItem[]>([]);
  const [selectedBagId, setSelectedBagId] = useState<number | null>(null);
  const [listPrice, setListPrice] = useState('');
  const [listQty, setListQty] = useState('1');

  const [marketLoading, setMarketLoading] = useState(false);
  const [marketListings, setMarketListings] = useState<ListingItem[]>([]);
  const [marketTotal, setMarketTotal] = useState(0);

  const [myLoading, setMyLoading] = useState(false);
  const [myListings, setMyListings] = useState<ListingItem[]>([]);
  const [myTotal, setMyTotal] = useState(0);

  const [recordsLoading, setRecordsLoading] = useState(false);
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);

  const selectedBagItem = useMemo(
    () => (selectedBagId === null ? null : bagItems.find((b) => b.id === selectedBagId) ?? null),
    [bagItems, selectedBagId],
  );

  const refreshBag = useCallback(async () => {
    setBagLoading(true);
    try {
      const res = await getInventoryItems('bag', 1, 200);
      if (!res.success || !res.data) throw new Error(res.message || '获取背包物品失败');
      const next = res.data.items
        .map(buildBagItem)
        .filter((v): v is BagItem => !!v)
        .filter((v) => v.qty > 0);
      setBagItems(next);
      setSelectedBagId((prev) => (prev !== null && next.some((b) => b.id === prev) ? prev : next[0]?.id ?? null));
    } catch (error: unknown) {
      const err = error as { message?: string };
      messageRef.current.error(err.message || '获取背包物品失败');
      setBagItems([]);
      setSelectedBagId(null);
    } finally {
      setBagLoading(false);
    }
  }, [messageRef]);

  const refreshMarket = useCallback(
    async (page: number) => {
      setMarketLoading(true);
      try {
        const min = parseMaybeNumber(minPrice);
        const max = parseMaybeNumber(maxPrice);
        const minParam = min === null ? undefined : Math.max(0, Math.floor(min));
        const maxParam = max === null ? undefined : Math.max(0, Math.floor(max));
        const res = await getMarketListings({
          category,
          quality,
          query: query.trim(),
          sort,
          minPrice: minParam,
          maxPrice: maxParam,
          page,
          pageSize,
        });
        if (!res.success || !res.data) throw new Error(res.message || '获取坊市列表失败');
        setMarketListings(res.data.listings.map(buildListingItem));
        setMarketTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '获取坊市列表失败');
        setMarketListings([]);
        setMarketTotal(0);
      } finally {
        setMarketLoading(false);
      }
    },
    [category, maxPrice, minPrice, pageSize, quality, query, sort, messageRef],
  );

  const refreshMy = useCallback(
    async (page: number) => {
      setMyLoading(true);
      try {
        const res = await getMyMarketListings({ status: 'active', page, pageSize });
        if (!res.success || !res.data) throw new Error(res.message || '获取我的上架失败');
        setMyListings(res.data.listings.map(buildListingItem));
        setMyTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '获取我的上架失败');
        setMyListings([]);
        setMyTotal(0);
      } finally {
        setMyLoading(false);
      }
    },
    [pageSize, messageRef],
  );

  const refreshRecords = useCallback(
    async (page: number) => {
      setRecordsLoading(true);
      try {
        const res = await getMarketTradeRecords({ page, pageSize });
        if (!res.success || !res.data) throw new Error(res.message || '获取交易记录失败');
        setRecords(res.data.records.map(buildTradeRecord));
        setRecordsTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '获取交易记录失败');
        setRecords([]);
        setRecordsTotal(0);
      } finally {
        setRecordsLoading(false);
      }
    },
    [pageSize, messageRef],
  );

  const resetAll = () => {
    setPanel('market');
    setCategory('all');
    setQuery('');
    setSort('timeDesc');
    setQuality('all');
    setMinPrice('');
    setMaxPrice('');
    setMarketPage(1);
    setMyPage(1);
    setRecordPage(1);
    setSelectedBagId(null);
    setListPrice('');
    setListQty('1');
    setMobileFilterOpen(false);
  };

  const menuItems = useMemo(
    () => [
      { key: 'market' as const, label: '坊市', shortLabel: '坊市' },
      { key: 'my' as const, label: '我的上架', shortLabel: '上架' },
      { key: 'list' as const, label: '物品上架', shortLabel: '上架物品' },
      { key: 'records' as const, label: '售卖记录', shortLabel: '记录' },
    ],
    [],
  );
  const menuKeys = useMemo(() => menuItems.map((it) => it.key), [menuItems]);
  const menuOptions = useMemo(
    () => menuItems.map((it) => ({ value: it.key, label: it.shortLabel })),
    [menuItems],
  );
  const categoryOptions = useMemo(
    () => [
      { value: 'all', label: '全部分类' },
      { value: 'consumable', label: '丹药' },
      { value: 'material', label: '材料' },
      { value: 'gem', label: '宝石' },
      { value: 'equipment', label: '装备' },
      { value: 'skillbook', label: '功法书' },
      { value: 'other', label: '其他' },
    ],
    [],
  );
  const sortOptions = useMemo(
    () => [
      { value: 'timeDesc', label: '最新上架' },
      { value: 'priceAsc', label: '价格升序' },
      { value: 'priceDesc', label: '价格降序' },
      { value: 'qtyDesc', label: '数量降序' },
    ],
    [],
  );
  const qualityOptions = useMemo(
    () => [
      { value: 'all', label: '全部品质' },
      { value: '黄', label: '黄' },
      { value: '玄', label: '玄' },
      { value: '地', label: '地' },
      { value: '天', label: '天' },
    ],
    [],
  );

  useEffect(() => {
    if (!open) return;
    setMarketPage(1);
    void refreshMarket(1);
  }, [category, maxPrice, minPrice, open, quality, query, refreshMarket, sort]);

  useEffect(() => {
    if (!isMobile) setMobileFilterOpen(false);
  }, [isMobile]);

  const handlePanelChange = useCallback(
    (nextPanel: MarketPanel) => {
      setPanel(nextPanel);
      if (nextPanel === 'market') {
        setMarketPage(1);
        void refreshMarket(1);
      }
      if (nextPanel === 'my') {
        setMyPage(1);
        void refreshMy(1);
      }
      if (nextPanel === 'list') {
        void refreshBag();
      }
      if (nextPanel === 'records') {
        setRecordPage(1);
        void refreshRecords(1);
      }
    },
    [refreshBag, refreshMarket, refreshMy, refreshRecords],
  );

  const buyListing = useCallback(
    async (row: ListingItem) => {
      if (characterId !== null && row.sellerCharacterId === characterId) return;
      try {
        const res = await buyMarketListing(row.id);
        if (!res.success) throw new Error(res.message || '购买失败');
        messageRef.current.success('购买成功');
        await Promise.all([refreshMarket(marketPage), refreshBag(), refreshMy(myPage), refreshRecords(recordPage)]);
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '购买失败');
      }
    },
    [characterId, marketPage, myPage, recordPage, refreshBag, refreshMarket, refreshMy, refreshRecords],
  );

  const unlistMyItem = useCallback(
    async (row: ListingItem) => {
      try {
        const res = await cancelMarketListing(row.id);
        if (!res.success) throw new Error(res.message || '下架失败');
        messageRef.current.success('下架成功');
        await Promise.all([refreshMarket(marketPage), refreshBag(), refreshMy(myPage)]);
      } catch (error: unknown) {
        const err = error as { message?: string };
        messageRef.current.error(err.message || '下架失败');
      }
    },
    [marketPage, myPage, refreshBag, refreshMarket, refreshMy],
  );

  const doList = useCallback(async () => {
    const item = selectedBagItem;
    if (!item) return;
    const p = parseMaybeNumber(listPrice);
    const q = parseMaybeNumber(listQty);
    if (!p || p <= 0) return;
    if (!q || q <= 0) return;
    if (q > item.qty) return;

    try {
      const res = await createMarketListing({ itemInstanceId: item.id, qty: Math.floor(q), unitPriceSpiritStones: Math.floor(p) });
      if (!res.success) throw new Error(res.message || '上架失败');
      messageRef.current.success('上架成功');
      setPanel('my');
      setSelectedBagId(null);
      setListPrice('');
      setListQty('1');
      await Promise.all([refreshMarket(marketPage), refreshBag(), refreshMy(myPage)]);
    } catch (error: unknown) {
      const err = error as { message?: string };
      messageRef.current.error(err.message || '上架失败');
    }
  }, [listPrice, listQty, marketPage, myPage, refreshBag, refreshMarket, refreshMy, selectedBagItem]);

  const renderMarketFilters = () => {
    const hasAdvancedFilters =
      category !== 'all' || sort !== 'timeDesc' || quality !== 'all' || minPrice.trim().length > 0 || maxPrice.trim().length > 0;

    return (
      <>
        <div className="market-filters">
          <Select
            value={category}
            onChange={(v) => {
              setCategory(v);
              setMarketPage(1);
            }}
            options={categoryOptions}
          />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMarketPage(1);
            }}
            placeholder="搜索物品/卖家"
            allowClear
            suffix={<SearchOutlined />}
          />
          <Select
            value={sort}
            onChange={(v) => {
              setSort(v);
              setMarketPage(1);
            }}
            options={sortOptions}
          />
          <Select
            value={quality}
            onChange={(v) => {
              setQuality(v);
              setMarketPage(1);
            }}
            options={qualityOptions}
          />
          <div className="market-price-range">
            <Input
              value={minPrice}
              onChange={(e) => {
                setMinPrice(e.target.value);
                setMarketPage(1);
              }}
              placeholder="最低价"
              inputMode="numeric"
            />
            <span className="market-price-split">~</span>
            <Input
              value={maxPrice}
              onChange={(e) => {
                setMaxPrice(e.target.value);
                setMarketPage(1);
              }}
              placeholder="最高价"
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="market-filters-mobile">
          <div className="market-filters-mobile-search">
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMarketPage(1);
              }}
              placeholder="搜索物品/卖家"
              allowClear
              suffix={<SearchOutlined />}
            />
            <Button
              className="market-filter-toggle"
              type={mobileFilterOpen || hasAdvancedFilters ? 'primary' : 'default'}
              onClick={() => setMobileFilterOpen((prev) => !prev)}
            >
              筛选
            </Button>
          </div>
          {mobileFilterOpen ? (
            <div className="market-filters-mobile-panel">
              <div className="market-filters-mobile-grid">
                <Select
                  value={category}
                  onChange={(v) => {
                    setCategory(v);
                    setMarketPage(1);
                  }}
                  options={categoryOptions}
                />
                <Select
                  value={sort}
                  onChange={(v) => {
                    setSort(v);
                    setMarketPage(1);
                  }}
                  options={sortOptions}
                />
                <Select
                  value={quality}
                  onChange={(v) => {
                    setQuality(v);
                    setMarketPage(1);
                  }}
                  options={qualityOptions}
                />
              </div>
              <div className="market-price-range market-price-range-mobile">
                <Input
                  value={minPrice}
                  onChange={(e) => {
                    setMinPrice(e.target.value);
                    setMarketPage(1);
                  }}
                  placeholder="最低价"
                  inputMode="numeric"
                />
                <span className="market-price-split">~</span>
                <Input
                  value={maxPrice}
                  onChange={(e) => {
                    setMaxPrice(e.target.value);
                    setMarketPage(1);
                  }}
                  placeholder="最高价"
                  inputMode="numeric"
                />
              </div>
            </div>
          ) : null}
        </div>
      </>
    );
  };

  const renderMarket = () => (
    <div className="market-pane">
      <div className="market-pane-top">
        <div className="market-title">坊市</div>
        {renderMarketFilters()}
      </div>
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {marketLoading && marketListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {marketListings.map((row) => (
                <div key={row.id} className="market-mobile-card">
                  <div className="market-mobile-card-head">
                    <img className="market-item-icon" src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality q-${row.quality}`}>{row.quality}</Tag>
                        <Tag className="market-tag">{categoryText[row.category]}</Tag>
                        {row.seller === playerName ? <Tag className="market-tag market-tag-mine">我的上架</Tag> : null}
                      </div>
                    </div>
                    <div className="market-mobile-price">
                      <div className="market-mobile-price-label">单价</div>
                      <div className="market-mobile-price-value">{row.unitPrice.toLocaleString()} 灵石</div>
                    </div>
                  </div>
                  <div className="market-mobile-card-foot">
                    <div className="market-mobile-meta-line">
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">数量</span>
                        <span className="market-mobile-meta-v">{row.qty}</span>
                      </span>
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">总价</span>
                        <span className="market-mobile-meta-v">{(row.unitPrice * row.qty).toLocaleString()} 灵石</span>
                      </span>
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">卖家</span>
                        <span className="market-mobile-meta-v">{row.seller}</span>
                      </span>
                    </div>
                    <div className="market-mobile-actions">
                      <Button
                        type="primary"
                        size="small"
                        disabled={characterId !== null && row.sellerCharacterId === characterId}
                        onClick={() => buyListing(row)}
                      >
                        购买
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {!marketLoading && marketListings.length === 0 ? <div className="market-empty">暂无上架物品</div> : null}
            </div>
          ) : (
            <Table
              size="small"
              rowKey={(row) => row.id}
              className="market-table"
              pagination={false}
              loading={marketLoading}
              columns={[
                {
                  title: '物品',
                  dataIndex: 'name',
                  key: 'name',
                  width: 220,
                  render: (_: string, row: ListingItem) => (
                    <Tooltip
                      overlayClassName="market-tooltip-overlay"
                      classNames={{ root: 'market-tooltip-overlay' }}
                      placement="right"
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent row={row} />}
                      getPopupContainer={(triggerNode) => triggerNode.closest('.market-modal') ?? document.body}
                    >
                      <div className="market-item">
                        <img className="market-item-icon" src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality q-${row.quality}`}>{row.quality}</Tag>
                            <Tag className="market-tag">{categoryText[row.category]}</Tag>
                            {row.seller === playerName ? <Tag className="market-tag market-tag-mine">我的上架</Tag> : null}
                          </div>
                        </div>
                      </div>
                    </Tooltip>
                  ),
                },
                { title: '数量', dataIndex: 'qty', key: 'qty', width: 90 },
                {
                  title: '单价',
                  dataIndex: 'unitPrice',
                  key: 'unitPrice',
                  width: 110,
                  render: (v: number) => `${v.toLocaleString()} 灵石`,
                },
                {
                  title: '总价',
                  key: 'total',
                  width: 120,
                  render: (_: unknown, row: ListingItem) => `${(row.unitPrice * row.qty).toLocaleString()} 灵石`,
                },
                { title: '卖家', dataIndex: 'seller', key: 'seller', width: 140 },
                {
                  title: '操作',
                  key: 'action',
                  width: 110,
                  render: (_: unknown, row: ListingItem) => (
                    <Button
                      type="primary"
                      size="small"
                      disabled={characterId !== null && row.sellerCharacterId === characterId}
                      onClick={() => buyListing(row)}
                    >
                      购买
                    </Button>
                  ),
                },
              ]}
              dataSource={marketListings}
            />
          )}
        </div>
        <div className="market-pagination-bar">
          <Pagination
            current={marketPage}
            pageSize={pageSize}
            total={marketTotal}
            onChange={(p) => {
              setMarketPage(p);
              void refreshMarket(p);
            }}
            showSizeChanger={false}
            hideOnSinglePage
          />
        </div>
      </div>
    </div>
  );

  const renderMyListings = () => (
    <div className="market-pane">
      <div className="market-pane-top">
        <div className="market-title">我的上架</div>
        <div className="market-subtitle">查看并管理自己上架的物品</div>
      </div>
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {myLoading && myListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {myListings.map((row) => (
                <div key={row.id} className="market-mobile-card">
                  <div className="market-mobile-card-head">
                    <img className="market-item-icon" src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality q-${row.quality}`}>{row.quality}</Tag>
                        <Tag className="market-tag">{categoryText[row.category]}</Tag>
                      </div>
                    </div>
                    <div className="market-mobile-price">
                      <div className="market-mobile-price-label">单价</div>
                      <div className="market-mobile-price-value">{row.unitPrice.toLocaleString()} 灵石</div>
                    </div>
                  </div>
                  <div className="market-mobile-card-foot">
                    <div className="market-mobile-meta-line">
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">数量</span>
                        <span className="market-mobile-meta-v">{row.qty}</span>
                      </span>
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">总价</span>
                        <span className="market-mobile-meta-v">{(row.unitPrice * row.qty).toLocaleString()} 灵石</span>
                      </span>
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">时间</span>
                        <span className="market-mobile-meta-v">
                          {row.listedAt > 0 ? new Date(row.listedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                        </span>
                      </span>
                    </div>
                    <div className="market-mobile-actions">
                      <Button size="small" onClick={() => unlistMyItem(row)}>
                        下架
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {!myLoading && myListings.length === 0 ? <div className="market-empty">暂无上架物品</div> : null}
            </div>
          ) : (
            <Table
              size="small"
              rowKey={(row) => row.id}
              className="market-table"
              pagination={false}
              loading={myLoading}
              columns={[
                {
                  title: '物品',
                  dataIndex: 'name',
                  key: 'name',
                  render: (_: string, row: ListingItem) => (
                    <Tooltip
                      overlayClassName="market-tooltip-overlay"
                      classNames={{ root: 'market-tooltip-overlay' }}
                      placement="right"
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent row={row} />}
                      getPopupContainer={(triggerNode) => triggerNode.closest('.market-modal') ?? document.body}
                    >
                      <div className="market-item">
                        <img className="market-item-icon" src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality q-${row.quality}`}>{row.quality}</Tag>
                            <Tag className="market-tag">{categoryText[row.category]}</Tag>
                          </div>
                        </div>
                      </div>
                    </Tooltip>
                  ),
                },
                { title: '数量', dataIndex: 'qty', key: 'qty', width: 90 },
                {
                  title: '单价',
                  dataIndex: 'unitPrice',
                  key: 'unitPrice',
                  width: 120,
                  render: (v: number) => `${v.toLocaleString()} 灵石`,
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 200,
                  render: (_: unknown, row: ListingItem) => (
                    <div className="market-actions">
                      <Button size="small" onClick={() => unlistMyItem(row)}>
                        下架
                      </Button>
                    </div>
                  ),
                },
              ]}
              dataSource={myListings}
            />
          )}
        </div>
        <div className="market-pagination-bar">
          <Pagination
            current={myPage}
            pageSize={pageSize}
            total={myTotal}
            onChange={(p) => {
              setMyPage(p);
              void refreshMy(p);
            }}
            showSizeChanger={false}
            hideOnSinglePage
          />
        </div>
      </div>
    </div>
  );

  const renderListItem = () => {
    const canListQty = selectedBagItem?.qty ?? 0;
    const qtyNum = parseMaybeNumber(listQty);
    const priceNum = parseMaybeNumber(listPrice);
    const safeQty = qtyNum ? Math.floor(qtyNum) : null;
    const safePrice = priceNum ? Math.floor(priceNum) : null;
    const canList = !!selectedBagItem && !!safeQty && safeQty > 0 && safeQty <= canListQty && !!safePrice && safePrice > 0;

    return (
      <div className="market-pane">
        <div className="market-pane-top">
          <div className="market-title">物品上架</div>
          <div className="market-subtitle">从背包选择物品并设置价格上架</div>
        </div>
        <div className="market-pane-body">
          <div className="market-list-shell">
            <div className="market-bag">
              <div className="market-bag-title">背包</div>
              <div className="market-bag-grid">
                {bagLoading && bagItems.length === 0 ? <div className="market-empty">加载中...</div> : null}
                {bagItems.map((b) => (
                  <div
                    key={b.id}
                    className={`market-bag-cell q-${b.quality} ${selectedBagId === b.id ? 'is-active' : ''} ${b.qty <= 0 ? 'is-empty' : ''
                      }`}
                    onClick={() => setSelectedBagId(b.id)}
                  >
                    <img className="market-bag-icon" src={b.icon} alt={b.name} />
                    <div className="market-bag-count">{b.qty}</div>
                    <div className="market-bag-name">{b.name}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="market-list-detail">
              <div className="market-list-detail-card">
                {selectedBagItem ? (
                  <>
                    <div className="market-list-detail-head">
                      <img className="market-list-detail-icon" src={selectedBagItem.icon} alt={selectedBagItem.name} />
                      <div className="market-list-detail-meta">
                        <div className="market-list-detail-name">{selectedBagItem.name}</div>
                        <div className="market-list-detail-tags">
                          <Tag className={`market-tag market-tag-quality q-${selectedBagItem.quality}`}>{selectedBagItem.quality}</Tag>
                          <Tag className="market-tag">{categoryText[selectedBagItem.category]}</Tag>
                          <Tag className="market-tag">数量 {selectedBagItem.qty}</Tag>
                        </div>
                      </div>
                    </div>
                    <div className="market-list-detail-desc">{selectedBagItem.desc}</div>
                    <div className="market-list-form">
                      <div className="market-list-row">
                        <div className="market-list-k">单价（灵石）</div>
                        <Input value={listPrice} onChange={(e) => setListPrice(e.target.value)} inputMode="numeric" placeholder="请输入单价" />
                      </div>
                      <div className="market-list-row">
                        <div className="market-list-k">数量</div>
                        <Input value={listQty} onChange={(e) => setListQty(e.target.value)} inputMode="numeric" placeholder="请输入数量" />
                      </div>
                      <div className="market-list-actions">
                        <Button type="primary" disabled={!canList} onClick={doList}>
                          确认上架
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="market-empty">请选择一个背包物品</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderRecords = () => (
    <div className="market-pane">
      <div className="market-pane-top">
        <div className="market-title">售卖记录</div>
      </div>
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {recordsLoading && records.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {records.map((row) => (
                <div key={row.id} className="market-mobile-card">
                  <div className="market-mobile-card-head">
                    <img className="market-item-icon" src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-record ${row.type === '买入' ? 'buy' : 'sell'}`}>{row.type}</Tag>
                        <Tag className="market-tag">数量 {row.qty}</Tag>
                      </div>
                    </div>
                    <div className="market-mobile-price">
                      <div className="market-mobile-price-label">单价</div>
                      <div className="market-mobile-price-value">{row.unitPrice.toLocaleString()} 灵石</div>
                    </div>
                  </div>
                  <div className="market-mobile-meta-line">
                    <span className="market-mobile-meta-item">
                      <span className="market-mobile-meta-k">总价</span>
                      <span className="market-mobile-meta-v">{(row.unitPrice * row.qty).toLocaleString()} 灵石</span>
                    </span>
                    <span className="market-mobile-meta-item">
                      <span className="market-mobile-meta-k">对方</span>
                      <span className="market-mobile-meta-v">{row.counterparty}</span>
                    </span>
                    <span className="market-mobile-meta-item">
                      <span className="market-mobile-meta-k">时间</span>
                      <span className="market-mobile-meta-v">
                        {row.time > 0 ? new Date(row.time).toLocaleString('zh-CN', { hour12: false }) : '-'}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Table
              size="small"
              rowKey={(row) => row.id}
              className="market-table"
              pagination={false}
              loading={recordsLoading}
              columns={[
                {
                  title: '类型',
                  dataIndex: 'type',
                  key: 'type',
                  width: 90,
                  render: (v: TradeRecordType) => (
                    <Tag className={`market-tag market-tag-record ${v === '买入' ? 'buy' : 'sell'}`}>{v}</Tag>
                  ),
                },
                {
                  title: '物品',
                  dataIndex: 'name',
                  key: 'name',
                  render: (_: string, row: TradeRecord) => (
                    <div className="market-item">
                      <img className="market-item-icon" src={row.icon} alt={row.name} />
                      <div className="market-item-meta">
                        <div className="market-item-name">{row.name}</div>
                        <div className="market-item-tags">
                          <Tag className="market-tag">数量 {row.qty}</Tag>
                          <Tag className="market-tag">单价 {row.unitPrice.toLocaleString()}</Tag>
                        </div>
                      </div>
                    </div>
                  ),
                },
                { title: '对方', dataIndex: 'counterparty', key: 'counterparty', width: 160 },
              ]}
              dataSource={records}
            />
          )}
        </div>
        {records.length === 0 && !recordsLoading ? <div className="market-empty">暂无记录</div> : null}
        <div className="market-pagination-bar">
          <Pagination
            current={recordPage}
            pageSize={pageSize}
            total={recordsTotal}
            onChange={(p) => {
              setRecordPage(p);
              void refreshRecords(p);
            }}
            showSizeChanger={false}
            hideOnSinglePage
          />
        </div>
      </div>
    </div>
  );

  const panelContent = () => {
    if (panel === 'market') return renderMarket();
    if (panel === 'my') return renderMyListings();
    if (panel === 'list') return renderListItem();
    return renderRecords();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1120}
      className="market-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        resetAll();
        void refreshMarket(1);
      }}
    >
      <div className="market-modal-shell">
        <div className="market-left">
          <div className="market-left-title">
            <img className="market-left-icon" src={coin01} alt="坊市" />
            <div className="market-left-name">坊市</div>
          </div>
          {isMobile ? (
            <div className="market-left-segmented-wrap">
              <Segmented
                className="market-left-segmented"
                value={panel}
                options={menuOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!menuKeys.includes(value as MarketPanel)) return;
                  handlePanelChange(value as MarketPanel);
                }}
              />
            </div>
          ) : (
            <div className="market-left-list">
              {menuItems.map((it) => (
                <Button
                  key={it.key}
                  type={panel === it.key ? 'primary' : 'default'}
                  className="market-left-item"
                  onClick={() => handlePanelChange(it.key)}
                >
                  {it.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <div className="market-right">{panelContent()}</div>
      </div>
    </Modal>
  );
};

export default MarketModal;
