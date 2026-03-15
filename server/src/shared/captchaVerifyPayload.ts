/**
 * 验证码请求体解析工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一解析并校验登录、注册、坊市验证码提交时共用的验证码字段，支持 local（captchaId/captchaCode）和 tencent（ticket/randstr）两种模式。
 * 2. 做什么：把"字段必填 + 去空格"的路由层规则收敛到单一入口，避免每个验证码接口都复制一份参数判断。
 * 3. 不做什么：不生成验证码，不校验验证码答案，也不处理具体业务成功后的后续动作。
 *
 * 输入/输出：
 * - 输入：包含验证码字段的请求体对象。
 * - 输出：根据当前 provider 返回对应的解析结果（local 或 tencent）。
 *
 * 数据流/状态流：
 * - 路由层读取 `req.body` -> 本模块根据 captchaProvider 解析对应字段 -> 调用对应验证码服务校验。
 *
 * 关键边界条件与坑点：
 * 1. 两种模式的字段完全不同，local 用 captchaId/captchaCode，tencent 用 ticket/randstr，解析函数按 provider 分流，不做混合兼容。
 * 2. 统一在这里 trim，可以避免登录和坊市接口对空白字符出现不同口径。
 *
 * 复用说明：
 * - parseCaptchaVerifyPayload 被 authRoutes、accountRoutes、marketRoutes 三处复用，是 local 模式的唯一解析入口。
 * - parseTencentCaptchaVerifyPayload 被同样三处复用，是 tencent 模式的唯一解析入口。
 */
import { BusinessError } from '../middleware/BusinessError.js';

export interface CaptchaVerifyPayloadLike {
  captchaId?: string;
  captchaCode?: string;
}

export interface ParsedCaptchaVerifyPayload {
  captchaId: string;
  captchaCode: string;
}

export const parseCaptchaVerifyPayload = (
  payload: CaptchaVerifyPayloadLike,
): ParsedCaptchaVerifyPayload => {
  const captchaId = payload.captchaId?.trim() ?? '';
  const captchaCode = payload.captchaCode?.trim() ?? '';

  if (!captchaId || !captchaCode) {
    throw new BusinessError('图片验证码不能为空');
  }

  return { captchaId, captchaCode };
};

export interface TencentCaptchaVerifyPayloadLike {
  ticket?: string;
  randstr?: string;
}

export interface ParsedTencentCaptchaVerifyPayload {
  ticket: string;
  randstr: string;
}

export const parseTencentCaptchaVerifyPayload = (
  payload: TencentCaptchaVerifyPayloadLike,
): ParsedTencentCaptchaVerifyPayload => {
  const ticket = payload.ticket?.trim() ?? '';
  const randstr = payload.randstr?.trim() ?? '';

  if (!ticket || !randstr) {
    throw new BusinessError('验证码票据不能为空');
  }

  return { ticket, randstr };
};
