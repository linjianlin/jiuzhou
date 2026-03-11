/**
 * 坊市挂单购买共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一计算坊市挂单在创建、购买、下架三个阶段的数量与金额规则。
 * 2. 做什么：为 `marketService` 提供无副作用的纯函数，避免同类数量/退款逻辑散落在多个分支里。
 * 3. 不做什么：不做数据库查询、不拼接 SQL、不返回 HTTP/业务文案。
 *
 * 输入/输出：
 * - 输入：购买数量、挂单数量、单价、原始手续费、原始挂单数量、剩余数量。
 * - 输出：合法购买数量、成交总价、上架手续费、按比例退款金额。
 *
 * 数据流/状态流：
 * - route/service 解析参数 -> 本模块统一计算 -> service 执行 SQL 与状态更新。
 *
 * 关键边界条件与坑点：
 * 1. 服务端购买数量不能静默夹紧，非法数量必须返回 `null`，由业务层显式拒绝，避免玩家传大数时被偷偷改成可购买数量。
 * 2. 手续费退款必须按剩余比例向下取整，且总退款不能超过原始手续费；因此 `remainingQty <= 0` 统一返回 `0n`。
 */

const MARKET_LISTING_FEE_SILVER_PER_SPIRIT_STONE = 5n;

export const normalizeMarketBuyQuantity = (
  requestedQty: number,
  listingQty: number,
): number | null => {
  if (!Number.isInteger(requestedQty) || requestedQty <= 0) return null;
  if (!Number.isInteger(listingQty) || listingQty <= 0) return null;
  if (requestedQty > listingQty) return null;
  return requestedQty;
};

export const calculateMarketTradeTotalPrice = (
  unitPriceSpiritStones: bigint,
  qty: number,
): bigint => {
  if (unitPriceSpiritStones <= 0n) return 0n;
  if (!Number.isInteger(qty) || qty <= 0) return 0n;
  return unitPriceSpiritStones * BigInt(qty);
};

export const calculateMarketListingFeeSilver = (
  totalPriceSpiritStones: bigint,
): bigint => {
  if (totalPriceSpiritStones <= 0n) return 0n;
  return totalPriceSpiritStones * MARKET_LISTING_FEE_SILVER_PER_SPIRIT_STONE;
};

export const calculateMarketListingRefundFee = (
  listingFeeSilver: bigint,
  originalQty: number,
  remainingQty: number,
): bigint => {
  if (listingFeeSilver <= 0n) return 0n;
  if (!Number.isInteger(originalQty) || originalQty <= 0) return 0n;
  if (!Number.isInteger(remainingQty) || remainingQty <= 0) return 0n;
  if (remainingQty >= originalQty) return listingFeeSilver;
  return (listingFeeSilver * BigInt(remainingQty)) / BigInt(originalQty);
};
