/**
 * 坊市购买专用腾讯验证码守卫
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在坊市购买路由内直接校验购买按钮前置获取的腾讯验证码票据，确保验证码与本次购买请求同一次提交。
 * 2. 做什么：把物品坊市与伙伴坊市的票据解析、IP 读取、服务端校验统一收敛到单一中间件，避免两条购买路由重复拼装。
 * 3. 不做什么：不签发 buyTicket，不处理购买频控，也不执行真实交易逻辑。
 *
 * 输入 / 输出：
 * - 输入：已注入 `req.userId` 的请求、请求体中的 `ticket/randstr`、以及规范化后的请求 IP。
 * - 输出：校验通过时进入后续购买链；失败时抛业务错误。
 *
 * 数据流 / 状态流：
 * - 购买按钮前置拉起腾讯验证码 -> 前端把 `ticket/randstr` 随 buy 请求提交 -> 本中间件即时校验 -> next()/抛错。
 *
 * 复用设计说明：
 * - 物品坊市与伙伴坊市复用同一中间件，统一“只验证购买按钮”的后端入口。
 * - 票据字段解析复用共享 `parseTencentCaptchaVerifyPayload`，避免不同业务场景出现不同的空值判断口径。
 *
 * 关键边界条件与坑点：
 * 1. 必须放在 `requireCharacter` 与 buyTicket 守卫之后执行，确保购买请求上下文已完整。
 * 2. 天御校验依赖真实请求 IP，不能用空字符串降级放行。
 */
import type { RequestHandler } from 'express';

import { isMarketPurchaseTencentCaptchaEnabled } from '../config/captchaConfig.js';
import { parseTencentCaptchaVerifyPayload } from '../shared/captchaVerifyPayload.js';
import { resolveRequestIp } from '../shared/requestIp.js';
import { verifyMarketPurchaseTencentCaptchaTicket } from '../services/tencentCaptchaService.js';

export const requireMarketPurchaseTencentCaptcha: RequestHandler = async (
  req,
  _res,
  next,
) => {
  if (!isMarketPurchaseTencentCaptchaEnabled) {
    next();
    return;
  }

  const { ticket, randstr } = parseTencentCaptchaVerifyPayload((req.body ?? {}) as {
    ticket?: string;
    randstr?: string;
  });

  await verifyMarketPurchaseTencentCaptchaTicket({
    ticket,
    randstr,
    userIp: resolveRequestIp(req),
  });
  next();
};
