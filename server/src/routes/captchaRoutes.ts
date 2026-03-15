/**
 * 验证码公共配置路由
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供一个无需鉴权的端点，让前端获取当前验证码提供方类型和天御 CaptchaAppId，以决定渲染图片验证码还是天御弹窗。
 * 2. 做什么：把"前端需要知道的验证码配置"收敛到单一端点，避免前端硬编码 provider 或在多个接口里各自返回配置。
 * 3. 不做什么：不生成验证码，不校验验证码，也不暴露 AppSecretKey 等服务端密钥。
 *
 * 输入/输出：
 * - 输入：无（GET 请求，无参数）。
 * - 输出：`{ provider: 'local' | 'tencent', tencentAppId?: number }`。
 *
 * 数据流/状态流：
 * - 前端页面加载 -> 请求 /api/captcha/config -> 拿到 provider 和 appId -> 决定验证码 UI 模式。
 *
 * 关键边界条件与坑点：
 * 1. 此端点不需要鉴权，因为验证码配置是公开信息（CaptchaAppId 本身就嵌在前端 JS 里），不暴露密钥。
 * 2. tencentAppId 只在 provider === 'tencent' 时有意义，local 模式下前端应忽略该字段。
 */
import { Router } from 'express';

import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../middleware/response.js';
import {
    captchaProvider,
    tencentCaptchaConfig,
} from '../config/captchaConfig.js';

const router = Router();

router.get(
    '/config',
    asyncHandler(async (_req, res) => {
        sendSuccess(res, {
            provider: captchaProvider,
            ...(captchaProvider === 'tencent'
                ? { tencentAppId: tencentCaptchaConfig.appId }
                : {}),
        });
    }),
);

export default router;
