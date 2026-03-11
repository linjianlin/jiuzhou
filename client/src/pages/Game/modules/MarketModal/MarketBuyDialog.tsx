/**
 * 坊市购买弹窗
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承接坊市自定义数量购买的统一 UI，供桌面列表、移动卡片与移动预览抽屉共用。
 * 2. 做什么：展示挂单摘要、购买数量输入、本次总价与确认按钮文案。
 * 3. 不做什么：不直接调用接口；提交动作完全交给父组件。
 *
 * 输入/输出：
 * - 输入：弹窗开关、当前挂单、确认/取消回调。
 * - 输出：标准 Ant Design Modal，确认时把规范后的购买数量回传给父组件。
 *
 * 数据流/状态流：
 * - 父组件设置 `open + listing` -> 本组件维护本地草稿数量 -> 共享计算函数生成摘要 -> 用户确认 -> 回调父组件发请求。
 *
 * 关键边界条件与坑点：
 * 1. 当挂单切换或弹窗重新打开时，草稿数量必须重置为 1，避免沿用上一次输入误购。
 * 2. 输入框允许临时清空，但最终提交前必须通过共享函数夹紧回合法范围。
 */

import { InputNumber, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { getItemQualityMeta } from '../../shared/itemQuality';
import {
  buildMarketBuySummary,
  clampMarketBuyQuantity,
} from './marketBuyShared';

export interface MarketBuyDialogListing {
  name: string;
  icon: string;
  quality: string;
  qty: number;
  unitPrice: number;
  seller: string;
}

interface MarketBuyDialogProps {
  open: boolean;
  listing: MarketBuyDialogListing | null;
  onCancel: () => void;
  onConfirm: (qty: number) => void;
}

const MarketBuyDialog: React.FC<MarketBuyDialogProps> = ({
  open,
  listing,
  onCancel,
  onConfirm,
}) => {
  const [draftQty, setDraftQty] = useState(1);

  useEffect(() => {
    if (!open || !listing) return;
    setDraftQty(1);
  }, [listing, open]);

  if (!listing) return null;

  const summary = buildMarketBuySummary({
    listingQty: listing.qty,
    draftQty,
    unitPrice: listing.unitPrice,
  });
  const qualityClassName = getItemQualityMeta(listing.quality)?.className ?? '';

  return (
    <Modal
      open={open}
      title="购买物品"
      onCancel={onCancel}
      onOk={() => onConfirm(summary.buyQty)}
      okText={summary.confirmLabel}
      cancelText="取消"
      width={420}
      className="market-buy-dialog"
      destroyOnHidden
    >
      <div className="market-buy-dialog__body">
        <div className="market-buy-dialog__item">
          <img
            className={`market-buy-dialog__icon ${qualityClassName}`}
            src={listing.icon}
            alt={listing.name}
          />
          <div className="market-buy-dialog__meta">
            <div className="market-buy-dialog__name">{listing.name}</div>
            <div className="market-buy-dialog__seller">卖家：{listing.seller}</div>
          </div>
        </div>

        <div className="market-buy-dialog__grid">
          <div className="market-buy-dialog__label">挂单数量</div>
          <div className="market-buy-dialog__value">{listing.qty}</div>

          <div className="market-buy-dialog__label">单价</div>
          <div className="market-buy-dialog__value">
            {listing.unitPrice.toLocaleString()} 灵石
          </div>

          <div className="market-buy-dialog__label">购买数量</div>
          <InputNumber<number>
            min={1}
            max={listing.qty}
            value={summary.buyQty}
            className="market-buy-dialog__input"
            onChange={(value) => {
              if (typeof value !== 'number') {
                setDraftQty(1);
                return;
              }
              setDraftQty(clampMarketBuyQuantity(value, listing.qty));
            }}
          />

          <div className="market-buy-dialog__label">本次总价</div>
          <div className="market-buy-dialog__value market-buy-dialog__value--price">
            {summary.totalPrice.toLocaleString()} 灵石
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default MarketBuyDialog;
