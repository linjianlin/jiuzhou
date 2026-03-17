import { App, Button, Input, InputNumber, Modal, Select, Tabs, Tag } from 'antd';
import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import MobileBagModal from './MobileBagModal';
import { AffixPoolPreviewModal } from './AffixPoolPreviewModal';

import { gameSocket } from '../../../../services/gameSocket';
import {
  disassembleInventoryEquipmentBatch,
  enhanceInventoryItem,
  equipInventoryItem,
  getInventoryInfo,
  getInventoryItems,
  refineInventoryItem,
  rerollInventoryAffixes,
  getRerollCostPreview,
  getAffixPoolPreview,
  removeInventoryItemsBatch,
  setInventoryItemLock,
  socketInventoryGem,
  sortInventory,
  unequipInventoryItem,
  inventoryUseItem,
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
  normalizeGemType,
  normalizeAffixLockIndexes,
  percentAttrKeys,
  qualityClass,
  qualityColor,
  qualityLabelText,
  qualityLabels,
  qualityRank,
} from './bagShared';
import type { BagAction, BagCategory, BagItem, BagQuality, BagSort, BatchMode } from './bagShared';
import DisassembleModal from './DisassembleModal';
import CraftModal from './CraftModal';
import GemSynthesisModal from './GemSynthesisModal';
import { formatPercent, formatSignedNumber, formatSignedPercent } from '../../shared/formatAttr';
import { buildAutoDisassembleSubCategoryOptionsByCategory } from '../../shared/autoDisassembleFilters';
import { getItemQualityTagClassName } from '../../shared/itemQuality';
import { ITEM_CATEGORY_ALL_OPTION, ITEM_CATEGORY_OPTIONS } from '../../shared/itemTaxonomy';
import { useGameItemTaxonomy } from '../../shared/useGameItemTaxonomy';
import { useIsMobile } from '../../shared/responsive';
import { getItemQualityMeta } from '../../shared/itemQuality';
import InventoryItemCell from '../../shared/InventoryItemCell';
import { EquipmentDetailAttrList } from './EquipmentDetailAttrList';
import { SetBonusDisplay } from './SetBonusDisplay';
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
import './index.scss';

interface BagModalProps {
  open: boolean;
  onClose: () => void;
}

const BagModal: React.FC<BagModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  useGameItemTaxonomy(open);
  const [category, setCategory] = useState<BagCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BagSort>('default');
  const [quality, setQuality] = useState<BagQuality | 'all'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategories, setFilterCategories] = useState<Array<Exclude<BagCategory, 'all'>>>([]);
  const [filterQualities, setFilterQualities] = useState<BagQuality[]>([]);
  const [filterAttrKeys, setFilterAttrKeys] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [disassembleOpen, setDisassembleOpen] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceSubmitting, setEnhanceSubmitting] = useState(false);
  const [growthMode, setGrowthMode] = useState<'enhance' | 'refine' | 'socket' | 'reroll'>('enhance');
  const [refineSubmitting, setRefineSubmitting] = useState(false);
  const [socketSubmitting, setSocketSubmitting] = useState(false);
  const [rerollSubmitting, setRerollSubmitting] = useState(false);
  const [autoRerollSubmitting, setAutoRerollSubmitting] = useState(false);
  const [equipmentUnbindOpen, setEquipmentUnbindOpen] = useState(false);
  const [equipmentUnbindSubmitting, setEquipmentUnbindSubmitting] = useState(false);
  const [selectedUnbindTargetItemId, setSelectedUnbindTargetItemId] = useState<number | undefined>(undefined);
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
  const [batchOpen, setBatchOpen] = useState(false);
  const [craftOpen, setCraftOpen] = useState(false);
  const [gemSynthesisOpen, setGemSynthesisOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<BatchMode>('disassemble');
  const [batchQualities, setBatchQualities] = useState<BagQuality[]>(qualityLabels);
  const [batchCategory, setBatchCategory] = useState<BagCategory>('equipment');
  const [batchSubCategory, setBatchSubCategory] = useState<string>('all');
  const [batchKeyword, setBatchKeyword] = useState('');
  const [batchIncludeKeywordsText, setBatchIncludeKeywordsText] = useState('');
  const [batchExcludeKeywordsText, setBatchExcludeKeywordsText] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<InventoryInfoData | null>(null);
  const [items, setItems] = useState<BagItem[]>([]);
  const [playerSilver, setPlayerSilver] = useState(0);
  const [playerSpiritStones, setPlayerSpiritStones] = useState(0);
  const [useQty, setUseQty] = useState(1);

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

      const nextBagItems = bagRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      const nextEquippedItems = equippedRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      const nextItems = [...nextBagItems, ...nextEquippedItems];
      setInfo(infoRes.data);
      setItems(nextItems);
    } catch (error: unknown) {
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
  });

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  const totalSlots = info?.bag_capacity ?? 100;

  const filterAttrKeyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it.category !== 'equipment' || !it.equip) continue;
      for (const k of Object.keys(it.equip.baseAttrs || {})) {
        if (k) set.add(k);
      }
      for (const a of it.equip.affixes || []) {
        for (const m of a.modifiers || []) {
          const k = m?.attr_key;
          if (k) set.add(k);
        }
      }
    }
    const list = [...set];
    list.sort((a, b) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b));
    return list.map((k) => ({ value: k, label: attrLabel[k] ?? k }));
  }, [items]);

  const activeFilterCount = useMemo(() => {
    return filterCategories.length + filterQualities.length + filterAttrKeys.length;
  }, [filterAttrKeys.length, filterCategories.length, filterQualities.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items;
    if (filterCategories.length > 0) {
      const set = new Set(filterCategories);
      list = list.filter((i) => set.has(i.category));
    } else if (category !== 'all') {
      list = list.filter((i) => i.category === category);
    }

    if (filterQualities.length > 0) {
      const set = new Set(filterQualities);
      list = list.filter((i) => set.has(i.quality));
    } else if (quality !== 'all') {
      list = list.filter((i) => i.quality === quality);
    }

    if (filterAttrKeys.length > 0) {
      const set = new Set(filterAttrKeys);
      list = list.filter((i) => {
        if (i.category !== 'equipment' || !i.equip) return false;
        for (const k of Object.keys(i.equip.baseAttrs || {})) {
          if (set.has(k)) return true;
        }
        for (const a of i.equip.affixes || []) {
          for (const m of a.modifiers || []) {
            const k = m?.attr_key;
            if (k && set.has(k)) return true;
          }
        }
        return false;
      });
    }

    if (q) {
      list = list.filter((i) => `${i.name}${i.tags.join('')}`.toLowerCase().includes(q));
    }

    const out = [...list];
    if (sort === 'nameAsc') out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    if (sort === 'nameDesc') out.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
    if (sort === 'qtyDesc') out.sort((a, b) => b.qty - a.qty);
    if (sort === 'qualityDesc') out.sort((a, b) => qualityRank[b.quality] - qualityRank[a.quality]);
    return out;
  }, [category, query, quality, sort, items, filterCategories, filterQualities, filterAttrKeys]);

  const safeActiveId = useMemo(() => {
    if (activeId !== null && filtered.some((i) => i.id === activeId)) return activeId;
    return filtered[0]?.id ?? null;
  }, [activeId, filtered]);

  const activeItem = useMemo(
    () => (safeActiveId === null ? null : filtered.find((i) => i.id === safeActiveId) ?? null),
    [filtered, safeActiveId]
  );
  const techniqueBookSkillsState = useTechniqueBookSkills({
    item: activeItem,
    enabled: open,
  });
  const equipmentUnbindCandidates = useMemo(
    () => collectEquipmentUnbindCandidates(items),
    [items],
  );
  const selectedUnbindTargetItem = useMemo(
    () => equipmentUnbindCandidates.find((item) => item.id === selectedUnbindTargetItemId) ?? null,
    [equipmentUnbindCandidates, selectedUnbindTargetItemId],
  );
  useEffect(() => {
    if (!enhanceOpen) {
      setRerollLockIndexes([]);
      setAutoRerollSubmitting(false);
      return;
    }
    const affixCount = activeItem?.equip?.affixes.length ?? 0;
    setRerollLockIndexes((prev) => normalizeAffixLockIndexes(prev, affixCount));
  }, [activeItem?.id, activeItem?.equip?.affixes.length, enhanceOpen]);

  useEffect(() => {
    setAutoRerollTargetKeys([]);
    setAutoRerollSubmitting(false);
  }, [activeItem?.id]);

  useEffect(() => {
    if (!enhanceOpen || !activeItem?.equip || activeItem.category !== 'equipment') {
      setRerollCostTable(null);
      return;
    }
    let cancelled = false;
    getRerollCostPreview(activeItem.id).then((res) => {
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
  }, [activeItem?.id, enhanceOpen]);

  const useQtyMax = useMemo(() => {
    if (!activeItem || activeItem.category !== 'consumable') return 1;
    return Math.max(1, Math.floor(activeItem.qty));
  }, [activeItem]);
  const canBatchUseConsumable = useMemo(() => {
    if (!activeItem) return false;
    if (!activeItem.actions.includes('use')) return false;
    if (activeItem.category !== 'consumable') return false;
    if (activeItem.location !== 'bag') return false;
    if (activeItem.useTargetType !== 'none') return false;
    return Math.floor(activeItem.qty) > 1;
  }, [activeItem]);
  const clampUseQty = useCallback(
    (value: number) => Math.max(1, Math.min(useQtyMax, Math.floor(value))),
    [useQtyMax]
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
  const updateUseQty = useCallback(
    (nextValue: number) => {
      if (!Number.isFinite(nextValue)) return;
      setUseQty(clampUseQty(nextValue));
    },
    [clampUseQty]
  );
  const stepUseQty = useCallback(
    (delta: number) => {
      setUseQty((prev) => clampUseQty(prev + delta));
    },
    [clampUseQty]
  );

  const equipLines = useMemo(() => buildEquipmentDetailLines(activeItem), [activeItem]);
  const hasDesc = useMemo(() => {
    if (!activeItem) return false;
    if (activeItem.category === 'equipment') return false;
    return Boolean(activeItem.desc?.trim());
  }, [activeItem]);
  const hasEquipAttrs = useMemo(() => activeItem?.category === 'equipment' && equipLines.length > 0, [activeItem, equipLines]);
  const hasSetInfo = useMemo(
    () => Boolean(activeItem?.setInfo && activeItem.setInfo.bonuses.length > 0),
    [activeItem]
  );
  const hasTechniqueBookSkills = useMemo(
    () => Boolean(activeItem?.learnableTechniqueId),
    [activeItem?.learnableTechniqueId],
  );
  const hasEffects = useMemo(() => (activeItem?.effects?.length ?? 0) > 0, [activeItem?.effects]);

  const usedSlots = info?.bag_used ?? items.filter((i) => i.location === 'bag').length;

  const bagItemCounts = useMemo(() => {
    // 洗炼符属于 consumable，这里按背包全部道具统计 itemDefId 数量。
    const out: Record<string, number> = {};
    for (const it of items) {
      if (it.location !== 'bag') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, Math.floor(it.qty));
    }
    return out;
  }, [items]);

  const {
    enhanceState,
    refineState,
    loading: growthPreviewLoading,
  } = useEquipmentGrowthPreview({
    item: activeItem,
    allItems: items,
    enabled: enhanceOpen && (growthMode === 'enhance' || growthMode === 'refine'),
  });

  const openBatch = useCallback(
    (mode: BatchMode) => {
      setBatchMode(mode);
      setBatchOpen(true);
      setBatchSubmitting(false);
      setBatchKeyword('');
      setBatchSubCategory('all');
      setBatchIncludeKeywordsText('');
      setBatchExcludeKeywordsText('');
      setBatchQualities(quality === 'all' ? qualityLabels : [quality]);
      // 默认主分类固定为“装备”，避免每次打开都落到“全部类型”。
      setBatchCategory('equipment');
    },
    [quality]
  );

  const actionDisabled = (a: BagAction) => {
    if (!activeItem) return true;
    if (!activeItem.actions.includes(a)) return true;
    if (a === 'use') {
      if (activeItem.locked) return true;
      if (activeItem.qty <= 0) return true;
      if (activeItem.location !== 'bag') return true;
    }
    if (a === 'disassemble') {
      if (!isDisassemblableBagItem(activeItem)) return true;
      if (activeItem.locked) return true;
      if (activeItem.location === 'equipped') return true;
    }
    if (a === 'enhance') {
      if (activeItem.category !== 'equipment') return true;
      if (!activeItem.equip) return true;
    }
    return false;
  };

  const hasAction = (a: BagAction) => {
    if (!activeItem) return false;
    return activeItem.actions.includes(a);
  };

  const equipButtonText = useMemo(() => {
    if (!activeItem) return '装备';
    if (activeItem.category !== 'equipment') return '装备';
    return activeItem.location === 'equipped' ? '卸下' : '装备';
  }, [activeItem]);

  const handleEquipToggle = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;

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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      window.dispatchEvent(
        new CustomEvent('chat:append', {
          detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${getUnifiedApiErrorMessage(error, '操作失败')}` },
        }),
      );
      setLoading(false);
    }
  }, [activeItem, clampUseQty, equipmentUnbindCandidates.length, message, openCharacterRename, refresh, useQty]);

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
      setLoading(false);
    }
  }, [activeItem, clampUseQty, equipmentUnbindCandidates.length, message, refresh, useQty]);

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
    } catch {
      void 0;
    } finally {
      setEquipmentUnbindSubmitting(false);
    }
  }, [activeItem, message, refresh, selectedUnbindTargetItem]);

  const socketState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const equip = activeItem.equip;
    const candidates = collectGemCandidates(items);
    const availableSlots = Array.from({ length: Math.max(0, equip.socketMax) }, (_, idx) => idx);
    const selectedSlot =
      socketSlot === undefined || socketSlot === null ? availableSlots.find((s) => !equip.socketedGems.some((g) => g.slot === s)) : socketSlot;
    const selectedGem = candidates.find((x) => x.id === selectedGemItemId) ?? null;
    const selectedGemType = selectedGem ? normalizeGemType(selectedGem.subCategory || selectedGem.name) : 'all';
    const slotValid = selectedSlot !== undefined && selectedSlot >= 0 && selectedSlot < equip.socketMax;
    const replacedGem =
      selectedSlot !== undefined && selectedSlot !== null
        ? equip.socketedGems.find((g) => g.slot === selectedSlot) ?? null
        : null;
    const duplicateGem =
      selectedGem && selectedSlot !== undefined
        ? equip.socketedGems.some((g) => g.itemDefId === selectedGem.itemDefId && g.slot !== selectedSlot)
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
  }, [activeItem, items, selectedGemItemId, socketSlot]);

  const rerollState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const affixes = activeItem.equip.affixes;
    if (!Array.isArray(affixes) || affixes.length <= 0) {
      return {
        affixes: [],
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
  }, [activeItem, bagItemCounts, rerollLockIndexes, rerollCostTable]);

  const handleEnhance = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;
    if (!activeItem.equip) return;

    setEnhanceSubmitting(true);
    try {
      const res = await enhanceInventoryItem({ itemId: activeItem.id });
      if (res.success) {
        message.success(res.message || '强化成功');
      } else {
        message.warning(res.message || '强化失败');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      void 0;
    } finally {
      setEnhanceSubmitting(false);
    }
  }, [activeItem, message, refresh]);

  const handleRefine = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;
    if (!activeItem.equip) return;

    setRefineSubmitting(true);
    try {
      const res = await refineInventoryItem({ itemId: activeItem.id });
      if (res.success) {
        message.success(res.message || '精炼成功');
      } else {
        if ((res.message || '') === '精炼失败') message.warning(res.message || '精炼失败');
        else void 0;
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      void 0;
    } finally {
      setRefineSubmitting(false);
    }
  }, [activeItem, message, refresh]);

  const handleSocket = useCallback(async () => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return;
    if (!socketState) return;
    if (!socketState.selectedGem) return;
    if (socketState.selectedSlot === undefined) return;
    if (!socketState.slotValid || !socketState.typeValid || socketState.duplicateGem) return;

    setSocketSubmitting(true);
    try {
      const res = await socketInventoryGem({
        itemId: activeItem.id,
        gemItemId: socketState.selectedGem.id,
        slot: socketState.selectedSlot,
      });
      if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '镶嵌失败'));
      message.success(res.message || '镶嵌成功');
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSelectedGemItemId(undefined);
      setSocketSlot(undefined);
    } catch (error: unknown) {
      void 0;
    } finally {
      setSocketSubmitting(false);
    }
  }, [activeItem, message, refresh, socketState]);

  const handleToggleRerollLock = useCallback((index: number) => {
    if (!rerollState) return;
    if (rerollSubmitting) return;
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
  }, [message, rerollState, rerollSubmitting]);

  const handleReroll = useCallback(async () => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return;
    if (!rerollState || rerollState.affixes.length <= 0) return;
    const lockIndexes = normalizeAffixLockIndexes(
      rerollState.lockIndexes,
      rerollState.affixes.length
    ).slice(0, rerollState.maxLockCount);

    setRerollSubmitting(true);
    try {
      const res = await rerollInventoryAffixes({
        itemId: activeItem.id,
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
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      void 0;
    } finally {
      setRerollSubmitting(false);
    }
  }, [activeItem, message, refresh, rerollState]);

  const autoRerollOptions = useMemo(
    () => buildAutoRerollTargetOptions(poolPreviewData?.affixes ?? [], rerollState?.affixes ?? []),
    [poolPreviewData?.affixes, rerollState?.affixes],
  );

  const autoRerollDisabled =
    rerollSubmitting ||
    autoRerollSubmitting ||
    !rerollState ||
    rerollState.affixes.length <= 0 ||
    !!activeItem?.locked ||
    autoRerollTargetKeys.length <= 0;

  const handleAutoReroll = useCallback(async () => {
    if (!activeItem || !rerollState || rerollState.affixes.length <= 0) return;
    const targetKeys = autoRerollTargetKeys.filter((key) => key.trim().length > 0);
    if (targetKeys.length <= 0) {
      message.warning('请先设置目标词条');
      return;
    }
    if (hasMatchedAutoRerollTargets(rerollState.affixes, targetKeys)) {
      message.success('当前词条已满足目标，无需自动洗炼');
      return;
    }
    if (activeItem.locked) {
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
    let matched = false;
    let attempt = 0;
    try {
      while (attempt < maxTimes) {
        const res = await rerollInventoryAffixes({ itemId: activeItem.id, lockIndexes });
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

      await refresh();
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
  }, [activeItem, autoRerollMaxAttempts, autoRerollTargetKeys, message, playerSilver, playerSpiritStones, refresh, rerollState]);

  const handleOpenPoolPreview = useCallback(async () => {
    if (!activeItem?.id || poolPreviewLoading) return;
    setPoolPreviewOpen(true);
    setPoolPreviewLoading(true);
    setPoolPreviewData(null);
    try {
      const res = await getAffixPoolPreview(activeItem.id);
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
  }, [activeItem, message, poolPreviewLoading]);

  const bagOnlyItems = useMemo(() => items.filter((i) => i.location === 'bag'), [items]);

  const batchSubCategoryOptions = useMemo(() => {
    const dynamicSubCategories: string[] = [];
    for (const it of bagOnlyItems) {
      if (batchCategory !== 'all' && it.category !== batchCategory) continue;
      if (!it.subCategory) continue;
      dynamicSubCategories.push(it.subCategory);
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
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
    const excludeKeywords = batchExcludeKeywordsText
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);

    let list = bagOnlyItems.filter((i) => !i.locked);
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
        list = list.filter((i) => i.category === batchCategory);
      }
      if (batchSubCategory !== 'all') {
        list = list.filter((i) => (i.subCategory ?? '') === batchSubCategory);
      }
    }

    if (batchQualities.length > 0) {
      const allowed = new Set(batchQualities);
      list = list.filter((i) => allowed.has(i.quality));
    }

    if (kw) {
      list = list.filter((i) => `${i.name}${i.tags.join('')}`.toLowerCase().includes(kw));
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
    const qty = batchCandidates.reduce((sum, it) => sum + Math.max(0, it.qty || 0), 0);
    return `共${qty}件`;
  }, [batchCandidates]);
  const useActionDisabled = loading || actionDisabled('use');
  const growthHeader = (
    <div className="bag-growth-header">
      <div className="bag-growth-header-name" style={{ color: activeItem?.quality ? qualityColor[activeItem.quality] : undefined }}>
        {activeItem?.name ?? '未选择'}
      </div>
      <div className="bag-growth-header-meta">
        {activeItem?.equip?.equipSlot ? <span>{getEquipSlotLabel(activeItem.equip.equipSlot)}</span> : null}
        {activeItem?.quality ? <span className={'bag-growth-quality-badge ' + qualityClass[activeItem.quality]}>{qualityLabelText[activeItem.quality]}</span> : null}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1040}
      className="bag-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setActiveId(null);
      }}
    >
      <div className="bag-modal-shell">
        <div className="bag-modal-left">
          <div className="bag-modal-left-top">
            <Tabs
              size="small"
              activeKey={category}
              onChange={(k) => {
                setCategory(k as BagCategory);
                setActiveId(null);
              }}
              items={(Object.keys(categoryLabels) as BagCategory[]).map((key) => ({
                key,
                label: categoryLabels[key],
              }))}
            />

            <div className="bag-modal-filters">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索物品..."
                allowClear
                prefix={<SearchOutlined />}
                size="middle"
              />
              <Select
                value={sort}
                onChange={(v) => setSort(v)}
                size="middle"
                options={[
                  { value: 'default', label: '默认排序' },
                  { value: 'qualityDesc', label: '按品质' },
                  { value: 'qtyDesc', label: '按数量' },
                  { value: 'nameAsc', label: '按名称 A-Z' },
                  { value: 'nameDesc', label: '按名称 Z-A' },
                ]}
              />
              <Select
                value={quality}
                onChange={(v) => setQuality(v)}
                size="middle"
                options={[
                  { value: 'all', label: '全部品质' },
                  ...qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] })),
                ]}
              />
              <Button
                size="middle"
                onClick={() => setFilterOpen(true)}
                className={activeFilterCount > 0 ? 'bag-filter-btn is-active' : 'bag-filter-btn'}
                icon={<FilterOutlined />}
              >
                筛选{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
              </Button>
            </div>
          </div>

          <div className="bag-modal-grid">
            {filtered.map((it) => (
              <InventoryItemCell
                key={it.id}
                className="bag-cell"
                qualityClassName={getItemQualityMeta(it.quality)?.className}
                active={it.id === safeActiveId}
                quantity={it.qty}
                showQuantity={it.stackMax > 1}
                equippedLabel={it.location === 'equipped' ? '已穿戴' : undefined}
                lockedLabel={it.locked ? '已锁' : undefined}
                icon={it.icon}
                name={it.name}
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(it.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveId(it.id);
                }}
              />
            ))}
            {filtered.length === 0 ? (
              <div className="bag-modal-empty">{loading ? '加载中...' : '暂无物品'}</div>
            ) : null}
            {loading && filtered.length > 0 ? <div className="bag-modal-grid-overlay">加载中...</div> : null}
          </div>

          <div className="bag-modal-left-footer">
            <div className="bag-modal-slot-text">
              已用 {usedSlots} / {totalSlots} 格
            </div>
            <div className="bag-modal-left-footer-actions">
              <Button
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  setCraftOpen(true);
                }}
              >
                炼丹炼器
              </Button>
              <Button
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  setGemSynthesisOpen(true);
                }}
              >
                宝石合成
              </Button>
              <Button
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  openBatch('disassemble');
                }}
              >
                一键分解
              </Button>
              <Button
                danger
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  openBatch('remove');
                }}
              >
                一键丢弃
              </Button>
              <Button
                type="primary"
                loading={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    const res = await sortInventory('bag');
                    if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '整理失败'));
                    await refresh();
                  } catch (error: unknown) {
                    void 0;
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                一键整理
              </Button>
            </div>
          </div>
        </div>

        <div className="bag-modal-right">
          {activeItem ? (
            <>
              <div className="bag-detail">
                <div className="bag-detail-head">
                  <div className="bag-detail-img">
                    <img src={activeItem.icon} alt={activeItem.name} />
                  </div>
                  <div className="bag-detail-meta">
                    <div className="bag-detail-name">{activeItem.name}</div>
                    <div className="bag-detail-tags">
                      <Tag color="blue">{categoryLabels[activeItem.category]}</Tag>
                      <Tag className={`bag-detail-quality-tag ${getItemQualityTagClassName(activeItem.quality)}`}>
                        {qualityLabelText[activeItem.quality]}
                      </Tag>
                      <Tag>{activeItem.bind.detailLabel}</Tag>
                      {activeItem.locked ? <Tag color="red">已锁定</Tag> : null}
                      {activeItem.tags.map((t) => (
                        <Tag key={t} color="default">
                          {t}
                        </Tag>
                      ))}
                    </div>
                    {activeItem.stackMax > 1 ? (
                      <div className="bag-detail-sub">
                        数量：{activeItem.qty} / {activeItem.stackMax}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="bag-detail-scroll">
                  <div className="bag-detail-body">
                    {hasDesc ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">物品描述</div>
                        <div className="bag-detail-text">{activeItem.desc}</div>
                      </div>
                    ) : null}

                    {hasTechniqueBookSkills ? (
                      <div className="bag-detail-section">
                        <TechniqueSkillSection
                          skills={techniqueBookSkillsState.skills}
                          loading={techniqueBookSkillsState.loading}
                          error={techniqueBookSkillsState.error}
                          variant="desktop"
                        />
                      </div>
                    ) : null}

                    {hasEquipAttrs ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">装备属性</div>
                        <EquipmentDetailAttrList lines={equipLines} variant="desktop" className="bag-detail-attr-grid" />
                      </div>
                    ) : null}

                    {hasSetInfo ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">套装效果</div>
                        {activeItem?.setInfo ? <SetBonusDisplay setInfo={activeItem.setInfo} variant="desktop" /> : null}
                      </div>
                    ) : null}

                    {hasEffects ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">效果 / 说明</div>
                        <div className="bag-detail-lines">
                          {activeItem.effects.map((line) => (
                            <div key={line} className="bag-detail-line">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="bag-actions">
                {hasAction('use') ||
                  hasAction('compose') ||
                  hasAction('equip') ||
                  hasAction('disassemble') ||
                  hasAction('enhance') ? (
                  <>
                    {canBatchUseConsumable ? (
                      <div className="bag-use-qty">
                        <span className="bag-use-qty-label">使用数量</span>
                        <div className="bag-use-qty-controls">
                          <Button
                            size="small"
                            disabled={useActionDisabled || useQty <= 1}
                            onClick={() => stepUseQty(-1)}
                          >
                            -
                          </Button>
                          <InputNumber
                            size="small"
                            min={1}
                            max={useQtyMax}
                            controls={false}
                            value={useQty}
                            className="bag-use-qty-input"
                            disabled={useActionDisabled}
                            onChange={(value) => updateUseQty(typeof value === 'number' ? value : Number.NaN)}
                          />
                          <Button
                            size="small"
                            disabled={useActionDisabled || useQty >= useQtyMax}
                            onClick={() => stepUseQty(1)}
                          >
                            +
                          </Button>
                          <Button
                            size="small"
                            disabled={useActionDisabled || useQty >= useQtyMax}
                            onClick={() => setUseQty(useQtyMax)}
                          >
                            最大
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <div className="bag-actions-row">
                      <div className="bag-actions-row-inner">
                        {hasAction('use') ? (
                          <Button
                            size="small"
                            type="primary"
                            disabled={useActionDisabled}
                            onClick={() => void handleUseItem()}
                          >
                            使用{canBatchUseConsumable && useQty > 1 ? `×${useQty}` : ''}
                          </Button>
                        ) : null}
                        {hasAction('compose') ? (
                          <Button
                            size="small"
                            disabled={loading || actionDisabled('compose')}
                            onClick={() => setCraftOpen(true)}
                          >
                            合成
                          </Button>
                        ) : null}
                        {hasAction('equip') ? (
                          <Button
                            size="small"
                            disabled={loading || actionDisabled('equip')}
                            onClick={() => void handleEquipToggle()}
                          >
                            {equipButtonText}
                          </Button>
                        ) : null}
                        {hasAction('disassemble') ? (
                          <Button
                            size="small"
                            danger
                            disabled={loading || actionDisabled('disassemble')}
                            onClick={() => setDisassembleOpen(true)}
                          >
                            分解
                          </Button>
                        ) : null}
                        {hasAction('enhance') ? (
                          <Button
                            size="small"
                            disabled={loading || actionDisabled('enhance')}
                            onClick={() => setEnhanceOpen(true)}
                          >
                            强化
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          disabled={loading}
                          onClick={() => void handleToggleItemLock()}
                        >
                          {activeItem.locked ? '解锁' : '上锁'}
                        </Button>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <div className="bag-modal-empty">请选择物品</div>
          )}
        </div>
      </div>

      <Modal
        open={filterOpen}
        onCancel={() => setFilterOpen(false)}
        footer={null}
        centered
        destroyOnHidden
        title="筛选"
        maskClosable
        className="bag-filter-modal"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="bag-filter-label">分类类型（多选）</div>
            <Select
              mode="multiple"
              value={filterCategories}
              onChange={(v) => {
                const next = (v as Array<Exclude<BagCategory, 'all'>>).filter(Boolean);
                setFilterCategories(next);
                if (next.length > 0) setCategory('all');
              }}
              placeholder="选择分类"
              options={(Object.keys(categoryLabels) as BagCategory[])
                .filter((k) => k !== 'all')
                .map((k) => ({ value: k, label: categoryLabels[k] }))}
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div className="bag-filter-label">品质（多选）</div>
            <Select
              mode="multiple"
              value={filterQualities}
              onChange={(v) => {
                const next = (v as BagQuality[]).filter(Boolean);
                setFilterQualities(next);
                if (next.length > 0) setQuality('all');
              }}
              placeholder="选择品质"
              options={qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] }))}
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div className="bag-filter-label">属性 / 词条（多选）</div>
            <Select
              mode="multiple"
              value={filterAttrKeys}
              onChange={(v) => setFilterAttrKeys((v as string[]).filter(Boolean))}
              placeholder="选择属性或词条"
              options={filterAttrKeyOptions}
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
            />
            <div className="bag-filter-hint">选择后仅展示包含对应属性/词条的装备</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              onClick={() => {
                setFilterCategories([]);
                setFilterQualities([]);
                setFilterAttrKeys([]);
              }}
            >
              重置
            </Button>
            <Button type="primary" onClick={() => setFilterOpen(false)}>
              确定
            </Button>
          </div>
        </div>
      </Modal>

      <DisassembleModal
        open={disassembleOpen}
        item={
          activeItem
            ? {
              id: activeItem.id,
              name: activeItem.name,
              quality: activeItem.quality,
              qty: activeItem.qty,
              location: activeItem.location,
              locked: activeItem.locked,
              category: activeItem.category,
              subCategory: activeItem.subCategory,
              canDisassemble: activeItem.canDisassemble,
            }
            : null
        }
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
        onOpenGemSynthesis={() => {
          setCraftOpen(false);
          setGemSynthesisOpen(true);
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

      <Modal
        open={equipmentUnbindOpen}
        onCancel={() => {
          if (equipmentUnbindSubmitting) return;
          setEquipmentUnbindOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        title="选择解绑装备"
        maskClosable={!equipmentUnbindSubmitting}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ color: 'var(--text-secondary)' }}>
            {activeItem ? `使用【${activeItem.name}】后，可将一件已绑定装备恢复为未绑定。` : '请选择要解绑的装备。'}
          </div>
          <Select
            value={selectedUnbindTargetItemId}
            onChange={(value) => setSelectedUnbindTargetItemId(typeof value === 'number' ? value : undefined)}
            placeholder="选择已绑定装备"
            options={equipmentUnbindCandidates.map((item) => {
              const slotText = item.equip?.equipSlot ? getEquipSlotLabel(item.equip.equipSlot) : '装备';
              const levelText = `+${item.equip?.strengthenLevel ?? 0} / 精炼+${item.equip?.refineLevel ?? 0}`;
              const locationText = item.location === 'equipped' ? '已穿戴' : '背包';
              return {
                value: item.id,
                label: `${item.name} · ${slotText} · ${levelText} · ${locationText}`,
              };
            })}
          />
          {equipmentUnbindCandidates.length <= 0 ? (
            <div style={{ color: 'var(--color-danger, #ff7875)' }}>当前没有可解绑的已绑定装备</div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              disabled={equipmentUnbindSubmitting}
              onClick={() => setEquipmentUnbindOpen(false)}
            >
              取消
            </Button>
            <Button
              type="primary"
              loading={equipmentUnbindSubmitting}
              disabled={!selectedUnbindTargetItem}
              onClick={() => void handleSubmitEquipmentUnbind()}
            >
              确认解绑
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={enhanceOpen}
        onCancel={() => {
          if (enhanceSubmitting || refineSubmitting || socketSubmitting || rerollSubmitting) return;
          setEnhanceOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        title="装备成长"
        className="bag-enhance-modal"
        maskClosable={!(enhanceSubmitting || refineSubmitting || socketSubmitting || rerollSubmitting)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Tabs
            size="small"
            activeKey={growthMode}
            onChange={(k) => setGrowthMode(k as 'enhance' | 'refine' | 'socket' | 'reroll')}
            items={[
              { key: 'enhance', label: '强化' },
              { key: 'refine', label: '精炼' },
              { key: 'socket', label: '镶嵌' },
              { key: 'reroll', label: '洗炼' },
            ]}
          />

          {growthMode === 'reroll' && rerollState && rerollState.affixes.length > 0 ? (
            <div className="bag-reroll-overview-row">
              {growthHeader}
              <div className="bag-growth-summary-card bag-growth-summary-card--reroll">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">{rerollState.affixes.length}</span>
                  <span className="bag-growth-arrow">条词条</span>
                </div>
                <div className="bag-growth-tip-muted">
                  已锁定 {rerollState.lockIndexes.length}/{rerollState.maxLockCount}
                </div>
              </div>
            </div>
          ) : growthHeader}

          {growthMode === 'enhance' && (enhanceState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{enhanceState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{enhanceState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPercent(enhanceState.successRate)}</span>
                </div>
                {enhanceState.failMode !== 'none' && (
                  <div className="bag-growth-tip-warn">
                    {getEquipmentGrowthFailModeText(enhanceState.failMode)}
                  </div>
                )}
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  {enhanceState.materialQty > 0 && (
                    <div className={'bag-growth-cost-chip' + (enhanceState.owned < enhanceState.materialQty ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">{enhanceState.materialName}</span>
                      <span className="bag-growth-cost-val">×{enhanceState.materialQty}</span>
                      <span className="bag-growth-cost-own">/{enhanceState.owned}</span>
                    </div>
                  )}
                  {enhanceState.silverCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSilver < enhanceState.silverCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">银两</span>
                      <span className="bag-growth-cost-val">{enhanceState.silverCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSilver.toLocaleString()}</span>
                    </div>
                  )}
                  {enhanceState.spiritStoneCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSpiritStones < enhanceState.spiritStoneCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">灵石</span>
                      <span className="bag-growth-cost-val">{enhanceState.spiritStoneCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSpiritStones.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="bag-growth-attr-grid">
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">当前属性</div>
                  {Object.entries(activeItem?.equip?.baseAttrs ?? {})
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`cur-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{percentAttrKeys.has(k) ? formatSignedPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">强化后</div>
                  {Object.entries(enhanceState.previewBaseAttrs)
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`next-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{percentAttrKeys.has(k) ? formatSignedPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  enhanceSubmitting ||
                  enhanceState.owned < enhanceState.materialQty ||
                  playerSilver < enhanceState.silverCost ||
                  playerSpiritStones < enhanceState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleEnhance()}
                loading={enhanceSubmitting}
              >
                {activeItem?.locked ? '物品已锁定' : '强化'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">{growthPreviewLoading ? '正在获取强化消耗...' : '请选择可强化的装备'}</div>
          ))}

          {growthMode === 'refine' && (refineState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{refineState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{refineState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPercent(refineState.successRate)}</span>
                </div>
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  {refineState.materialQty > 0 && (
                    <div className={'bag-growth-cost-chip' + (refineState.owned < refineState.materialQty ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">{refineState.materialName}</span>
                      <span className="bag-growth-cost-val">×{refineState.materialQty}</span>
                      <span className="bag-growth-cost-own">/{refineState.owned}</span>
                    </div>
                  )}
                  {refineState.silverCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSilver < refineState.silverCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">银两</span>
                      <span className="bag-growth-cost-val">{refineState.silverCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSilver.toLocaleString()}</span>
                    </div>
                  )}
                  {refineState.spiritStoneCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSpiritStones < refineState.spiritStoneCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">灵石</span>
                      <span className="bag-growth-cost-val">{refineState.spiritStoneCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSpiritStones.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="bag-growth-attr-grid">
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">当前属性</div>
                  {Object.entries(activeItem?.equip?.baseAttrs ?? {})
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`ref-cur-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{percentAttrKeys.has(k) ? formatSignedPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">精炼后</div>
                  {Object.entries(refineState.previewBaseAttrs)
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`ref-next-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{percentAttrKeys.has(k) ? formatSignedPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  refineSubmitting ||
                  (refineState.maxLv !== null && refineState.curLv >= refineState.maxLv) ||
                  refineState.owned < refineState.materialQty ||
                  playerSilver < refineState.silverCost ||
                  playerSpiritStones < refineState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleRefine()}
                loading={refineSubmitting}
              >
                {activeItem?.locked
                  ? '物品已锁定'
                  : refineState.maxLv !== null && refineState.curLv >= refineState.maxLv
                    ? '已达上限'
                    : '精炼'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">{growthPreviewLoading ? '正在获取精炼消耗...' : '请选择可精炼的装备'}</div>
          ))}

          {growthMode === 'socket' && (socketState ? (
            <>
              <div>孔位：{socketState.socketed.length}/{socketState.socketMax}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Select
                  value={socketState.selectedSlot}
                  onChange={(v) => setSocketSlot(typeof v === 'number' ? v : undefined)}
                  placeholder="选择孔位"
                  options={socketState.availableSlots.map((slot) => {
                    const existed = socketState.socketed.find((g) => g.slot === slot);
                    const displaySlot = slot + 1;
                    return {
                      value: slot,
                      label: existed ? `孔位${displaySlot}（已镶嵌：${existed.name ?? existed.itemDefId}）` : `孔位${displaySlot}（空）`,
                    };
                  })}
                />
                <Select
                  value={selectedGemItemId}
                  onChange={(v) => setSelectedGemItemId(typeof v === 'number' ? v : undefined)}
                  placeholder="选择宝石"
                  options={socketState.candidates.map((g) => ({ value: g.id, label: `${g.name} x${g.qty}` }))}
                />
              </div>

              <div style={{ color: 'var(--text-secondary)' }}>
                {socketState.selectedGem
                  ? `已选宝石：${socketState.selectedGem.name}（类型：${socketState.selectedGemType}）`
                  : '请选择可镶嵌宝石'}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                {socketState.replacedGem ? `替换镶嵌消耗银两：${socketState.silverCost}` : `首次镶嵌消耗银两：${socketState.silverCost}`}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>宝石不可卸下，仅可通过替换镶嵌覆盖原孔位宝石（原宝石销毁）。</div>
              {socketState.selectedGem && socketState.selectedSlot !== undefined && !socketState.typeValid ? (
                <div className="bag-enhance-warning">宝石类型与孔位不匹配</div>
              ) : null}
              {socketState.selectedGem && socketState.selectedSlot !== undefined && socketState.duplicateGem ? (
                <div className="bag-enhance-warning">同一件装备不可镶嵌相同宝石</div>
              ) : null}

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  type="primary"
                  disabled={
                    socketSubmitting ||
                    !socketState.selectedGem ||
                    socketState.selectedSlot === undefined ||
                    !socketState.slotValid ||
                    !socketState.typeValid ||
                    socketState.duplicateGem ||
                    !!activeItem?.locked
                  }
                  onClick={() => void handleSocket()}
                  loading={socketSubmitting}
                >
                  {socketState.replacedGem ? '替换镶嵌' : '镶嵌宝石'}
                </Button>
              </div>

              {activeItem?.locked ? <div className="bag-enhance-hint">物品已锁定</div> : null}
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可镶嵌的装备</div>
          ))}

          {growthMode === 'reroll' && (rerollState ? (
            rerollState.affixes.length > 0 ? (
              <>
                <div className="bag-growth-cost-card">
                  <div className="bag-growth-cost-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>消耗</span>
                    <a
                      href="#"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (!activeItem?.locked) {
                          handleOpenPoolPreview();
                        }
                      }}
                      style={{
                        fontSize: 12,
                        fontWeight: 'normal',
                        color: activeItem?.locked ? 'var(--text-tertiary)' : 'var(--primary-color)',
                        cursor: activeItem?.locked ? 'not-allowed' : 'pointer',
                        textDecoration: 'none'
                      }}
                    >
                      <SearchOutlined style={{ marginRight: 4 }} />
                      查看词条池
                    </a>
                  </div>
                  <div className="bag-growth-cost-list">
                    <div className={'bag-growth-cost-chip' + (rerollState.rerollScrollOwned < rerollState.rerollScrollQty ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">洗炼符</span>
                      <span className="bag-growth-cost-val">×{rerollState.rerollScrollQty}</span>
                      <span className="bag-growth-cost-own">/{rerollState.rerollScrollOwned}</span>
                    </div>
                    <div className={'bag-growth-cost-chip' + (playerSpiritStones < rerollState.spiritStoneCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">灵石</span>
                      <span className="bag-growth-cost-val">{rerollState.spiritStoneCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSpiritStones.toLocaleString()}</span>
                    </div>
                    <div className={'bag-growth-cost-chip' + (playerSilver < rerollState.silverCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">银两</span>
                      <span className="bag-growth-cost-val">{rerollState.silverCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSilver.toLocaleString()}</span>
                    </div>
                  </div>
                </div>

                <div className="bag-reroll-affix-list">
                  {rerollState.affixes.map((affix, index) => {
                    const locked = rerollState.lockIndexSet.has(index);
                    const rollPercent = getAffixRollPercent(affix);
                    const rollColorVars = getAffixRollColorVars(rollPercent);
                    return (
                      <button
                        key={`${index}-${affix.key ?? 'affix'}`}
                        type="button"
                        className={'bag-reroll-affix-btn' + (locked ? ' is-locked' : '')}
                        onClick={() => handleToggleRerollLock(index)}
                        disabled={rerollSubmitting || !!activeItem?.locked}
                      >
                        <span className="bag-reroll-affix-index">#{index + 1}</span>
                        <span className="bag-reroll-affix-main">
                          <span className="bag-reroll-affix-text">{formatEquipmentAffixLine(affix)}</span>
                          <span className="bag-reroll-affix-roll" style={rollColorVars ?? undefined}>
                            <span className="bag-reroll-affix-roll-label">ROLL</span>
                            <span className="bag-reroll-affix-roll-value">{formatAffixRollPercent(rollPercent)}</span>
                            <span className="bag-reroll-affix-roll-track" aria-hidden="true">
                              <span
                                className="bag-reroll-affix-roll-fill"
                                style={{ width: `${rollPercent ?? 0}%` }}
                              />
                            </span>
                          </span>
                        </span>
                        <span className="bag-reroll-affix-lock">{locked ? '已锁定' : '点击锁定'}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="bag-reroll-auto-card">
                  <div className="bag-reroll-auto-title">自动洗炼</div>
                  <div className="bag-reroll-auto-controls">
                    <Select
                      mode="multiple"
                      value={autoRerollTargetKeys}
                      onChange={(values) => setAutoRerollTargetKeys(values)}
                      placeholder="选择目标词条（命中全部后停止）"
                      options={autoRerollOptions.map((option) => ({ value: option.key, label: option.label }))}
                      disabled={rerollSubmitting || autoRerollSubmitting || !!activeItem?.locked}
                      size="middle"
                      showSearch
                      optionFilterProp="label"
                    />
                    <InputNumber
                      min={1}
                      max={2000}
                      value={autoRerollMaxAttempts}
                      onChange={(value) => setAutoRerollMaxAttempts(typeof value === 'number' ? value : 1)}
                      addonBefore="最大次数"
                      disabled={rerollSubmitting || autoRerollSubmitting || !!activeItem?.locked}
                    />
                  </div>
                  <Button
                    block
                    onClick={() => void handleAutoReroll()}
                    loading={autoRerollSubmitting}
                    disabled={autoRerollDisabled}
                  >
                    开启自动洗炼
                  </Button>
                </div>

                <Button
                  block
                  type="primary"
                  disabled={
                    rerollSubmitting ||
                    autoRerollSubmitting ||
                    !!activeItem?.locked ||
                    rerollState.rerollScrollOwned < rerollState.rerollScrollQty ||
                    playerSpiritStones < rerollState.spiritStoneCost ||
                    playerSilver < rerollState.silverCost
                  }
                  onClick={() => void handleReroll()}
                  loading={rerollSubmitting}
                >
                  {activeItem?.locked ? '物品已锁定' : '洗炼'}
                </Button>
              </>
            ) : (
              <div className="bag-enhance-hint">该装备没有可洗炼词条</div>
            )
          ) : (
            <div className="bag-enhance-hint">请选择可洗炼的装备</div>
          ))}
        </div>
      </Modal>

      <AffixPoolPreviewModal
        open={poolPreviewOpen}
        onClose={() => setPoolPreviewOpen(false)}
        loading={poolPreviewLoading}
        poolName={poolPreviewData?.poolName ?? ''}
        affixes={poolPreviewData?.affixes ?? []}
      />

      <Modal
        open={batchOpen}
        onCancel={() => {
          if (batchSubmitting) return;
          setBatchOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        width={640}
        title={batchMode === 'disassemble' ? '一键分解' : '一键丢弃'}
        maskClosable={!batchSubmitting}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Select
              mode="multiple"
              value={batchQualities}
              onChange={(v) => setBatchQualities(v as BagQuality[])}
              placeholder="品质"
              options={qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] }))}
            />
            <Input value={batchKeyword} onChange={(e) => setBatchKeyword(e.target.value)} placeholder="搜索名称/标签" allowClear />
            <Select
              value={batchCategory}
              onChange={(v) => {
                setBatchCategory(v as BagCategory);
                setBatchSubCategory('all');
              }}
              placeholder="类型"
              options={[
                { value: ITEM_CATEGORY_ALL_OPTION.value, label: ITEM_CATEGORY_ALL_OPTION.label },
                ...ITEM_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
            <Select
              value={batchSubCategory}
              onChange={(v) => setBatchSubCategory(String(v))}
              placeholder="子类型"
              options={[{ value: 'all', label: '全部子类型' }, ...batchSubCategoryOptions]}
            />
          </div>
          {batchMode === 'disassemble' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Input
                value={batchIncludeKeywordsText}
                onChange={(e) => setBatchIncludeKeywordsText(e.target.value)}
                placeholder="包含关键词（逗号分隔）"
                allowClear
              />
              <Input
                value={batchExcludeKeywordsText}
                onChange={(e) => setBatchExcludeKeywordsText(e.target.value)}
                placeholder="排除关键词（逗号分隔）"
                allowClear
              />
            </div>
          ) : null}

          <div style={{ color: 'rgba(255,255,255,0.7)' }}>
            将处理 {batchCandidates.length} 个物品{batchSummary ? `（${batchSummary}）` : ''}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.55)' }}>已自动排除：已穿戴、已锁定</div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              disabled={batchSubmitting}
              onClick={() => {
                if (batchSubmitting) return;
                setBatchOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              danger={batchMode === 'remove'}
              loading={batchSubmitting}
              disabled={batchCandidates.length === 0}
              onClick={async () => {
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
                    const ids = batchCandidates.map((x) => x.id);
                    const res = await removeInventoryItemsBatch(ids);
                    if (!res.success) throw new Error(getUnifiedApiErrorMessage(res, '丢弃失败'));
                    message.success(res.message || '丢弃成功');
                  }
                  await refresh();
                  setBatchOpen(false);
                } catch (error: unknown) {
                  void 0;
                } finally {
                  setBatchSubmitting(false);
                }
              }}
            >
              {batchMode === 'disassemble' ? '确认分解' : '确认丢弃'}
            </Button>
          </div>
        </div>
      </Modal>
      {renameModalNode}
    </Modal>
  );
};

const BagModalSwitch: React.FC<{ open: boolean; onClose: () => void }> = (props) => {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileBagModal {...props} />;
  return <BagModal {...props} />;
};

export default BagModalSwitch;
