/**
 * 宗门商店面板。
 * 输入：商品列表、当前贡献、兑换动作。
 * 输出：可兑换商品卡片与贡献消耗提示。
 * 边界：贡献不足时按钮禁用，显示“贡献不足”。
 */
import { Button, InputNumber } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { SectShopItemDto } from '../../../../../services/api';
import { resolveIcon } from '../../BagModal/bagShared';
import { SECT_SHOP_BATCH_BUY_INPUT_MAX } from '../constants';

interface ShopPanelProps {
  loading: boolean;
  myContribution: number;
  shopItems: SectShopItemDto[];
  actionLoadingKey: string | null;
  onBuy: (itemId: string, quantity: number) => void;
}

/**
 * 商店名称去重：当名称末尾已经包含“xN / ×N”数量后缀时，移除该后缀，
 * 避免与“数量 xN”标签重复展示。
 */
const normalizeShopItemName = (name: string, qty: number): string => {
  const trimmed = name.trim();
  const qtyText = String(Math.max(0, Math.floor(qty)));
  const suffixPattern = new RegExp(`\\s*[xX×]\\s*${qtyText}$`);
  const cleaned = trimmed.replace(suffixPattern, '').trim();
  return cleaned || trimmed;
};

/**
 * 将后端字段归一化为“每天最多可兑换次数”。
 * 约定：
 * 1) <= 0 或非法值 = 不限购；
 * 2) 限购存在时，前端输入上限仍会再叠加本地批量输入上限。
 */
const resolveDailyLimit = (rawLimit: number | undefined): number => {
  if (!Number.isFinite(rawLimit)) return 0;
  const safe = Math.floor(rawLimit as number);
  if (safe <= 0) return 0;
  return safe;
};

/**
 * 计算当前可兑换次数上限。
 * 输入：个人贡献、单次兑换消耗、每日限购（0 表示不限）。
 * 输出：本次请求允许提交的最大 quantity（>=0）。
 */
const calcMaxBuyCount = (myContribution: number, costContribution: number, dailyLimit: number): number => {
  const maxByContribution =
    costContribution > 0 ? Math.max(0, Math.floor(myContribution / costContribution)) : SECT_SHOP_BATCH_BUY_INPUT_MAX;
  const maxByDailyLimit = dailyLimit > 0 ? Math.max(0, dailyLimit) : SECT_SHOP_BATCH_BUY_INPUT_MAX;
  return Math.max(0, Math.min(SECT_SHOP_BATCH_BUY_INPUT_MAX, maxByContribution, maxByDailyLimit));
};

const clampBuyCount = (value: number, maxCount: number): number => {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(maxCount, Math.floor(value)));
};

const normalizeUnitQty = (qty: number): number => {
  if (!Number.isFinite(qty)) return 1;
  return Math.max(1, Math.floor(qty));
};

/**
 * 提取物品占位图标字符：
 * 跳过常见的前缀符号（如《、[、( 等），获取第一个有效的文字字符。
 */
const getItemPlaceholder = (name: string): string => {
  const cleaned = name.replace(/^[《\[\(\s"'【「]+/, '');
  return (cleaned.charAt(0) || name.charAt(0) || '?').toUpperCase();
};

const ShopPanel: React.FC<ShopPanelProps> = ({ loading, myContribution, shopItems, actionLoadingKey, onBuy }) => {
  const [buyCountMap, setBuyCountMap] = useState<Record<string, number>>({});

  /**
   * 当商品列表或贡献变化时，重新夹紧各商品的批量兑换输入。
   * 这样可保证：
   * 1) 贡献减少后不会保留一个超上限旧值；
   * 2) 商品下线后自动清理无效键，避免状态膨胀。
   */
  useEffect(() => {
    setBuyCountMap((prev) => {
      const next: Record<string, number> = {};
      for (const item of shopItems) {
        const dailyLimit = resolveDailyLimit(item.limitDaily);
        const maxCount = calcMaxBuyCount(myContribution, item.costContribution, dailyLimit);
        if (maxCount <= 1) continue;
        next[item.id] = clampBuyCount(prev[item.id] ?? 1, maxCount);
      }

      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      const same =
        prevKeys.length === nextKeys.length &&
        nextKeys.every((key) => Object.prototype.hasOwnProperty.call(prev, key) && prev[key] === next[key]);
      return same ? prev : next;
    });
  }, [myContribution, shopItems]);

  const updateBuyCount = useCallback((itemId: string, nextValue: number, maxCount: number) => {
    setBuyCountMap((prev) => {
      const safeValue = clampBuyCount(nextValue, maxCount);
      if (prev[itemId] === safeValue) return prev;
      return { ...prev, [itemId]: safeValue };
    });
  }, []);

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门商店</div>
          <div className="sect-subtitle">消耗个人贡献兑换宗门专属物资。</div>
        </div>
      </div>

      <div className="sect-pane-body sect-panel-scroll">
        <div className="sect-shop-balance">
          <div className="sect-shop-balance-k">当前贡献</div>
          <div className="sect-shop-balance-v">{myContribution.toLocaleString()}</div>
        </div>

        {loading ? <div className="sect-empty">商店加载中...</div> : null}
        {!loading && shopItems.length === 0 ? <div className="sect-empty">暂无可兑换商品</div> : null}

        <div className="sect-shop-grid">
          {shopItems.map((item) => {
            const unitQty = normalizeUnitQty(item.qty);
            const loadingKey = `shop-buy-${item.id}`;
            const isLoading = actionLoadingKey === loadingKey;
            const dailyLimit = resolveDailyLimit(item.limitDaily);
            const maxBuyCount = calcMaxBuyCount(myContribution, item.costContribution, dailyLimit);
            const affordable = maxBuyCount >= 1;
            const canBatchBuy = maxBuyCount > 1;
            const buyCount = canBatchBuy ? clampBuyCount(buyCountMap[item.id] ?? 1, maxBuyCount) : 1;
            const displayName = normalizeShopItemName(item.name, unitQty);
            const iconUrl = resolveIcon({ icon: item.itemIcon ?? null });
            const costTotal = item.costContribution * buyCount;

            return (
              <div key={item.id} className={`sect-shop-card ${!affordable ? 'is-unaffordable' : ''}`}>
                <div className="sect-shop-card-content">
                  <div className="sect-shop-item-icon">
                    <img 
                      src={iconUrl} 
                      alt={displayName} 
                      onError={(e) => {
                        // 如果图片加载失败，隐藏图片并显示占位文字（通过父级样式或 JS 控制）
                        (e.target as HTMLImageElement).style.display = 'none';
                        const parent = (e.target as HTMLElement).parentElement;
                        if (parent) {
                          const span = document.createElement('span');
                          span.innerText = getItemPlaceholder(displayName);
                          parent.appendChild(span);
                        }
                      }}
                    />
                  </div>
                  <div className="sect-shop-item-info">
                    <div className="sect-shop-item-name">{displayName}</div>
                    <div className="sect-shop-item-meta">
                      <span className="sect-shop-qty">数量 x{unitQty}</span>
                      {dailyLimit > 0 && (
                        <span className="sect-shop-limit">每日限购 {dailyLimit}</span>
                      )}
                    </div>
                  </div>
                  {canBatchBuy ? (
                    <div className="sect-shop-batch" aria-label="兑换次数">
                      <InputNumber
                        size="small"
                        mode="spinner"
                        min={1}
                        max={maxBuyCount}
                        value={buyCount}
                        className="sect-shop-batch-input"
                        disabled={!affordable || isLoading}
                        onChange={(value) => {
                          if (typeof value !== 'number') return;
                          updateBuyCount(item.id, value, maxBuyCount);
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="sect-shop-card-footer">
                  <div className="sect-shop-price">
                    <span className="sect-shop-price-label">消耗</span>
                    <div className="sect-shop-price-main">
                      <span className={`sect-shop-price-value ${!affordable ? 'is-shortage' : ''}`}>
                        {costTotal.toLocaleString()} 贡献
                      </span>
                    </div>
                  </div>
                  <div className="sect-shop-actions">
                    <Button
                      size="small"
                      type="primary"
                      disabled={!affordable}
                      loading={isLoading}
                      onClick={() => {
                        if (!affordable) return;
                        void onBuy(item.id, buyCount);
                      }}
                    >
                      {!affordable ? '贡献不足' : buyCount > 1 ? `兑换×${buyCount}` : '兑换'}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ShopPanel;
