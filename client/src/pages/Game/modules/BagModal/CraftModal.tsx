import { App, Button, Empty, InputNumber, Modal, Segmented, Spin, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  executeInventoryCraftRecipe,
  getInventoryCraftRecipes,
  type InventoryCraftKind,
  type InventoryCraftRecipeDto,
} from '../../../../services/api';

type CraftKindFilter = InventoryCraftKind | 'all';

interface CraftModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  focusItemDefId?: string;
}

const kindLabel: Record<InventoryCraftKind, string> = {
  alchemy: '炼丹',
  smithing: '炼器',
  craft: '制作',
};

const clampTimes = (value: number, maxCraftTimes: number): number => {
  const safeMax = Math.max(1, Math.floor(maxCraftTimes || 1));
  if (!Number.isFinite(value)) return 1;
  return Math.min(safeMax, Math.max(1, Math.floor(value)));
};

const CraftModal: React.FC<CraftModalProps> = ({ open, onClose, onSuccess, focusItemDefId }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [kind, setKind] = useState<CraftKindFilter>('all');
  const [recipes, setRecipes] = useState<InventoryCraftRecipeDto[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [times, setTimes] = useState(1);
  const [character, setCharacter] = useState<{ realm: string; exp: number; silver: number; spiritStones: number } | null>(null);
  const selectedRecipeIdRef = useRef('');
  const prevRecipeIdRef = useRef<string>('');

  useEffect(() => {
    selectedRecipeIdRef.current = selectedRecipeId;
  }, [selectedRecipeId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getInventoryCraftRecipes();
      if (!res.success || !res.data) throw new Error(res.message || '加载配方失败');
      const nextRecipes = res.data.recipes || [];
      setRecipes(nextRecipes);
      setCharacter(res.data.character);

      const currentSelectedRecipeId = selectedRecipeIdRef.current;
      let nextSelected = currentSelectedRecipeId;
      const hasSelected = nextRecipes.some((x) => x.id === currentSelectedRecipeId);
      if (!hasSelected) {
        const focus = (focusItemDefId || '').trim();
        if (focus) {
          const byFocus = nextRecipes.find(
            (x) => x.product.itemDefId === focus || x.costs.items.some((c) => c.itemDefId === focus),
          );
          nextSelected = byFocus?.id || '';
        }
        if (!nextSelected) nextSelected = nextRecipes[0]?.id || '';
      }
      setSelectedRecipeId(nextSelected);

      const selected = nextRecipes.find((x) => x.id === nextSelected);
      setTimes(clampTimes(1, selected?.maxCraftTimes ?? 1));
    } catch (error: unknown) {
      message.error((error as { message?: string }).message || '加载配方失败');
      setRecipes([]);
      setCharacter(null);
      setSelectedRecipeId('');
      setTimes(1);
    } finally {
      setLoading(false);
    }
  }, [focusItemDefId, message]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const filteredRecipes = useMemo(() => {
    if (kind === 'all') return recipes;
    return recipes.filter((x) => x.craftKind === kind);
  }, [kind, recipes]);

  const selectedRecipe = useMemo(() => {
    if (!filteredRecipes.length) return null;
    const found = filteredRecipes.find((x) => x.id === selectedRecipeId);
    return found ?? filteredRecipes[0];
  }, [filteredRecipes, selectedRecipeId]);

  useEffect(() => {
    if (!selectedRecipe) return;
    // 仅在配方真正变化时调整次数
    if (selectedRecipe.id !== prevRecipeIdRef.current) {
      prevRecipeIdRef.current = selectedRecipe.id;
      setTimes((prev) => clampTimes(prev, selectedRecipe.maxCraftTimes));
    }
  }, [selectedRecipe]);

  const handleSelectRecipe = useCallback(
    (recipeId: string) => {
      if (recipeId === selectedRecipeId) return;
      setSelectedRecipeId(recipeId);
    },
    [selectedRecipeId],
  );

  const canCraftNow = !!selectedRecipe && selectedRecipe.craftable && selectedRecipe.maxCraftTimes > 0;
  const isInitialLoading = loading && recipes.length === 0;
  const executeCraft = useCallback(async () => {
    if (!selectedRecipe) return;
    const recipeTimes = clampTimes(times, selectedRecipe.maxCraftTimes);
    setSubmitting(true);
    try {
      const res = await executeInventoryCraftRecipe({ recipeId: selectedRecipe.id, times: recipeTimes });
      if (!res.success || !res.data) throw new Error(res.message || '炼制失败');
      if (res.data.successCount > 0) {
        const qty = res.data.produced?.qty ?? 0;
        message.success(`${res.message || '炼制完成'}：成功 ${res.data.successCount} 次${qty > 0 ? `，产出 ${qty}` : ''}`);
      } else {
        message.warning(res.message || '炼制失败');
      }
      await onSuccess();
      await refresh();
    } catch (error: unknown) {
      message.error((error as { message?: string }).message || '炼制失败');
    } finally {
      setSubmitting(false);
    }
  }, [message, onSuccess, refresh, selectedRecipe, times]);

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (submitting) return;
        onClose();
      }}
      footer={null}
      centered
      width={980}
      title="炼丹炼器"
      className="bag-craft-modal"
      destroyOnHidden
      maskClosable={!submitting}
    >
      <div className="bag-craft-shell">
        <div className="bag-craft-top">
          <Segmented
            value={kind}
            options={[
              { label: '全部', value: 'all' },
              { label: '炼丹', value: 'alchemy' },
              { label: '炼器', value: 'smithing' },
              { label: '制作', value: 'craft' },
            ]}
            onChange={(value) => {
              const next = (value as CraftKindFilter) || 'all';
              setKind(next);
            }}
          />
          {character ? (
            <div className="bag-craft-wallet">
              <Tag color="default">境界：{character.realm}</Tag>
              <Tag color="gold">银两：{character.silver.toLocaleString()}</Tag>
              <Tag color="blue">灵石：{character.spiritStones.toLocaleString()}</Tag>
              <Tag color="purple">修为：{character.exp.toLocaleString()}</Tag>
            </div>
          ) : null}
        </div>

        <div className="bag-craft-body">
          {isInitialLoading ? (
            <div className="bag-craft-loading">
              <Spin />
            </div>
          ) : (
            <>
              <div className="bag-craft-list">
                {filteredRecipes.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用配方" />
                ) : (
                  filteredRecipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      type="button"
                      className={`bag-craft-item ${selectedRecipe?.id === recipe.id ? 'is-active' : ''}`}
                      onClick={() => handleSelectRecipe(recipe.id)}
                    >
                      <div className="bag-craft-item-title">{recipe.name}</div>
                      <div className="bag-craft-item-meta">
                        <span>{kindLabel[recipe.craftKind]}</span>
                        <span>{recipe.product.name} ×{recipe.product.qty}</span>
                      </div>
                      <div className="bag-craft-item-meta">
                        <span>{recipe.craftable ? `可制作 ${recipe.maxCraftTimes}` : '不可制作'}</span>
                        <span>成功率 {recipe.successRate}%</span>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="bag-craft-detail">
                {selectedRecipe ? (
                  <div className="bag-craft-detail-content">
                    <div className="bag-craft-detail-title">{selectedRecipe.name}</div>
                    <div className="bag-craft-detail-meta">
                      <Tag color="blue">{kindLabel[selectedRecipe.craftKind]}</Tag>
                      <Tag color="default">产物：{selectedRecipe.product.name} ×{selectedRecipe.product.qty}</Tag>
                      <Tag color={selectedRecipe.requirements.realmMet ? 'green' : 'red'}>
                        境界需求：{selectedRecipe.requirements.realm || '无'}
                      </Tag>
                    </div>

                    <div className="bag-craft-costs">
                      <div className="bag-craft-cost-line">
                        <span>银两</span>
                        <span>{selectedRecipe.costs.silver.toLocaleString()}</span>
                      </div>
                      <div className="bag-craft-cost-line">
                        <span>灵石</span>
                        <span>{selectedRecipe.costs.spiritStones.toLocaleString()}</span>
                      </div>
                      <div className="bag-craft-cost-line">
                        <span>修为</span>
                        <span>{selectedRecipe.costs.exp.toLocaleString()}</span>
                      </div>
                      {selectedRecipe.costs.items.map((cost) => (
                        <div className={`bag-craft-cost-line ${cost.missing > 0 ? 'is-missing' : ''}`} key={cost.itemDefId}>
                          <span>{cost.itemName}</span>
                          <span>{cost.required} / {cost.owned}</span>
                        </div>
                      ))}
                    </div>

                    <div className="bag-craft-submit">
                      <div className="bag-craft-submit-input">
                        <span>次数</span>
                        <InputNumber
                          min={1}
                          max={Math.max(1, selectedRecipe.maxCraftTimes)}
                          value={times}
                          onChange={(value) => setTimes(clampTimes(Number(value || 1), selectedRecipe.maxCraftTimes))}
                        />
                        <span>最多 {selectedRecipe.maxCraftTimes}</span>
                      </div>
                      <Button
                        type="primary"
                        disabled={!canCraftNow || submitting}
                        loading={submitting}
                        onClick={() => void executeCraft()}
                      >
                        {canCraftNow ? '开始炼制' : '材料或境界不足'}
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
      </div>
    </Modal>
  );
};

export default CraftModal;
