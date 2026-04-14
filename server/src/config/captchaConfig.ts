/**
 * 验证码提供方配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中读取验证码相关环境变量，统一导出公共验证码与坊市购买专用腾讯验证码配置，供 captchaService 和路由层复用。
 * 2. 做什么：把"当前用哪种验证码"与"坊市购买是否启用独立腾讯验证码"的判断收敛到单一模块，避免多个服务/路由各自读 process.env 再做分支。
 * 3. 不做什么：不生成验证码，不校验验证码，也不处理 HTTP 请求。
 *
 * 输入/输出：
 * - 输入：环境变量 CAPTCHA_PROVIDER、TENCENT_CAPTCHA_*、MARKET_PURCHASE_TENCENT_CAPTCHA_*。
 * - 输出：验证码提供方类型常量、公共腾讯云天御配置对象、坊市购买专用腾讯云天御配置对象。
 *
 * 数据流/状态流：
 * - 进程启动 -> dotenv 加载 .env -> 本模块读取并导出配置 -> captchaService / 路由层按需引用。
 *
 * 关键边界条件与坑点：
 * 1. CAPTCHA_PROVIDER 默认为 'local'，只有显式设为 'tencent' 时才启用天御；拼写错误会静默回退到 local，这是有意为之，避免配置错误导致验证码完全不可用。
 * 2. 坊市购买专用验证码只单独切 AppId / AppSecretKey，默认复用同一套腾讯云 API 凭据，避免把 auth 与 market 的业务场景重新耦合到同一 CaptchaAppId。
 */
import dotenv from 'dotenv';

dotenv.config();

export type CaptchaProvider = 'local' | 'tencent';

export interface TencentCaptchaRuntimeConfig {
    appId: number;
    appSecretKey: string;
    secretId: string;
    secretKey: string;
}

const rawProvider = (process.env.CAPTCHA_PROVIDER ?? 'local').trim().toLowerCase();

export const captchaProvider: CaptchaProvider =
    rawProvider === 'tencent' ? 'tencent' : 'local';

/**
 * 腾讯云天御验证码配置
 * - appId / appSecretKey：验证码控制台的 CaptchaAppId 和 AppSecretKey，用于票据校验
 * - secretId / secretKey：腾讯云 API 密钥，用于 SDK 鉴权
 */
const sharedTencentCaptchaSecretId = process.env.TENCENT_CAPTCHA_SECRET_ID ?? '';
const sharedTencentCaptchaSecretKey = process.env.TENCENT_CAPTCHA_SECRET_KEY ?? '';

export const tencentCaptchaConfig: TencentCaptchaRuntimeConfig = {
    appId: Number(process.env.TENCENT_CAPTCHA_APP_ID ?? '0'),
    appSecretKey: process.env.TENCENT_CAPTCHA_APP_SECRET_KEY ?? '',
    secretId: sharedTencentCaptchaSecretId,
    secretKey: sharedTencentCaptchaSecretKey,
};

/**
 * 坊市购买专用腾讯云天御验证码配置。
 * 仅拆分业务场景对应的 CaptchaAppId / AppSecretKey，腾讯云 API 凭据默认与全局验证码复用。
 */
export const marketPurchaseTencentCaptchaConfig: TencentCaptchaRuntimeConfig = {
    appId: Number(process.env.MARKET_PURCHASE_TENCENT_CAPTCHA_APP_ID ?? '0'),
    appSecretKey: process.env.MARKET_PURCHASE_TENCENT_CAPTCHA_APP_SECRET_KEY ?? '',
    secretId: sharedTencentCaptchaSecretId,
    secretKey: sharedTencentCaptchaSecretKey,
};

export const isTencentCaptchaProvider = captchaProvider === 'tencent';

export const isMarketPurchaseTencentCaptchaEnabled = marketPurchaseTencentCaptchaConfig.appId > 0
    && marketPurchaseTencentCaptchaConfig.appSecretKey.trim().length > 0;
