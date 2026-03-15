/**
 * 验证码提供方配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中读取验证码相关环境变量，统一导出验证码提供方类型与腾讯云天御配置，供 captchaService 和路由层复用。
 * 2. 做什么：把"当前用哪种验证码"的判断收敛到单一模块，避免多个服务/路由各自读 process.env 再做分支。
 * 3. 不做什么：不生成验证码，不校验验证码，也不处理 HTTP 请求。
 *
 * 输入/输出：
 * - 输入：环境变量 CAPTCHA_PROVIDER、TENCENT_CAPTCHA_APP_ID、TENCENT_CAPTCHA_APP_SECRET_KEY、TENCENT_CAPTCHA_SECRET_ID、TENCENT_CAPTCHA_SECRET_KEY。
 * - 输出：验证码提供方类型常量、腾讯云天御配置对象。
 *
 * 数据流/状态流：
 * - 进程启动 -> dotenv 加载 .env -> 本模块读取并导出配置 -> captchaService / 路由层按需引用。
 *
 * 关键边界条件与坑点：
 * 1. CAPTCHA_PROVIDER 默认为 'local'，只有显式设为 'tencent' 时才启用天御；拼写错误会静默回退到 local，这是有意为之，避免配置错误导致验证码完全不可用。
 * 2. 天御模式下四个配置项缺一不可，但本模块只负责读取，校验由 tencentCaptchaService 在首次调用时执行，避免 local 模式下因缺少天御配置而启动失败。
 */
import dotenv from 'dotenv';

dotenv.config();

export type CaptchaProvider = 'local' | 'tencent';

const rawProvider = (process.env.CAPTCHA_PROVIDER ?? 'local').trim().toLowerCase();

export const captchaProvider: CaptchaProvider =
    rawProvider === 'tencent' ? 'tencent' : 'local';

/**
 * 腾讯云天御验证码配置
 * - appId / appSecretKey：验证码控制台的 CaptchaAppId 和 AppSecretKey，用于票据校验
 * - secretId / secretKey：腾讯云 API 密钥，用于 SDK 鉴权
 */
export const tencentCaptchaConfig = {
    appId: Number(process.env.TENCENT_CAPTCHA_APP_ID ?? '0'),
    appSecretKey: process.env.TENCENT_CAPTCHA_APP_SECRET_KEY ?? '',
    secretId: process.env.TENCENT_CAPTCHA_SECRET_ID ?? '',
    secretKey: process.env.TENCENT_CAPTCHA_SECRET_KEY ?? '',
} as const;

export const isTencentCaptchaProvider = captchaProvider === 'tencent';
