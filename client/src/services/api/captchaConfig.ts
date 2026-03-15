/**
 * 验证码配置 API
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：从服务端获取当前验证码提供方配置（local / tencent），供前端验证码组件决定渲染图片验证码还是天御弹窗。
 * 2. 做什么：集中定义验证码配置的类型与请求函数，避免多个组件各自拼接请求。
 * 3. 不做什么：不缓存配置，不渲染 UI，也不处理验证码校验逻辑。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：`CaptchaConfigResponse`，包含 provider 和天御 appId。
 *
 * 数据流/状态流：
 * - 前端组件挂载 -> 调用 getCaptchaConfig -> 拿到 provider -> 决定验证码 UI 模式。
 *
 * 关键边界条件与坑点：
 * 1. 此接口无需鉴权，可在登录页加载时调用。
 * 2. tencentAppId 只在 provider === 'tencent' 时有意义，local 模式下前端应忽略。
 *
 * 复用说明：
 * - 被 useCaptchaConfig Hook 消费，Hook 再被 AuthCaptchaField、MarketCaptchaDialog、PhoneBindingCaptcha 等组件复用。
 */
import api from './core';

export type CaptchaProvider = 'local' | 'tencent';

export interface CaptchaConfig {
    provider: CaptchaProvider;
    tencentAppId?: number;
}

export interface CaptchaConfigResponse {
    success: boolean;
    data: CaptchaConfig;
}

export const getCaptchaConfig = (): Promise<CaptchaConfigResponse> => {
    return api.get('/captcha/config');
};
