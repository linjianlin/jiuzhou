/**
 * 坊市购买共享计算
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一坊市购买弹窗、桌面列表按钮、移动端卡片按钮的数量规范化与总价计算。
 * 2. 做什么：把“是否需要自定义数量输入”的规则收敛到一个入口，避免多个交互入口各写一套判断。
 * 3. 不做什么：不负责接口请求、不持有 React 状态、不拼接消息提示。
 *
 * 输入/输出：
 * - 输入：挂单数量、草稿购买数量、单价。
 * - 输出：规范后的购买数量、本次总价、确认按钮文案。
 *
 * 数据流/状态流：
 * - UI 事件输入 -> 本模块规范化 -> 组件展示摘要/提交购买 -> 父组件调用 API。
 *
 * 关键边界条件与坑点：
 * 1. 前端可以夹紧非法输入，但服务端仍需再次校验；这里的规范化只用于稳定交互，不是安全边界。
 * 2. `listingQty <= 1` 时必须保持一键购买体验，不能平白多弹一个输入框增加操作成本。
 */

const normalizeListingQty = (listingQty: number): number => {
  if (!Number.isFinite(listingQty)) return 1;
  return Math.max(1, Math.floor(listingQty));
};

const normalizeUnitPrice = (unitPrice: number): number => {
  if (!Number.isFinite(unitPrice)) return 0;
  return Math.max(0, Math.floor(unitPrice));
};

export const shouldPromptMarketBuyQuantity = (listingQty: number): boolean => {
  return normalizeListingQty(listingQty) > 1;
};

export const clampMarketBuyQuantity = (
  draftQty: number,
  listingQty: number,
): number => {
  const maxQty = normalizeListingQty(listingQty);
  if (!Number.isFinite(draftQty)) return 1;
  return Math.max(1, Math.min(maxQty, Math.floor(draftQty)));
};

export const buildMarketBuySummary = (params: {
  listingQty: number;
  draftQty: number;
  unitPrice: number;
}): {
  buyQty: number;
  totalPrice: number;
  confirmLabel: string;
} => {
  const buyQty = clampMarketBuyQuantity(params.draftQty, params.listingQty);
  const totalPrice = normalizeUnitPrice(params.unitPrice) * buyQty;
  return {
    buyQty,
    totalPrice,
    confirmLabel: buyQty > 1 ? `购买×${buyQty}` : '购买',
  };
};
