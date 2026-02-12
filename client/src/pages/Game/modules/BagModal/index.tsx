import { App, Button, Input, InputNumber, Modal, Select, Tabs, Tag } from 'antd';
import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import MobileBagModal from './MobileBagModal';
import { gameSocket } from '../../../../services/gameSocket';
import {
  disassembleInventoryEquipmentBatch,
  enhanceInventoryItem,
  equipInventoryItem,
  getInventoryInfo,
  getInventoryItems,
  refineInventoryItem,
  removeInventoryItemsBatch,
  socketInventoryGem,
  sortInventory,
  unequipInventoryItem,
  inventoryUseItem,
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
  collectBatchDisassembleEquipmentCandidates,
  collectGemCandidates,
  formatPermyriadPercent,
  formatSignedNumber,
  formatSignedPermyriadPercent,
  getEnhanceSuccessRatePermyriad,
  getEquipSlotLabel,
  getRefineSuccessRatePermyriad,
  isDisassemblableBagItem,
  isGemTypeAllowedInSlot,
  normalizeGemType,
  permyriadPercentKeys,
  pickNumber,
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
import './index.scss';

interface BagModalProps {
  open: boolean;
  onClose: () => void;
}

const BagModal: React.FC<BagModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
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
  const [growthMode, setGrowthMode] = useState<'enhance' | 'refine' | 'socket'>('enhance');
  const [refineSubmitting, setRefineSubmitting] = useState(false);
  const [socketSubmitting, setSocketSubmitting] = useState(false);
  const [socketSlot, setSocketSlot] = useState<number | undefined>(undefined);
  const [selectedGemItemId, setSelectedGemItemId] = useState<number | undefined>(undefined);
  const [batchOpen, setBatchOpen] = useState(false);
  const [craftOpen, setCraftOpen] = useState(false);
  const [gemSynthesisOpen, setGemSynthesisOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<BatchMode>('disassemble');
  const [batchQualities, setBatchQualities] = useState<BagQuality[]>(qualityLabels);
  const [batchCategory, setBatchCategory] = useState<BagCategory>('all');
  const [batchSubCategory, setBatchSubCategory] = useState<string>('all');
  const [batchEquipSlot, setBatchEquipSlot] = useState<string>('all');
  const [batchKeyword, setBatchKeyword] = useState('');
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
      const err = error as { message?: string };
      message.error(err.message || '获取背包数据失败');
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

  const totalSlots = info?.bag_capacity ?? 100;

  const filterAttrKeyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it.category !== 'equipment' || !it.equip) continue;
      for (const k of Object.keys(it.equip.baseAttrs || {})) {
        if (k) set.add(k);
      }
      for (const a of it.equip.affixes || []) {
        const k = a.attr_key;
        if (k) set.add(k);
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
          const k = a.attr_key;
          if (k && set.has(k)) return true;
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
  const useQtyMax = useMemo(() => {
    if (!activeItem || activeItem.category !== 'consumable') return 1;
    return Math.max(1, Math.floor(activeItem.qty));
  }, [activeItem]);
  const canBatchUseConsumable = useMemo(() => {
    if (!activeItem) return false;
    if (!activeItem.actions.includes('use')) return false;
    if (activeItem.category !== 'consumable') return false;
    if (activeItem.location !== 'bag') return false;
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

  const equipLines = useMemo(() => buildEquipmentLines(activeItem), [activeItem]);
  const hasDesc = useMemo(() => Boolean(activeItem?.desc?.trim()), [activeItem?.desc]);
  const hasEquipAttrs = useMemo(() => activeItem?.category === 'equipment' && equipLines.length > 0, [activeItem, equipLines]);
  const hasSetInfo = useMemo(
    () => Boolean(activeItem?.setInfo && activeItem.setInfo.bonuses.length > 0),
    [activeItem]
  );
  const hasEffects = useMemo(() => (activeItem?.effects?.length ?? 0) > 0, [activeItem?.effects]);

  const usedSlots = info?.bag_used ?? items.filter((i) => i.location === 'bag').length;

  const materialCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of items) {
      if (it.category !== 'material') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, Math.floor(it.qty));
    }
    return out;
  }, [items]);

  const openBatch = useCallback(
    (mode: BatchMode) => {
      setBatchMode(mode);
      setBatchOpen(true);
      setBatchSubmitting(false);
      setBatchKeyword('');
      setBatchSubCategory('all');
      setBatchEquipSlot('all');
      setBatchQualities(quality === 'all' ? qualityLabels : [quality]);
      if (mode === 'remove') {
        setBatchCategory(category === 'all' ? 'all' : category);
      } else {
        setBatchCategory('equipment');
      }
    },
    [category, quality]
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
        if (!res.success) throw new Error(res.message || '卸下失败');
        message.success(res.message || '卸下成功');
      } else {
        const res = await equipInventoryItem(activeItem.id);
        if (!res.success) throw new Error(res.message || '装备失败');
        message.success(res.message || '装备成功');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '操作失败');
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
        const rewardParts = lootResults.map((r) => `${r.name || r.type}×${r.amount}`);
        const qtyPart = useCount > 1 ? `×${useCount}` : '';
        content = `打开【${activeItem.name}】${qtyPart}，获得${rewardParts.join('、')}。`;
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

        const restoredQixue = qixueByStat !== null ? qixueByStat : Math.max(0, Math.floor(effectDelta.qixue));
        const restoredLingqi = lingqiByStat !== null ? lingqiByStat : Math.max(0, Math.floor(effectDelta.lingqi));
        const gainedExp = expByStat !== null ? expByStat : Math.max(0, Math.floor(effectDelta.exp));

        const effectParts: string[] = [];
        if (restoredQixue > 0) effectParts.push(`恢复了${restoredQixue}点气血`);
        if (restoredLingqi > 0) effectParts.push(`恢复了${restoredLingqi}点灵气`);
        if (gainedExp > 0) effectParts.push(`获得了${gainedExp}点经验`);

        const qtyPart = useCount > 1 ? `×${useCount}` : '';
        content =
          activeItem.category === 'consumable'
            ? effectParts.length > 0
              ? `使用【${activeItem.name}】${qtyPart}成功，${effectParts.join('，')}，背包剩余${remaining}。`
              : `使用【${activeItem.name}】${qtyPart}成功，背包剩余${remaining}。`
            : `使用【${activeItem.name}】成功，背包剩余${remaining}。`;
      }
      window.dispatchEvent(new CustomEvent('chat:append', { detail: { channel: 'system', content } }));

      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      window.dispatchEvent(
        new CustomEvent('chat:append', {
          detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${err.message || '操作失败'}` },
        }),
      );
      setLoading(false);
    }
  }, [activeItem, clampUseQty, refresh, useQty]);

  const enhanceState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const curLv = Math.max(0, Math.min(15, Math.floor(Number(activeItem.equip.strengthenLevel) || 0)));
    const targetLv = Math.min(15, curLv + 1);
    const costPlan = buildEnhanceCostPlan(activeItem.equip.itemLevel, targetLv);
    const materialName = costPlan.materialItemDefId === 'enhance-001' ? '淬灵石' : '蕴灵石';
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const previewBaseAttrs = buildGrowthPreviewAttrs(
      {
        baseAttrsRaw: activeItem.equip.baseAttrsRaw,
        defQualityRankRaw: activeItem.equip.defQualityRank,
        resolvedQualityRankRaw: activeItem.equip.resolvedQualityRank,
        strengthenLevelRaw: curLv,
        refineLevelRaw: activeItem.equip.refineLevel,
      },
      'enhance',
    );
    return {
      curLv,
      targetLv,
      materialItemDefId: costPlan.materialItemDefId,
      materialName,
      owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRatePermyriad: getEnhanceSuccessRatePermyriad(targetLv),
      downgradeOnFail: targetLv >= 8,
      previewBaseAttrs,
    };
  }, [activeItem, materialCounts]);

  const refineState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const curLv = Math.max(0, Math.min(10, Math.floor(Number(activeItem.equip.refineLevel) || 0)));
    const targetLv = Math.min(10, curLv + 1);
    const costPlan = buildRefineCostPlan(activeItem.equip.itemLevel, targetLv);
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const previewBaseAttrs = buildGrowthPreviewAttrs(
      {
        baseAttrsRaw: activeItem.equip.baseAttrsRaw,
        defQualityRankRaw: activeItem.equip.defQualityRank,
        resolvedQualityRankRaw: activeItem.equip.resolvedQualityRank,
        strengthenLevelRaw: activeItem.equip.strengthenLevel,
        refineLevelRaw: curLv,
      },
      'refine',
    );

    const materialName = costPlan.materialItemDefId === 'enhance-002' ? '蕴灵石' : costPlan.materialItemDefId;
    return {
      curLv,
      targetLv,
      materialItemDefId: costPlan.materialItemDefId,
      materialName,
      materialQty: costPlan.materialQty,
      owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRatePermyriad: getRefineSuccessRatePermyriad(targetLv),
      previewBaseAttrs,
    };
  }, [activeItem, materialCounts]);

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
        if ((res.message || '') === '强化失败') message.warning(res.message || '强化失败');
        else message.error(res.message || '强化失败');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '强化失败');
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
        else message.error(res.message || '精炼失败');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '精炼失败');
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
      if (!res.success) throw new Error(res.message || '镶嵌失败');
      message.success(res.message || '镶嵌成功');
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSelectedGemItemId(undefined);
      setSocketSlot(undefined);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '镶嵌失败');
    } finally {
      setSocketSubmitting(false);
    }
  }, [activeItem, message, refresh, socketState]);

  const bagOnlyItems = useMemo(() => items.filter((i) => i.location === 'bag'), [items]);

  const batchSubCategoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of bagOnlyItems) {
      if (it.subCategory) set.add(it.subCategory);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bagOnlyItems]);

  const batchEquipSlotOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of bagOnlyItems) {
      if (it.category !== 'equipment') continue;
      const slot = it.equip?.equipSlot;
      if (slot) set.add(slot);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bagOnlyItems]);

  const batchCandidates = useMemo(() => {
    const kw = batchKeyword.trim().toLowerCase();

    let list = bagOnlyItems.filter((i) => !i.locked);
    if (batchMode === 'disassemble') {
      list = collectBatchDisassembleEquipmentCandidates(list);
      if (batchEquipSlot !== 'all') {
        list = list.filter((i) => (i.equip?.equipSlot ?? '') === batchEquipSlot);
      }
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
  }, [bagOnlyItems, batchCategory, batchEquipSlot, batchKeyword, batchMode, batchQualities, batchSubCategory]);

  const batchSummary = useMemo(() => {
    if (batchMode === 'disassemble') {
      let cui = 0;
      let yun = 0;
      for (const it of batchCandidates) {
        if (it.quality === '黄' || it.quality === '玄') cui += 1;
        else yun += 1;
      }
      const parts: string[] = [];
      if (cui > 0) parts.push(`淬灵石×${cui}`);
      if (yun > 0) parts.push(`蕴灵石×${yun}`);
      return parts.join('，');
    }

    const qty = batchCandidates.reduce((sum, it) => sum + Math.max(0, it.qty || 0), 0);
    return `共${qty}件`;
  }, [batchCandidates, batchMode]);
  const useActionDisabled = loading || actionDisabled('use');

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
              <div
                key={it.id}
                className={`bag-cell ${qualityClass[it.quality]} ${it.id === safeActiveId ? 'is-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(it.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveId(it.id);
                }}
              >
                {it.stackMax > 1 ? <div className="bag-cell-count">{it.qty}</div> : null}
                {it.location === 'equipped' ? <div className="bag-cell-equipped-badge">已穿戴</div> : null}
                <img className="bag-cell-icon" src={it.icon} alt={it.name} />
                <div className="bag-cell-name">{it.name}</div>
              </div>
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
                    if (!res.success) throw new Error(res.message || '整理失败');
                    await refresh();
                  } catch (error: unknown) {
                    const err = error as { message?: string };
                    message.error(err.message || '整理失败');
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
                      <Tag color={qualityColor[activeItem.quality]}>{qualityLabelText[activeItem.quality]}</Tag>
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

                    {hasEquipAttrs ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">装备属性</div>
                        <div className="bag-detail-attr-grid">
                          {equipLines.map((line, idx) => (
                            <div key={`${idx}-${line}`} className="bag-detail-attr-item">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {hasSetInfo ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">套装效果</div>
                        <div className="bag-detail-lines">
                          <div className="bag-detail-line">
                            套装：{activeItem?.setInfo?.setName}（已穿戴 {activeItem?.setInfo?.equippedCount ?? 0} 件）
                          </div>
                          {activeItem?.setInfo?.bonuses.map((bonus) => (
                            <div key={`${bonus.pieceCount}-${bonus.lines.join('|')}`} className="bag-detail-line">
                              {bonus.active ? '已激活' : '未激活'} {bonus.pieceCount} 件：{bonus.lines.join('；')}
                            </div>
                          ))}
                        </div>
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
                hasAction('enhance') ||
                hasAction('show') ? (
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
                        {hasAction('show') ? (
                          <Button size="small" disabled={actionDisabled('show')}>
                            展示
                          </Button>
                        ) : null}
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
                location: activeItem.location,
                locked: activeItem.locked,
                category: activeItem.category,
                subCategory: activeItem.subCategory,
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
        open={enhanceOpen}
        onCancel={() => {
          if (enhanceSubmitting || refineSubmitting || socketSubmitting) return;
          setEnhanceOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        title="装备成长"
        className="bag-enhance-modal"
        maskClosable={!(enhanceSubmitting || refineSubmitting || socketSubmitting)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Tabs
            size="small"
            activeKey={growthMode}
            onChange={(k) => setGrowthMode(k as 'enhance' | 'refine' | 'socket')}
            items={[
              { key: 'enhance', label: '强化' },
              { key: 'refine', label: '精炼' },
              { key: 'socket', label: '镶嵌' },
            ]}
          />

          <div className="bag-growth-header">
            <div className="bag-growth-header-name" style={{ color: activeItem?.quality ? qualityColor[activeItem.quality] : undefined }}>
              {activeItem?.name ?? '未选择'}
            </div>
            <div className="bag-growth-header-meta">
              {activeItem?.equip?.equipSlot ? <span>{getEquipSlotLabel(activeItem.equip.equipSlot)}</span> : null}
              {activeItem?.quality ? <span className={'bag-growth-quality-badge ' + qualityClass[activeItem.quality]}>{qualityLabelText[activeItem.quality]}</span> : null}
            </div>
          </div>

          {growthMode === 'enhance' && (enhanceState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{enhanceState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{enhanceState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPermyriadPercent(enhanceState.successRatePermyriad)}%</span>
                </div>
                {enhanceState.downgradeOnFail && <div className="bag-growth-tip-warn">失败掉级</div>}
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  <div className={'bag-growth-cost-chip' + (enhanceState.owned < 1 ? ' is-insufficient' : '')}>
                    <span className="bag-growth-cost-name">{enhanceState.materialName}</span>
                    <span className="bag-growth-cost-val">×1</span>
                    <span className="bag-growth-cost-own">/{enhanceState.owned}</span>
                  </div>
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
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
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
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  enhanceSubmitting ||
                  enhanceState.curLv >= 15 ||
                  enhanceState.owned < 1 ||
                  playerSilver < enhanceState.silverCost ||
                  playerSpiritStones < enhanceState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleEnhance()}
                loading={enhanceSubmitting}
              >
                {activeItem?.locked ? '物品已锁定' : enhanceState.curLv >= 15 ? '已达上限' : '强化'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可强化的装备</div>
          ))}

          {growthMode === 'refine' && (refineState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{refineState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{refineState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPermyriadPercent(refineState.successRatePermyriad)}%</span>
                </div>
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  <div className={'bag-growth-cost-chip' + (refineState.owned < refineState.materialQty ? ' is-insufficient' : '')}>
                    <span className="bag-growth-cost-name">{refineState.materialName}</span>
                    <span className="bag-growth-cost-val">×{refineState.materialQty}</span>
                    <span className="bag-growth-cost-own">/{refineState.owned}</span>
                  </div>
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
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
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
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  refineSubmitting ||
                  refineState.curLv >= 10 ||
                  refineState.owned < refineState.materialQty ||
                  playerSilver < refineState.silverCost ||
                  playerSpiritStones < refineState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleRefine()}
                loading={refineSubmitting}
              >
                {activeItem?.locked ? '物品已锁定' : refineState.curLv >= 10 ? '已达上限' : '精炼'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可精炼的装备</div>
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
                    return {
                      value: slot,
                      label: existed ? `孔位${slot}（已镶嵌：${existed.name ?? existed.itemDefId}）` : `孔位${slot}（空）`,
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
        </div>
      </Modal>

      <Modal
        open={batchOpen}
        onCancel={() => {
          if (batchSubmitting) return;
          setBatchOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
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
            {batchMode === 'remove' ? (
              <>
                <Select
                  value={batchCategory}
                  onChange={(v) => setBatchCategory(v as BagCategory)}
                  placeholder="类型"
                  options={[
                    { value: 'all', label: '全部类型' },
                    { value: 'consumable', label: categoryLabels.consumable },
                    { value: 'material', label: categoryLabels.material },
                    { value: 'equipment', label: categoryLabels.equipment },
                    { value: 'skill', label: categoryLabels.skill },
                    { value: 'quest', label: categoryLabels.quest },
                  ]}
                />
                <Select
                  value={batchSubCategory}
                  onChange={(v) => setBatchSubCategory(String(v))}
                  placeholder="子类型"
                  options={[{ value: 'all', label: '全部子类型' }, ...batchSubCategoryOptions.map((s) => ({ value: s, label: s }))]}
                />
              </>
            ) : (
              <>
                <Select
                  value={batchEquipSlot}
                  onChange={(v) => setBatchEquipSlot(String(v))}
                  placeholder="装备部位"
                  options={[
                    { value: 'all', label: '全部部位' },
                    ...batchEquipSlotOptions.map((s) => ({ value: s, label: getEquipSlotLabel(s) })),
                  ]}
                />
                <Select value="bag" disabled options={[{ value: 'bag', label: '仅背包' }]} />
              </>
            )}
          </div>

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
                  const ids = batchCandidates.map((x) => x.id);
                  if (batchMode === 'disassemble') {
                    const res = await disassembleInventoryEquipmentBatch(ids);
                    if (!res.success) throw new Error(res.message || '分解失败');
                    message.success(res.message || '分解成功');
                  } else {
                    const res = await removeInventoryItemsBatch(ids);
                    if (!res.success) throw new Error(res.message || '丢弃失败');
                    message.success(res.message || '丢弃成功');
                  }
                  await refresh();
                  setBatchOpen(false);
                } catch (error: unknown) {
                  const err = error as { message?: string };
                  message.error(err.message || '操作失败');
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
    </Modal>
  );
};

const MOBILE_BREAKPOINT = 768;

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
};

const BagModalSwitch: React.FC<{ open: boolean; onClose: () => void }> = (props) => {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileBagModal {...props} />;
  return <BagModal {...props} />;
};

export default BagModalSwitch;
