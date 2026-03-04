import { App, Button, Drawer, Modal, Segmented, Spin, Tabs, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveIconUrl } from '../../shared/resolveIcon';
import {
  INVENTORY_ITEMS_PAGE_SIZE_MAX,
  getInventoryInfo,
  getInventoryItems,
  moveInventoryItem,
  type InventoryItemDto,
  type ItemDefLite,
} from '../../../../services/api';
import { useIsMobile } from '../../shared/responsive';
import { getItemQualityMeta } from '../../shared/itemQuality';
import InventoryItemCell from '../../shared/InventoryItemCell';
import MarketItemTooltipContent, {
  ITEM_TOOLTIP_CLASS_NAMES,
  buildMarketTooltipCategoryLabel,
  normalizeMarketTooltipCategory,
  type MarketTooltipItemData,
} from '../../shared/MarketItemTooltipContent';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
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

const resolveIcon = (def?: ItemDefLite | null): string =>
  resolveIconUrl(def?.icon);

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

const buildWarehouseTooltipItem = (it: InventoryItemDto): MarketTooltipItemData => {
  const def = it.def ?? null;
  const name = typeof def?.name === 'string' ? def.name.trim() : '';
  return {
    name: name || '未知物品',
    icon: resolveIcon(def),
    qty: Math.max(0, Number(it.qty || 0)),
    quality: def?.quality ?? it.quality ?? null,
    category: normalizeMarketTooltipCategory(def?.category),
    categoryLabel: buildMarketTooltipCategoryLabel(def?.category, def?.sub_category),
    description: def?.description ?? null,
    longDesc: def?.long_desc ?? null,
    effectDefs: def?.effect_defs ?? null,
    baseAttrs: def?.base_attrs ?? null,
    equipSlot: def?.equip_slot ?? null,
    equipReqRealm: def?.equip_req_realm ?? def?.use_req_realm ?? null,
    useType: def?.use_type ?? null,
    strengthenLevel: it.strengthen_level,
    refineLevel: it.refine_level,
    identified: Boolean(it.identified),
    affixes: it.affixes,
  };
};


interface WarehouseModalProps {
  open: boolean;
  onClose: () => void;
}

const WarehouseModal: React.FC<WarehouseModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  useGameItemTaxonomy(open);
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();
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
  const mobilePreviewTooltipItem = useMemo(
    () => (mobilePreviewItem ? buildWarehouseTooltipItem(mobilePreviewItem) : null),
    [mobilePreviewItem],
  );
  const mobilePreviewSide = mobilePreview?.side ?? null;

  const fetchAllInventoryItems = useCallback(async (location: 'bag' | 'warehouse'): Promise<InventoryItemDto[]> => {
    const pageSize = INVENTORY_ITEMS_PAGE_SIZE_MAX;
    const out: InventoryItemDto[] = [];
    let page = 1;
    for (; ;) {
      const res = await getInventoryItems(location, page, pageSize);
      if (!res?.success || !res.data) return out;
      const items = res.data.items ?? [];
      out.push(...items);
      const totalRaw = Number(res.data.total);
      const hasValidTotal = Number.isFinite(totalRaw) && totalRaw >= 0;
      // 终止条件基于“是否还有数据”而不是“是否小于请求页大小”，
      // 避免服务端 pageSize 上限与前端请求值不一致时提前结束分页。
      if (items.length === 0 || (hasValidTotal && out.length >= totalRaw)) return out;
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
      void 0;
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
          if (!res.success) {
            void 0;
            return;
          }
          void refreshAll({ keepLoading: true });
        })
        .catch(() => {
          void 0;
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
          if (!res.success) {
            void 0;
            return;
          }
          void refreshAll({ keepLoading: true });
        })
        .catch(() => {
          void 0;
        })
        .finally(() => setLoading(false));
    },
    [getSlotsBySide, loading, message, refreshAll],
  );

  const renderSlot = (side: SlotSide, index: number, it: InventoryItemDto | null) => {
    const name = it?.def?.name ?? '';
    const qty = Math.max(0, Number(it?.qty || 0));
    const icon = resolveIcon(it?.def ?? null);
    const tooltipItem = it ? buildWarehouseTooltipItem(it) : null;
    const displayName = name || '未知物品';
    const displayQty = qty > 0 ? qty : 1;
    const qualityClassName = it ? getItemQualityMeta(it.quality ?? it.def?.quality ?? null)?.className ?? '' : '';

    const node = (
      <InventoryItemCell
        key={`${side}-${index}`}
        className={`warehouse-slot${it ? ' has-item' : ''}`}
        qualityClassName={qualityClassName || undefined}
        icon={it ? icon : undefined}
        name={displayName}
        quantity={qty}
        showQuantity={qty > 1}
        quantityPrefix="x"
        showName={true}
        empty={!it}
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
      />
    );

    if (!tooltipItem || isMobile) return node;

    return (
      <Tooltip
        overlayClassName={ITEM_TOOLTIP_CLASS_NAMES.root}
        classNames={ITEM_TOOLTIP_CLASS_NAMES}
        title={<MarketItemTooltipContent item={tooltipItem} />}
        mouseEnterDelay={0.12}
        placement="right"
        getPopupContainer={(triggerNode) => {
          const modalRoot = triggerNode.closest('.warehouse-modal');
          return modalRoot instanceof HTMLElement ? modalRoot : document.body;
        }}
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
            open={Boolean(mobilePreviewTooltipItem)}
            onClose={() => setMobilePreview(null)}
            height="56dvh"
            className="warehouse-mobile-preview-drawer"
            styles={{ body: { padding: '10px 12px 12px' } }}
          >
            {mobilePreviewTooltipItem ? (
              <div className="warehouse-mobile-preview">
                <div className="warehouse-mobile-preview-content">
                  <MarketItemTooltipContent item={mobilePreviewTooltipItem} />
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
