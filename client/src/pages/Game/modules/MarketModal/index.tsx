import { App, Button, Input, Modal, Pagination, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import { formatSignedNumber, formatSignedPercent } from '../../shared/formatAttr';
import { PERCENT_ATTR_KEYS, coerceAffixes, formatScalar, limitLines, normalizeText } from '../../shared/itemMetaFormat';
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
import EquipmentAffixTooltipList from '../../shared/EquipmentAffixTooltipList';
import { getItemQualityMeta, normalizeItemQualityName } from '../../shared/itemQuality';
import InventoryItemCell from '../../shared/InventoryItemCell';
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
  locked: boolean;
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
const RATING_SUFFIX = '_rating';

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
  if (k.endsWith(RATING_SUFFIX)) {
    const baseKey = k.slice(0, -RATING_SUFFIX.length).trim();
    const baseLabel = m[baseKey];
    if (baseLabel) return `${baseLabel}等级`;
  }
  return null;
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

type TooltipTag = {
  text: string;
  qualityClassName?: string;
};

const MarketItemTooltipContent: React.FC<{ row: ListingItem }> = ({ row }) => {
  const desc = useMemo(() => {
    const longDesc = normalizeText(row.longDesc);
    const shortDesc = normalizeText(row.description);
    return longDesc || shortDesc;
  }, [row.description, row.longDesc]);

  const isEquip = row.category === 'equipment';

  const infoTags = useMemo(() => {
    const tags: TooltipTag[] = [];
    const qualityMeta = getItemQualityMeta(row.quality);
    if (qualityMeta) {
      tags.push({
        text: qualityMeta.label,
        qualityClassName: qualityMeta.className,
      });
    }

    tags.push({ text: categoryText[row.category] });
    const equipSlot = translateEquipSlot(row.equipSlot);
    if (equipSlot) tags.push({ text: `部位：${equipSlot}` });
    const useType = translateUseType(row.useType);
    if (useType) tags.push({ text: `类型：${useType}` });
    const req = normalizeText(row.equipReqRealm);
    if (req) tags.push({ text: `需求：${req}` });
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
          {infoTags.map((tag, idx) => (
            <span
              key={`${idx}-${tag.text}`}
              className={`market-tooltip-tag${tag.qualityClassName ? ` market-tooltip-tag--quality ${tag.qualityClassName}` : ''}`}
            >
              {tag.text}
            </span>
          ))}
        </div>
      ) : null}

      {!isEquip && desc ? <div className="market-tooltip-desc">{desc}</div> : null}

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

      {isEquip ? (
        <div className="market-tooltip-section">
          <div className="market-tooltip-section-title">词条</div>
          <div className="market-tooltip-lines">
            <EquipmentAffixTooltipList
              affixes={affixes}
              identified={Boolean(row.identified)}
              maxLines={10}
              displayOptions={{
                normalPrefix: '词条',
                legendaryPrefix: '传奇词条',
                keyTranslator: translateKey,
                rejectLatinLabel: true,
                percentKeys: PERCENT_ATTR_KEYS,
                formatSignedNumber,
                formatSignedPercent,
              }}
            />
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
  return normalizeItemQualityName(value, '黄');
};

const getQualityClassName = (value: unknown): string => {
  return getItemQualityMeta(value)?.className ?? '';
};

const normalizeMarketCategory = (value: string | null | undefined): Exclude<MarketCategory, 'all'> => {
  switch (value) {
    case 'consumable':
    case 'material':
    case 'gem':
    case 'equipment':
    case 'skillbook':
    case 'other':
      return value;
    default:
      return 'other';
  }
};

const toNonNegativeIntegerOrUndefined = (value: string): number | undefined => {
  const parsed = parseMaybeNumber(value);
  if (parsed === null) return undefined;
  return Math.max(0, Math.floor(parsed));
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
  const category = normalizeMarketCategory(def.category);
  const desc = category === 'equipment' ? '' : String(def.description ?? def.long_desc ?? '').trim();
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
    locked: Boolean(it.locked),
    desc,
    stackMax,
  };
};

const buildListingItem = (dto: MarketListingDto): ListingItem => {
  const quality = normalizeQuality(dto.quality);
  const category = normalizeMarketCategory(dto.category);
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
  const marketItemTooltipClassNames = useMemo(
    () =>
      ({
        root: 'market-tooltip-overlay game-tooltip-surface-root',
        container: 'market-tooltip-overlay-container game-tooltip-surface-container',
      }) as const,
    [],
  );
  const getMarketTooltipPopupContainer = useCallback(
    (triggerNode: HTMLElement): HTMLElement => {
      const modalRoot = triggerNode.closest('.market-modal');
      return modalRoot instanceof HTMLElement ? modalRoot : document.body;
    },
    [],
  );

  const resetMarketPage = useCallback(() => {
    setMarketPage(1);
  }, []);

  const handleCategoryChange = useCallback(
    (value: MarketCategory) => {
      setCategory(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handleSortChange = useCallback(
    (value: MarketSort) => {
      setSort(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handleQualityChange = useCallback(
    (value: ItemQuality | 'all') => {
      setQuality(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handleMinPriceChange = useCallback(
    (value: string) => {
      setMinPrice(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handleMaxPriceChange = useCallback(
    (value: string) => {
      setMaxPrice(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

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
        const res = await getMarketListings({
          category,
          quality,
          query: query.trim(),
          sort,
          minPrice: toNonNegativeIntegerOrUndefined(minPrice),
          maxPrice: toNonNegativeIntegerOrUndefined(maxPrice),
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
    if (item.locked) return;
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
            onChange={handleCategoryChange}
            options={categoryOptions}
          />
          <Input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="搜索物品/卖家"
            allowClear
            suffix={<SearchOutlined />}
          />
          <Select
            value={sort}
            onChange={handleSortChange}
            options={sortOptions}
          />
          <Select
            value={quality}
            onChange={handleQualityChange}
            options={qualityOptions}
          />
          <div className="market-price-range">
            <Input
              value={minPrice}
              onChange={(e) => handleMinPriceChange(e.target.value)}
              placeholder="最低价"
              inputMode="numeric"
            />
            <span className="market-price-split">~</span>
            <Input
              value={maxPrice}
              onChange={(e) => handleMaxPriceChange(e.target.value)}
              placeholder="最高价"
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="market-filters-mobile">
          <div className="market-filters-mobile-search">
            <Input
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
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
                  onChange={handleCategoryChange}
                  options={categoryOptions}
                />
                <Select
                  value={sort}
                  onChange={handleSortChange}
                  options={sortOptions}
                />
                <Select
                  value={quality}
                  onChange={handleQualityChange}
                  options={qualityOptions}
                />
              </div>
              <div className="market-price-range market-price-range-mobile">
                <Input
                  value={minPrice}
                  onChange={(e) => handleMinPriceChange(e.target.value)}
                  placeholder="最低价"
                  inputMode="numeric"
                />
                <span className="market-price-split">~</span>
                <Input
                  value={maxPrice}
                  onChange={(e) => handleMaxPriceChange(e.target.value)}
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
      </div>
      <div className="market-pane-body">
        <div className="market-market-filters-wrap">{renderMarketFilters()}</div>
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {marketLoading && marketListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {marketListings.map((row) => (
                <div key={row.id} className={`market-mobile-card ${getQualityClassName(row.quality)}`}>
                  <div className="market-mobile-card-head">
                    <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
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
                      overlayClassName={marketItemTooltipClassNames.root}
                      classNames={marketItemTooltipClassNames}
                      placement="right"
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent row={row} />}
                      getPopupContainer={getMarketTooltipPopupContainer}
                    >
                      <div className={`market-item ${getQualityClassName(row.quality)}`}>
                        <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
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
      </div>
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {myLoading && myListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {myListings.map((row) => (
                <div key={row.id} className={`market-mobile-card ${getQualityClassName(row.quality)}`}>
                  <div className="market-mobile-card-head">
                    <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
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
                      overlayClassName={marketItemTooltipClassNames.root}
                      classNames={marketItemTooltipClassNames}
                      placement="right"
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent row={row} />}
                      getPopupContainer={getMarketTooltipPopupContainer}
                    >
                      <div className={`market-item ${getQualityClassName(row.quality)}`}>
                        <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
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
    const canList =
      !!selectedBagItem &&
      !selectedBagItem.locked &&
      !!safeQty &&
      safeQty > 0 &&
      safeQty <= canListQty &&
      !!safePrice &&
      safePrice > 0;

    return (
      <div className="market-pane">
        <div className="market-pane-top">
          <div className="market-title">物品上架</div>
        </div>
        <div className="market-pane-body">
          <div className="market-list-shell">
            <div className="market-bag">
              <div className="market-bag-title">背包</div>
              <div className="market-bag-grid">
                {bagLoading && bagItems.length === 0 ? <div className="market-empty">加载中...</div> : null}
                {bagItems.map((b) => (
                  <InventoryItemCell
                    key={b.id}
                    className="market-bag-cell"
                    qualityClassName={getQualityClassName(b.quality)}
                    active={selectedBagId === b.id}
                    empty={b.qty <= 0}
                    icon={b.icon}
                    name={b.name}
                    quantity={b.qty}
                    showQuantity={b.qty > 1}
                    lockedLabel={b.locked ? '锁' : undefined}
                    onClick={() => setSelectedBagId(b.id)}
                  />
                ))}
              </div>
            </div>
            <div className="market-list-detail">
              <div className="market-list-detail-card">
                {selectedBagItem ? (
                  <>
                    <div className="market-list-detail-head">
                      <img className={`market-list-detail-icon ${getQualityClassName(selectedBagItem.quality)}`} src={selectedBagItem.icon} alt={selectedBagItem.name} />
                      <div className="market-list-detail-meta">
                        <div className="market-list-detail-name">{selectedBagItem.name}</div>
                        <div className="market-list-detail-tags">
                          <Tag className={`market-tag market-tag-quality ${getQualityClassName(selectedBagItem.quality)}`}>{selectedBagItem.quality}</Tag>
                          <Tag className="market-tag">{categoryText[selectedBagItem.category]}</Tag>
                          <Tag className="market-tag">数量 {selectedBagItem.qty}</Tag>
                          {selectedBagItem.locked ? <Tag color="red">已锁定</Tag> : null}
                        </div>
                      </div>
                    </div>
                    {selectedBagItem.category !== 'equipment' && selectedBagItem.desc ? (
                      <div className="market-list-detail-desc">{selectedBagItem.desc}</div>
                    ) : null}
                    {selectedBagItem.locked ? (
                      <div className="market-list-locked-tip">物品已锁定，无法上架交易。</div>
                    ) : null}
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
