import { App, Button, Drawer, Input, Modal, Pagination, Segmented, Select, Table, Tag, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import {
  buyPartnerMarketListing,
  buyMarketListing,
  cancelPartnerMarketListing,
  cancelMarketListing,
  createPartnerMarketListing,
  createMarketListing,
  getInventoryItems,
  getMyPartnerMarketListings,
  getMarketListings,
  getPartnerMarketListings,
  getPartnerMarketTradeRecords,
  getPartnerOverview,
  getMarketTradeRecords,
  getMyMarketListings,
} from '../../../../services/api';
import type {
  MarketListingDto,
  MarketPartnerListingDto,
  MarketPartnerTradeRecordDto,
  MarketTradeRecordDto,
  PartnerDetailDto,
  PartnerDisplayDto,
} from '../../../../services/api';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import { useIsMobile } from '../../shared/responsive';
import { getElementToneClassName } from '../../shared/elementTheme';
import { getItemQualityClassName, getItemQualityTagClassName, normalizeItemQualityName } from '../../shared/itemQuality';
import InventoryItemCell from '../../shared/InventoryItemCell';
import { ITEM_CATEGORY_ALL_OPTION, ITEM_CATEGORY_LABELS, ITEM_CATEGORY_OPTIONS } from '../../shared/itemTaxonomy';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import { getLearnableTechniqueId } from '../../shared/learnableTechnique';
import {
  formatPartnerAttrValue,
  formatPartnerElementLabel,
  getPartnerAttrLabel,
  getPartnerVisibleCombatAttrs,
  resolvePartnerAvatar,
} from '../../shared/partnerDisplay';
import { dispatchPartnerChangedEvent, PARTNER_CHANGED_EVENT } from '../../shared/partnerTradeEvents';
import MarketItemTooltipContent, {
  ITEM_TOOLTIP_CLASS_NAMES,
} from '../../shared/MarketItemTooltipContent';
import MarketBuyDialog from './MarketBuyDialog';
import MarketPartnerPreviewSheet from './MarketPartnerPreviewSheet';
import MarketPartnerBuyModal from './MarketPartnerBuyModal';
import MarketEquipmentSummary from './MarketEquipmentSummary';
import {
  buildMarketEquipmentSummary,
  type MarketEquipmentSummaryItem,
} from './marketEquipmentSummary';
import {
  buildMarketBuySummary,
  shouldPromptMarketBuyQuantity,
} from './marketBuyShared';
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
import type { SocketedGemEntry } from '../../shared/socketedGemDisplay';
import './index.scss';

type MarketPanel = 'market' | 'my' | 'list' | 'records';
type MarketAssetType = 'item' | 'partner';

type ItemQuality = '黄' | '玄' | '地' | '天';

type MarketCategory = string;

type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';
type MarketTooltipPlacement = 'rightTop' | 'right' | 'rightBottom';
type MobileListingPreviewSource = 'market' | 'my';

type MobileListingPreview = {
  source: MobileListingPreviewSource;
  listingId: number;
};

interface MarketPartnerStatusTagData {
  isActive: boolean;
  tradeStatus: string;
}

const renderMarketPartnerStatusTags = ({ isActive, tradeStatus }: MarketPartnerStatusTagData): ReactElement => (
  <>
    {isActive ? <Tag className="market-tag market-tag-state market-tag-state--active">当前出战</Tag> : null}
    {tradeStatus === 'market_listed' ? <Tag className="market-tag market-tag-state market-tag-state--listed">坊市中</Tag> : null}
  </>
);

const renderMarketPartnerSheetStatusTags = ({ isActive, tradeStatus }: MarketPartnerStatusTagData): ReactElement => (
  <>
    {isActive ? <span className="market-list-sheet-tag market-list-sheet-tag--active">当前出战</span> : null}
    {tradeStatus === 'market_listed' ? <span className="market-list-sheet-tag market-list-sheet-tag--listed">坊市中</span> : null}
  </>
);

/* ─── 移动端 Bottom Sheet 组件 ─── */

interface ListSheetProps {
  item: BagItem | null;
  listPrice: string;
  listQty: string;
  listingFeeText: string;
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
  listingFeeText,
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
                <span className={`market-list-sheet-tag market-list-sheet-tag--quality ${getItemQualityTagClassName(item.quality)}`}>
                  {qualityLabelText[item.quality]}
                </span>
              <span className="market-list-sheet-tag market-list-sheet-tag--bind">{item.bind.detailLabel}</span>
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
          <div className="market-list-sheet-row">
            <span className="market-list-sheet-label">手续费（银两）</span>
            <span className="market-list-sheet-value">{listingFeeText}</span>
          </div>
          <div className="market-list-sheet-fee-tip">未卖出下架会退还手续费</div>
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

interface PartnerListSheetProps {
  partner: PartnerDetailDto | null;
  listPrice: string;
  listingFeeText: string;
  canList: boolean;
  onClose: () => void;
  onPriceChange: (v: string) => void;
  onList: () => void;
}

const PartnerListSheet: React.FC<PartnerListSheetProps> = ({
  partner,
  listPrice,
  listingFeeText,
  canList,
  onClose,
  onPriceChange,
  onList,
}) => {
  if (!partner) return null;

  return (
    <>
      <div className="market-list-sheet-mask" onClick={onClose} />
      <div className="market-list-sheet">
        <div className="market-list-sheet-handle">
          <div className="market-list-sheet-bar" />
        </div>

        {/* 头部 */}
        <div className="market-list-sheet-head">
          <div className="market-list-sheet-head-main">
            <div className="market-list-sheet-icon-box">
              <img className="market-list-sheet-icon-img" style={{ borderRadius: '12px', width: '100%', height: '100%' }} src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
            </div>
            <div className="market-list-sheet-meta">
              <div className="market-list-sheet-name">
                {partner.nickname || partner.name}
              </div>
              <div className="market-list-sheet-tags">
                <span className={`market-list-sheet-tag market-list-sheet-tag--quality ${getItemQualityTagClassName(partner.quality)}`}>
                  {partner.quality}
                </span>
                <span className={`market-list-sheet-tag ${getElementToneClassName(partner.element)}`}>{formatPartnerElementLabel(partner.element)}</span>
                <span className="market-list-sheet-tag">{partner.role}</span>
                <span className="market-list-sheet-tag">等级 {partner.level}</span>
                {renderMarketPartnerSheetStatusTags(partner)}
              </div>
              <div className="market-list-sheet-qty">{partner.name}</div>
            </div>
          </div>
          {partner.isActive ? (
            <div className="market-list-sheet-locked-tip">出战中的伙伴不可上架，请先下阵。</div>
          ) : null}
          {partner.tradeStatus === 'market_listed' ? (
            <div className="market-list-sheet-locked-tip">该伙伴已在坊市挂单中，无法重复上架。</div>
          ) : null}
        </div>

        {/* 详情 */}
        <div className="market-list-sheet-body">
          <div className="market-list-sheet-section">
            <div className="market-list-sheet-section-title">属性</div>
            <div className="market-list-sheet-effect-list">
              {buildPartnerAllAttrsPreview(partner).map((line) => (
                <div key={line} className="market-list-sheet-effect-chip">{line}</div>
              ))}
            </div>
          </div>
          <div className="market-list-sheet-section">
            <div className="market-list-sheet-section-title">功法</div>
            <div className="market-partner-technique-grid">
              {partner.techniques.length > 0 ? (
                partner.techniques.map((tech) => (
                  <div key={tech.techniqueId} className="market-partner-technique-cell">
                    <div className="market-partner-technique-name">{tech.name} <span className="market-partner-technique-level">一层</span></div>
                    <div className="market-partner-technique-desc">{tech.description || '暂无描述'}</div>
                  </div>
                ))
              ) : (
                <div className="market-list-detail-text">暂无功法</div>
              )}
            </div>
          </div>
        </div>

        {/* 上架表单 */}
        <div className="market-list-sheet-form">
          <div className="market-list-sheet-row">
            <span className="market-list-sheet-label">一口价（灵石）</span>
            <input
              className="market-list-sheet-input"
              value={listPrice}
              onChange={(e) => onPriceChange(e.target.value)}
              inputMode="numeric"
              placeholder="请输入伙伴售价"
            />
          </div>
          <div className="market-list-sheet-row">
            <span className="market-list-sheet-label">手续费（银两）</span>
            <span className="market-list-sheet-value">{listingFeeText}</span>
          </div>
          <div className="market-list-sheet-fee-tip">未卖出下架会退还手续费</div>
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
  socketedGems: string | SocketedGemEntry[] | null;
  learnableTechniqueId: string | null;
  equipmentSummary: MarketEquipmentSummaryItem[];
  qty: number;
  unitPrice: number;
  seller: string;
  sellerCharacterId: number;
  listedAt: number;
};

type PartnerListingItem = {
  id: number;
  partner: PartnerDisplayDto;
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

type PartnerTradeRecord = {
  id: number;
  type: TradeRecordType;
  partner: PartnerDisplayDto;
  unitPrice: number;
  totalPrice: number;
  counterparty: string;
  time: number;
};

const resolveIcon = resolveIconUrl;

const normalizeQuality = (value: unknown): ItemQuality => {
  return normalizeItemQualityName(value, '黄');
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
  const socketedGems =
    typeof dto.socketedGems === 'string'
      ? dto.socketedGems
      : Array.isArray(dto.socketedGems)
        ? (dto.socketedGems as SocketedGemEntry[])
        : null;
  const strengthenLevel = Math.max(0, Math.floor(Number(dto.strengthenLevel) || 0));
  const refineLevel = Math.max(0, Math.floor(Number(dto.refineLevel) || 0));
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
    strengthenLevel,
    refineLevel,
    identified: Boolean(dto.identified),
    affixes: dto.affixes ?? [],
    socketedGems,
    learnableTechniqueId: getLearnableTechniqueId({
      generated_technique_id: dto.generatedTechniqueId,
      effect_defs: dto.effectDefs,
    }),
    equipmentSummary: buildMarketEquipmentSummary({
      category,
      strengthenLevel,
      refineLevel,
      socketedGems,
    }),
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

const buildPartnerListingItem = (dto: MarketPartnerListingDto): PartnerListingItem => {
  return {
    id: Number(dto.id),
    partner: dto.partner,
    unitPrice: Number(dto.unitPriceSpiritStones) || 0,
    seller: String(dto.sellerName ?? ''),
    sellerCharacterId: Number(dto.sellerCharacterId) || 0,
    listedAt: Number(dto.listedAt) || 0,
  };
};

const buildPartnerTradeRecord = (dto: MarketPartnerTradeRecordDto): PartnerTradeRecord => {
  return {
    id: Number(dto.id),
    type: dto.type === '卖出' ? '卖出' : '买入',
    partner: dto.partner,
    unitPrice: Number(dto.unitPriceSpiritStones) || 0,
    totalPrice: Number(dto.totalPriceSpiritStones) || 0,
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

const MARKET_LISTING_FEE_SILVER_PER_SPIRIT_STONE = 5;

const calculateListingFeeSilver = (priceInput: string, qtyInput: string): number | null => {
  const unitPrice = parseMaybeNumber(priceInput);
  const qty = parseMaybeNumber(qtyInput);
  if (!unitPrice || !qty) return null;
  const safeUnitPrice = Math.floor(unitPrice);
  const safeQty = Math.floor(qty);
  if (safeUnitPrice <= 0 || safeQty <= 0) return null;
  return safeUnitPrice * safeQty * MARKET_LISTING_FEE_SILVER_PER_SPIRIT_STONE;
};

const buildPartnerAllAttrsPreview = (partner: PartnerDisplayDto): string[] => {
  return getPartnerVisibleCombatAttrs(partner.computedAttrs)
    .map((entry) => `${getPartnerAttrLabel(entry.key)} ${formatPartnerAttrValue(entry.key, entry.value)}`);
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

  const [assetType, setAssetType] = useState<MarketAssetType>('item');
  const [panel, setPanel] = useState<MarketPanel>('market');
  const isMobile = useIsMobile();
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);

  const [category, setCategory] = useState<MarketCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MarketSort>('timeDesc');
  const [quality, setQuality] = useState<ItemQuality | 'all'>('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [partnerQuery, setPartnerQuery] = useState('');
  const [partnerSort, setPartnerSort] = useState<'timeDesc' | 'priceAsc' | 'priceDesc' | 'levelDesc'>('timeDesc');
  const [partnerQuality, setPartnerQuality] = useState<'all' | '黄' | '玄' | '地' | '天'>('all');
  const [partnerElement, setPartnerElement] = useState<'all' | 'none' | 'jin' | 'mu' | 'shui' | 'huo' | 'tu' | 'an'>('all');

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
  const [partnerMarketLoading, setPartnerMarketLoading] = useState(false);
  const [partnerMarketListings, setPartnerMarketListings] = useState<PartnerListingItem[]>([]);
  const [partnerMarketTotal, setPartnerMarketTotal] = useState(0);

  const [myLoading, setMyLoading] = useState(false);
  const [myListings, setMyListings] = useState<ListingItem[]>([]);
  const [myTotal, setMyTotal] = useState(0);
  const [myPartnerLoading, setMyPartnerLoading] = useState(false);
  const [myPartnerListings, setMyPartnerListings] = useState<PartnerListingItem[]>([]);
  const [myPartnerTotal, setMyPartnerTotal] = useState(0);

  const [recordsLoading, setRecordsLoading] = useState(false);
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [partnerRecordsLoading, setPartnerRecordsLoading] = useState(false);
  const [partnerRecords, setPartnerRecords] = useState<PartnerTradeRecord[]>([]);
  const [partnerRecordsTotal, setPartnerRecordsTotal] = useState(0);
  const [marketTooltipPlacement, setMarketTooltipPlacement] = useState<MarketTooltipPlacement>('right');
  const [mobileListingPreview, setMobileListingPreview] = useState<MobileListingPreview | null>(null);
  const [buyDialogListing, setBuyDialogListing] = useState<ListingItem | null>(null);
  const [partnerOverviewLoading, setPartnerOverviewLoading] = useState(false);
  const [partnerOverview, setPartnerOverview] = useState<PartnerDetailDto[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);
  const [previewPartnerListing, setPreviewPartnerListing] = useState<PartnerListingItem | null>(null);
  const [partnerListPrice, setPartnerListPrice] = useState('');
  const [partnerListingActionLoading, setPartnerListingActionLoading] = useState(false);
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

  const handlePartnerSortChange = useCallback(
    (value: 'timeDesc' | 'priceAsc' | 'priceDesc' | 'levelDesc') => {
      setPartnerSort(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handlePartnerQueryChange = useCallback(
    (value: string) => {
      setPartnerQuery(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handlePartnerQualityChange = useCallback(
    (value: 'all' | '黄' | '玄' | '地' | '天') => {
      setPartnerQuality(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const handlePartnerElementChange = useCallback(
    (value: 'all' | 'none' | 'jin' | 'mu' | 'shui' | 'huo' | 'tu' | 'an') => {
      setPartnerElement(value);
      resetMarketPage();
    },
    [resetMarketPage],
  );

  const selectedBagItem = useMemo(
    () => (selectedBagId === null ? null : bagItems.find((b) => b.id === selectedBagId) ?? null),
    [bagItems, selectedBagId],
  );
  const selectedPartner = useMemo(
    () => (selectedPartnerId === null ? null : partnerOverview.find((partner) => partner.id === selectedPartnerId) ?? null),
    [partnerOverview, selectedPartnerId],
  );
  const mobilePreviewListing = useMemo(() => {
    if (!mobileListingPreview) return null;
    const sourceListings = mobileListingPreview.source === 'market' ? marketListings : myListings;
    return sourceListings.find((listing) => listing.id === mobileListingPreview.listingId) ?? null;
  }, [marketListings, mobileListingPreview, myListings]);

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

  const refreshPartnerMarket = useCallback(
    async (page: number) => {
      setPartnerMarketLoading(true);
      try {
        const res = await getPartnerMarketListings({
          quality: partnerQuality,
          element: partnerElement,
          query: partnerQuery.trim(),
          sort: partnerSort,
          page,
          pageSize,
        });
        if (!res.success || !res.data) throw new Error(res.message || '获取伙伴坊市失败');
        setPartnerMarketListings(res.data.listings.map(buildPartnerListingItem));
        setPartnerMarketTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        void 0;
        setPartnerMarketListings([]);
        setPartnerMarketTotal(0);
      } finally {
        setPartnerMarketLoading(false);
      }
    },
    [pageSize, partnerElement, partnerQuality, partnerQuery, partnerSort],
  );

  const refreshMyPartnerListings = useCallback(
    async (page: number) => {
      setMyPartnerLoading(true);
      try {
        const res = await getMyPartnerMarketListings({ status: 'active', page, pageSize });
        if (!res.success || !res.data) throw new Error(res.message || '获取我的伙伴上架失败');
        setMyPartnerListings(res.data.listings.map(buildPartnerListingItem));
        setMyPartnerTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        void 0;
        setMyPartnerListings([]);
        setMyPartnerTotal(0);
      } finally {
        setMyPartnerLoading(false);
      }
    },
    [pageSize],
  );

  const refreshPartnerRecords = useCallback(
    async (page: number) => {
      setPartnerRecordsLoading(true);
      try {
        const res = await getPartnerMarketTradeRecords({ page, pageSize });
        if (!res.success || !res.data) throw new Error(res.message || '获取伙伴交易记录失败');
        setPartnerRecords(res.data.records.map(buildPartnerTradeRecord));
        setPartnerRecordsTotal(Number(res.data.total) || 0);
      } catch (error: unknown) {
        void 0;
        setPartnerRecords([]);
        setPartnerRecordsTotal(0);
      } finally {
        setPartnerRecordsLoading(false);
      }
    },
    [pageSize],
  );

  const refreshPartnerOverview = useCallback(async () => {
    setPartnerOverviewLoading(true);
    try {
      const res = await getPartnerOverview();
      if (!res.success || !res.data) throw new Error(res.message || '获取伙伴总览失败');
      const nextPartners = res.data.partners;
      setPartnerOverview(nextPartners);
      setSelectedPartnerId((prev) => (prev !== null && nextPartners.some((partner) => partner.id === prev) ? prev : nextPartners[0]?.id ?? null));
    } catch (error: unknown) {
      void 0;
      setPartnerOverview([]);
      setSelectedPartnerId(null);
    } finally {
      setPartnerOverviewLoading(false);
    }
  }, []);

  const resetAll = () => {
    setAssetType('item');
    setPanel('market');
    setCategory('all');
    setQuery('');
    setSort('timeDesc');
    setQuality('all');
    setMinPrice('');
    setMaxPrice('');
    setPartnerQuery('');
    setPartnerSort('timeDesc');
    setPartnerQuality('all');
    setPartnerElement('all');
    setMarketPage(1);
    setMyPage(1);
    setRecordPage(1);
    setSelectedBagId(null);
    setListPrice('');
    setListQty('1');
    setPartnerListPrice('');
    setPartnerOverview([]);
    setSelectedPartnerId(null);
    setMobileFilterOpen(false);
    setMobileListingPreview(null);
    setBuyDialogListing(null);
  };

  const menuItems = useMemo(
    () => [
      { key: 'market' as const, label: assetType === 'item' ? '坊市' : '伙伴坊市', shortLabel: assetType === 'item' ? '坊市' : '伙伴坊市' },
      { key: 'my' as const, label: '我的上架', shortLabel: '我的上架' },
      { key: 'list' as const, label: assetType === 'item' ? '物品上架' : '伙伴上架', shortLabel: assetType === 'item' ? '物品上架' : '伙伴上架' },
      { key: 'records' as const, label: assetType === 'item' ? '售卖记录' : '伙伴记录', shortLabel: assetType === 'item' ? '售卖记录' : '伙伴记录' },
    ],
    [assetType],
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
  const assetOptions = useMemo(
    () => [
      { value: 'item' as const, label: '物品坊市' },
      { value: 'partner' as const, label: '伙伴坊市' },
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
  const partnerSortOptions = useMemo(
    () => [
      { value: 'timeDesc', label: '最新上架' },
      { value: 'priceAsc', label: '价格升序' },
      { value: 'priceDesc', label: '价格降序' },
      { value: 'levelDesc', label: '等级降序' },
    ],
    [],
  );
  const partnerQualityOptions = qualityOptions;
  const partnerElementOptions = useMemo(
    () => [
      { value: 'all', label: '全部属性' },
      { value: 'none', label: '无属性' },
      { value: 'jin', label: '金' },
      { value: 'mu', label: '木' },
      { value: 'shui', label: '水' },
      { value: 'huo', label: '火' },
      { value: 'tu', label: '土' },
      { value: 'an', label: '暗' },
    ],
    [],
  );

  useEffect(() => {
    if (!open || assetType !== 'item') return;
    setMarketPage(1);
    void refreshMarket(1);
  }, [assetType, category, maxPrice, minPrice, open, quality, query, refreshMarket, sort]);

  useEffect(() => {
    if (!open || assetType !== 'partner') return;
    setMarketPage(1);
    void refreshPartnerMarket(1);
  }, [assetType, open, partnerElement, partnerQuality, partnerQuery, partnerSort, refreshPartnerMarket]);

  useEffect(() => {
    if (!open) return;
    if (panel === 'market') {
      if (assetType === 'item') {
        void refreshMarket(marketPage);
      } else {
        void refreshPartnerMarket(marketPage);
      }
      return;
    }
    if (panel === 'my') {
      if (assetType === 'item') {
        void refreshMy(myPage);
      } else {
        void refreshMyPartnerListings(myPage);
      }
      return;
    }
    if (panel === 'list') {
      if (assetType === 'item') {
        void refreshBag();
      } else {
        void refreshPartnerOverview();
      }
      return;
    }
    if (assetType === 'item') {
      void refreshRecords(recordPage);
    } else {
      void refreshPartnerRecords(recordPage);
    }
  }, [assetType, marketPage, myPage, open, panel, recordPage, refreshBag, refreshMarket, refreshMy, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview, refreshPartnerRecords, refreshRecords]);

  useEffect(() => {
    if (!isMobile) setMobileFilterOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileListingPreview) return;
    if (mobilePreviewListing) return;
    setMobileListingPreview(null);
  }, [mobileListingPreview, mobilePreviewListing]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = () => {
      if (assetType !== 'partner') return;
      if (panel === 'market') void refreshPartnerMarket(marketPage);
      if (panel === 'my') void refreshMyPartnerListings(myPage);
      if (panel === 'list') void refreshPartnerOverview();
      if (panel === 'records') void refreshPartnerRecords(recordPage);
    };
    window.addEventListener(PARTNER_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PARTNER_CHANGED_EVENT, handler);
  }, [assetType, marketPage, myPage, open, panel, recordPage, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview, refreshPartnerRecords]);

  const handlePanelChange = useCallback(
    (nextPanel: MarketPanel) => {
      setPanel(nextPanel);
      if (nextPanel === 'market') {
        setMarketPage(1);
        if (assetType === 'item') {
          void refreshMarket(1);
        } else {
          void refreshPartnerMarket(1);
        }
      }
      if (nextPanel === 'my') {
        setMyPage(1);
        if (assetType === 'item') {
          void refreshMy(1);
        } else {
          void refreshMyPartnerListings(1);
        }
      }
      if (nextPanel === 'list') {
        if (assetType === 'item') {
          void refreshBag();
        } else {
          void refreshPartnerOverview();
        }
      }
      if (nextPanel === 'records') {
        setRecordPage(1);
        if (assetType === 'item') {
          void refreshRecords(1);
        } else {
          void refreshPartnerRecords(1);
        }
      }
    },
    [assetType, refreshBag, refreshMarket, refreshMy, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview, refreshPartnerRecords, refreshRecords],
  );

  const handleAssetTypeChange = useCallback(
    (nextAssetType: MarketAssetType) => {
      setAssetType(nextAssetType);
      setPanel('market');
      setMarketPage(1);
      setMyPage(1);
      setRecordPage(1);
      setMobileFilterOpen(false);
      if (nextAssetType === 'item') {
        void refreshMarket(1);
      } else {
        void refreshPartnerMarket(1);
      }
    },
    [refreshMarket, refreshPartnerMarket],
  );

  const buyListing = useCallback(
    async (row: ListingItem, requestedQty: number = 1) => {
      if (characterId !== null && row.sellerCharacterId === characterId) return;
      const summary = buildMarketBuySummary({
        listingQty: row.qty,
        draftQty: requestedQty,
        unitPrice: row.unitPrice,
      });
      try {
        const res = await buyMarketListing(row.id, summary.buyQty);
        if (!res.success) throw new Error(res.message || '购买失败');
        messageRef.current.success('购买成功');
        setBuyDialogListing(null);
        setMobileListingPreview(null);
        await Promise.all([refreshMarket(marketPage), refreshBag(), refreshMy(myPage), refreshRecords(recordPage)]);
      } catch (error: unknown) {
        void 0;
      }
    },
    [characterId, marketPage, myPage, recordPage, refreshBag, refreshMarket, refreshMy, refreshRecords],
  );

  const startBuyListing = useCallback(
    (row: ListingItem) => {
      if (characterId !== null && row.sellerCharacterId === characterId) return;
      if (!shouldPromptMarketBuyQuantity(row.qty)) {
        void buyListing(row, 1);
        return;
      }
      setBuyDialogListing(row);
    },
    [buyListing, characterId],
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

  const buyPartnerListing = useCallback(
    async (row: PartnerListingItem) => {
      if (characterId !== null && row.sellerCharacterId === characterId) return;
      try {
        const res = await buyPartnerMarketListing(row.id);
        if (!res.success) throw new Error(res.message || '购买失败');
        messageRef.current.success(res.message || '购买成功');
        dispatchPartnerChangedEvent();
        gameSocket.refreshCharacter();
        await Promise.all([
          refreshPartnerMarket(marketPage),
          refreshMyPartnerListings(myPage),
          refreshPartnerRecords(recordPage),
          refreshPartnerOverview(),
        ]);
      } catch (error: unknown) {
        void 0;
      }
    },
    [characterId, marketPage, myPage, recordPage, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview, refreshPartnerRecords],
  );

  const unlistPartner = useCallback(
    async (row: PartnerListingItem) => {
      try {
        const res = await cancelPartnerMarketListing(row.id);
        if (!res.success) throw new Error(res.message || '下架失败');
        messageRef.current.success(res.message || '下架成功');
        dispatchPartnerChangedEvent();
        gameSocket.refreshCharacter();
        await Promise.all([
          refreshPartnerMarket(marketPage),
          refreshMyPartnerListings(myPage),
          refreshPartnerOverview(),
        ]);
      } catch (error: unknown) {
        void 0;
      }
    },
    [marketPage, myPage, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview],
  );

  const doListPartner = useCallback(async () => {
    if (!selectedPartner) return;
    if (selectedPartner.isActive || selectedPartner.tradeStatus === 'market_listed') return;
    const price = parseMaybeNumber(partnerListPrice);
    if (!price || price <= 0) return;

    setPartnerListingActionLoading(true);
    try {
      const res = await createPartnerMarketListing({
        partnerId: selectedPartner.id,
        unitPriceSpiritStones: Math.floor(price),
      });
      if (!res.success) throw new Error(res.message || '上架失败');
      messageRef.current.success(res.message || '上架成功');
      setPanel('my');
      setPartnerListPrice('');
      dispatchPartnerChangedEvent();
      gameSocket.refreshCharacter();
      await Promise.all([
        refreshPartnerMarket(marketPage),
        refreshMyPartnerListings(myPage),
        refreshPartnerOverview(),
      ]);
    } catch (error: unknown) {
      void 0;
    } finally {
      setPartnerListingActionLoading(false);
    }
  }, [marketPage, myPage, partnerListPrice, refreshMyPartnerListings, refreshPartnerMarket, refreshPartnerOverview, selectedPartner]);

  const renderPartnerFilters = () => {
    const hasAdvancedFilters =
      partnerSort !== 'timeDesc' || partnerQuality !== 'all' || partnerElement !== 'all';

    return (
      <>
        <div className="market-filters">
          <Select
            value={partnerSort}
            onChange={handlePartnerSortChange}
            options={partnerSortOptions}
          />
          <Input
            value={partnerQuery}
            onChange={(e) => handlePartnerQueryChange(e.target.value)}
            placeholder="搜索伙伴/卖家"
            allowClear
            suffix={<SearchOutlined />}
          />
          <Select
            value={partnerQuality}
            onChange={handlePartnerQualityChange}
            options={partnerQualityOptions}
          />
          <Select
            value={partnerElement}
            onChange={handlePartnerElementChange}
            options={partnerElementOptions}
          />
        </div>
        <div className="market-filters-mobile">
          <div className="market-filters-mobile-search">
            <Input
              value={partnerQuery}
              onChange={(e) => handlePartnerQueryChange(e.target.value)}
              placeholder="搜索伙伴/卖家"
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
              <div className="market-filters-mobile-grid market-filters-mobile-grid--partner">
                <Select
                  value={partnerSort}
                  onChange={handlePartnerSortChange}
                  options={partnerSortOptions}
                />
                <Select
                  value={partnerQuality}
                  onChange={handlePartnerQualityChange}
                  options={partnerQualityOptions}
                />
                <Select
                  value={partnerElement}
                  onChange={handlePartnerElementChange}
                  options={partnerElementOptions}
                />
              </div>
            </div>
          ) : null}
        </div>
      </>
    );
  };

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

  const renderAssetSwitch = (className: string) => (
    <Segmented
      className={className}
      value={assetType}
      options={assetOptions}
      onChange={(value) => {
        if (value !== 'item' && value !== 'partner') return;
        handleAssetTypeChange(value);
      }}
    />
  );

  const renderPaneHeader = (title: string) => (
    <div className="market-pane-top">
      <div className="market-pane-head-row">
        <div className="market-title">{title}</div>
        {renderAssetSwitch('market-asset-switch')}
      </div>
    </div>
  );

  const renderMarket = () => (
    <div className="market-pane">
      {renderPaneHeader('坊市')}
      <div className="market-pane-body">
        <div className="market-market-filters-wrap">{renderMarketFilters()}</div>
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {marketLoading && marketListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {marketListings.map((row) => (
                <div
                  key={row.id}
                  className={`market-mobile-card ${getItemQualityClassName(row.quality)}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setMobileListingPreview({ source: 'market', listingId: row.id })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setMobileListingPreview({ source: 'market', listingId: row.id });
                  }}
                >
                  <div className="market-mobile-card-head">
                    <img className={`market-item-icon ${getItemQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                      <div className="market-mobile-head-main">
                        <div className="market-item-name">{row.name}</div>
                        <MarketEquipmentSummary items={row.equipmentSummary} />
                        <div className="market-item-tags">
                          <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.quality)}`}>{row.quality}</Tag>
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
                        onClick={(event) => {
                          event.stopPropagation();
                          startBuyListing(row);
                        }}
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
                      <div className={`market-item ${getItemQualityClassName(row.quality)}`} onMouseEnter={resolveMarketTooltipPlacement}>
                        <img className={`market-item-icon ${getItemQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <MarketEquipmentSummary items={row.equipmentSummary} />
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.quality)}`}>{row.quality}</Tag>
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
                      onClick={() => startBuyListing(row)}
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

  const renderPartnerMarket = () => (
    <div className="market-pane">
      {renderPaneHeader('伙伴坊市')}
      <div className="market-pane-body">
        <div className="market-market-filters-wrap">{renderPartnerFilters()}</div>
        <div className="market-pane-scroll">
          <div className="market-mobile-list">
            {partnerMarketLoading && partnerMarketListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
            {partnerMarketListings.map((row) => {
              return (
                <div key={row.id} className="market-mobile-card market-mobile-card--partner">
                  <div 
                    className="market-mobile-card-head"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setPreviewPartnerListing(row)}
                  >
                    <img className="market-partner-avatar" src={resolvePartnerAvatar(row.partner.avatar)} alt={row.partner.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.partner.nickname || row.partner.name} <span className="market-partner-level">Lv.{row.partner.level}</span></div>
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.partner.quality)}`}>{row.partner.quality}</Tag>
                        <Tag className={`market-tag ${getElementToneClassName(row.partner.element)}`}>{formatPartnerElementLabel(row.partner.element)}</Tag>
                        <Tag className="market-tag">{row.partner.role}</Tag>
                        {row.seller === playerName ? <Tag className="market-tag market-tag-mine">我的上架</Tag> : null}
                      </div>
                    </div>
                    <div className="market-mobile-price">
                      <div className="market-mobile-price-label">一口价</div>
                      <div className="market-mobile-price-value">{row.unitPrice.toLocaleString()} 灵石</div>
                    </div>
                  </div>
                  <div className="market-mobile-card-foot">
                    <div className="market-mobile-meta-line">
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">卖家</span>
                        <span className="market-mobile-meta-v">{row.seller}</span>
                      </span>
                      <span className="market-mobile-meta-item">
                        <span className="market-mobile-meta-k">时间</span>
                        <span className="market-mobile-meta-v">
                          {row.listedAt > 0 ? new Date(row.listedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                        </span>
                      </span>
                    </div>
                    <div className="market-mobile-actions">
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => {
                          setPreviewPartnerListing(row);
                        }}
                      >
                        购买伙伴
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {!partnerMarketLoading && partnerMarketListings.length === 0 ? <div className="market-empty">暂无上架伙伴</div> : null}
          </div>
        </div>
        <div className="market-pagination-bar">
          <Pagination
            current={marketPage}
            pageSize={pageSize}
            total={partnerMarketTotal}
            onChange={(p) => {
              setMarketPage(p);
              void refreshPartnerMarket(p);
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
      {renderPaneHeader('我的上架')}
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          {isMobile ? (
            <div className="market-mobile-list">
              {myLoading && myListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
              {myListings.map((row) => (
                <div
                  key={row.id}
                  className={`market-mobile-card ${getItemQualityClassName(row.quality)}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setMobileListingPreview({ source: 'my', listingId: row.id })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setMobileListingPreview({ source: 'my', listingId: row.id });
                  }}
                >
                  <div className="market-mobile-card-head">
                    <img className={`market-item-icon ${getItemQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                    <div className="market-mobile-head-main">
                      <div className="market-item-name">{row.name}</div>
                      <MarketEquipmentSummary items={row.equipmentSummary} />
                      <div className="market-item-tags">
                        <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.quality)}`}>{row.quality}</Tag>
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
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          void unlistMyItem(row);
                        }}
                      >
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
                      <div className={`market-item ${getItemQualityClassName(row.quality)}`} onMouseEnter={resolveMarketTooltipPlacement}>
                        <img className={`market-item-icon ${getItemQualityClassName(row.quality)}`} src={row.icon} alt={row.name} />
                        <div className="market-item-meta">
                          <div className="market-item-name">{row.name}</div>
                          <MarketEquipmentSummary items={row.equipmentSummary} />
                          <div className="market-item-tags">
                            <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.quality)}`}>{row.quality}</Tag>
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

  const renderMyPartnerListings = () => (
    <div className="market-pane">
      {renderPaneHeader('我的上架')}
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          <div className="market-mobile-list">
            {myPartnerLoading && myPartnerListings.length === 0 ? <div className="market-empty">加载中...</div> : null}
            {myPartnerListings.map((row) => (
              <div key={row.id} className="market-mobile-card market-mobile-card--partner">
                <div 
                  className="market-mobile-card-head"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setPreviewPartnerListing(row)}
                >
                  <img className="market-partner-avatar" src={resolvePartnerAvatar(row.partner.avatar)} alt={row.partner.name} />
                  <div className="market-mobile-head-main">
                    <div className="market-item-name">{row.partner.nickname || row.partner.name} <span className="market-partner-level">Lv.{row.partner.level}</span></div>
                    <div className="market-item-tags">
                      <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.partner.quality)}`}>{row.partner.quality}</Tag>
                      <Tag className={`market-tag ${getElementToneClassName(row.partner.element)}`}>{formatPartnerElementLabel(row.partner.element)}</Tag>
                      <Tag className="market-tag">{row.partner.role}</Tag>
                    </div>
                  </div>
                  <div className="market-mobile-price">
                    <div className="market-mobile-price-label">一口价</div>
                    <div className="market-mobile-price-value">{row.unitPrice.toLocaleString()} 灵石</div>
                  </div>
                </div>
                <div className="market-mobile-card-foot">
                  <div className="market-mobile-meta-line">
                    <span className="market-mobile-meta-item">
                      <span className="market-mobile-meta-k">时间</span>
                      <span className="market-mobile-meta-v">
                        {row.listedAt > 0 ? new Date(row.listedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                      </span>
                    </span>
                  </div>
                  <div className="market-mobile-actions">
                    <Button
                      size="small"
                      onClick={() => {
                        void unlistPartner(row);
                      }}
                    >
                      下架
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {!myPartnerLoading && myPartnerListings.length === 0 ? <div className="market-empty">暂无上架伙伴</div> : null}
          </div>
        </div>
        <div className="market-pagination-bar">
          <Pagination
            current={myPage}
            pageSize={pageSize}
            total={myPartnerTotal}
            onChange={(p) => {
              setMyPage(p);
              void refreshMyPartnerListings(p);
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
    const listingFeeSilver = calculateListingFeeSilver(listPrice, listQty);
    const listingFeeText = listingFeeSilver === null ? '--' : `${listingFeeSilver.toLocaleString()} 银两`;
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
                    qualityClassName={getItemQualityClassName(b.quality)}
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
              listingFeeText={listingFeeText}
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
                    qualityClassName={getItemQualityClassName(b.quality)}
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
                      <div className="market-list-detail-head-main">
                        <img className={`market-list-detail-icon ${getItemQualityClassName(selectedBagItem.quality)}`} src={selectedBagItem.icon} alt={selectedBagItem.name} />
                        <div className="market-list-detail-meta">
                          <div className="market-list-detail-name">{selectedBagItem.name}</div>
                          <div className="market-list-detail-tags">
                            <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(selectedBagItem.quality)}`}>{selectedBagItem.quality}</Tag>
                            <Tag className="market-tag">{bagCategoryLabels[selectedBagItem.category]}</Tag>
                            <Tag className="market-tag">{selectedBagItem.bind.detailLabel}</Tag>
                            <Tag className="market-tag">数量 {selectedBagItem.qty}</Tag>
                            {selectedBagItem.locked ? <Tag color="red">已锁定</Tag> : null}
                          </div>
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
                      <div className="market-list-row">
                        <div className="market-list-k">手续费（银两）</div>
                        <div className="market-list-v">{listingFeeText}</div>
                      </div>
                      <div className="market-list-fee-tip">未卖出下架会退还手续费</div>
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

  const renderPartnerListItem = () => {
    const price = parseMaybeNumber(partnerListPrice);
    const safePrice = price ? Math.floor(price) : null;
    const canList =
      !!selectedPartner &&
      !selectedPartner.isActive &&
      selectedPartner.tradeStatus === 'none' &&
      !!safePrice &&
      safePrice > 0;
    const listingFeeSilver = safePrice ? safePrice * MARKET_LISTING_FEE_SILVER_PER_SPIRIT_STONE : null;
    const listingFeeText = listingFeeSilver === null ? '--' : `${listingFeeSilver.toLocaleString()} 银两`;

    const selectionList = (
      <div className={`market-partner-list ${isMobile ? 'market-partner-list--mobile' : 'market-partner-list--desktop'}`}>
        {partnerOverviewLoading && partnerOverview.length === 0 ? <div className="market-empty">加载中...</div> : null}
        {partnerOverview.map((partner) => (
          <div
            key={partner.id}
            className={`market-mobile-card market-mobile-card--partner market-partner-sell-card${selectedPartnerId === partner.id ? ' is-selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedPartnerId(partner.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setSelectedPartnerId(partner.id);
            }}
          >
            <div className="market-mobile-card-head">
              <img className="market-partner-avatar" src={resolvePartnerAvatar(partner.avatar)} alt={partner.name} />
              <div className="market-mobile-head-main">
                <div className="market-item-name">{partner.nickname || partner.name} <span className="market-partner-level">Lv.{partner.level}</span></div>
                <div className="market-item-tags">
                  <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(partner.quality)}`}>{partner.quality}</Tag>
                  <Tag className={`market-tag ${getElementToneClassName(partner.element)}`}>{formatPartnerElementLabel(partner.element)}</Tag>
                  <Tag className="market-tag">{partner.role}</Tag>
                  {renderMarketPartnerStatusTags(partner)}
                </div>
              </div>
            </div>
          </div>
        ))}
        {!partnerOverviewLoading && partnerOverview.length === 0 ? <div className="market-empty">暂无伙伴</div> : null}
      </div>
    );

    if (isMobile) {
      return (
        <div className="market-pane">
          <div className="market-pane-body market-pane-body--mobile-list">
            {selectionList}
          </div>
          {selectedPartner && (
            <PartnerListSheet
              partner={selectedPartner}
              listPrice={partnerListPrice}
              listingFeeText={listingFeeText}
              canList={canList}
              onClose={() => setSelectedPartnerId(null)}
              onPriceChange={setPartnerListPrice}
              onList={() => void doListPartner()}
            />
          )}
        </div>
      );
    }

    return (
      <div className="market-pane">
        <div className="market-pane-top">
          <div className="market-title">伙伴上架</div>
        </div>
        <div className="market-pane-body">
          <div className="market-list-shell">
            <div className="market-bag">
              {selectionList}
            </div>
            <div className="market-list-detail">
              <div className="market-list-detail-card">
                {selectedPartner ? (
                  <>
                    <div className="market-list-detail-head">
                      <div className="market-list-detail-head-main">
                        <img className={`market-list-detail-icon market-partner-avatar--detail`} src={resolvePartnerAvatar(selectedPartner.avatar)} alt={selectedPartner.name} />
                        <div className="market-list-detail-meta">
                          <div className="market-list-detail-name">{selectedPartner.nickname || selectedPartner.name}</div>
                          <div className="market-list-detail-tags">
                            <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(selectedPartner.quality)}`}>{selectedPartner.quality}</Tag>
                            <Tag className={`market-tag ${getElementToneClassName(selectedPartner.element)}`}>{formatPartnerElementLabel(selectedPartner.element)}</Tag>
                            <Tag className="market-tag">{selectedPartner.role}</Tag>
                            <Tag className="market-tag">等级 {selectedPartner.level}</Tag>
                            {renderMarketPartnerStatusTags(selectedPartner)}
                          </div>
                        </div>
                      </div>
                      {selectedPartner.isActive ? (
                        <div className="market-list-locked-tip" style={{ marginTop: 12 }}>出战中的伙伴不可上架，请先下阵。</div>
                      ) : null}
                      {selectedPartner.tradeStatus === 'market_listed' ? (
                        <div className="market-list-locked-tip" style={{ marginTop: 12 }}>该伙伴已在坊市挂单中，无法重复上架。</div>
                      ) : null}
                    </div>

                    <div className="market-list-detail-scroll">
                      <div className="market-list-detail-section">
                        <div className="market-list-detail-title">属性</div>
                        <div className="market-list-detail-attr-grid">
                          {buildPartnerAllAttrsPreview(selectedPartner).map((line) => (
                            <div key={line} className="market-list-detail-line">{line}</div>
                          ))}
                        </div>
                      </div>
                      <div className="market-list-detail-section">
                        <div className="market-list-detail-title">功法</div>
                        <div className="market-partner-technique-grid">
                          {selectedPartner.techniques.length > 0 ? (
                            selectedPartner.techniques.map((tech) => (
                              <div key={tech.techniqueId} className="market-partner-technique-cell">
                                <div className="market-partner-technique-name">{tech.name} <span className="market-partner-technique-level">一层</span></div>
                                <div className="market-partner-technique-desc">{tech.description || '暂无描述'}</div>
                              </div>
                            ))
                          ) : (
                            <div className="market-list-detail-text">暂无功法</div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="market-list-form">
                      <div className="market-list-row">
                        <div className="market-list-k">一口价（灵石）</div>
                        <Input value={partnerListPrice} onChange={(e) => setPartnerListPrice(e.target.value)} inputMode="numeric" placeholder="请输入伙伴售价" />
                      </div>
                      <div className="market-list-row">
                        <div className="market-list-k">手续费（银两）</div>
                        <div className="market-list-v">{listingFeeText}</div>
                      </div>
                      <div className="market-list-fee-tip">未卖出下架会退还手续费</div>
                      <div className="market-list-actions">
                        <Button type="primary" disabled={!canList} loading={partnerListingActionLoading} onClick={() => void doListPartner()}>
                          确认上架
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="market-list-empty">
                    请在左侧选择要上架的伙伴
                  </div>
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
      {renderPaneHeader('售卖记录')}
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

  const renderPartnerRecordsPanel = () => (
    <div className="market-pane">
      {renderPaneHeader('伙伴记录')}
      <div className="market-pane-body">
        <div className="market-pane-scroll">
          <div className="market-mobile-list">
            {partnerRecordsLoading && partnerRecords.length === 0 ? <div className="market-empty">加载中...</div> : null}
            {partnerRecords.map((row) => (
              <div key={row.id} className="market-mobile-card market-mobile-card--partner">
                <div className="market-mobile-card-head">
                  <img className="market-partner-avatar" src={resolvePartnerAvatar(row.partner.avatar)} alt={row.partner.name} />
                  <div className="market-mobile-head-main">
                    <div className="market-item-name">{row.partner.nickname || row.partner.name} <span className="market-partner-level">Lv.{row.partner.level}</span></div>
                    <div className="market-item-tags">
                      <Tag className={`market-tag market-tag-record ${row.type === '买入' ? 'buy' : 'sell'}`}>{row.type}</Tag>
                      <Tag className={`market-tag market-tag-quality ${getItemQualityTagClassName(row.partner.quality)}`}>{row.partner.quality}</Tag>
                      <Tag className={`market-tag ${getElementToneClassName(row.partner.element)}`}>{formatPartnerElementLabel(row.partner.element)}</Tag>
                    </div>
                  </div>
                  <div className="market-mobile-price">
                    <div className="market-mobile-price-label">成交价</div>
                    <div className="market-mobile-price-value">{row.totalPrice.toLocaleString()} 灵石</div>
                  </div>
                </div>
                <div className="market-mobile-meta-line">
                  <span className="market-mobile-meta-item">
                    <span className="market-mobile-meta-k">单价</span>
                    <span className="market-mobile-meta-v">{row.unitPrice.toLocaleString()} 灵石</span>
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
        </div>
        {partnerRecords.length === 0 && !partnerRecordsLoading ? <div className="market-empty">暂无记录</div> : null}
        <div className="market-pagination-bar">
          <Pagination
            current={recordPage}
            pageSize={pageSize}
            total={partnerRecordsTotal}
            onChange={(p) => {
              setRecordPage(p);
              void refreshPartnerRecords(p);
            }}
            showSizeChanger={false}
            hideOnSinglePage
          />
        </div>
      </div>
    </div>
  );

  const panelContent = () => {
    if (assetType === 'item') {
      if (panel === 'market') return renderMarket();
      if (panel === 'my') return renderMyListings();
      if (panel === 'list') return renderListItem();
      return renderRecords();
    }
    if (panel === 'market') return renderPartnerMarket();
    if (panel === 'my') return renderMyPartnerListings();
    if (panel === 'list') return renderPartnerListItem();
    return renderPartnerRecordsPanel();
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
            <>
              <div className="market-mobile-asset-switch-wrap">
                {renderAssetSwitch('market-asset-switch market-asset-switch--mobile')}
              </div>
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
            </>
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

      {isMobile && assetType === 'item' ? (
        <Drawer
          placement="bottom"
          open={Boolean(mobilePreviewListing)}
          onClose={() => setMobileListingPreview(null)}
          height="56dvh"
          className="market-mobile-preview-drawer"
          styles={{
            header: { display: 'none' },
            body: { padding: '10px 12px 12px' },
          }}
        >
          {mobilePreviewListing ? (
            <div className="market-mobile-preview">
              <div className="market-mobile-preview-content">
                <div className="market-mobile-preview-surface">
                  <MarketItemTooltipContent item={mobilePreviewListing} />
                </div>
              </div>
              <div className="market-mobile-preview-actions">
                {mobileListingPreview?.source === 'my' ? (
                  <Button
                    block
                    onClick={() => {
                      void unlistMyItem(mobilePreviewListing);
                    }}
                  >
                    下架
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    block
                    disabled={characterId !== null && mobilePreviewListing.sellerCharacterId === characterId}
                    onClick={() => {
                      startBuyListing(mobilePreviewListing);
                    }}
                  >
                    购买
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </Drawer>
      ) : null}

      {assetType === 'item' ? (
        <MarketBuyDialog
          open={buyDialogListing !== null}
          listing={buyDialogListing}
          onCancel={() => setBuyDialogListing(null)}
          onConfirm={(qty) => {
            if (!buyDialogListing) return;
            void buyListing(buyDialogListing, qty);
          }}
        />
      ) : null}
      {previewPartnerListing && (
        isMobile ? (
          <MarketPartnerPreviewSheet
            partner={previewPartnerListing.partner}
            unitPrice={previewPartnerListing.unitPrice}
            sellerCharacterId={previewPartnerListing.sellerCharacterId}
            myCharacterId={characterId}
            onClose={() => setPreviewPartnerListing(null)}
            onBuy={() => {
              void buyPartnerListing(previewPartnerListing);
              setPreviewPartnerListing(null);
            }}
          />
        ) : (
          <MarketPartnerBuyModal
            partner={previewPartnerListing.partner}
            unitPrice={previewPartnerListing.unitPrice}
            sellerCharacterId={previewPartnerListing.sellerCharacterId}
            myCharacterId={characterId}
            onClose={() => setPreviewPartnerListing(null)}
            onBuy={() => {
              void buyPartnerListing(previewPartnerListing);
              setPreviewPartnerListing(null);
            }}
          />
        )
      )}
    </Modal>
  );
};

export default MarketModal;
