import { App, Button, Empty, InputNumber, Modal, Segmented, Select, Spin, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getInventoryGemSynthesisRecipes,
  synthesizeInventoryGem,
  synthesizeInventoryGemBatch,
  type GemSynthesisRecipeDto,
  type GemType,
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

const clampSynthesizeTimes = (value: number, maxValue: number): number => {
  const safeMax = Math.max(1, Math.floor(maxValue || 1));
  if (!Number.isFinite(value)) return 1;
  return Math.min(safeMax, Math.max(1, Math.floor(value)));
};

const GemSynthesisModal: React.FC<GemSynthesisModalProps> = ({ open, onClose, onSuccess }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [gemType, setGemType] = useState<GemType>('attack');
  const [recipes, setRecipes] = useState<GemSynthesisRecipeDto[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [times, setTimes] = useState(1);
  const [sourceLevel, setSourceLevel] = useState(1);
  const [targetLevel, setTargetLevel] = useState(2);
  const [wallet, setWallet] = useState<{ silver: number; spiritStones: number } | null>(null);
  const selectedRecipeIdRef = useRef('');
  const sourceLevelRef = useRef(1);
  const targetLevelRef = useRef(2);

  useEffect(() => {
    selectedRecipeIdRef.current = selectedRecipeId;
  }, [selectedRecipeId]);

  useEffect(() => {
    sourceLevelRef.current = sourceLevel;
  }, [sourceLevel]);

  useEffect(() => {
    targetLevelRef.current = targetLevel;
  }, [targetLevel]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getInventoryGemSynthesisRecipes();
      if (!res.success || !res.data) throw new Error(res.message || '加载宝石配方失败');
      const nextRecipes = res.data.recipes || [];
      setRecipes(nextRecipes);
      setWallet(res.data.character);

      const sameTypeRecipes = nextRecipes
        .filter((recipe) => recipe.gemType === gemType)
        .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey) || a.fromLevel - b.fromLevel);
      const currentSelectedRecipeId = selectedRecipeIdRef.current;
      const nextSelected = sameTypeRecipes.find((recipe) => recipe.recipeId === currentSelectedRecipeId)
        ? currentSelectedRecipeId
        : sameTypeRecipes[0]?.recipeId || '';
      setSelectedRecipeId(nextSelected);
      const selected = sameTypeRecipes.find((recipe) => recipe.recipeId === nextSelected) ?? sameTypeRecipes[0] ?? null;
      setTimes(clampSynthesizeTimes(1, selected?.maxSynthesizeTimes ?? 1));

      const sameSeriesRecipes = selected
        ? sameTypeRecipes.filter((recipe) => recipe.seriesKey === selected.seriesKey)
        : [];
      const levelList = [...new Set(sameSeriesRecipes.map((recipe) => recipe.fromLevel))].sort((a, b) => a - b);
      const currentSourceLevel = sourceLevelRef.current;
      const currentTargetLevel = targetLevelRef.current;
      const nextSource = levelList.includes(currentSourceLevel) ? currentSourceLevel : (levelList[0] ?? 1);
      setSourceLevel(nextSource);
      const maxLevel = sameSeriesRecipes.reduce((max, recipe) => Math.max(max, recipe.toLevel), nextSource + 1);
      const minTarget = Math.min(10, Math.max(nextSource + 1, 2));
      const nextTarget = Math.max(minTarget, Math.min(maxLevel, currentTargetLevel));
      setTargetLevel(nextTarget);
    } catch (error: unknown) {
      message.error((error as { message?: string }).message || '加载宝石配方失败');
      setRecipes([]);
      setWallet(null);
      setSelectedRecipeId('');
      setTimes(1);
      setSourceLevel(1);
      setTargetLevel(2);
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

  const selectedRecipe = useMemo(() => {
    if (filteredRecipes.length === 0) return null;
    const found = filteredRecipes.find((recipe) => recipe.recipeId === selectedRecipeId);
    return found ?? filteredRecipes[0];
  }, [filteredRecipes, selectedRecipeId]);

  const selectedSeriesRecipes = useMemo(() => {
    if (!selectedRecipe) return [] as GemSynthesisRecipeDto[];
    return filteredRecipes
      .filter((recipe) => recipe.seriesKey === selectedRecipe.seriesKey)
      .sort((a, b) => a.fromLevel - b.fromLevel);
  }, [filteredRecipes, selectedRecipe]);

  useEffect(() => {
    if (!selectedRecipe) {
      setTimes(1);
      return;
    }
    setTimes((prev) => clampSynthesizeTimes(prev, selectedRecipe.maxSynthesizeTimes));
  }, [selectedRecipe]);

  const sourceLevelOptions = useMemo(() => {
    return [...new Set(selectedSeriesRecipes.map((recipe) => recipe.fromLevel))]
      .sort((a, b) => a - b)
      .map((lv) => ({ value: lv, label: `${lv}级` }));
  }, [selectedSeriesRecipes]);

  const targetLevelOptions = useMemo(() => {
    const levels = [...new Set(selectedSeriesRecipes.map((recipe) => recipe.toLevel))]
      .filter((lv) => lv > sourceLevel)
      .sort((a, b) => a - b);
    return levels.map((lv) => ({ value: lv, label: `${lv}级` }));
  }, [selectedSeriesRecipes, sourceLevel]);

  useEffect(() => {
    if (sourceLevelOptions.length === 0) {
      setSourceLevel(1);
      setTargetLevel(2);
      return;
    }
    if (!sourceLevelOptions.some((opt) => opt.value === sourceLevel)) {
      setSourceLevel(sourceLevelOptions[0].value);
    }
  }, [sourceLevel, sourceLevelOptions]);

  useEffect(() => {
    if (targetLevelOptions.length === 0) {
      setTargetLevel(Math.min(10, Math.max(2, sourceLevel + 1)));
      return;
    }
    if (!targetLevelOptions.some((opt) => opt.value === targetLevel)) {
      setTargetLevel(targetLevelOptions[0].value);
    }
  }, [sourceLevel, targetLevel, targetLevelOptions]);

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
      message.error((error as { message?: string }).message || '宝石合成失败');
    } finally {
      setSubmitting(false);
    }
  }, [message, onSuccess, refresh, selectedRecipe, times]);

  const handleBatch = useCallback(async () => {
    if (!selectedRecipe) return;
    setBatchSubmitting(true);
    try {
      const res = await synthesizeInventoryGemBatch({
        gemType,
        sourceLevel,
        targetLevel,
        seriesKey: selectedRecipe.seriesKey,
      });
      if (!res.success || !res.data) throw new Error(res.message || '批量宝石合成失败');
      const steps = res.data.steps ?? [];
      const successCount = steps.reduce((sum, step) => sum + (step.successCount || 0), 0);
      const failCount = steps.reduce((sum, step) => sum + (step.failCount || 0), 0);
      if (successCount > 0) {
        message.success(`${res.message || '批量合成成功'}（成功${successCount}次，失败${failCount}次）`);
      } else {
        message.warning(`${res.message || '批量合成失败'}（失败${failCount}次）`);
      }
      await onSuccess();
      await refresh();
    } catch (error: unknown) {
      message.error((error as { message?: string }).message || '批量宝石合成失败');
    } finally {
      setBatchSubmitting(false);
    }
  }, [gemType, message, onSuccess, refresh, selectedRecipe, sourceLevel, targetLevel]);

  const canSynthesize = !!selectedRecipe && selectedRecipe.maxSynthesizeTimes > 0;
  const canBatch = !!selectedRecipe && targetLevelOptions.length > 0 && !batchSubmitting;

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (submitting || batchSubmitting) return;
        onClose();
      }}
      footer={null}
      centered
      width={980}
      title="宝石合成"
      className="bag-gem-modal"
      destroyOnHidden
      maskClosable={!(submitting || batchSubmitting)}
    >
      <div className="bag-gem-shell">
        <div className="bag-gem-top">
          <Segmented
            value={gemType}
            options={(Object.keys(gemTypeLabel) as GemType[]).map((type) => ({
              label: gemTypeLabel[type],
              value: type,
            }))}
            onChange={(value) => {
              setGemType(value as GemType);
              setSelectedRecipeId('');
            }}
          />
          {wallet ? (
            <div className="bag-gem-wallet">
              <Tag color="gold">银两：{wallet.silver.toLocaleString()}</Tag>
              <Tag color="blue">灵石：{wallet.spiritStones.toLocaleString()}</Tag>
            </div>
          ) : null}
        </div>

        <div className="bag-gem-body">
          {loading && recipes.length === 0 ? (
            <div className="bag-gem-loading">
              <Spin />
            </div>
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
                        <span>成功率 {recipe.successRate}%</span>
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
                      <Tag color={selectedRecipe.successRate >= 100 ? 'green' : 'orange'}>成功率：{selectedRecipe.successRate}%</Tag>
                    </div>

                    <div className="bag-gem-costs">
                      <div className={`bag-gem-cost-line ${selectedRecipe.input.owned < selectedRecipe.input.qty ? 'is-missing' : ''}`}>
                        <span>{selectedRecipe.input.name}</span>
                        <span>{selectedRecipe.input.qty} / {selectedRecipe.input.owned}</span>
                      </div>
                      <div className={`bag-gem-cost-line ${(wallet?.silver ?? 0) < selectedRecipe.costs.silver ? 'is-missing' : ''}`}>
                        <span>银两</span>
                        <span>{selectedRecipe.costs.silver.toLocaleString()} / {(wallet?.silver ?? 0).toLocaleString()}</span>
                      </div>
                      <div className={`bag-gem-cost-line ${(wallet?.spiritStones ?? 0) < selectedRecipe.costs.spiritStones ? 'is-missing' : ''}`}>
                        <span>灵石</span>
                        <span>{selectedRecipe.costs.spiritStones.toLocaleString()} / {(wallet?.spiritStones ?? 0).toLocaleString()}</span>
                      </div>
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

                    <div className="bag-gem-batch">
                      <div className="bag-gem-batch-title">批量合成到目标等级</div>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
                        6级以上合成存在失败率，失败会损失本次投入的全部宝石材料。
                      </div>
                      <div className="bag-gem-batch-controls">
                        <Select
                          value={sourceLevel}
                          options={sourceLevelOptions}
                          onChange={(value) => setSourceLevel(Number(value) || 1)}
                          placeholder="起始等级"
                        />
                        <Select
                          value={targetLevel}
                          options={targetLevelOptions}
                          onChange={(value) => setTargetLevel(Number(value) || 2)}
                          placeholder="目标等级"
                        />
                        <Button
                          disabled={!canBatch}
                          loading={batchSubmitting}
                          onClick={() => void handleBatch()}
                        >
                          一键批量合成
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择配方" />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default GemSynthesisModal;
