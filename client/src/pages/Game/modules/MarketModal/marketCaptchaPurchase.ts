/**
 * 坊市购买错误码共享工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护坊市购买凭证失效与购买频控错误码，供物品坊市和伙伴坊市共用。
 * 2. 做什么：把购买错误码判断收敛到单一模块，避免不同按钮入口各自硬编码字符串。
 * 3. 不做什么：不发请求，不处理验证码 UI，也不维护购买重试状态。
 *
 * 输入/输出：
 * - 输入：服务端错误码。
 * - 输出：统一错误码常量与错误码判断函数。
 *
 * 数据流/状态流：
 * - 购买请求失败 -> UI 读取统一错误码 -> 决定是否刷新列表或展示提示。
 *
 * 关键边界条件与坑点：
 * 1. 错误码判断必须集中，否则物品坊市和伙伴坊市后续改码时容易出现一处改了另一处漏改。
 * 2. 本模块只保留仍在购买链路中使用的错误码，避免旧验证码补验协议残留。
 */
export const MARKET_BUY_TICKET_INVALID_ERROR_CODE = 'MARKET_BUY_TICKET_INVALID';
export const PARTNER_MARKET_BUY_TICKET_INVALID_ERROR_CODE = 'PARTNER_MARKET_BUY_TICKET_INVALID';
export const MARKET_BUY_RATE_LIMITED_ERROR_CODE = 'MARKET_BUY_RATE_LIMITED';
export const MARKET_BUY_COOLDOWN_ACTIVE_ERROR_CODE = 'MARKET_BUY_COOLDOWN_ACTIVE';

export const isPartnerMarketBuyTicketInvalidCode = (code: string | null): boolean => {
  return code === PARTNER_MARKET_BUY_TICKET_INVALID_ERROR_CODE;
};

export const isMarketBuyTicketInvalidCode = (code: string | null): boolean => {
  return code === MARKET_BUY_TICKET_INVALID_ERROR_CODE
    || code === PARTNER_MARKET_BUY_TICKET_INVALID_ERROR_CODE;
};

export const isMarketBuyAttemptLimitedCode = (code: string | null): boolean => {
  return code === MARKET_BUY_RATE_LIMITED_ERROR_CODE
    || code === MARKET_BUY_COOLDOWN_ACTIVE_ERROR_CODE;
};
