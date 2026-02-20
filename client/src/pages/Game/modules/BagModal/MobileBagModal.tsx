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
  rerollInventoryAffixes,
  removeInventoryItemsBatch,
  setInventoryItemLock,
  socketInventoryGem,
  sortInventory,
  unequipInventoryItem,
} from '../../../../services/api';
import type { InventoryInfoData } from '../../../../services/api';
import {
  attrLabel,
  attrOrder,
  buildAffixRerollCostPlan,
  buildBagItem,
  buildBatchDisassemblePayloadItems,
  buildEquipmentDetailLines,
  buildEnhanceCostPlan,
  buildGrowthPreviewAttrs,
  buildRefineCostPlan,
  calcUseEffectDelta,
  categoryLabels,
  collectBatchDisassembleCandidates,
  collectGemCandidates,
  formatAffixRollPercent,
  formatEquipmentAffixLine,
  getAffixRollColor,
  getAffixRollPercent,
  getEnhanceSuccessRatePercent,
  getRefineSuccessRatePercent,
  isDisassemblableBagItem,
  isGemTypeAllowedInSlot,
  normalizeAffixLockIndexes,
  normalizeGemType,
  percentAttrKeys,
  pickNumber,
  qualityClass,
  qualityColor,
  qualityLabelText,
  qualityLabels,
  qualityRank,
} from './bagShared';
import type { BagAction, BagCategory, BagItem, BagQuality, BagSort, BatchMode } from './bagShared';
import { buildAutoDisassembleSubCategoryOptionsByCategory } from '../../shared/autoDisassembleFilters';
import { formatPercent, formatSignedNumber, formatSignedPercent } from '../../shared/formatAttr';
import { getItemQualityMeta } from '../../shared/itemQuality';
import { ITEM_CATEGORY_ALL_OPTION, ITEM_CATEGORY_OPTIONS } from '../../shared/itemTaxonomy';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import InventoryItemCell from '../../shared/InventoryItemCell';
import { EquipmentDetailAttrList } from './EquipmentDetailAttrList';
import { SetBonusDisplay } from './SetBonusDisplay';
import DisassembleModal from './DisassembleModal';
import CraftModal from './CraftModal';
import GemSynthesisModal from './GemSynthesisModal';
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

/* ─── 批量分解 / 丢弃面板 ─── */

interface BatchPanelProps {
  mode: BatchMode;
  submitting: boolean;
  qualities: BagQuality[];
  category: BagCategory;
  subCategory: string;
  keyword: string;
  includeKeywordsText: string;
  excludeKeywordsText: string;
  subCategoryOptions: Array<{ label: string; value: string }>;
  candidateCount: number;
  summaryText: string;
  onClose: () => void;
  onSubmit: () => void;
  onToggleQuality: (quality: BagQuality) => void;
  onCategoryChange: (value: BagCategory) => void;
  onSubCategoryChange: (value: string) => void;
  onKeywordChange: (value: string) => void;
  onIncludeKeywordsChange: (value: string) => void;
  onExcludeKeywordsChange: (value: string) => void;
}

const BatchPanel: React.FC<BatchPanelProps> = ({
  mode,
  submitting,
  qualities,
  category,
  subCategory,
  keyword,
  includeKeywordsText,
  excludeKeywordsText,
  subCategoryOptions,
  candidateCount,
  summaryText,
  onClose,
  onSubmit,
  onToggleQuality,
  onCategoryChange,
  onSubCategoryChange,
  onKeywordChange,
  onIncludeKeywordsChange,
  onExcludeKeywordsChange,
}) => (
  <>
    <div
      className="mbag-sort-mask"
      onClick={() => {
        if (submitting) return;
        onClose();
      }}
    />
    <div className="mbag-batch-panel">
      <div className="mbag-batch-title">{mode === 'disassemble' ? '一键分解' : '一键丢弃'}</div>

      <div className="mbag-batch-section">
        <div className="mbag-batch-label">品质（多选）</div>
        <div className="mbag-batch-quality-list">
          {qualityLabels.map((quality) => {
            const active = qualities.includes(quality);
            return (
              <button
                key={quality}
                className={`mbag-batch-quality-chip${active ? ' is-active' : ''}`}
                type="button"
                disabled={submitting}
                onClick={() => onToggleQuality(quality)}
              >
                {qualityLabelText[quality]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mbag-batch-grid">
        <div className="mbag-batch-field">
          <div className="mbag-batch-label">主分类</div>
          <select
            className="mbag-batch-select"
            value={category}
            disabled={submitting}
            onChange={(event) => onCategoryChange(event.target.value as BagCategory)}
          >
            <option value={ITEM_CATEGORY_ALL_OPTION.value}>{ITEM_CATEGORY_ALL_OPTION.label}</option>
            {ITEM_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mbag-batch-field">
          <div className="mbag-batch-label">子类型</div>
          <select
            className="mbag-batch-select"
            value={subCategory}
            disabled={submitting}
            onChange={(event) => onSubCategoryChange(event.target.value)}
          >
            <option value="all">全部子类型</option>
            {subCategoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mbag-batch-field">
        <div className="mbag-batch-label">关键词</div>
        <input
          className="mbag-batch-input"
          value={keyword}
          disabled={submitting}
          onChange={(event) => onKeywordChange(event.target.value)}
          placeholder="搜索名称/标签"
        />
      </div>

      {mode === 'disassemble' ? (
        <div className="mbag-batch-grid mbag-batch-grid--stackable">
          <div className="mbag-batch-field">
            <div className="mbag-batch-label">包含关键词</div>
            <input
              className="mbag-batch-input"
              value={includeKeywordsText}
              disabled={submitting}
              onChange={(event) => onIncludeKeywordsChange(event.target.value)}
              placeholder="逗号分隔，如：丹,灵气"
            />
          </div>
          <div className="mbag-batch-field">
            <div className="mbag-batch-label">排除关键词</div>
            <input
              className="mbag-batch-input"
              value={excludeKeywordsText}
              disabled={submitting}
              onChange={(event) => onExcludeKeywordsChange(event.target.value)}
              placeholder="逗号分隔，如：绑定,任务"
            />
          </div>
        </div>
      ) : null}

      <div className="mbag-batch-summary">将处理 {candidateCount} 个物品{summaryText ? `（${summaryText}）` : ''}</div>
      <div className="mbag-batch-tip">已自动排除：已穿戴、已锁定</div>

      <div className="mbag-batch-actions">
        <button
          className="mbag-sheet-act-btn"
          type="button"
          disabled={submitting}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className={mode === 'remove' ? 'mbag-sheet-act-btn is-danger' : 'mbag-sheet-act-btn is-primary'}
          type="button"
          disabled={submitting || candidateCount <= 0}
          onClick={onSubmit}
        >
          {submitting ? '处理中...' : mode === 'disassemble' ? '确认分解' : '确认丢弃'}
        </button>
      </div>
    </div>
  </>
);

/* ─── Bottom Sheet 详情 ─── */

interface SheetProps {
  item: BagItem;
  loading: boolean;
  useQty: number;
  useQtyMax: number;
  onClose: () => void;
  onUse: () => void;
  onUseQtyChange: (nextValue: number) => void;
  onUseQtyStep: (delta: number) => void;
  onUseQtyMax: () => void;
  onEquipToggle: () => void;
  onDisassemble: () => void;
  onEnhance: () => void;
  onSocket: () => void;
  onToggleLock: () => void;
}

const ItemSheet: React.FC<SheetProps> = ({
  item,
  loading,
  useQty,
  useQtyMax,
  onClose,
  onUse,
  onUseQtyChange,
  onUseQtyStep,
  onUseQtyMax,
  onEquipToggle,
  onDisassemble,
  onEnhance,
  onSocket,
  onToggleLock,
}) => {
  const equipLines = useMemo(() => buildEquipmentDetailLines(item), [item]);
  const hasDesc = item.category !== 'equipment' && Boolean(item.desc?.trim());
  const hasEquipAttrs = item.category === 'equipment' && equipLines.length > 0;
  const hasSetInfo = Boolean(item.setInfo && item.setInfo.bonuses.length > 0);
  const hasEffects = (item.effects?.length ?? 0) > 0;
  const isEquipped = item.location === 'equipped';
  const canBatchUse =
    item.actions.includes('use') &&
    item.category === 'consumable' &&
    item.location === 'bag' &&
    Math.floor(item.qty) > 1;

  const actionDisabled = (a: BagAction) => {
    if (!item.actions.includes(a)) return true;
    if (a === 'use') return item.locked || item.qty <= 0 || item.location !== 'bag';
    if (a === 'disassemble') return !isDisassemblableBagItem(item) || item.locked || isEquipped;
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
              {item.locked ? <span className="mbag-sheet-tag mbag-sheet-tag--locked">已锁定</span> : null}
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
              <EquipmentDetailAttrList lines={equipLines} variant="mobile" className="mbag-sheet-attr-list" />
            </div>
          )}

          {hasSetInfo && (
            <div className="mbag-sheet-section">
              <div className="mbag-sheet-section-title">套装效果</div>
              {item.setInfo ? <SetBonusDisplay setInfo={item.setInfo} variant="mobile" /> : null}
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

        {canBatchUse && (
          <div className="mbag-sheet-use-qty">
            <span className="mbag-sheet-use-qty-label">使用数量</span>
            <div className="mbag-sheet-use-qty-controls">
              <button
                className="mbag-sheet-use-qty-btn"
                disabled={loading || actionDisabled('use') || useQty <= 1}
                onClick={() => onUseQtyStep(-1)}
              >
                -
              </button>
              <input
                className="mbag-sheet-use-qty-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={useQtyMax}
                disabled={loading || actionDisabled('use')}
                value={useQty}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) return;
                  onUseQtyChange(parsed);
                }}
              />
              <button
                className="mbag-sheet-use-qty-btn"
                disabled={loading || actionDisabled('use') || useQty >= useQtyMax}
                onClick={() => onUseQtyStep(1)}
              >
                +
              </button>
              <button
                className="mbag-sheet-use-qty-btn is-max"
                disabled={loading || actionDisabled('use') || useQty >= useQtyMax}
                onClick={onUseQtyMax}
              >
                最大
              </button>
            </div>
          </div>
        )}

        {/* 操作 */}
        <div className="mbag-sheet-actions">
          {item.actions.includes('use') && (
            <button
              className="mbag-sheet-act-btn is-primary"
              disabled={loading || actionDisabled('use')}
              onClick={onUse}
            >
              使用{canBatchUse && useQty > 1 ? `×${useQty}` : ''}
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
          {item.category === 'equipment' && item.equip && (
            <button
              className="mbag-sheet-act-btn"
              disabled={loading || actionDisabled('enhance')}
              onClick={onSocket}
            >
              镶嵌
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
          <button
            className="mbag-sheet-act-btn"
            disabled={loading}
            onClick={onToggleLock}
          >
            {item.locked ? '解锁' : '上锁'}
          </button>
        </div>
      </div>
    </>
  );
};

/* ─── 强化 / 精炼 Bottom Sheet ─── */

type GrowthMode = 'enhance' | 'refine' | 'socket' | 'reroll';

interface GrowthSheetProps {
  item: BagItem;
  allItems: BagItem[];
  playerSilver: number;
  playerSpiritStones: number;
  initialMode: GrowthMode;
  onClose: () => void;
  onDone: () => Promise<void>;
}

const GrowthSheet: React.FC<GrowthSheetProps> = ({
  item,
  allItems,
  playerSilver,
  playerSpiritStones,
  initialMode,
  onClose,
  onDone,
}) => {
  const { message } = App.useApp();
  const [mode, setMode] = useState<GrowthMode>(initialMode);
  const [submitting, setSubmitting] = useState(false);
  const [rerollLockIndexes, setRerollLockIndexes] = useState<number[]>([]);
  const [socketSlot, setSocketSlot] = useState<number | undefined>(undefined);
  const [selectedGemItemId, setSelectedGemItemId] = useState<number | undefined>(undefined);

  const materialCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of allItems) {
      if (it.category !== 'material') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, it.qty);
    }
    return out;
  }, [allItems]);

  const bagItemCounts = useMemo(() => {
    // 洗炼符是 consumable，因此需要按背包全部物品统计，而不是仅 material。
    const out: Record<string, number> = {};
    for (const it of allItems) {
      if (it.location !== 'bag') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, it.qty);
    }
    return out;
  }, [allItems]);

  useEffect(() => {
    const affixCount = item.equip?.affixes.length ?? 0;
    setRerollLockIndexes((prev) => normalizeAffixLockIndexes(prev, affixCount));
  }, [item.id, item.equip?.affixes.length]);
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, item.id]);
  useEffect(() => {
    setSocketSlot(undefined);
    setSelectedGemItemId(undefined);
  }, [item.id]);

  const enhanceState = useMemo(() => {
    if (!item.equip) return null;
    const curLv = Math.max(0, Math.min(15, item.equip.strengthenLevel));
    const targetLv = Math.min(15, curLv + 1);
    const costPlan = buildEnhanceCostPlan(targetLv);
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
      successRate: getEnhanceSuccessRatePercent(targetLv),
      downgradeOnFail: targetLv >= 8,
      previewBaseAttrs,
    };
  }, [item, materialCounts]);

  const refineState = useMemo(() => {
    if (!item.equip) return null;
    const curLv = Math.max(0, Math.min(10, item.equip.refineLevel));
    const targetLv = Math.min(10, curLv + 1);
    const costPlan = buildRefineCostPlan(targetLv);
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
      successRate: getRefineSuccessRatePercent(targetLv),
      previewBaseAttrs,
    };
  }, [item, materialCounts]);

  const rerollState = useMemo(() => {
    if (!item.equip) return null;
    const affixes = item.equip.affixes;
    if (!Array.isArray(affixes) || affixes.length <= 0) {
      return {
        affixes: [] as typeof item.equip.affixes,
        maxLockCount: 0,
        lockIndexes: [] as number[],
        lockIndexSet: new Set<number>(),
        rerollScrollQty: 0,
        rerollScrollOwned: 0,
        spiritStoneCost: 0,
        silverCost: 0,
      };
    }

    const maxLockCount = Math.max(0, affixes.length - 1);
    const normalizedLocks = normalizeAffixLockIndexes(rerollLockIndexes, affixes.length);
    const lockIndexes = normalizedLocks.slice(0, maxLockCount);
    const lockIndexSet = new Set(lockIndexes);
    const costPlan = buildAffixRerollCostPlan(item.equip.equipReqRealm, lockIndexes.length);

    return {
      affixes,
      maxLockCount,
      lockIndexes,
      lockIndexSet,
      rerollScrollQty: costPlan.rerollScrollQty,
      rerollScrollOwned: bagItemCounts[costPlan.rerollScrollItemDefId] ?? 0,
      spiritStoneCost: costPlan.spiritStoneCost,
      silverCost: costPlan.silverCost,
    };
  }, [item, bagItemCounts, rerollLockIndexes]);

  const socketState = useMemo(() => {
    if (!item.equip) return null;
    const equip = item.equip;
    const candidates = collectGemCandidates(allItems);
    const availableSlots = Array.from({ length: Math.max(0, equip.socketMax) }, (_, idx) => idx);
    const selectedSlot =
      socketSlot === undefined || socketSlot === null
        ? availableSlots.find((slot) => !equip.socketedGems.some((gem) => gem.slot === slot))
        : socketSlot;
    const selectedGem = candidates.find((gem) => gem.id === selectedGemItemId) ?? null;
    const selectedGemType = selectedGem ? normalizeGemType(selectedGem.subCategory || selectedGem.name) : 'all';
    const slotValid = selectedSlot !== undefined && selectedSlot >= 0 && selectedSlot < equip.socketMax;
    const replacedGem = selectedSlot !== undefined ? equip.socketedGems.find((gem) => gem.slot === selectedSlot) ?? null : null;
    const duplicateGem =
      selectedGem && selectedSlot !== undefined
        ? equip.socketedGems.some((gem) => gem.itemDefId === selectedGem.itemDefId && gem.slot !== selectedSlot)
        : false;
    const typeValid =
      selectedGem && selectedSlot !== undefined
        ? isGemTypeAllowedInSlot(equip.gemSlotTypes, selectedSlot, selectedGemType)
        : false;

    return {
      socketed: equip.socketedGems,
      socketMax: equip.socketMax,
      availableSlots,
      selectedSlot,
      candidates,
      selectedGem,
      selectedGemType,
      slotValid,
      typeValid,
      duplicateGem,
      replacedGem,
      silverCost: replacedGem ? 100 : 50,
    };
  }, [allItems, item.equip, selectedGemItemId, socketSlot]);

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

  const handleToggleRerollLock = useCallback((index: number) => {
    if (!rerollState) return;
    if (submitting) return;
    if (index < 0 || index >= rerollState.affixes.length) return;

    if (rerollState.lockIndexSet.has(index)) {
      setRerollLockIndexes((prev) =>
        normalizeAffixLockIndexes(
          prev.filter((lockIndex) => lockIndex !== index),
          rerollState.affixes.length
        )
      );
      return;
    }

    if (rerollState.lockIndexes.length >= rerollState.maxLockCount) {
      message.warning(`最多锁定${rerollState.maxLockCount}条词条`);
      return;
    }

    setRerollLockIndexes((prev) =>
      normalizeAffixLockIndexes([...prev, index], rerollState.affixes.length)
    );
  }, [message, rerollState, submitting]);

  const handleReroll = useCallback(async () => {
    if (!rerollState || rerollState.affixes.length <= 0) return;
    const lockIndexes = normalizeAffixLockIndexes(
      rerollState.lockIndexes,
      rerollState.affixes.length
    ).slice(0, rerollState.maxLockCount);

    setSubmitting(true);
    try {
      const res = await rerollInventoryAffixes({
        itemId: item.id,
        lockIndexes,
      });
      if (!res.success) {
        message.error(res.message || '洗炼失败');
        return;
      }
      message.success(res.message || '洗炼成功');
      setRerollLockIndexes(
        normalizeAffixLockIndexes(
          res.data?.lockIndexes ?? lockIndexes,
          rerollState.affixes.length
        )
      );
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      message.error((e as { message?: string }).message || '洗炼失败');
    } finally {
      setSubmitting(false);
    }
  }, [item.id, message, onDone, rerollState]);

  const handleSocket = useCallback(async () => {
    if (!socketState) return;
    if (!socketState.selectedGem) return;
    if (socketState.selectedSlot === undefined) return;
    if (!socketState.slotValid || !socketState.typeValid || socketState.duplicateGem) return;

    setSubmitting(true);
    try {
      const res = await socketInventoryGem({
        itemId: item.id,
        gemItemId: socketState.selectedGem.id,
        slot: socketState.selectedSlot,
      });
      if (!res.success) throw new Error(res.message || '镶嵌失败');
      message.success(res.message || '镶嵌成功');
      setSocketSlot(undefined);
      setSelectedGemItemId(undefined);
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      message.error((e as { message?: string }).message || '镶嵌失败');
    } finally {
      setSubmitting(false);
    }
  }, [item.id, message, onDone, socketState]);

  const st = mode === 'enhance' ? enhanceState : mode === 'refine' ? refineState : null;
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
          {(['enhance', 'refine', 'socket', 'reroll'] as const).map((m) => (
            <button
              key={m}
              className={`mbag-cat-btn${mode === m ? ' is-active' : ''}`}
              style={{ padding: '8px 14px' }}
              onClick={() => setMode(m)}
            >
              {m === 'enhance' ? '强化' : m === 'refine' ? '精炼' : m === 'socket' ? '镶嵌' : '洗炼'}
            </button>
          ))}
        </div>

        <div className="mbag-sheet-body">
          {(mode === 'enhance' || mode === 'refine') && st ? (
            <>
              {/* 等级预览 */}
              <div className="mbag-sheet-section" style={{ textAlign: 'center' }}>
                <span style={{ fontSize: 22, fontWeight: 900 }}>+{st.curLv}</span>
                <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>→</span>
                <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--primary-color)' }}>+{st.targetLv}</span>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                  成功率 {formatPercent(st.successRate)}
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
                    const isPct = percentAttrKeys.has(k);
                    const fmtCur = isPct ? formatSignedPercent(cur) : formatSignedNumber(cur);
                    const fmtNext = isPct ? formatSignedPercent(next) : formatSignedNumber(next);
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
          ) : null}

          {mode === 'socket' && socketState ? (
            <>
              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">孔位状态</div>
                <div className="mbag-sheet-section-text">
                  已镶嵌 {socketState.socketed.length}/{socketState.socketMax}
                </div>
              </div>

              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">选择镶嵌目标</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>孔位</span>
                    <select
                      value={socketState.selectedSlot ?? ''}
                      disabled={submitting}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setSocketSlot(Number.isInteger(next) ? next : undefined);
                      }}
                      className="mbag-batch-select"
                    >
                      <option value="">请选择孔位</option>
                      {socketState.availableSlots.map((slot) => {
                        const existed = socketState.socketed.find((gem) => gem.slot === slot);
                        const displaySlot = slot + 1;
                        return (
                          <option key={slot} value={slot}>
                            {existed
                              ? `孔位${displaySlot}（已镶嵌：${existed.name ?? existed.itemDefId}）`
                              : `孔位${displaySlot}（空）`}
                          </option>
                        );
                      })}
                    </select>
                  </label>

                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>宝石</span>
                    <select
                      value={selectedGemItemId ?? ''}
                      disabled={submitting}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setSelectedGemItemId(Number.isInteger(next) ? next : undefined);
                      }}
                      className="mbag-batch-select"
                    >
                      <option value="">请选择宝石</option>
                      {socketState.candidates.map((gem) => (
                        <option key={gem.id} value={gem.id}>
                          {gem.name} x{gem.qty}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-text">
                  {socketState.selectedGem
                    ? `已选宝石：${socketState.selectedGem.name}（类型：${socketState.selectedGemType}）`
                    : '请选择可镶嵌宝石'}
                </div>
                <div className="mbag-sheet-section-text">
                  {socketState.replacedGem ? `替换镶嵌消耗银两：${socketState.silverCost}` : `首次镶嵌消耗银两：${socketState.silverCost}`}
                </div>
                <div className="mbag-sheet-section-text">宝石不可卸下，仅可通过替换镶嵌覆盖原孔位宝石（原宝石销毁）。</div>
                {socketState.candidates.length <= 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                    当前背包没有可镶嵌的宝石
                  </div>
                ) : null}
                {socketState.selectedGem && socketState.selectedSlot !== undefined && !socketState.typeValid ? (
                  <div style={{ fontSize: 12, color: 'var(--danger-color)', marginTop: 6 }}>
                    宝石类型与孔位不匹配
                  </div>
                ) : null}
                {socketState.selectedGem && socketState.selectedSlot !== undefined && socketState.duplicateGem ? (
                  <div style={{ fontSize: 12, color: 'var(--danger-color)', marginTop: 6 }}>
                    同一件装备不可镶嵌相同宝石
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {mode === 'reroll' && rerollState && rerollState.affixes.length > 0 ? (
            <>
              <div className="mbag-sheet-section" style={{ textAlign: 'center' }}>
                <span style={{ fontSize: 22, fontWeight: 900 }}>{rerollState.affixes.length}</span>
                <span style={{ marginLeft: 6, color: 'var(--text-secondary)', fontSize: 13 }}>条词条</span>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                  已锁定 {rerollState.lockIndexes.length}/{rerollState.maxLockCount}
                </div>
              </div>

              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">消耗</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <CostChip label="洗炼符" cost={rerollState.rerollScrollQty} owned={rerollState.rerollScrollOwned} />
                  <CostChip label="灵石" cost={rerollState.spiritStoneCost} owned={playerSpiritStones} />
                  <CostChip label="银两" cost={rerollState.silverCost} owned={playerSilver} />
                </div>
              </div>

              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">词条锁定</div>
                <div className="mbag-sheet-effect-list">
                  {rerollState.affixes.map((affix, index) => {
                    const locked = rerollState.lockIndexSet.has(index);
                    const rollPercent = getAffixRollPercent(affix);
                    const rollColor = getAffixRollColor(rollPercent);
                    return (
                      <button
                        key={`${index}-${affix.key ?? 'affix'}`}
                        className={`mbag-sheet-reroll-lock${locked ? ' is-locked' : ''}`}
                        disabled={submitting || item.locked}
                        onClick={() => handleToggleRerollLock(index)}
                      >
                        <span className="mbag-sheet-reroll-lock-index">#{index + 1}</span>
                        <span className="mbag-sheet-reroll-lock-main">
                          <span className="mbag-sheet-reroll-lock-text">{formatEquipmentAffixLine(affix)}</span>
                          <span className="mbag-sheet-reroll-lock-roll">
                            <span className="mbag-sheet-reroll-lock-roll-label">ROLL</span>
                            <span
                              className="mbag-sheet-reroll-lock-roll-value"
                              style={rollColor ? { color: rollColor } : undefined}
                            >
                              {formatAffixRollPercent(rollPercent)}
                            </span>
                            <span className="mbag-sheet-reroll-lock-roll-track" aria-hidden="true">
                              <span
                                className="mbag-sheet-reroll-lock-roll-fill"
                                style={{
                                  width: `${rollPercent ?? 0}%`,
                                  background: rollColor ?? "var(--border-color-soft)",
                                }}
                              />
                            </span>
                          </span>
                        </span>
                        <span className="mbag-sheet-reroll-lock-tag">{locked ? '已锁定' : '点击锁定'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}

          {mode === 'reroll' && (!rerollState || rerollState.affixes.length <= 0) ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 20 }}>
              该装备没有可洗炼词条
            </div>
          ) : null}

          {(mode === 'enhance' || mode === 'refine') && !st ? (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 20 }}>
              无法{mode === 'enhance' ? '强化' : '精炼'}
            </div>
          ) : null}
        </div>

        <div className="mbag-sheet-actions">
          <button className="mbag-sheet-act-btn" onClick={onClose} disabled={submitting}>取消</button>
          <button
            className="mbag-sheet-act-btn is-primary"
            disabled={
              submitting || item.locked ||
              (mode === 'enhance' && enhanceState
                ? enhanceState.curLv >= 15 || enhanceState.owned < 1 ||
                playerSilver < enhanceState.silverCost || playerSpiritStones < enhanceState.spiritStoneCost
                : false) ||
              (mode === 'refine' && refineState
                ? refineState.curLv >= 10 || refineState.owned < refineState.materialQty ||
                playerSilver < refineState.silverCost || playerSpiritStones < refineState.spiritStoneCost
                : false) ||
              (mode === 'reroll' && rerollState
                ? rerollState.affixes.length <= 0 ||
                rerollState.rerollScrollOwned < rerollState.rerollScrollQty ||
                playerSpiritStones < rerollState.spiritStoneCost ||
                playerSilver < rerollState.silverCost
                : mode === 'reroll') ||
              (mode === 'socket' && socketState
                ? !socketState.selectedGem ||
                socketState.selectedSlot === undefined ||
                !socketState.slotValid ||
                !socketState.typeValid ||
                socketState.duplicateGem
                : mode === 'socket')
            }
            onClick={() => void (
              mode === 'enhance'
                ? handleEnhance()
                : mode === 'refine'
                  ? handleRefine()
                  : mode === 'socket'
                    ? handleSocket()
                    : handleReroll()
            )}
          >
            {submitting
              ? '处理中...'
              : mode === 'enhance'
                ? '强化'
                : mode === 'refine'
                  ? '精炼'
                  : mode === 'socket'
                    ? socketState?.replacedGem ? '替换镶嵌' : '镶嵌宝石'
                    : '洗炼'}
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
  useGameItemTaxonomy(open);

  /* 状态 */
  const [category, setCategory] = useState<BagCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BagSort>('default');
  const [sortOpen, setSortOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<BatchMode>('disassemble');
  const [batchQualities, setBatchQualities] = useState<BagQuality[]>(qualityLabels);
  const [batchCategory, setBatchCategory] = useState<BagCategory>('equipment');
  const [batchSubCategory, setBatchSubCategory] = useState<string>('all');
  const [batchKeyword, setBatchKeyword] = useState('');
  const [batchIncludeKeywordsText, setBatchIncludeKeywordsText] = useState('');
  const [batchExcludeKeywordsText, setBatchExcludeKeywordsText] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [disassembleOpen, setDisassembleOpen] = useState(false);
  const [craftOpen, setCraftOpen] = useState(false);
  const [gemSynthesisOpen, setGemSynthesisOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<InventoryInfoData | null>(null);
  const [items, setItems] = useState<BagItem[]>([]);
  const [playerSilver, setPlayerSilver] = useState(0);
  const [playerSpiritStones, setPlayerSpiritStones] = useState(0);
  const [useQty, setUseQty] = useState(1);
  const [growthMode, setGrowthMode] = useState<GrowthMode>('enhance');

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
  const useQtyMax = useMemo(() => {
    if (!activeItem || activeItem.category !== 'consumable') return 1;
    return Math.max(1, Math.floor(activeItem.qty));
  }, [activeItem]);
  const clampUseQty = useCallback(
    (value: number) => Math.max(1, Math.min(useQtyMax, Math.floor(value))),
    [useQtyMax],
  );
  useEffect(() => {
    setUseQty(1);
  }, [activeItem?.id]);
  useEffect(() => {
    setUseQty((prev) => Math.max(1, Math.min(prev, useQtyMax)));
  }, [useQtyMax]);
  const handleUseQtyChange = useCallback(
    (nextValue: number) => {
      if (!Number.isFinite(nextValue)) return;
      setUseQty(clampUseQty(nextValue));
    },
    [clampUseQty],
  );
  const handleUseQtyStep = useCallback(
    (delta: number) => {
      setUseQty((prev) => clampUseQty(prev + delta));
    },
    [clampUseQty],
  );
  const handleUseQtyMax = useCallback(() => {
    setUseQty(useQtyMax);
  }, [useQtyMax]);

  const usedSlots = info?.bag_used ?? items.filter((i) => i.location === 'bag').length;
  const totalSlots = info?.bag_capacity ?? 100;
  const bagOnlyItems = useMemo(() => items.filter((i) => i.location === 'bag'), [items]);

  const openBatch = useCallback(
    (mode: BatchMode) => {
      setBatchMode(mode);
      setBatchOpen(true);
      setBatchSubmitting(false);
      setBatchKeyword('');
      setBatchSubCategory('all');
      setBatchIncludeKeywordsText('');
      setBatchExcludeKeywordsText('');
      setBatchQualities(qualityLabels);
      // 默认主分类固定为“装备”，避免每次打开都落到“全部类型”。
      setBatchCategory('equipment');
    },
    [],
  );

  const batchSubCategoryOptions = useMemo(() => {
    const dynamicSubCategories: string[] = [];
    for (const item of bagOnlyItems) {
      if (batchCategory !== 'all' && item.category !== batchCategory) continue;
      if (!item.subCategory) continue;
      dynamicSubCategories.push(item.subCategory);
    }
    return buildAutoDisassembleSubCategoryOptionsByCategory(batchCategory, dynamicSubCategories);
  }, [bagOnlyItems, batchCategory]);

  useEffect(() => {
    if (batchSubCategory === 'all') return;
    const matched = batchSubCategoryOptions.some((option) => option.value === batchSubCategory);
    if (matched) return;
    setBatchSubCategory('all');
  }, [batchSubCategory, batchSubCategoryOptions]);

  const batchCandidates = useMemo(() => {
    const kw = batchKeyword.trim().toLowerCase();
    const includeKeywords = batchIncludeKeywordsText
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    const excludeKeywords = batchExcludeKeywordsText
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);

    let list = bagOnlyItems.filter((item) => !item.locked);
    if (batchMode === 'disassemble') {
      list = collectBatchDisassembleCandidates(list, {
        ...(batchCategory !== 'all' ? { categories: [batchCategory] } : {}),
        ...(batchSubCategory !== 'all' ? { subCategories: [batchSubCategory] } : {}),
        ...(batchQualities.length > 0 ? { qualities: batchQualities } : {}),
        ...(kw ? { keyword: kw } : {}),
        ...(includeKeywords.length > 0 ? { includeKeywords } : {}),
        ...(excludeKeywords.length > 0 ? { excludeKeywords } : {}),
      });
    } else {
      if (batchCategory !== 'all') {
        list = list.filter((item) => item.category === batchCategory);
      }
      if (batchSubCategory !== 'all') {
        list = list.filter((item) => (item.subCategory ?? '') === batchSubCategory);
      }
    }

    if (batchQualities.length > 0) {
      const allowed = new Set(batchQualities);
      list = list.filter((item) => allowed.has(item.quality));
    }

    if (kw) {
      list = list.filter((item) => `${item.name}${item.tags.join('')}`.toLowerCase().includes(kw));
    }

    return list;
  }, [
    bagOnlyItems,
    batchCategory,
    batchExcludeKeywordsText,
    batchIncludeKeywordsText,
    batchKeyword,
    batchMode,
    batchQualities,
    batchSubCategory,
  ]);

  const batchSummary = useMemo(() => {
    const qty = batchCandidates.reduce((sum, item) => sum + Math.max(0, item.qty || 0), 0);
    return `共${qty}件`;
  }, [batchCandidates]);

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
    const useCount = activeItem.category === 'consumable' ? clampUseQty(useQty) : 1;
    setLoading(true);
    try {
      const beforeChar = gameSocket.getCharacter();
      const res = await inventoryUseItem({ itemInstanceId: activeItem.id, qty: useCount });
      if (!res.success) throw new Error(res.message || '使用失败');

      const lootResults = res.data?.lootResults;
      const remaining = Math.max(0, Math.floor(activeItem.qty) - useCount);

      let content: string;
      if (lootResults && lootResults.length > 0) {
        const parts = lootResults.map((r) => `${r.name || r.type}×${r.amount}`);
        const qtyPart = useCount > 1 ? `×${useCount}` : '';
        content = `打开【${activeItem.name}】${qtyPart}，获得${parts.join('、')}。`;
      } else {
        const afterChar = res.data?.character;
        const beforeQixue = beforeChar?.qixue ?? null;
        const beforeLingqi = beforeChar?.lingqi ?? null;
        const beforeExp = beforeChar?.exp ?? null;
        const afterQixue = pickNumber(afterChar, ['qixue']);
        const afterLingqi = pickNumber(afterChar, ['lingqi']);
        const afterExp = pickNumber(afterChar, ['exp']);
        const effectDelta = calcUseEffectDelta(res.effects, useCount);
        const qixueByStat =
          beforeQixue !== null && afterQixue !== null ? Math.max(0, Math.floor(afterQixue - beforeQixue)) : null;
        const lingqiByStat =
          beforeLingqi !== null && afterLingqi !== null ? Math.max(0, Math.floor(afterLingqi - beforeLingqi)) : null;
        const expByStat = beforeExp !== null && afterExp !== null ? Math.max(0, Math.floor(afterExp - beforeExp)) : null;
        const restoredQixue = qixueByStat !== null ? qixueByStat : Math.max(0, effectDelta.qixue);
        const restoredLingqi = lingqiByStat !== null ? lingqiByStat : Math.max(0, effectDelta.lingqi);
        const gainedExp = expByStat !== null ? expByStat : Math.max(0, effectDelta.exp);
        const effectParts: string[] = [];
        if (restoredQixue > 0) effectParts.push(`恢复了${restoredQixue}点气血`);
        if (restoredLingqi > 0) effectParts.push(`恢复了${restoredLingqi}点灵气`);
        if (gainedExp > 0) effectParts.push(`获得了${gainedExp}点经验`);
        const qtyPart = useCount > 1 ? `×${useCount}` : '';
        content = activeItem.category === 'consumable'
          ? effectParts.length > 0
            ? `使用【${activeItem.name}】${qtyPart}成功，${effectParts.join('，')}，背包剩余${remaining}。`
            : `使用【${activeItem.name}】${qtyPart}成功，背包剩余${remaining}。`
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
  }, [activeItem, clampUseQty, refresh, useQty]);

  const handleToggleItemLock = useCallback(async () => {
    if (!activeItem) return;
    setLoading(true);
    try {
      const nextLocked = !activeItem.locked;
      const res = await setInventoryItemLock({
        itemId: activeItem.id,
        locked: nextLocked,
      });
      if (!res.success) throw new Error(res.message || (nextLocked ? '上锁失败' : '解锁失败'));

      message.success(res.message || (nextLocked ? '已锁定' : '已解锁'));
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '设置锁定状态失败');
    } finally {
      setLoading(false);
    }
  }, [activeItem, message, refresh]);

  const handleToggleBatchQuality = useCallback((quality: BagQuality) => {
    setBatchQualities((prev) => {
      if (prev.includes(quality)) {
        return prev.filter((value) => value !== quality);
      }
      return [...prev, quality];
    });
  }, []);

  const handleSubmitBatch = useCallback(async () => {
    if (batchCandidates.length === 0) return;
    setBatchSubmitting(true);
    try {
      if (batchMode === 'disassemble') {
        const payloadItems = buildBatchDisassemblePayloadItems(batchCandidates);
        if (payloadItems.length === 0) {
          message.info('没有可分解的物品');
          return;
        }

        const res = await disassembleInventoryEquipmentBatch(payloadItems);
        if (!res.success) throw new Error(res.message || '分解失败');
        message.success(res.message || '分解成功');
      } else {
        const ids = batchCandidates.map((item) => item.id);
        const res = await removeInventoryItemsBatch(ids);
        if (!res.success) throw new Error(res.message || '丢弃失败');
        message.success(res.message || '丢弃成功');
      }
      await refresh();
      setBatchOpen(false);
    } catch (e) {
      message.error((e as { message?: string }).message || '操作失败');
    } finally {
      setBatchSubmitting(false);
    }
  }, [batchCandidates, batchMode, message, refresh]);

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
            <InventoryItemCell
              key={it.id}
              className="mbag-cell"
              qualityClassName={getItemQualityMeta(it.quality)?.className}
              active={it.id === activeId}
              quantity={it.qty}
              showQuantity={it.stackMax > 1}
              equippedLabel={it.location === 'equipped' ? '穿戴' : undefined}
              lockedLabel={it.locked ? '锁' : undefined}
              icon={it.icon}
              name={it.name}
              onClick={() => { setActiveId(it.id); setSheetOpen(true); }}
            />
          ))}
        </div>
      </div>

      {/* ── 底部操作栏 ── */}
      <div className="mbag-footer">
        <div className="mbag-footer-actions">
          <button className="mbag-footer-btn" disabled={loading || batchSubmitting} onClick={() => setCraftOpen(true)}>
            炼制
          </button>
          <button className="mbag-footer-btn" disabled={loading || batchSubmitting} onClick={() => setGemSynthesisOpen(true)}>
            宝石合成
          </button>
          <button className="mbag-footer-btn" disabled={loading || batchSubmitting} onClick={() => openBatch('disassemble')}>
            分解
          </button>
          <button className="mbag-footer-btn is-danger" disabled={loading || batchSubmitting} onClick={() => openBatch('remove')}>
            丢弃
          </button>
        </div>
        <button className="mbag-footer-btn is-primary" disabled={loading || batchSubmitting} onClick={() => void handleSort()}>
          {loading ? '整理中...' : '整理'}
        </button>
      </div>

      {/* ── Bottom Sheet: 物品详情 ── */}
      {sheetOpen && activeItem && (
        <ItemSheet
          item={activeItem}
          loading={loading}
          useQty={useQty}
          useQtyMax={useQtyMax}
          onClose={() => setSheetOpen(false)}
          onUse={() => void handleUseItem()}
          onUseQtyChange={handleUseQtyChange}
          onUseQtyStep={handleUseQtyStep}
          onUseQtyMax={handleUseQtyMax}
          onEquipToggle={() => void handleEquipToggle()}
          onDisassemble={() => { setSheetOpen(false); setDisassembleOpen(true); }}
          onEnhance={() => {
            setGrowthMode('enhance');
            setSheetOpen(false);
            setGrowthOpen(true);
          }}
          onSocket={() => {
            setGrowthMode('socket');
            setSheetOpen(false);
            setGrowthOpen(true);
          }}
          onToggleLock={() => void handleToggleItemLock()}
        />
      )}

      {/* ── Bottom Sheet: 强化/精炼 ── */}
      {growthOpen && activeItem && activeItem.category === 'equipment' && (
        <GrowthSheet
          item={activeItem}
          allItems={items}
          playerSilver={playerSilver}
          playerSpiritStones={playerSpiritStones}
          initialMode={growthMode}
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
          qty: activeItem.qty,
          location: activeItem.location,
          locked: activeItem.locked,
          category: activeItem.category,
          subCategory: activeItem.subCategory,
        } : null}
        onClose={() => setDisassembleOpen(false)}
        onSuccess={refresh}
      />

      <CraftModal
        open={craftOpen}
        onClose={() => setCraftOpen(false)}
        focusItemDefId={activeItem?.itemDefId}
        onSuccess={async () => {
          await refresh();
          window.dispatchEvent(new Event('inventory:changed'));
        }}
      />

      <GemSynthesisModal
        open={gemSynthesisOpen}
        onClose={() => setGemSynthesisOpen(false)}
        onSuccess={async () => {
          await refresh();
          window.dispatchEvent(new Event('inventory:changed'));
        }}
      />

      {/* ── 排序面板 ── */}
      {sortOpen && (
        <SortPanel
          value={sort}
          onChange={setSort}
          onClose={() => setSortOpen(false)}
        />
      )}

      {/* ── 批量操作面板 ── */}
      {batchOpen && (
        <BatchPanel
          mode={batchMode}
          submitting={batchSubmitting}
          qualities={batchQualities}
          category={batchCategory}
          subCategory={batchSubCategory}
          keyword={batchKeyword}
          includeKeywordsText={batchIncludeKeywordsText}
          excludeKeywordsText={batchExcludeKeywordsText}
          subCategoryOptions={batchSubCategoryOptions}
          candidateCount={batchCandidates.length}
          summaryText={batchSummary}
          onClose={() => {
            if (batchSubmitting) return;
            setBatchOpen(false);
          }}
          onSubmit={() => void handleSubmitBatch()}
          onToggleQuality={handleToggleBatchQuality}
          onCategoryChange={(value) => {
            setBatchCategory(value);
            setBatchSubCategory('all');
          }}
          onSubCategoryChange={setBatchSubCategory}
          onKeywordChange={setBatchKeyword}
          onIncludeKeywordsChange={setBatchIncludeKeywordsText}
          onExcludeKeywordsChange={setBatchExcludeKeywordsText}
        />
      )}
    </div>
  );
};

export default MobileBagModal;
