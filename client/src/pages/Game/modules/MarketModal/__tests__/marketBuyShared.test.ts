import { describe, expect, it } from 'vitest';
import {
  buildMarketBuySummary,
  clampMarketBuyQuantity,
  shouldPromptMarketBuyQuantity,
} from '../marketBuyShared';

describe('marketBuyShared', () => {
  it('所有合法挂单购买都需要先弹出确认框', () => {
    expect(shouldPromptMarketBuyQuantity(1)).toBe(true);
    expect(shouldPromptMarketBuyQuantity(2)).toBe(true);
  });

  it('购买数量应被夹紧在合法区间内', () => {
    expect(clampMarketBuyQuantity(0, 8)).toBe(1);
    expect(clampMarketBuyQuantity(3, 8)).toBe(3);
    expect(clampMarketBuyQuantity(12, 8)).toBe(8);
  });

  it('摘要应返回规范后的购买数量、本次总价与按钮文案', () => {
    expect(
      buildMarketBuySummary({
        listingQty: 9,
        draftQty: 12,
        unitPrice: 88,
      }),
    ).toStrictEqual({
      buyQty: 9,
      totalPrice: 792,
      confirmLabel: '购买×9',
    });

    expect(
      buildMarketBuySummary({
        listingQty: 1,
        draftQty: 1,
        unitPrice: 88,
      }),
    ).toStrictEqual({
      buyQty: 1,
      totalPrice: 88,
      confirmLabel: '购买',
    });
  });
});
