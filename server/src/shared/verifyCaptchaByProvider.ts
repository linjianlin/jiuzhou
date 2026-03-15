/**
 * 验证码校验调度器（按 provider 分流）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：根据当前 CAPTCHA_PROVIDER 环境变量，统一调度 local 图片验证码校验或腾讯云天御票据校验，避免每个路由各自写 if/else 分支。
 * 2. 做什么：把"解析请求体 + 调用对应校验服务"的完整流程收敛到单一函数，供 authRoutes、accountRoutes、marketRoutes 复用。
 * 3. 不做什么：不生成验证码，不处理 HTTP 响应，也不管理 Redis 状态。
 *
 * 输入/输出：
 * - 输入：请求体对象（包含 local 或 tencent 的验证码字段）、用户 IP、验证码场景。
 * - 输出：校验通过时无返回；校验失败时抛 BusinessError。
 *
 * 数据流/状态流：
 * - 路由层传入 req.body 和 req.ip -> 本模块按 provider 解析对应字段 -> 调用 local captchaService 或 tencent captchaService -> 通过或抛错。
 *
 * 关键边界条件与坑点：
 * 1. tencent 模式下不需要 captchaId/captchaCode，local 模式下不需要 ticket/randstr，两套字段互不干扰。
 * 2. userIp 在 tencent 模式下是必需的（天御 API 要求），从 Express req.ip 获取；local 模式下忽略。
 *
 * 复用说明：
 * - 被 authRoutes（登录/注册）、accountRoutes（手机绑定发码）、marketRiskService（坊市验证码校验）三处复用。
 */
import { isTencentCaptchaProvider } from '../config/captchaConfig.js';
import { verifyCaptcha, type CaptchaScene } from '../services/captchaService.js';
import { verifyTencentCaptchaTicket } from '../services/tencentCaptchaService.js';
import {
    parseCaptchaVerifyPayload,
    parseTencentCaptchaVerifyPayload,
    type CaptchaVerifyPayloadLike,
    type TencentCaptchaVerifyPayloadLike,
} from './captchaVerifyPayload.js';

type CaptchaRequestBody = CaptchaVerifyPayloadLike & TencentCaptchaVerifyPayloadLike;

export interface VerifyCaptchaByProviderInput {
    body: CaptchaRequestBody;
    userIp: string;
    scene?: CaptchaScene;
}

export const verifyCaptchaByProvider = async (
    input: VerifyCaptchaByProviderInput,
): Promise<void> => {
    if (isTencentCaptchaProvider) {
        const { ticket, randstr } = parseTencentCaptchaVerifyPayload(input.body);
        await verifyTencentCaptchaTicket({ ticket, randstr, userIp: input.userIp });
    } else {
        const { captchaId, captchaCode } = parseCaptchaVerifyPayload(input.body);
        await verifyCaptcha(captchaId, captchaCode, input.scene);
    }
};
