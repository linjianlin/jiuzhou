/**
 * MobileBagModal - 移动端背包界面
 *
 * 全屏布局:
 *  - 顶部标题栏 + 关闭
 *  - 分类横向滚动标签
 *  - 搜索 + 排序条
 *  - 4列物品网格 (主可滚动区)
 *  - 底部快捷操作栏
 *  - 点击物品后弹出 Bottom Sheet 详情面板
 */
import { App } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { gameSocket } from '../../../../services/gameSocket';
import {
  disassembleInventoryEquipmentBatch,
  enhanceInventoryItem,
  equipInventoryItem,
  getInventoryInfo,
  getInventoryItems,
  inventoryUseItem,
  refineInventoryItem,
  removeInventoryItemsBatch,
  sortInventory,
  unequipInventoryItem,
} from '../../../../services/api';
import type { InventoryInfoData } from '../../../../services/api';
import {
  attrLabel,
  attrOrder,
  buildBagItem,
  buildEnhanceCostPlan,
  buildEquipmentLines,
  buildGrowthPreviewAttrs,
  buildRefineCostPlan,
  calcUseEffectDelta,
  categoryLabels,
  formatPermyriadPercent,
  formatSignedNumber,
  formatSignedPermyriadPercent,
  getEnhanceSuccessRatePermyriad,
  getRefineSuccessRatePermyriad,
  permyriadPercentKeys,
  pickNumber,
  qualityClass,
  qualityColor,
  qualityLabelText,
  qualityLabels,
  qualityRank,
} from './bagShared';
import type { BagAction, BagCategory, BagItem, BagQuality, BagSort } from './bagShared';
import DisassembleModal from './DisassembleModal';
import './MobileBagModal.scss';

/* ─── 排序面板 ─── */

const SORT_OPTIONS: { value: BagSort; label: string }[] = [
  { value: 'default', label: '默认排序' },
  { value: 'qualityDesc', label: '按品质排序' },
  { value: 'qtyDesc', label: '按数量排序' },
  { value: 'nameAsc', label: '名称 A → Z' },
  { value: 'nameDesc', label: '名称 Z → A' },
];

interface SortPanelProps {
  value: BagSort;
  onChange: (v: BagSort) => void;
  onClose: () => void;
}

const SortPanel: React.FC<SortPanelProps> = ({ value, onChange, onClose }) => (
  <>
    <div className="mbag-sort-mask" onClick={onClose} />
    <div className="mbag-sort-panel">
      <div className="mbag-sort-title">排序方式</div>
      <div className="mbag-sort-list">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`mbag-sort-item${opt.value === value ? ' is-active' : ''}`}
            onClick={() => { onChange(opt.value); onClose(); }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  </>
);

/* ─── Bottom Sheet 详情 ─── */

interface SheetProps {
  item: BagItem;
  loading: boolean;
  onClose: () => void;
  onUse: () => void;
  onEquipToggle: () => void;
  onDisassemble: () => void;
  onEnhance: () => void;
}

const ItemSheet: React.FC<SheetProps> = ({
  item,
  loading,
  onClose,
  onUse,
  onEquipToggle,
  onDisassemble,
  onEnhance,
}) => {
  const equipLines = useMemo(() => buildEquipmentLines(item), [item]);
  const hasDesc = Boolean(item.desc?.trim());
  const hasEquipAttrs = item.category === 'equipment' && equipLines.length > 0;
  const hasEffects = (item.effects?.length ?? 0) > 0;
  const isEquipped = item.location === 'equipped';

  const actionDisabled = (a: BagAction) => {
    if (!item.actions.includes(a)) return true;
    if (a === 'use') return item.locked || item.qty <= 0 || item.location !== 'bag';
    if (a === 'disassemble') return item.category !== 'equipment' || item.locked || isEquipped;
    if (a === 'enhance') return item.category !== 'equipment' || !item.equip;
    return false;
  };

  return (
    <>
      <div className="mbag-sheet-mask" onClick={onClose} />
      <div className="mbag-sheet">
        <div className="mbag-sheet-handle">
          <div className="mbag-sheet-bar" />
        </div>

        {/* 头部 */}
        <div className="mbag-sheet-head">
          <div className={`mbag-sheet-icon-box ${qualityClass[item.quality]}`}>
            <img className="mbag-sheet-icon-img" src={item.icon} alt={item.name} />
          </div>
          <div className="mbag-sheet-meta">
            <div className="mbag-sheet-name" style={{ color: qualityColor[item.quality] }}>
              {item.name}
            </div>
            <div className="mbag-sheet-tags">
              <span className="mbag-sheet-tag mbag-sheet-tag--cat">
                {categoryLabels[item.category]}
              </span>
              <span className={`mbag-sheet-tag mbag-sheet-tag--quality ${qualityClass[item.quality]}`}>
                {qualityLabelText[item.quality]}
              </span>
              {item.tags.map((t) => (
                <span key={t} className="mbag-sheet-tag mbag-sheet-tag--tag">{t}</span>
              ))}
            </div>
            {item.stackMax > 1 && (
              <div className="mbag-sheet-qty">数量 {item.qty} / {item.stackMax}</div>
            )}
          </div>
        </div>

        {/* 详情 */}
        <div className="mbag-sheet-body">
          {hasDesc && (
            <div className="mbag-sheet-section">
              <div className="mbag-sheet-section-title">物品描述</div>
              <div className="mbag-sheet-section-text">{item.desc}</div>
            </div>
          )}

          {hasEquipAttrs && (
            <div className="mbag-sheet-section">
              <div className="mbag-sheet-section-title">装备属性</div>
              <div className="mbag-sheet-attr-list">
                {equipLines.map((line, idx) => {
                  const colonIdx = line.indexOf('：');
                  if (colonIdx > 0) {
                    const label = line.slice(0, colonIdx);
                    const value = line.slice(colonIdx + 1).trim();
                    return (
                      <div key={`${idx}-${line}`} className="mbag-sheet-attr-row">
                        <span>{label}</span>
                        <span>{value}</span>
                      </div>
                    );
                  }
                  return (
                    <div key={`${idx}-${line}`} className="mbag-sheet-attr-row">
                      <span>{line}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {hasEffects && (
            <div className="mbag-sheet-section">
              <div className="mbag-sheet-section-title">效果</div>
              <div className="mbag-sheet-effect-list">
                {item.effects.map((line) => (
                  <div key={line} className="mbag-sheet-effect-chip">{line}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 操作 */}
        <div className="mbag-sheet-actions">
          {item.actions.includes('use') && (
            <button
              className="mbag-sheet-act-btn is-primary"
              disabled={loading || actionDisabled('use')}
              onClick={onUse}
            >
              使用
            </button>
          )}
          {item.actions.includes('equip') && (
            <button
              className="mbag-sheet-act-btn is-primary"
              disabled={loading || actionDisabled('equip')}
              onClick={onEquipToggle}
            >
              {isEquipped ? '卸下' : '装备'}
            </button>
          )}
          {item.actions.includes('enhance') && (
            <button
              className="mbag-sheet-act-btn"
              disabled={loading || actionDisabled('enhance')}
              onClick={onEnhance}
            >
              强化
            </button>
          )}
          {item.actions.includes('disassemble') && (
            <button
              className="mbag-sheet-act-btn is-danger"
              disabled={loading || actionDisabled('disassemble')}
              onClick={onDisassemble}
            >
              分解
            </button>
          )}
        </div>
      </div>
    </>
  );
};

/* ─── 强化 / 精炼 Bottom Sheet ─── */

interface GrowthSheetProps {
  item: BagItem;
  allItems: BagItem[];
  playerSilver: number;
  playerSpiritStones: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}

const GrowthSheet: React.FC<GrowthSheetProps> = ({
  item,
  allItems,
  playerSilver,
  playerSpiritStones,
  onClose,
  onDone,
}) => {
  const { message } = App.useApp();
  const [mode, setMode] = useState<'enhance' | 'refine'>('enhance');
  const [submitting, setSubmitting] = useState(false);

  const materialCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of allItems) {
      if (it.category !== 'material') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, it.qty);
    }
    return out;
  }, [allItems]);

  const enhanceState = useMemo(() => {
    if (!item.equip) return null;
    const curLv = Math.max(0, Math.min(15, item.equip.strengthenLevel));
    const targetLv = Math.min(15, curLv + 1);
    const costPlan = buildEnhanceCostPlan(item.equip.itemLevel, targetLv);
    const materialName = costPlan.materialItemDefId === 'enhance-001' ? '淬灵石' : '蕴灵石';
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const previewBaseAttrs = buildGrowthPreviewAttrs({
      baseAttrsRaw: item.equip.baseAttrsRaw,
      defQualityRankRaw: item.equip.defQualityRank,
      resolvedQualityRankRaw: item.equip.resolvedQualityRank,
      strengthenLevelRaw: curLv,
      refineLevelRaw: item.equip.refineLevel,
    }, 'enhance');
    return {
      curLv, targetLv, materialName, owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRate: getEnhanceSuccessRatePermyriad(targetLv),
      downgradeOnFail: targetLv >= 8,
      previewBaseAttrs,
    };
  }, [item, materialCounts]);

  const refineState = useMemo(() => {
    if (!item.equip) return null;
    const curLv = Math.max(0, Math.min(10, item.equip.refineLevel));
    const targetLv = Math.min(10, curLv + 1);
    const costPlan = buildRefineCostPlan(item.equip.itemLevel, targetLv);
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const materialName = costPlan.materialItemDefId === 'enhance-002' ? '蕴灵石' : costPlan.materialItemDefId;
    const previewBaseAttrs = buildGrowthPreviewAttrs({
      baseAttrsRaw: item.equip.baseAttrsRaw,
      defQualityRankRaw: item.equip.defQualityRank,
      resolvedQualityRankRaw: item.equip.resolvedQualityRank,
      strengthenLevelRaw: item.equip.strengthenLevel,
      refineLevelRaw: curLv,
    }, 'refine');
    return {
      curLv, targetLv, materialName, materialQty: costPlan.materialQty, owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRate: getRefineSuccessRatePermyriad(targetLv),
      previewBaseAttrs,
    };
  }, [item, materialCounts]);

  const handleEnhance = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await enhanceInventoryItem({ itemId: item.id });
      if (res.success) message.success(res.message || '强化成功');
      else {
        if (res.message === '强化失败') message.warning(res.message);
        else message.error(res.message || '强化失败');
      }
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      message.error((e as { message?: string }).message || '强化失败');
    } finally {
      setSubmitting(false);
    }
  }, [item.id, message, onDone]);

  const handleRefine = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await refineInventoryItem({ itemId: item.id });
      if (res.success) message.success(res.message || '精炼成功');
      else {
        if (res.message === '精炼失败') message.warning(res.message);
        else message.error(res.message || '精炼失败');
      }
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      message.error((e as { message?: string }).message || '精炼失败');
    } finally {
      setSubmitting(false);
    }
  }, [item.id, message, onDone]);

  const st = mode === 'enhance' ? enhanceState : refineState;
  const curAttrs = item.equip?.baseAttrs ?? {};

  const sorted = (rec: Record<string, number>) =>
    Object.entries(rec).sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b));

  return (
    <>
      <div className="mbag-sheet-mask" onClick={() => { if (!submitting) onClose(); }} />
      <div className="mbag-sheet">
        <div className="mbag-sheet-handle"><div className="mbag-sheet-bar" /></div>

        {/* 模式切换 */}
        <div style={{ display: 'flex', gap: 0, padding: '0 16px 8px' }}>
          {(['enhance', 'refine'] as const).map((m) => (
            <button
              key={m}
              className={`mbag-cat-btn${mode === m ? ' is-active' : ''}`}
              style={{ padding: '8px 20px' }}
              onClick={() => setMode(m)}
            >
              {m === 'enhance' ? '强化' : '精炼'}
            </button>
          ))}
        </div>

        <div className="mbag-sheet-body">
          {st ? (
            <>
              {/* 等级预览 */}
              <div className="mbag-sheet-section" style={{ textAlign: 'center' }}>
                <span style={{ fontSize: 22, fontWeight: 900 }}>+{st.curLv}</span>
                <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>→</span>
                <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--primary-color)' }}>+{st.targetLv}</span>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                  成功率 {formatPermyriadPercent(st.successRate)}%
                  {mode === 'enhance' && enhanceState?.downgradeOnFail && (
                    <span style={{ marginLeft: 8, color: 'var(--danger-color)' }}>失败掉级</span>
                  )}
                </div>
              </div>

              {/* 消耗 */}
              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">消耗</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <CostChip
                    label={st.materialName}
                    cost={mode === 'refine' && refineState ? refineState.materialQty : 1}
                    owned={st.owned}
                  />
                  {st.silverCost > 0 && (
                    <CostChip label="银两" cost={st.silverCost} owned={playerSilver} />
                  )}
                  {st.spiritStoneCost > 0 && (
                    <CostChip label="灵石" cost={st.spiritStoneCost} owned={playerSpiritStones} />
                  )}
                </div>
              </div>

              {/* 属性对比 */}
              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">属性变化</div>
                <div className="mbag-sheet-attr-list">
                  {sorted(st.previewBaseAttrs).map(([k, next]) => {
                    const cur = curAttrs[k] ?? 0;
                    const isPct = permyriadPercentKeys.has(k);
                    const fmtCur = isPct ? formatSignedPermyriadPercent(cur) : formatSignedNumber(cur);
                    const fmtNext = isPct ? formatSignedPermyriadPercent(next) : formatSignedNumber(next);
                    return (
                      <div key={k} className="mbag-sheet-attr-row">
                        <span>{attrLabel[k] ?? k}</span>
                        <span>
                          {fmtCur}
                          <span style={{ margin: '0 4px', color: 'var(--text-secondary)', fontWeight: 400 }}>→</span>
                          <span style={{ color: 'var(--primary-color)' }}>{fmtNext}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 20 }}>
              无法{mode === 'enhance' ? '强化' : '精炼'}
            </div>
          )}
        </div>

        <div className="mbag-sheet-actions">
          <button className="mbag-sheet-act-btn" onClick={onClose} disabled={submitting}>取消</button>
          <button
            className="mbag-sheet-act-btn is-primary"
            disabled={
              submitting || !st || item.locked ||
              (mode === 'enhance' && enhanceState
                ? enhanceState.curLv >= 15 || enhanceState.owned < 1 ||
                  playerSilver < enhanceState.silverCost || playerSpiritStones < enhanceState.spiritStoneCost
                : false) ||
              (mode === 'refine' && refineState
                ? refineState.curLv >= 10 || refineState.owned < refineState.materialQty ||
                  playerSilver < refineState.silverCost || playerSpiritStones < refineState.spiritStoneCost
                : false)
            }
            onClick={() => void (mode === 'enhance' ? handleEnhance() : handleRefine())}
          >
            {submitting ? '处理中...' : mode === 'enhance' ? '强化' : '精炼'}
          </button>
        </div>
      </div>
    </>
  );
};

/* 消耗标签 */
const CostChip: React.FC<{ label: string; cost: number; owned: number }> = ({ label, cost, owned }) => {
  const insufficient = owned < cost;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 3,
        padding: '3px 10px',
        borderRadius: 999,
        border: `1px solid ${insufficient ? 'rgba(255,77,79,0.4)' : 'var(--border-color-soft)'}`,
        background: insufficient ? 'rgba(255,77,79,0.06)' : 'var(--panel-bg)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: 700, color: insufficient ? 'var(--danger-color)' : undefined }}>
        ×{cost.toLocaleString()}
      </span>
      <span style={{ fontSize: 11, color: insufficient ? 'var(--danger-color)' : 'var(--text-secondary)' }}>
        /{owned.toLocaleString()}
      </span>
    </span>
  );
};

/* ═══════════════════════════════════════════
   主组件
   ═══════════════════════════════════════════ */

interface MobileBagModalProps {
  open: boolean;
  onClose: () => void;
}

const MobileBagModal: React.FC<MobileBagModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();

  /* 状态 */
  const [category, setCategory] = useState<BagCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BagSort>('default');
  const [sortOpen, setSortOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);
  const [disassembleOpen, setDisassembleOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<InventoryInfoData | null>(null);
  const [items, setItems] = useState<BagItem[]>([]);
  const [playerSilver, setPlayerSilver] = useState(0);
  const [playerSpiritStones, setPlayerSpiritStones] = useState(0);

  useEffect(() => {
    return gameSocket.onCharacterUpdate((char) => {
      setPlayerSilver(Number(char?.silver) || 0);
      setPlayerSpiritStones(Number(char?.spiritStones) || 0);
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [infoRes, bagRes, equippedRes] = await Promise.all([
        getInventoryInfo(),
        getInventoryItems('bag', 1, 200),
        getInventoryItems('equipped', 1, 200),
      ]);
      if (!infoRes.success || !infoRes.data) throw new Error(infoRes.message || '获取背包信息失败');
      if (!bagRes.success || !bagRes.data) throw new Error(bagRes.message || '获取背包物品失败');
      if (!equippedRes.success || !equippedRes.data) throw new Error(equippedRes.message || '获取已穿戴物品失败');

      const nextBag = bagRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      const nextEquipped = equippedRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      setInfo(infoRes.data);
      setItems([...nextBag, ...nextEquipped]);
    } catch (e) {
      message.error((e as { message?: string }).message || '获取背包数据失败');
      setInfo(null);
      setItems([]);
      setActiveId(null);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  /* 筛选 + 排序 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items;
    if (category !== 'all') list = list.filter((i) => i.category === category);
    if (q) list = list.filter((i) => `${i.name}${i.tags.join('')}`.toLowerCase().includes(q));

    const out = [...list];
    if (sort === 'nameAsc') out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    if (sort === 'nameDesc') out.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
    if (sort === 'qtyDesc') out.sort((a, b) => b.qty - a.qty);
    if (sort === 'qualityDesc') out.sort((a, b) => qualityRank[b.quality] - qualityRank[a.quality]);
    return out;
  }, [category, query, sort, items]);

  const activeItem = useMemo(
    () => (activeId !== null ? filtered.find((i) => i.id === activeId) ?? null : null),
    [activeId, filtered],
  );

  const usedSlots = info?.bag_used ?? items.filter((i) => i.location === 'bag').length;
  const totalSlots = info?.bag_capacity ?? 100;

  /* 操作回调 */
  const handleEquipToggle = useCallback(async () => {
    if (!activeItem) return;
    setLoading(true);
    try {
      if (activeItem.location === 'equipped') {
        const res = await unequipInventoryItem(activeItem.id, 'bag');
        if (!res.success) throw new Error(res.message || '卸下失败');
        message.success(res.message || '卸下成功');
      } else {
        const res = await equipInventoryItem(activeItem.id);
        if (!res.success) throw new Error(res.message || '装备失败');
        message.success(res.message || '装备成功');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSheetOpen(false);
    } catch (e) {
      message.error((e as { message?: string }).message || '操作失败');
      setLoading(false);
    }
  }, [activeItem, message, refresh]);

  const handleUseItem = useCallback(async () => {
    if (!activeItem) return;
    setLoading(true);
    try {
      const beforeChar = gameSocket.getCharacter();
      const res = await inventoryUseItem({ itemInstanceId: activeItem.id, qty: 1 });
      if (!res.success) throw new Error(res.message || '使用失败');

      const lootResults = res.data?.lootResults;
      const remaining = Math.max(0, activeItem.qty - 1);

      let content: string;
      if (lootResults && lootResults.length > 0) {
        const parts = lootResults.map((r) => `${r.name || r.type}×${r.amount}`);
        content = `打开【${activeItem.name}】，获得${parts.join('、')}。`;
      } else {
        const afterChar = res.data?.character;
        const beforeQixue = beforeChar?.qixue ?? null;
        const afterQixue = pickNumber(afterChar, ['qixue']);
        const effectDelta = calcUseEffectDelta(res.effects, 1);
        const restoredByStat =
          beforeQixue !== null && afterQixue !== null ? Math.max(0, Math.floor(afterQixue - beforeQixue)) : null;
        const restored = restoredByStat !== null ? restoredByStat : Math.max(0, effectDelta.qixue);
        content = activeItem.category === 'consumable'
          ? `使用【${activeItem.name}】成功，恢复了${restored}点气血，背包剩余${remaining}。`
          : `使用【${activeItem.name}】成功，背包剩余${remaining}。`;
      }
      window.dispatchEvent(new CustomEvent('chat:append', { detail: { channel: 'system', content } }));
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSheetOpen(false);
    } catch (e) {
      window.dispatchEvent(new CustomEvent('chat:append', {
        detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${(e as { message?: string }).message || '操作失败'}` },
      }));
      setLoading(false);
    }
  }, [activeItem, refresh]);

  const handleBatchDisassemble = useCallback(async () => {
    const candidates = items.filter(
      (i) => i.location === 'bag' && !i.locked && i.category === 'equipment' &&
        (i.quality === '黄' || i.quality === '玄'),
    );
    if (candidates.length === 0) { message.info('没有可分解的装备'); return; }
    setLoading(true);
    try {
      const res = await disassembleInventoryEquipmentBatch(candidates.map((x) => x.id));
      if (!res.success) throw new Error(res.message || '分解失败');
      message.success(res.message || `分解了${candidates.length}件装备`);
      await refresh();
    } catch (e) {
      message.error((e as { message?: string }).message || '分解失败');
    } finally {
      setLoading(false);
    }
  }, [items, message, refresh]);

  const handleBatchRemove = useCallback(async () => {
    const candidates = items.filter(
      (i) => i.location === 'bag' && !i.locked && i.quality === '黄',
    );
    if (candidates.length === 0) { message.info('没有可丢弃的物品'); return; }
    setLoading(true);
    try {
      const res = await removeInventoryItemsBatch(candidates.map((x) => x.id));
      if (!res.success) throw new Error(res.message || '丢弃失败');
      message.success(res.message || `丢弃了${candidates.length}件物品`);
      await refresh();
    } catch (e) {
      message.error((e as { message?: string }).message || '丢弃失败');
    } finally {
      setLoading(false);
    }
  }, [items, message, refresh]);

  const handleSort = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sortInventory('bag');
      if (!res.success) throw new Error(res.message || '整理失败');
      await refresh();
    } catch (e) {
      message.error((e as { message?: string }).message || '整理失败');
    } finally {
      setLoading(false);
    }
  }, [message, refresh]);

  if (!open) return null;

  const categories = Object.keys(categoryLabels) as BagCategory[];

  return (
    <div className="mbag-overlay">
      {/* ── 顶部栏 ── */}
      <div className="mbag-header">
        <div className="mbag-header-left">
          <span className="mbag-header-title">背包</span>
          <span className="mbag-header-slot">{usedSlots}/{totalSlots}</span>
        </div>
        <button className="mbag-header-close" onClick={onClose}>✕</button>
      </div>

      {/* ── 分类 ── */}
      <div className="mbag-categories">
        {categories.map((c) => (
          <button
            key={c}
            className={`mbag-cat-btn${category === c ? ' is-active' : ''}`}
            onClick={() => { setCategory(c); setActiveId(null); }}
          >
            {categoryLabels[c]}
          </button>
        ))}
      </div>

      {/* ── 搜索 + 排序 ── */}
      <div className="mbag-toolbar">
        <input
          className="mbag-search"
          placeholder="搜索物品..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="mbag-sort-btn" onClick={() => setSortOpen(true)}>
          {SORT_OPTIONS.find((o) => o.value === sort)?.label ?? '排序'}
        </button>
      </div>

      {/* ── 物品网格 ── */}
      <div className="mbag-grid-wrap">
        <div className="mbag-grid">
          {filtered.length === 0 && (
            <div className="mbag-empty">{loading ? '加载中...' : '暂无物品'}</div>
          )}
          {filtered.map((it) => (
            <div
              key={it.id}
              className={`mbag-cell ${qualityClass[it.quality]}${it.id === activeId ? ' is-active' : ''}`}
              onClick={() => { setActiveId(it.id); setSheetOpen(true); }}
            >
              {it.stackMax > 1 && <div className="mbag-cell-count">{it.qty}</div>}
              {it.location === 'equipped' && <div className="mbag-cell-badge">穿戴</div>}
              <img className="mbag-cell-icon" src={it.icon} alt={it.name} />
              <div className="mbag-cell-name">{it.name}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 底部操作栏 ── */}
      <div className="mbag-footer">
        <div className="mbag-footer-actions">
          <button className="mbag-footer-btn" disabled={loading} onClick={() => void handleBatchDisassemble()}>
            分解
          </button>
          <button className="mbag-footer-btn is-danger" disabled={loading} onClick={() => void handleBatchRemove()}>
            丢弃
          </button>
        </div>
        <button className="mbag-footer-btn is-primary" disabled={loading} onClick={() => void handleSort()}>
          {loading ? '整理中...' : '整理'}
        </button>
      </div>

      {/* ── Bottom Sheet: 物品详情 ── */}
      {sheetOpen && activeItem && (
        <ItemSheet
          item={activeItem}
          loading={loading}
          onClose={() => setSheetOpen(false)}
          onUse={() => void handleUseItem()}
          onEquipToggle={() => void handleEquipToggle()}
          onDisassemble={() => { setSheetOpen(false); setDisassembleOpen(true); }}
          onEnhance={() => { setSheetOpen(false); setGrowthOpen(true); }}
        />
      )}

      {/* ── Bottom Sheet: 强化/精炼 ── */}
      {growthOpen && activeItem && activeItem.category === 'equipment' && (
        <GrowthSheet
          item={activeItem}
          allItems={items}
          playerSilver={playerSilver}
          playerSpiritStones={playerSpiritStones}
          onClose={() => setGrowthOpen(false)}
          onDone={refresh}
        />
      )}

      {/* ── 分解确认弹窗 ── */}
      <DisassembleModal
        open={disassembleOpen}
        item={activeItem ? {
          id: activeItem.id,
          name: activeItem.name,
          quality: activeItem.quality,
          location: activeItem.location,
          locked: activeItem.locked,
        } : null}
        onClose={() => setDisassembleOpen(false)}
        onSuccess={refresh}
      />

      {/* ── 排序面板 ── */}
      {sortOpen && (
        <SortPanel
          value={sort}
          onChange={setSort}
          onClose={() => setSortOpen(false)}
        />
      )}
    </div>
  );
};

export default MobileBagModal;
