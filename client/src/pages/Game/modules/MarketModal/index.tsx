import { App, Button, Input, Modal, Pagination, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import {
  buyMarketListing,
  cancelMarketListing,
  createMarketListing,
  getInventoryItems,
  getMarketListings,
  getMarketTradeRecords,
  getMyMarketListings,
} from '../../../../services/api';
import type { MarketListingDto, MarketTradeRecordDto } from '../../../../services/api';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import { useIsMobile } from '../../shared/responsive';
import { getItemQualityMeta, normalizeItemQualityName } from '../../shared/itemQuality';
import InventoryItemCell from '../../shared/InventoryItemCell';
import { ITEM_CATEGORY_ALL_OPTION, ITEM_CATEGORY_LABELS, ITEM_CATEGORY_OPTIONS } from '../../shared/itemTaxonomy';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import MarketItemTooltipContent, {
  ITEM_TOOLTIP_CLASS_NAMES,
} from '../../shared/MarketItemTooltipContent';
import {
  buildBagItem,
  buildEquipmentDetailLines,
  categoryLabels as bagCategoryLabels,
  qualityClass,
  qualityColor,
  qualityLabelText,
  type BagItem,
} from '../BagModal/bagShared';
import { EquipmentDetailAttrList } from '../BagModal/EquipmentDetailAttrList';
import { SetBonusDisplay } from '../BagModal/SetBonusDisplay';
import './index.scss';

type MarketPanel = 'market' | 'my' | 'list' | 'records';

type ItemQuality = '黄' | '玄' | '地' | '天';

type MarketCategory = string;

type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';
type MarketTooltipPlacement = 'rightTop' | 'right' | 'rightBottom';

/* ─── 移动端 Bottom Sheet 组件 ─── */

interface ListSheetProps {
  item: BagItem | null;
  listPrice: string;
  listQty: string;
  canList: boolean;
  equipDetailLines: ReturnType<typeof buildEquipmentDetailLines>;
  setInfo: BagItem['setInfo'];
  effects: string[];
  onClose: () => void;
  onPriceChange: (v: string) => void;
  onQtyChange: (v: string) => void;
  onList: () => void;
}

const ListSheet: React.FC<ListSheetProps> = ({
  item,
  listPrice,
  listQty,
  canList,
  equipDetailLines,
  setInfo,
  effects,
  onClose,
  onPriceChange,
  onQtyChange,
  onList,
}) => {
  if (!item) return null;

  const hasEquipDetail = equipDetailLines.length > 0;
  const hasSetInfo = setInfo && setInfo.bonuses.length > 0;
  const hasEffects = effects.length > 0;

  return (
    <>
      <div className="market-list-sheet-mask" onClick={onClose} />
      <div className="market-list-sheet">
        <div className="market-list-sheet-handle">
          <div className="market-list-sheet-bar" />
        </div>

        {/* 头部 */}
        <div className="market-list-sheet-head">
          <div className={`market-list-sheet-icon-box ${qualityClass[item.quality]}`}>
            <img className="market-list-sheet-icon-img" src={item.icon} alt={item.name} />
          </div>
          <div className="market-list-sheet-meta">
            <div className="market-list-sheet-name" style={{ color: qualityColor[item.quality] }}>
              {item.name}
            </div>
            <div className="market-list-sheet-tags">
              <span className="market-list-sheet-tag market-list-sheet-tag--cat">
                {bagCategoryLabels[item.category]}
              </span>
              <span className={`market-list-sheet-tag market-list-sheet-tag--quality ${qualityClass[item.quality]}`}>
                {qualityLabelText[item.quality]}
              </span>
              {item.locked ? <span className="market-list-sheet-tag market-list-sheet-tag--locked">已锁定</span> : null}
            </div>
            {item.stackMax > 1 && (
              <div className="market-list-sheet-qty">数量 {item.qty} / {item.stackMax}</div>
            )}
          </div>
        </div>

        {/* 详情 */}
        <div className="market-list-sheet-body">
          {item.category !== 'equipment' && item.desc ? (
            <div className="market-list-sheet-section">
              <div className="market-list-sheet-section-title">物品描述</div>
              <div className="market-list-sheet-section-text">{item.desc}</div>
            </div>
          ) : null}

          {hasEquipDetail ? (
            <div className="market-list-sheet-section">
              <div className="market-list-sheet-section-title">装备属性</div>
              <EquipmentDetailAttrList lines={equipDetailLines} variant="mobile" className="market-list-sheet-attr-list" />
            </div>
          ) : null}

          {hasSetInfo ? (
            <div className="market-list-sheet-section">
              <div className="market-list-sheet-section-title">套装效果</div>
              <SetBonusDisplay setInfo={setInfo!} variant="mobile" />
            </div>
          ) : null}

          {hasEffects ? (
            <div className="market-list-sheet-section">
              <div className="market-list-sheet-section-title">效果</div>
              <div className="market-list-sheet-effect-list">
                {effects.map((line) => (
                  <div key={line} className="market-list-sheet-effect-chip">{line}</div>
                ))}
              </div>
            </div>
          ) : null}

          {item.locked ? (
            <div className="market-list-sheet-locked-tip">物品已锁定，无法上架交易。</div>
          ) : null}
        </div>

        {/* 上架表单 */}
        <div className="market-list-sheet-form">
          <div className="market-list-sheet-row">
            <span className="market-list-sheet-label">单价（灵石）</span>
            <input
              className="market-list-sheet-input"
              value={listPrice}
              onChange={(e) => onPriceChange(e.target.value)}
              inputMode="numeric"
              placeholder="请输入单价"
            />
          </div>
          <div className="market-list-sheet-row">
            <span className="market-list-sheet-label">数量</span>
            <input
              className="market-list-sheet-input"
              value={listQty}
              onChange={(e) => onQtyChange(e.target.value)}
              inputMode="numeric"
              placeholder="请输入数量"
            />
          </div>
          <div className="market-list-sheet-actions">
            <button
              className="market-list-sheet-btn is-primary"
              disabled={!canList}
              onClick={onList}
            >
              确认上架
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

type ListingItem = {
  id: number;
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string;
  quality: ItemQuality;
  category: string;
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

const resolveIcon = resolveIconUrl;

const normalizeQuality = (value: unknown): ItemQuality => {
  return normalizeItemQualityName(value, '黄');
};

const getQualityClassName = (value: unknown): string => {
  return getItemQualityMeta(value)?.className ?? '';
};

const normalizeMarketCategory = (value: string | null | undefined): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return 'other';
  return normalized;
};

const toNonNegativeIntegerOrUndefined = (value: string): number | undefined => {
  const parsed = parseMaybeNumber(value);
  if (parsed === null) return undefined;
  return Math.max(0, Math.floor(parsed));
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
  useGameItemTaxonomy(open);
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
  const [marketTooltipPlacement, setMarketTooltipPlacement] = useState<MarketTooltipPlacement>('right');
  const resolveMarketTooltipPlacement = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (!viewportHeight) return;
    const { top, bottom } = event.currentTarget.getBoundingClientRect();
    const nextPlacement: MarketTooltipPlacement = top <= viewportHeight * 0.28 ? 'rightTop' : bottom >= viewportHeight * 0.72 ? 'rightBottom' : 'right';
    setMarketTooltipPlacement((prev) => (prev === nextPlacement ? prev : nextPlacement));
  }, []);
  const getMarketTooltipPopupContainer = useCallback(
    (triggerNode: HTMLElement): HTMLElement => {
      const modalWrap = triggerNode.closest('.ant-modal-wrap');
      return modalWrap instanceof HTMLElement ? modalWrap : document.body;
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
      // 移动端不自动选中第一个物品
      if (!isMobile) {
        setSelectedBagId((prev) => (prev !== null && next.some((b) => b.id === prev) ? prev : next[0]?.id ?? null));
      }
    } catch (error: unknown) {
      void 0;
      setBagItems([]);
      setSelectedBagId(null);
    } finally {
      setBagLoading(false);
    }
  }, [messageRef, isMobile]);

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
        void 0;
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
        void 0;
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
        void 0;
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
      { key: 'my' as const, label: '我的上架', shortLabel: '我的上架' },
      { key: 'list' as const, label: '物品上架', shortLabel: '物品上架' },
      { key: 'records' as const, label: '售卖记录', shortLabel: '售卖记录' },
    ],
    [],
  );
  const menuKeys = useMemo(() => menuItems.map((it) => it.key), [menuItems]);
  const menuOptions = useMemo(
    () => menuItems.map((it) => ({ value: it.key, label: it.shortLabel })),
    [menuItems],
  );
  const categoryOptions = [ITEM_CATEGORY_ALL_OPTION, ...ITEM_CATEGORY_OPTIONS].map((option) => ({
    value: option.value as MarketCategory,
    label: option.label,
  }));
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
        void 0;
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
        void 0;
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
      void 0;
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
                        <Tag className="market-tag">{ITEM_CATEGORY_LABELS[row.category] ?? row.category}</Tag>
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
                      overlayClassName={ITEM_TOOLTIP_CLASS_NAMES.root}
                      classNames={ITEM_TOOLTIP_CLASS_NAMES}
                      placement={marketTooltipPlacement}
                      autoAdjustOverflow
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent item={row} />}
                      getPopupContainer={getMarketTooltipPopupContainer}
                    >
                      <div className={`market-item ${getQualityClassName(row.quality)}`} onMouseEnter={resolveMarketTooltipPlacement}>
                        <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
                            <Tag className="market-tag">{ITEM_CATEGORY_LABELS[row.category] ?? row.category}</Tag>
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
                        <Tag className="market-tag">{ITEM_CATEGORY_LABELS[row.category] ?? row.category}</Tag>
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
                      overlayClassName={ITEM_TOOLTIP_CLASS_NAMES.root}
                      classNames={ITEM_TOOLTIP_CLASS_NAMES}
                      placement={marketTooltipPlacement}
                      autoAdjustOverflow
                      mouseEnterDelay={0.15}
                      title={<MarketItemTooltipContent item={row} />}
                      getPopupContainer={getMarketTooltipPopupContainer}
                    >
                      <div className={`market-item ${getQualityClassName(row.quality)}`} onMouseEnter={resolveMarketTooltipPlacement}>
                        <img className={`market-item-icon ${getQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getQualityClassName(row.quality)}`}>{row.quality}</Tag>
                            <Tag className="market-tag">{ITEM_CATEGORY_LABELS[row.category] ?? row.category}</Tag>
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

    // 装备属性行（用于 EquipmentDetailAttrList）
    const equipDetailLines = selectedBagItem ? buildEquipmentDetailLines(selectedBagItem) : [];
    const hasEquipDetail = equipDetailLines.length > 0;

    // 套装效果
    const setInfo = selectedBagItem?.setInfo ?? null;
    const hasSetInfo = setInfo && setInfo.bonuses.length > 0;

    // 效果/说明
    const effects = selectedBagItem?.effects ?? [];
    const hasEffects = effects.length > 0;

    // 移动端：只显示背包格子 + Bottom Sheet
    if (isMobile) {
      return (
        <div className="market-pane">
          <div className="market-pane-body market-pane-body--mobile-list">
            <div className="market-bag market-bag--mobile">
              <div className="market-bag-grid">
                {bagLoading && bagItems.length === 0 ? <div className="market-empty">加载中...</div> : null}
                {bagItems.map((b) => (
                  <InventoryItemCell
                    key={b.id}
                    className="market-bag-cell"
                    qualityClassName={getQualityClassName(b.quality)}
                    active={selectedBagId === b.id}
                    icon={b.icon}
                    name={b.name}
                    quantity={b.qty}
                    showQuantity={b.stackMax > 1}
                    equippedLabel={b.location === 'equipped' ? '已穿戴' : undefined}
                    lockedLabel={b.locked ? '已锁' : undefined}
                    onClick={() => setSelectedBagId(b.id)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* 移动端 Bottom Sheet */}
          {selectedBagItem && (
            <ListSheet
              item={selectedBagItem}
              listPrice={listPrice}
              listQty={listQty}
              canList={canList}
              equipDetailLines={equipDetailLines}
              setInfo={setInfo}
              effects={effects}
              onClose={() => setSelectedBagId(null)}
              onPriceChange={setListPrice}
              onQtyChange={setListQty}
              onList={doList}
            />
          )}
        </div>
      );
    }

    // 桌面端：左右分栏布局
    return (
      <div className="market-pane">
        <div className="market-pane-top">
          <div className="market-title">物品上架</div>
        </div>
        <div className="market-pane-body">
          <div className="market-list-shell">
            <div className="market-bag">
              <div className="market-bag-grid">
                {bagLoading && bagItems.length === 0 ? <div className="market-empty">加载中...</div> : null}
                {bagItems.map((b) => (
                  <InventoryItemCell
                    key={b.id}
                    className="market-bag-cell"
                    qualityClassName={getQualityClassName(b.quality)}
                    active={selectedBagId === b.id}
                    icon={b.icon}
                    name={b.name}
                    quantity={b.qty}
                    showQuantity={b.stackMax > 1}
                    equippedLabel={b.location === 'equipped' ? '已穿戴' : undefined}
                    lockedLabel={b.locked ? '已锁' : undefined}
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
                          <Tag className="market-tag">{bagCategoryLabels[selectedBagItem.category]}</Tag>
                          <Tag className="market-tag">数量 {selectedBagItem.qty}</Tag>
                          {selectedBagItem.locked ? <Tag color="red">已锁定</Tag> : null}
                        </div>
                      </div>
                    </div>

                    <div className="market-list-detail-scroll">
                      {/* 物品描述 */}
                      {selectedBagItem.category !== 'equipment' && selectedBagItem.desc ? (
                        <div className="market-list-detail-section">
                          <div className="market-list-detail-title">物品描述</div>
                          <div className="market-list-detail-text">{selectedBagItem.desc}</div>
                        </div>
                      ) : null}

                      {/* 装备属性 */}
                      {hasEquipDetail ? (
                        <div className="market-list-detail-section">
                          <div className="market-list-detail-title">装备属性</div>
                          <EquipmentDetailAttrList lines={equipDetailLines} variant="desktop" className="market-list-detail-attr-grid" />
                        </div>
                      ) : null}

                      {/* 套装效果 */}
                      {hasSetInfo && setInfo ? (
                        <div className="market-list-detail-section">
                          <div className="market-list-detail-title">套装效果</div>
                          <SetBonusDisplay setInfo={setInfo} variant="desktop" />
                        </div>
                      ) : null}

                      {/* 效果/说明 */}
                      {hasEffects ? (
                        <div className="market-list-detail-section">
                          <div className="market-list-detail-title">效果 / 说明</div>
                          <div className="market-list-detail-lines">
                            {effects.map((line) => (
                              <div key={line} className="market-list-detail-line">{line}</div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {selectedBagItem.locked ? (
                        <div className="market-list-locked-tip">物品已锁定，无法上架交易。</div>
                      ) : null}
                    </div>

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
      wrapClassName="market-modal-wrap"
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
