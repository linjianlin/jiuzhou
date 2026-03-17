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
  getRerollCostPreview,
  getAffixPoolPreview,
  removeInventoryItemsBatch,
  setInventoryItemLock,
  socketInventoryGem,
  sortInventory,
  unequipInventoryItem,
} from '../../../../services/api';
import { getUnifiedApiErrorMessage } from '../../../../services/api';
import type { InventoryInfoData, AffixPoolPreviewResponse } from '../../../../services/api';
import {
  attrLabel,
  attrOrder,
  buildBagItem,
  buildBatchDisassemblePayloadItems,
  buildEquipmentDetailLines,
  categoryLabels,
  collectBatchDisassembleCandidates,
  collectGemCandidates,
  formatAffixRollPercent,
  formatEquipmentAffixLine,
  formatUseItemChatContent,
  getAffixRollColorVars,
  getAffixRollPercent,
  getEquipSlotLabel,
  isDisassemblableBagItem,
  isGemTypeAllowedInSlot,
  normalizeAffixLockIndexes,
  normalizeGemType,
  percentAttrKeys,
  qualityClass,
  qualityColor,
  qualityLabelText,
  qualityLabels,
  qualityRank,
} from './bagShared';
import type { BagAction, BagCategory, BagItem, BagQuality, BagSort, BatchMode } from './bagShared';
import { AffixPoolPreviewModal } from './AffixPoolPreviewModal';
import { buildAutoDisassembleSubCategoryOptionsByCategory } from '../../shared/autoDisassembleFilters';
import { formatPercent, formatSignedNumber, formatSignedPercent } from '../../shared/formatAttr';
import { getItemQualityMeta, getItemQualityTagClassName } from '../../shared/itemQuality';
import { ITEM_CATEGORY_ALL_OPTION, ITEM_CATEGORY_OPTIONS } from '../../shared/itemTaxonomy';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import InventoryItemCell from '../../shared/InventoryItemCell';
import { EquipmentDetailAttrList } from './EquipmentDetailAttrList';
import { SetBonusDisplay } from './SetBonusDisplay';
import DisassembleModal from './DisassembleModal';
import CraftModal from './CraftModal';
import GemSynthesisModal from './GemSynthesisModal';
import { formatDisassembleSuccessMessage } from './disassembleRewardText';
import { getEquipmentGrowthFailModeText, useEquipmentGrowthPreview } from './useEquipmentGrowthPreview';
import { useTechniqueBookSkills } from './useTechniqueBookSkills';
import { collectEquipmentUnbindCandidates } from './equipmentUnbind';
import {
  buildAutoRerollTargetOptions,
  getAffordableAutoRerollTimes,
  hasMatchedAutoRerollTargets,
} from './autoReroll';
import { TechniqueSkillSection } from '../../shared/TechniqueSkillSection';
import { useCharacterRenameCardFlow } from '../../shared/useCharacterRenameCardFlow';
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

interface EquipmentUnbindPanelProps {
  itemName: string;
  submitting: boolean;
  candidates: BagItem[];
  selectedTargetItemId?: number;
  onClose: () => void;
  onChangeTarget: (value: number | undefined) => void;
  onSubmit: () => void;
}

const EquipmentUnbindPanel: React.FC<EquipmentUnbindPanelProps> = ({
  itemName,
  submitting,
  candidates,
  selectedTargetItemId,
  onClose,
  onChangeTarget,
  onSubmit,
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
      <div className="mbag-batch-title">选择解绑装备</div>
      <div className="mbag-batch-summary">使用【{itemName}】后，可将一件已绑定装备恢复为未绑定。</div>

      <div className="mbag-batch-field">
        <div className="mbag-batch-label">已绑定装备</div>
        <select
          className="mbag-batch-select"
          value={selectedTargetItemId ?? ''}
          disabled={submitting || candidates.length <= 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChangeTarget(Number.isInteger(next) && next > 0 ? next : undefined);
          }}
        >
          <option value="">请选择已绑定装备</option>
          {candidates.map((item) => {
            const slotText = item.equip?.equipSlot ? getEquipSlotLabel(item.equip.equipSlot) : '装备';
            const levelText = `+${item.equip?.strengthenLevel ?? 0}/精炼+${item.equip?.refineLevel ?? 0}`;
            const locationText = item.location === 'equipped' ? '已穿戴' : '背包';
            return (
              <option key={item.id} value={item.id}>
                {item.name} · {slotText} · {levelText} · {locationText}
              </option>
            );
          })}
        </select>
      </div>

      {candidates.length <= 0 ? (
        <div className="mbag-batch-tip">当前没有可解绑的已绑定装备</div>
      ) : null}

      <div className="mbag-batch-actions">
        <button
          type="button"
          className="mbag-batch-btn"
          disabled={submitting}
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          className="mbag-batch-btn is-primary"
          disabled={submitting || selectedTargetItemId === undefined}
          onClick={onSubmit}
        >
          {submitting ? '解绑中...' : '确认解绑'}
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
  const techniqueBookSkillsState = useTechniqueBookSkills({
    item,
    enabled: true,
  });
  const hasDesc = item.category !== 'equipment' && Boolean(item.desc?.trim());
  const hasEquipAttrs = item.category === 'equipment' && equipLines.length > 0;
  const hasSetInfo = Boolean(item.setInfo && item.setInfo.bonuses.length > 0);
  const hasTechniqueBookSkills = Boolean(item.learnableTechniqueId);
  const hasEffects = (item.effects?.length ?? 0) > 0;
  const isEquipped = item.location === 'equipped';
  const canBatchUse =
    item.actions.includes('use') &&
    item.category === 'consumable' &&
    item.location === 'bag' &&
    item.useTargetType === 'none' &&
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
              <span className={`mbag-sheet-tag mbag-sheet-tag--quality ${getItemQualityTagClassName(item.quality)}`}>
                {qualityLabelText[item.quality]}
              </span>
              <span className="mbag-sheet-tag mbag-sheet-tag--bind">{item.bind.detailLabel}</span>
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

          {hasTechniqueBookSkills && (
            <div className="mbag-sheet-section">
              <TechniqueSkillSection
                skills={techniqueBookSkillsState.skills}
                loading={techniqueBookSkillsState.loading}
                error={techniqueBookSkillsState.error}
                variant="mobile"
              />
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
  const [autoRerollSubmitting, setAutoRerollSubmitting] = useState(false);
  const [rerollLockIndexes, setRerollLockIndexes] = useState<number[]>([]);
  const [rerollCostTable, setRerollCostTable] = useState<{
    rerollScrollItemDefId: string;
    entries: Array<{ lockCount: number; rerollScrollQty: number; silverCost: number; spiritStoneCost: number }>;
  } | null>(null);
  const [poolPreviewOpen, setPoolPreviewOpen] = useState(false);
  const [poolPreviewLoading, setPoolPreviewLoading] = useState(false);
  const [poolPreviewData, setPoolPreviewData] = useState<AffixPoolPreviewResponse['data'] | null>(null);
  const [autoRerollTargetKeys, setAutoRerollTargetKeys] = useState<string[]>([]);
  const [autoRerollMaxAttempts, setAutoRerollMaxAttempts] = useState(50);
  const [socketSlot, setSocketSlot] = useState<number | undefined>(undefined);
  const [selectedGemItemId, setSelectedGemItemId] = useState<number | undefined>(undefined);

  const bagItemCounts = useMemo(() => {
    // 洗炼符是 consumable，因此需要按背包全部物品统计，而不是仅 material。
    const out: Record<string, number> = {};
    for (const it of allItems) {
      if (it.location !== 'bag') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, it.qty);
    }
    return out;
  }, [allItems]);

  const {
    enhanceState,
    refineState,
    loading: growthPreviewLoading,
  } = useEquipmentGrowthPreview({
    item,
    allItems,
    enabled: mode === 'enhance' || mode === 'refine',
  });

  useEffect(() => {
    const affixCount = item.equip?.affixes.length ?? 0;
    setRerollLockIndexes((prev) => normalizeAffixLockIndexes(prev, affixCount));
  }, [item.id, item.equip?.affixes.length]);
  useEffect(() => {
    if (!item.equip || item.category !== 'equipment') {
      setRerollCostTable(null);
      return;
    }
    let cancelled = false;
    getRerollCostPreview(item.id).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setRerollCostTable({
          rerollScrollItemDefId: res.data.rerollScrollItemDefId,
          entries: res.data.costTable,
        });
      } else {
        setRerollCostTable(null);
      }
    }).catch(() => { if (!cancelled) setRerollCostTable(null); });
    return () => { cancelled = true; };
  }, [item.id]);
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, item.id]);
  useEffect(() => {
    setSocketSlot(undefined);
    setSelectedGemItemId(undefined);
    setAutoRerollTargetKeys([]);
    setAutoRerollSubmitting(false);
  }, [item.id]);

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
    const costEntry = rerollCostTable?.entries[lockIndexes.length];

    return {
      affixes,
      maxLockCount,
      lockIndexes,
      lockIndexSet,
      rerollScrollQty: costEntry?.rerollScrollQty ?? 0,
      rerollScrollOwned: bagItemCounts[rerollCostTable?.rerollScrollItemDefId ?? ''] ?? 0,
      spiritStoneCost: costEntry?.spiritStoneCost ?? 0,
      silverCost: costEntry?.silverCost ?? 0,
    };
  }, [item, bagItemCounts, rerollLockIndexes, rerollCostTable]);

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
        message.warning(res.message || '强化失败');
      }
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      void 0;
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
        else void 0;
      }
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      void 0;
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
        void 0;
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
      void 0;
    } finally {
      setSubmitting(false);
    }
  }, [item.id, message, onDone, rerollState]);

  const autoRerollOptions = useMemo(
    () => buildAutoRerollTargetOptions(poolPreviewData?.affixes ?? [], rerollState?.affixes ?? []),
    [poolPreviewData?.affixes, rerollState?.affixes],
  );

  const handleAutoReroll = useCallback(async () => {
    if (!rerollState || rerollState.affixes.length <= 0) return;
    const targetKeys = autoRerollTargetKeys.filter((key) => key.trim().length > 0);
    if (targetKeys.length <= 0) {
      message.warning('请先设置目标词条');
      return;
    }
    if (hasMatchedAutoRerollTargets(rerollState.affixes, targetKeys)) {
      message.success('当前词条已满足目标，无需自动洗炼');
      return;
    }
    if (item.locked) {
      message.warning('物品已锁定，无法自动洗炼');
      return;
    }

    const lockIndexes = normalizeAffixLockIndexes(
      rerollState.lockIndexes,
      rerollState.affixes.length,
    ).slice(0, rerollState.maxLockCount);
    const maxTimes = getAffordableAutoRerollTimes({
      rerollScrollOwned: rerollState.rerollScrollOwned,
      rerollScrollCost: rerollState.rerollScrollQty,
      spiritStoneOwned: playerSpiritStones,
      spiritStoneCost: rerollState.spiritStoneCost,
      silverOwned: playerSilver,
      silverCost: rerollState.silverCost,
      maxAttempts: autoRerollMaxAttempts,
    });
    if (maxTimes <= 0) {
      message.warning('资源不足或最大次数为 0，无法开始自动洗炼');
      return;
    }

    setAutoRerollSubmitting(true);
    let attempt = 0;
    let matched = false;
    try {
      while (attempt < maxTimes) {
        const res = await rerollInventoryAffixes({
          itemId: item.id,
          lockIndexes,
        });
        if (!res.success) {
          message.warning(res.message || '自动洗炼中断');
          break;
        }
        attempt += 1;
        const latestAffixes = res.data?.affixes ?? [];
        if (hasMatchedAutoRerollTargets(latestAffixes, targetKeys)) {
          matched = true;
          break;
        }
      }
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
      if (matched) {
        message.success(`自动洗炼完成，已命中目标词条（第${attempt}次）`);
      } else if (attempt >= maxTimes) {
        message.warning(`自动洗炼结束，达到最大尝试次数（${maxTimes}次）`);
      }
    } catch {
      void 0;
    } finally {
      setAutoRerollSubmitting(false);
    }
  }, [autoRerollMaxAttempts, autoRerollTargetKeys, item.id, item.locked, message, onDone, playerSilver, playerSpiritStones, rerollState]);

  const handleOpenPoolPreview = useCallback(async () => {
    if (!item?.id || poolPreviewLoading) return;
    setPoolPreviewOpen(true);
    setPoolPreviewLoading(true);
    setPoolPreviewData(null);
    try {
      const res = await getAffixPoolPreview(item.id);
      if (res.success) {
        setPoolPreviewData(res.data ?? null);
      } else {
        message.warning(res.message || '获取词条池失败');
        setPoolPreviewOpen(false);
      }
    } catch {
      message.error('获取词条池失败');
      setPoolPreviewOpen(false);
    } finally {
      setPoolPreviewLoading(false);
    }
  }, [item, message, poolPreviewLoading]);

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
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '镶嵌失败'));
      message.success(res.message || '镶嵌成功');
      setSocketSlot(undefined);
      setSelectedGemItemId(undefined);
      await onDone();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (e) {
      void 0;
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
                  {mode === 'enhance' && enhanceState && enhanceState.failMode !== 'none' && (
                    <span style={{ marginLeft: 8, color: 'var(--danger-color)' }}>
                      {getEquipmentGrowthFailModeText(enhanceState.failMode)}
                    </span>
                  )}
                </div>
              </div>

              {/* 消耗 */}
              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">消耗</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {st.materialQty > 0 && (
                    <CostChip
                      label={st.materialName}
                      cost={st.materialQty}
                      owned={st.owned}
                    />
                  )}
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
                <div className="mbag-sheet-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>消耗</span>
                  <a
                    href="#"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!item.locked) {
                        handleOpenPoolPreview();
                      }
                    }}
                    style={{
                      fontSize: 12,
                      fontWeight: 'normal',
                      color: item.locked ? 'var(--text-tertiary)' : 'var(--primary-color)',
                      cursor: item.locked ? 'not-allowed' : 'pointer',
                      textDecoration: 'none'
                    }}
                  >
                    查看词条池
                  </a>
                </div>
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
                    const rollColorVars = getAffixRollColorVars(rollPercent);
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
                          <span className="mbag-sheet-reroll-lock-roll" style={rollColorVars ?? undefined}>
                            <span className="mbag-sheet-reroll-lock-roll-label">ROLL</span>
                            <span className="mbag-sheet-reroll-lock-roll-value">{formatAffixRollPercent(rollPercent)}</span>
                            <span className="mbag-sheet-reroll-lock-roll-track" aria-hidden="true">
                              <span
                                className="mbag-sheet-reroll-lock-roll-fill"
                                style={{ width: `${rollPercent ?? 0}%` }}
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

              <div className="mbag-sheet-section">
                <div className="mbag-sheet-section-title">自动洗炼</div>
                <div className="mbag-auto-reroll-controls">
                  <select
                    className="mbag-auto-reroll-select"
                    multiple
                    value={autoRerollTargetKeys}
                    onChange={(event) => {
                      const values = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
                      setAutoRerollTargetKeys(values);
                    }}
                    disabled={submitting || autoRerollSubmitting || item.locked}
                  >
                    {autoRerollOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                  <label className="mbag-auto-reroll-attempts">
                    <span>最大次数</span>
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={autoRerollMaxAttempts}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (!Number.isFinite(value)) return;
                        setAutoRerollMaxAttempts(Math.max(1, Math.min(2000, Math.floor(value))));
                      }}
                      disabled={submitting || autoRerollSubmitting || item.locked}
                    />
                  </label>
                  <button
                    className="mbag-sheet-act-btn is-primary"
                    disabled={
                      submitting ||
                      autoRerollSubmitting ||
                      item.locked ||
                      autoRerollTargetKeys.length <= 0 ||
                      rerollState.affixes.length <= 0
                    }
                    onClick={() => void handleAutoReroll()}
                  >
                    {autoRerollSubmitting ? '自动洗炼中...' : '开启自动洗炼'}
                  </button>
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
              {growthPreviewLoading ? '正在获取成长消耗...' : `无法${mode === 'enhance' ? '强化' : '精炼'}`}
            </div>
          ) : null}
        </div>

        <div className="mbag-sheet-actions">
          <button className="mbag-sheet-act-btn" onClick={onClose} disabled={submitting}>取消</button>
          <button
            className="mbag-sheet-act-btn is-primary"
            disabled={
              submitting || autoRerollSubmitting || item.locked ||
              (mode === 'enhance' && enhanceState
                ? enhanceState.owned < enhanceState.materialQty ||
                playerSilver < enhanceState.silverCost || playerSpiritStones < enhanceState.spiritStoneCost
                : mode === 'enhance') ||
              (mode === 'refine' && refineState
                ? (refineState.maxLv !== null && refineState.curLv >= refineState.maxLv) ||
                refineState.owned < refineState.materialQty ||
                playerSilver < refineState.silverCost || playerSpiritStones < refineState.spiritStoneCost
                : mode === 'refine') ||
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

      <AffixPoolPreviewModal
        open={poolPreviewOpen}
        onClose={() => setPoolPreviewOpen(false)}
        loading={poolPreviewLoading}
        poolName={poolPreviewData?.poolName ?? ''}
        affixes={poolPreviewData?.affixes ?? []}
      />
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
  const [equipmentUnbindOpen, setEquipmentUnbindOpen] = useState(false);
  const [equipmentUnbindSubmitting, setEquipmentUnbindSubmitting] = useState(false);
  const [selectedUnbindTargetItemId, setSelectedUnbindTargetItemId] = useState<number | undefined>(undefined);
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
      void 0;
      setInfo(null);
      setItems([]);
      setActiveId(null);
    } finally {
      setLoading(false);
    }
  }, [message]);

  const { openCharacterRename, renameModalNode } = useCharacterRenameCardFlow({
    refresh,
    onAfterSuccess: () => {
      setSheetOpen(false);
    },
  });

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
  const equipmentUnbindCandidates = useMemo(
    () => collectEquipmentUnbindCandidates(items),
    [items],
  );
  const selectedUnbindTargetItem = useMemo(
    () => equipmentUnbindCandidates.find((item) => item.id === selectedUnbindTargetItemId) ?? null,
    [equipmentUnbindCandidates, selectedUnbindTargetItemId],
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
    if (!equipmentUnbindOpen) {
      setSelectedUnbindTargetItemId(undefined);
      return;
    }
    setSelectedUnbindTargetItemId((prev) => {
      if (prev !== undefined && equipmentUnbindCandidates.some((item) => item.id === prev)) {
        return prev;
      }
      return equipmentUnbindCandidates[0]?.id;
    });
  }, [equipmentUnbindCandidates, equipmentUnbindOpen]);
  useEffect(() => {
    if (activeItem?.useTargetType === 'boundEquipment') return;
    setEquipmentUnbindOpen(false);
  }, [activeItem?.id, activeItem?.useTargetType]);
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
        if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '卸下失败'));
        message.success(res.message || '卸下成功');
      } else {
        const res = await equipInventoryItem(activeItem.id);
        if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '装备失败'));
        message.success(res.message || '装备成功');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSheetOpen(false);
    } catch (e) {
      void 0;
      setLoading(false);
    }
  }, [activeItem, message, refresh]);

  const handleUseItem = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.useTargetType === 'characterRename') {
      openCharacterRename({
        itemInstanceId: activeItem.id,
        itemName: activeItem.name,
      });
      return;
    }
    if (activeItem.useTargetType === 'boundEquipment') {
      if (equipmentUnbindCandidates.length <= 0) {
        message.warning('当前没有可解绑的已绑定装备');
        return;
      }
      setEquipmentUnbindOpen(true);
      return;
    }
    const useCount = activeItem.category === 'consumable' ? clampUseQty(useQty) : 1;
    setLoading(true);
    try {
      const beforeChar = gameSocket.getCharacter();
      const res = await inventoryUseItem({ itemInstanceId: activeItem.id, qty: useCount });
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '使用失败'));

      const lootResults = res.data?.lootResults;
      const remaining = Math.max(0, Math.floor(activeItem.qty) - useCount);
      const content = formatUseItemChatContent({
        itemName: activeItem.name,
        itemCategory: activeItem.category,
        useCount,
        remaining,
        lootResults,
        beforeCharacter: beforeChar,
        afterCharacter: res.data?.character,
        effects: res.effects,
      });
      window.dispatchEvent(new CustomEvent('chat:append', { detail: { channel: 'system', content } }));
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSheetOpen(false);
    } catch (e) {
      window.dispatchEvent(new CustomEvent('chat:append', {
        detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${getUnifiedApiErrorMessage(e, '操作失败')}` },
      }));
      setLoading(false);
    }
  }, [activeItem, clampUseQty, equipmentUnbindCandidates.length, message, openCharacterRename, refresh, useQty]);

  const handleSubmitEquipmentUnbind = useCallback(async () => {
    if (!activeItem || activeItem.useTargetType !== 'boundEquipment') return;
    if (!selectedUnbindTargetItem) {
      message.warning('请选择要解绑的装备');
      return;
    }

    setEquipmentUnbindSubmitting(true);
    try {
      const res = await inventoryUseItem({
        itemInstanceId: activeItem.id,
        qty: 1,
        targetItemInstanceId: selectedUnbindTargetItem.id,
      });
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '使用失败'));

      window.dispatchEvent(new CustomEvent('chat:append', {
        detail: {
          channel: 'system',
          content: `使用【${activeItem.name}】成功，【${selectedUnbindTargetItem.name}】已解除绑定。`,
        },
      }));
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setEquipmentUnbindOpen(false);
      setSheetOpen(false);
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('chat:append', {
        detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${getUnifiedApiErrorMessage(error, '操作失败')}` },
      }));
    } finally {
      setEquipmentUnbindSubmitting(false);
    }
  }, [activeItem, message, refresh, selectedUnbindTargetItem]);

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
      void 0;
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
        if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '分解失败'));
        message.success(formatDisassembleSuccessMessage(res.message || '分解成功', res.rewards));
      } else {
        const ids = batchCandidates.map((item) => item.id);
        const res = await removeInventoryItemsBatch(ids);
        if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '丢弃失败'));
        message.success(res.message || '丢弃成功');
      }
      await refresh();
      setBatchOpen(false);
    } catch (e) {
      void 0;
    } finally {
      setBatchSubmitting(false);
    }
  }, [batchCandidates, batchMode, message, refresh]);

  const handleSort = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sortInventory('bag');
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '整理失败'));
      await refresh();
    } catch (e) {
      void 0;
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
          canDisassemble: activeItem.canDisassemble,
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

      {equipmentUnbindOpen && activeItem && (
        <EquipmentUnbindPanel
          itemName={activeItem.name}
          submitting={equipmentUnbindSubmitting}
          candidates={equipmentUnbindCandidates}
          selectedTargetItemId={selectedUnbindTargetItemId}
          onClose={() => {
            if (equipmentUnbindSubmitting) return;
            setEquipmentUnbindOpen(false);
          }}
          onChangeTarget={setSelectedUnbindTargetItemId}
          onSubmit={() => void handleSubmitEquipmentUnbind()}
        />
      )}
      {renameModalNode}
    </div>
  );
};

export default MobileBagModal;
