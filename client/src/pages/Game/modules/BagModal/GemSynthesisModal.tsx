import { App, Button, Empty, InputNumber, Modal, Segmented, Select, Spin, Tag } from 'antd';
import { formatPercent, formatRecovery } from '../../shared/formatAttr';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { estimateBatchOutput, type BatchEstimate, EMPTY_BATCH_ESTIMATE } from './gemSynthesisEstimate';
import {
  convertInventoryGem,
  getInventoryItems,
  getInventoryGemConvertOptions,
  getInventoryGemSynthesisRecipes,
  synthesizeInventoryGem,
  synthesizeInventoryGemBatch,
  type GemConvertOptionDto,
  type GemSynthesisRecipeDto,
  type GemType,
  type InventoryItemDto,
} from '../../../../services/api';

interface GemSynthesisModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}

const gemTypeLabel: Record<GemType, string> = {
  attack: '攻击',
  defense: '防御',
  survival: '生存',
  all: '通用',
};

type SynthesisMode = 'quick' | 'single' | 'convert';

const clampSynthesizeTimes = (value: number, maxValue: number): number => {
  const safeMax = Math.max(1, Math.floor(maxValue || 1));
  if (!Number.isFinite(value)) return 1;
  return Math.min(safeMax, Math.max(1, Math.floor(value)));
};

const GEM_CONVERT_MANUAL_SELECT_QTY = 2;
const GEM_ITEM_LEVEL_RE = /^gem-(?:atk|def|sur|all)(?:-[a-z0-9_]+)?-([1-9]|10)$/i;

interface ConvertSelectableGemItem {
  itemId: number;
  itemDefId: string;
  name: string;
  level: number;
  qty: number;
}

/**
 * 从配方列表中提取系列选项
 *
 * 输入：当前宝石类型下的配方列表
 * 输出：[{ value: seriesKey, label: 系列显示名 }]
 */
const buildSeriesOptions = (recipes: GemSynthesisRecipeDto[]) => {
  const map = new Map<string, string>();
  for (const recipe of recipes) {
    if (!map.has(recipe.seriesKey)) {
      const displayName = recipe.output.name.replace(/·\d+级$/, '') || recipe.seriesKey;
      map.set(recipe.seriesKey, displayName);
    }
  }
  return [...map.entries()].map(([value, label]) => ({ value, label }));
};

const parseGemLevelFromInventoryItem = (item: InventoryItemDto): number | null => {
  const levelFromDef = Number(item.def?.gem_level);
  if (Number.isInteger(levelFromDef) && levelFromDef >= 1 && levelFromDef <= 10) {
    return levelFromDef;
  }
  const matched = GEM_ITEM_LEVEL_RE.exec(String(item.item_def_id || '').trim());
  if (!matched) return null;
  const parsedLevel = Number(matched[1]);
  if (!Number.isInteger(parsedLevel)) return null;
  return parsedLevel;
};

const buildConvertSelectableGemItems = (items: InventoryItemDto[]): ConvertSelectableGemItem[] => {
  return items
    .filter((item) => item.location === 'bag' && !item.locked && (item.def?.category ?? '').toLowerCase() === 'gem')
    .map((item): ConvertSelectableGemItem | null => {
      const level = parseGemLevelFromInventoryItem(item);
      if (!level || level < 2 || level > 10) return null;
      const qty = Math.max(0, Number(item.qty) || 0);
      if (qty <= 0) return null;
      return {
        itemId: item.id,
        itemDefId: item.item_def_id,
        name: item.def?.name || item.item_def_id,
        level,
        qty,
      };
    })
    .filter((item): item is ConvertSelectableGemItem => !!item)
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'zh-Hans-CN') || a.itemId - b.itemId);
};

const normalizeSelectedConvertGemItemIds = (
  selectedIds: number[],
  convertGemItems: ConvertSelectableGemItem[],
): number[] => {
  const qtyByItemId = new Map<number, number>();
  for (const item of convertGemItems) {
    qtyByItemId.set(item.itemId, item.qty);
  }
  const consumedByItemId = new Map<number, number>();
  const normalized: number[] = [];
  for (const itemId of selectedIds) {
    if (normalized.length >= GEM_CONVERT_MANUAL_SELECT_QTY) break;
    const availableQty = qtyByItemId.get(itemId) ?? 0;
    if (availableQty <= 0) continue;
    const consumedQty = consumedByItemId.get(itemId) ?? 0;
    if (consumedQty >= availableQty) continue;
    normalized.push(itemId);
    consumedByItemId.set(itemId, consumedQty + 1);
  }
  return normalized;
};

const GemSynthesisModal: React.FC<GemSynthesisModalProps> = ({ open, onClose, onSuccess }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [convertSubmitting, setConvertSubmitting] = useState(false);
  const [gemType, setGemType] = useState<GemType>('attack');
  const [recipes, setRecipes] = useState<GemSynthesisRecipeDto[]>([]);
  const [convertOptions, setConvertOptions] = useState<GemConvertOptionDto[]>([]);
  const [convertGemItems, setConvertGemItems] = useState<ConvertSelectableGemItem[]>([]);
  const [wallet, setWallet] = useState<{ silver: number; spiritStones: number } | null>(null);
  const [mode, setMode] = useState<SynthesisMode>('quick');

  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [times, setTimes] = useState(1);
  const selectedRecipeIdRef = useRef('');

  const [batchSeriesKey, setBatchSeriesKey] = useState('');
  const [targetLevel, setTargetLevel] = useState(2);
  const targetLevelRef = useRef(2);

  const [convertTimes, setConvertTimes] = useState(1);
  const [selectedConvertGemItemIds, setSelectedConvertGemItemIds] = useState<number[]>([]);
  const selectedConvertGemItemIdsRef = useRef<number[]>([]);

  useEffect(() => {
    selectedRecipeIdRef.current = selectedRecipeId;
  }, [selectedRecipeId]);

  useEffect(() => {
    targetLevelRef.current = targetLevel;
  }, [targetLevel]);

  useEffect(() => {
    selectedConvertGemItemIdsRef.current = selectedConvertGemItemIds;
  }, [selectedConvertGemItemIds]);

  /**
   * 刷新宝石合成与转换数据
   *
   * 数据流：
   * - 并发请求配方、转换选项、背包物品
   * - 统一更新钱包/合成状态/转换状态
   * - 尽量保留用户已选项（配方、目标等级、手动选中的宝石）
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [synthesisRes, convertRes, bagRes] = await Promise.all([
        getInventoryGemSynthesisRecipes(),
        getInventoryGemConvertOptions(),
        getInventoryItems('bag', 1, 200),
      ]);
      if (!synthesisRes.success || !synthesisRes.data) {
        throw new Error(synthesisRes.message || '加载宝石配方失败');
      }
      if (!convertRes.success || !convertRes.data) {
        throw new Error(convertRes.message || '加载宝石转换配置失败');
      }
      if (!bagRes.success || !bagRes.data) {
        throw new Error(bagRes.message || '加载背包宝石失败');
      }

      const nextRecipes = synthesisRes.data.recipes || [];
      const nextConvertOptions = (convertRes.data.options || []).slice().sort((a, b) => a.inputLevel - b.inputLevel);
      const nextConvertGemItems = buildConvertSelectableGemItems(bagRes.data.items || []);
      setRecipes(nextRecipes);
      setConvertOptions(nextConvertOptions);
      setConvertGemItems(nextConvertGemItems);
      setSelectedConvertGemItemIds(
        normalizeSelectedConvertGemItemIds(selectedConvertGemItemIdsRef.current, nextConvertGemItems),
      );
      setWallet(synthesisRes.data.character);

      const sameTypeRecipes = nextRecipes
        .filter((recipe) => recipe.gemType === gemType)
        .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey) || a.fromLevel - b.fromLevel);

      const currentSelectedRecipeId = selectedRecipeIdRef.current;
      const nextSelectedRecipeId = sameTypeRecipes.some((recipe) => recipe.recipeId === currentSelectedRecipeId)
        ? currentSelectedRecipeId
        : sameTypeRecipes[0]?.recipeId || '';
      setSelectedRecipeId(nextSelectedRecipeId);
      const selectedRecipe =
        sameTypeRecipes.find((recipe) => recipe.recipeId === nextSelectedRecipeId) ?? sameTypeRecipes[0] ?? null;
      setTimes(clampSynthesizeTimes(1, selectedRecipe?.maxSynthesizeTimes ?? 1));

      const currentTargetLevel = targetLevelRef.current;
      const allToLevels = [...new Set(sameTypeRecipes.map((recipe) => recipe.toLevel))];
      const maxToLevel = allToLevels.length > 0 ? Math.max(...allToLevels) : 2;
      setTargetLevel(Math.max(2, Math.min(maxToLevel, currentTargetLevel)));
    } catch (error: unknown) {
      void 0;
      setRecipes([]);
      setConvertOptions([]);
      setConvertGemItems([]);
      setWallet(null);
      setSelectedRecipeId('');
      setTimes(1);
      setTargetLevel(2);
      setConvertTimes(1);
      setSelectedConvertGemItemIds([]);
    } finally {
      setLoading(false);
    }
  }, [gemType, message]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const filteredRecipes = useMemo(() => {
    return recipes
      .filter((recipe) => recipe.gemType === gemType)
      .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey) || a.fromLevel - b.fromLevel);
  }, [gemType, recipes]);

  const seriesOptions = useMemo(() => buildSeriesOptions(filteredRecipes), [filteredRecipes]);

  useEffect(() => {
    if (seriesOptions.length === 0) {
      setBatchSeriesKey('');
      return;
    }
    if (!seriesOptions.some((option) => option.value === batchSeriesKey)) {
      setBatchSeriesKey(seriesOptions[0].value);
    }
  }, [batchSeriesKey, seriesOptions]);

  const batchTargetLevelOptions = useMemo(() => {
    if (!batchSeriesKey) return [];
    const seriesRecipes = filteredRecipes.filter((recipe) => recipe.seriesKey === batchSeriesKey);
    const levels = [...new Set(seriesRecipes.map((recipe) => recipe.toLevel))]
      .filter((level) => level > 1)
      .sort((a, b) => a - b);
    return levels.map((level) => ({ value: level, label: `${level}级` }));
  }, [batchSeriesKey, filteredRecipes]);

  useEffect(() => {
    if (batchTargetLevelOptions.length === 0) {
      setTargetLevel(2);
      return;
    }
    if (!batchTargetLevelOptions.some((option) => option.value === targetLevel)) {
      setTargetLevel(batchTargetLevelOptions[0].value);
    }
  }, [targetLevel, batchTargetLevelOptions]);

  const batchEstimate = useMemo((): BatchEstimate => {
    if (!batchSeriesKey) return EMPTY_BATCH_ESTIMATE;
    const seriesRecipes = filteredRecipes.filter((recipe) => recipe.seriesKey === batchSeriesKey);
    return estimateBatchOutput(seriesRecipes, targetLevel, wallet);
  }, [batchSeriesKey, filteredRecipes, targetLevel, wallet]);

  const selectedRecipe = useMemo(() => {
    if (filteredRecipes.length === 0) return null;
    return filteredRecipes.find((recipe) => recipe.recipeId === selectedRecipeId) ?? filteredRecipes[0];
  }, [filteredRecipes, selectedRecipeId]);

  useEffect(() => {
    if (!selectedRecipe) {
      setTimes(1);
      return;
    }
    setTimes((prev) => clampSynthesizeTimes(prev, selectedRecipe.maxSynthesizeTimes));
  }, [selectedRecipe]);

  const convertGemItemById = useMemo(() => {
    return new Map<number, ConvertSelectableGemItem>(convertGemItems.map((item) => [item.itemId, item]));
  }, [convertGemItems]);

  const selectedConvertGemCountByItemId = useMemo(() => {
    const map = new Map<number, number>();
    for (const itemId of selectedConvertGemItemIds) {
      map.set(itemId, (map.get(itemId) ?? 0) + 1);
    }
    return map;
  }, [selectedConvertGemItemIds]);

  const selectedBaseConvertLevel = useMemo(() => {
    if (selectedConvertGemItemIds.length <= 0) return null;
    const firstItem = convertGemItemById.get(selectedConvertGemItemIds[0]);
    return firstItem?.level ?? null;
  }, [convertGemItemById, selectedConvertGemItemIds]);

  const selectedConvertLevel = useMemo(() => {
    if (selectedConvertGemItemIds.length !== GEM_CONVERT_MANUAL_SELECT_QTY) return null;
    const levels = selectedConvertGemItemIds
      .map((itemId) => convertGemItemById.get(itemId)?.level ?? null)
      .filter((level): level is number => typeof level === 'number');
    if (levels.length !== GEM_CONVERT_MANUAL_SELECT_QTY) return null;
    return levels.every((level) => level === levels[0]) ? levels[0] : null;
  }, [convertGemItemById, selectedConvertGemItemIds]);

  const convertOptionByInputLevel = useMemo(() => {
    return new Map<number, GemConvertOptionDto>(convertOptions.map((option) => [option.inputLevel, option]));
  }, [convertOptions]);

  const selectedConvertOption = useMemo(() => {
    if (!selectedConvertLevel) return null;
    return convertOptionByInputLevel.get(selectedConvertLevel) ?? null;
  }, [convertOptionByInputLevel, selectedConvertLevel]);

  const selectedConvertMaxTimesByItems = useMemo(() => {
    if (selectedConvertGemItemIds.length !== GEM_CONVERT_MANUAL_SELECT_QTY) return 0;
    const needByItemId = new Map<number, number>();
    for (const itemId of selectedConvertGemItemIds) {
      needByItemId.set(itemId, (needByItemId.get(itemId) ?? 0) + 1);
    }
    let maxTimes = Number.MAX_SAFE_INTEGER;
    for (const [itemId, needQty] of needByItemId.entries()) {
      const item = convertGemItemById.get(itemId);
      if (!item || needQty <= 0) return 0;
      maxTimes = Math.min(maxTimes, Math.floor(item.qty / needQty));
    }
    if (!Number.isFinite(maxTimes) || maxTimes <= 0) return 0;
    return maxTimes;
  }, [convertGemItemById, selectedConvertGemItemIds]);

  const selectedConvertMaxTimesBySpirit = useMemo(() => {
    if (!selectedConvertOption) return 0;
    const cost = selectedConvertOption.costSpiritStonesPerConvert;
    if (cost <= 0) return Number.MAX_SAFE_INTEGER;
    return Math.floor((wallet?.spiritStones ?? 0) / cost);
  }, [selectedConvertOption, wallet?.spiritStones]);

  const selectedConvertMaxTimes = useMemo(() => {
    if (!selectedConvertOption) return 0;
    if (selectedConvertOption.candidateGemCount <= 0) return 0;
    return Math.max(0, Math.min(selectedConvertMaxTimesByItems, selectedConvertMaxTimesBySpirit));
  }, [selectedConvertMaxTimesByItems, selectedConvertMaxTimesBySpirit, selectedConvertOption]);

  useEffect(() => {
    if (selectedConvertMaxTimes <= 0) {
      setConvertTimes(1);
      return;
    }
    setConvertTimes((prev) => clampSynthesizeTimes(prev, selectedConvertMaxTimes));
  }, [selectedConvertMaxTimes]);

  const addSelectedConvertGem = useCallback((itemId: number) => {
    setSelectedConvertGemItemIds((prev) => {
      if (prev.length >= GEM_CONVERT_MANUAL_SELECT_QTY) return prev;
      const target = convertGemItemById.get(itemId);
      if (!target) return prev;
      const selectedLevel = prev.length > 0 ? (convertGemItemById.get(prev[0])?.level ?? null) : null;
      if (selectedLevel !== null && selectedLevel !== target.level) return prev;
      const alreadySelectedCount = prev.reduce((count, id) => (id === itemId ? count + 1 : count), 0);
      if (alreadySelectedCount >= target.qty) return prev;
      return [...prev, itemId];
    });
  }, [convertGemItemById]);

  const removeSelectedConvertGem = useCallback((itemId: number) => {
    setSelectedConvertGemItemIds((prev) => {
      const removeIndex = prev.indexOf(itemId);
      if (removeIndex < 0) return prev;
      return prev.filter((_, index) => index !== removeIndex);
    });
  }, []);

  const clearSelectedConvertGems = useCallback(() => {
    setSelectedConvertGemItemIds([]);
  }, []);

  const handleExecute = useCallback(async () => {
    if (!selectedRecipe) return;
    const executeTimes = clampSynthesizeTimes(times, selectedRecipe.maxSynthesizeTimes);
    setSubmitting(true);
    try {
      const res = await synthesizeInventoryGem({ recipeId: selectedRecipe.recipeId, times: executeTimes });
      if (!res.success || !res.data) throw new Error(res.message || '宝石合成失败');
      if (res.data.successCount > 0) {
        message.success(res.message || '宝石合成完成');
      } else {
        message.warning(res.message || '宝石合成失败');
      }
      await onSuccess();
      await refresh();
    } catch (error: unknown) {
      void 0;
    } finally {
      setSubmitting(false);
    }
  }, [message, onSuccess, refresh, selectedRecipe, times]);

  /**
   * 快捷合成：使用独立的 batchSeriesKey + targetLevel
   * 不传 sourceLevel，服务端默认从1级开始逐级合成
   */
  const handleBatch = useCallback(async () => {
    if (!batchSeriesKey) return;
    setBatchSubmitting(true);
    try {
      const res = await synthesizeInventoryGemBatch({
        gemType,
        targetLevel,
        seriesKey: batchSeriesKey,
      });
      if (!res.success || !res.data) throw new Error(res.message || '快捷合成失败');
      const steps = res.data.steps ?? [];
      const successCount = steps.reduce((sum, step) => sum + (step.successCount || 0), 0);
      const failCount = steps.reduce((sum, step) => sum + (step.failCount || 0), 0);
      if (successCount > 0) {
        message.success(`${res.message || '快捷合成成功'}（成功${successCount}次，失败${failCount}次）`);
      } else {
        message.warning(`${res.message || '快捷合成失败'}（失败${failCount}次）`);
      }
      await onSuccess();
      await refresh();
    } catch (error: unknown) {
      void 0;
    } finally {
      setBatchSubmitting(false);
    }
  }, [batchSeriesKey, gemType, message, onSuccess, refresh, targetLevel]);

  const handleConvert = useCallback(async () => {
    if (selectedConvertGemItemIds.length !== GEM_CONVERT_MANUAL_SELECT_QTY) return;
    if (!selectedConvertOption) return;
    if (selectedConvertMaxTimes <= 0) return;

    const executeTimes = clampSynthesizeTimes(convertTimes, selectedConvertMaxTimes);
    setConvertSubmitting(true);
    try {
      const res = await convertInventoryGem({
        selectedGemItemIds: selectedConvertGemItemIds,
        times: executeTimes,
      });
      if (!res.success || !res.data) throw new Error(res.message || '宝石转换失败');

      const producedSummary = (res.data.produced.items || [])
        .map((item) => `${item.name}×${item.qty}`)
        .join('、');
      if (producedSummary) {
        message.success(`${res.message || '宝石转换成功'}：${producedSummary}`);
      } else {
        message.success(res.message || '宝石转换成功');
      }
      await onSuccess();
      await refresh();
    } catch (error: unknown) {
      void 0;
    } finally {
      setConvertSubmitting(false);
    }
  }, [convertTimes, message, onSuccess, refresh, selectedConvertGemItemIds, selectedConvertMaxTimes, selectedConvertOption]);

  const canSynthesize = !!selectedRecipe && selectedRecipe.maxSynthesizeTimes > 0;
  const canBatch = !!batchSeriesKey && batchTargetLevelOptions.length > 0 && !batchSubmitting;
  const canConvert =
    selectedConvertGemItemIds.length === GEM_CONVERT_MANUAL_SELECT_QTY &&
    !!selectedConvertOption &&
    selectedConvertMaxTimes > 0 &&
    !convertSubmitting;
  const selectedConvertGemLabelText = useMemo(() => {
    if (selectedConvertGemItemIds.length <= 0) {
      return `请选择${GEM_CONVERT_MANUAL_SELECT_QTY}个同等级宝石`;
    }
    return selectedConvertGemItemIds
      .map((itemId) => {
        const item = convertGemItemById.get(itemId);
        if (!item) return '未知宝石';
        return `${item.name}(${item.level}级)`;
      })
      .join('、');
  }, [convertGemItemById, selectedConvertGemItemIds]);

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (submitting || batchSubmitting || convertSubmitting) return;
        onClose();
      }}
      footer={null}
      centered
      width={980}
      title="宝石工坊"
      className="bag-gem-modal"
      destroyOnHidden
      maskClosable={!(submitting || batchSubmitting || convertSubmitting)}
    >
      <div className="bag-gem-shell">
        <div className="bag-gem-top">
          <div className="bag-gem-top-left">
            <Segmented
              value={mode}
              options={[
                { label: '快捷合成', value: 'quick' },
                { label: '单次合成', value: 'single' },
                { label: '宝石转换', value: 'convert' },
              ]}
              onChange={(value) => setMode(value as SynthesisMode)}
            />
            {mode !== 'convert' ? (
              <Segmented
                value={gemType}
                options={(Object.keys(gemTypeLabel) as GemType[]).map((type) => ({
                  label: gemTypeLabel[type],
                  value: type,
                }))}
                onChange={(value) => {
                  setGemType(value as GemType);
                  setSelectedRecipeId('');
                  setBatchSeriesKey('');
                }}
              />
            ) : null}
          </div>
          {wallet ? (
            <div className="bag-gem-wallet">
              <Tag color="gold">银两：{wallet.silver.toLocaleString()}</Tag>
              <Tag color="blue">灵石：{wallet.spiritStones.toLocaleString()}</Tag>
            </div>
          ) : null}
        </div>

        {mode === 'quick' ? (
          <div className="bag-gem-quick">
            {loading && recipes.length === 0 ? (
              <div className="bag-gem-loading"><Spin /></div>
            ) : seriesOptions.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用宝石配方" />
            ) : (
              <div className="bag-gem-quick-form">
                <div className="bag-gem-quick-row">
                  <Select
                    value={batchSeriesKey || undefined}
                    options={seriesOptions}
                    onChange={(value) => setBatchSeriesKey(String(value))}
                    placeholder="选择系列"
                    className="bag-gem-quick-series"
                  />
                  <Select
                    value={targetLevel}
                    options={batchTargetLevelOptions}
                    onChange={(value) => setTargetLevel(Number(value) || 2)}
                    placeholder="目标等级"
                    className="bag-gem-quick-target"
                  />
                  <Button
                    type="primary"
                    disabled={!canBatch}
                    loading={batchSubmitting}
                    onClick={() => void handleBatch()}
                  >
                    快捷合成
                  </Button>
                </div>
                {batchSeriesKey && batchTargetLevelOptions.length > 0 ? (
                  <div className="bag-gem-quick-estimate">
                    <span className="bag-gem-quick-estimate-label">预估产出</span>
                    <span className="bag-gem-quick-estimate-levels">
                      {batchEstimate.byLevel.length > 0
                        ? batchEstimate.byLevel.map((item) => (
                            <span key={item.level} className={item.level === targetLevel ? 'is-target' : 'is-remainder'}>
                              {item.level}级×{formatRecovery(item.count)}
                            </span>
                          ))
                        : <span className="is-empty">无法合成</span>}
                    </span>
                    {batchEstimate.silver > 0 ? (
                      <span>消耗银两 <strong>{batchEstimate.silver.toLocaleString()}</strong></span>
                    ) : null}
                    {batchEstimate.spiritStones > 0 ? (
                      <span>消耗灵石 <strong>{batchEstimate.spiritStones.toLocaleString()}</strong></span>
                    ) : null}
                  </div>
                ) : null}
                <div className="bag-gem-quick-hint">
                  自动使用低级宝石逐级合成到目标等级，6级以上存在失败率。
                </div>
              </div>
            )}
          </div>
        ) : mode === 'single' ? (
          <div className="bag-gem-body">
            {loading && recipes.length === 0 ? (
              <div className="bag-gem-loading"><Spin /></div>
            ) : (
              <>
                <div className="bag-gem-list">
                  {filteredRecipes.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用宝石配方" />
                  ) : (
                    filteredRecipes.map((recipe) => (
                      <button
                        key={recipe.recipeId}
                        type="button"
                        className={`bag-gem-item ${selectedRecipe?.recipeId === recipe.recipeId ? 'is-active' : ''}`}
                        onClick={() => setSelectedRecipeId(recipe.recipeId)}
                      >
                        <div className="bag-gem-item-title">{recipe.name}</div>
                        <div className="bag-gem-item-meta">
                          <span>{recipe.fromLevel}级 → {recipe.toLevel}级</span>
                          <span>成功率 {formatPercent(recipe.successRate)}</span>
                        </div>
                        <div className="bag-gem-item-meta">
                          <span>可合成 {recipe.maxSynthesizeTimes} 次</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <div className="bag-gem-detail">
                  {selectedRecipe ? (
                    <div className="bag-gem-detail-content">
                      <div className="bag-gem-detail-title">{selectedRecipe.name}</div>
                      <div className="bag-gem-detail-meta">
                        <Tag color="default">类型：{gemTypeLabel[selectedRecipe.gemType]}</Tag>
                        <Tag color="blue">产出：{selectedRecipe.output.name} ×{selectedRecipe.output.qty}</Tag>
                        <Tag color={selectedRecipe.successRate >= 1 ? 'green' : 'orange'}>
                          成功率：{formatPercent(selectedRecipe.successRate)}
                        </Tag>
                      </div>

                      <div className="bag-gem-costs">
                        {selectedRecipe.input.qty > 0 ? (
                          <div className={`bag-gem-cost-line ${selectedRecipe.input.owned < selectedRecipe.input.qty ? 'is-missing' : ''}`}>
                            <span>{selectedRecipe.input.name}</span>
                            <span>{selectedRecipe.input.qty} / {selectedRecipe.input.owned}</span>
                          </div>
                        ) : null}
                        {selectedRecipe.costs.silver > 0 ? (
                          <div className={`bag-gem-cost-line ${(wallet?.silver ?? 0) < selectedRecipe.costs.silver ? 'is-missing' : ''}`}>
                            <span>银两</span>
                            <span>{selectedRecipe.costs.silver.toLocaleString()} / {(wallet?.silver ?? 0).toLocaleString()}</span>
                          </div>
                        ) : null}
                        {selectedRecipe.costs.spiritStones > 0 ? (
                          <div className={`bag-gem-cost-line ${(wallet?.spiritStones ?? 0) < selectedRecipe.costs.spiritStones ? 'is-missing' : ''}`}>
                            <span>灵石</span>
                            <span>{selectedRecipe.costs.spiritStones.toLocaleString()} / {(wallet?.spiritStones ?? 0).toLocaleString()}</span>
                          </div>
                        ) : null}
                      </div>

                      <div className="bag-gem-submit">
                        <div className="bag-gem-submit-input">
                          <span>合成次数</span>
                          <InputNumber
                            min={1}
                            max={Math.max(1, selectedRecipe.maxSynthesizeTimes)}
                            value={times}
                            onChange={(value) => setTimes(clampSynthesizeTimes(Number(value || 1), selectedRecipe.maxSynthesizeTimes))}
                          />
                          <span>最多 {selectedRecipe.maxSynthesizeTimes}</span>
                        </div>
                        <Button
                          type="primary"
                          disabled={!canSynthesize || submitting}
                          loading={submitting}
                          onClick={() => void handleExecute()}
                        >
                          {canSynthesize ? '执行合成' : '材料或货币不足'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择配方" />
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="bag-gem-convert">
            {loading && convertOptions.length === 0 ? (
              <div className="bag-gem-loading"><Spin /></div>
            ) : convertOptions.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用转换配置" />
            ) : (
              <div className="bag-gem-convert-form">
                <div className="bag-gem-convert-row">
                  <div className="bag-gem-convert-selected">
                    <span className="bag-gem-convert-selected-label">已选择</span>
                    <span className="bag-gem-convert-selected-value">{selectedConvertGemLabelText}</span>
                  </div>
                  <div className="bag-gem-convert-times">
                    <span>转换次数</span>
                    <InputNumber
                      min={1}
                      max={Math.max(1, selectedConvertMaxTimes)}
                      value={convertTimes}
                      onChange={(value) => setConvertTimes(clampSynthesizeTimes(Number(value || 1), selectedConvertMaxTimes))}
                    />
                    <span>最多 {selectedConvertMaxTimes}</span>
                  </div>
                  <Button
                    onClick={clearSelectedConvertGems}
                    disabled={selectedConvertGemItemIds.length <= 0 || convertSubmitting}
                  >
                    清空选择
                  </Button>
                  <Button
                    type="primary"
                    disabled={!canConvert}
                    loading={convertSubmitting}
                    onClick={() => void handleConvert()}
                  >
                    执行转换
                  </Button>
                </div>

                {selectedConvertOption ? (
                  <>
                    <div className="bag-gem-convert-formula">
                      {selectedConvertOption.inputGemQtyPerConvert}颗{selectedConvertOption.inputLevel}级手选宝石
                      {' -> '}
                      1颗{selectedConvertOption.outputLevel}级随机宝石
                    </div>
                    <div className="bag-gem-convert-summary">
                      <span>当前选择 <strong>{selectedConvertGemItemIds.length}</strong> / {GEM_CONVERT_MANUAL_SELECT_QTY}</span>
                      <span>单次消耗灵石 <strong>{selectedConvertOption.costSpiritStonesPerConvert.toLocaleString()}</strong></span>
                      <span>本次消耗灵石 <strong>{(selectedConvertOption.costSpiritStonesPerConvert * clampSynthesizeTimes(convertTimes, selectedConvertMaxTimes)).toLocaleString()}</strong></span>
                      <span>随机池数量 <strong>{selectedConvertOption.candidateGemCount}</strong></span>
                      <span>当前最多可转 <strong>{selectedConvertMaxTimes}</strong> 次</span>
                    </div>
                  </>
                ) : (
                  <div className="bag-gem-convert-formula is-warning">
                    请选择2个同等级宝石后可查看转换消耗与结果。
                  </div>
                )}

                <div className="bag-gem-convert-list">
                  {convertGemItems.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="背包内暂无可转换宝石" />
                  ) : (
                    convertGemItems.map((item) => {
                      const selectedCount = selectedConvertGemCountByItemId.get(item.itemId) ?? 0;
                      const levelLocked = selectedBaseConvertLevel !== null && selectedBaseConvertLevel !== item.level;
                      const canAdd =
                        !levelLocked &&
                        selectedConvertGemItemIds.length < GEM_CONVERT_MANUAL_SELECT_QTY &&
                        selectedCount < item.qty &&
                        !convertSubmitting;
                      return (
                        <div
                          key={item.itemId}
                          className={`bag-gem-convert-candidate ${selectedCount > 0 ? 'is-selected' : ''} ${levelLocked ? 'is-disabled' : ''}`}
                        >
                          <div className="bag-gem-convert-candidate-main">
                            <span className="bag-gem-convert-candidate-name">{item.name}</span>
                            <span className="bag-gem-convert-candidate-meta">
                              {item.level}级 · 数量{item.qty}
                            </span>
                          </div>
                          <div className="bag-gem-convert-candidate-actions">
                            <Button
                              size="small"
                              onClick={() => removeSelectedConvertGem(item.itemId)}
                              disabled={selectedCount <= 0 || convertSubmitting}
                            >
                              -
                            </Button>
                            <span>{selectedCount}</span>
                            <Button
                              size="small"
                              onClick={() => addSelectedConvertGem(item.itemId)}
                              disabled={!canAdd}
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="bag-gem-convert-hint">
                  仅可手动选择背包内未锁定宝石；每次固定消耗2颗并产出1颗低1级随机宝石。
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default GemSynthesisModal;
