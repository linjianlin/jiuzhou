/**
 * 腾讯云天御验证码票据校验服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：封装腾讯云天御 DescribeCaptchaResult API 调用，统一完成前端验证码票据的服务端二次校验。
 * 2. 做什么：把天御 SDK 初始化、请求参数组装、响应码判断收敛到单一模块，避免多个路由各自拼装 SDK 调用。
 * 3. 不做什么：不处理 HTTP 请求，不生成前端验证码，也不管理 Redis 状态。
 *
 * 输入/输出：
 * - 输入：前端回调返回的 ticket、randstr，以及用户 IP。
 * - 输出：校验通过时无返回；校验失败时抛 BusinessError。
 *
 * 数据流/状态流：
 * - 路由层从 req.body 提取 ticket/randstr、从 req.ip 获取用户 IP -> 调用本模块 -> SDK 请求天御 API -> 判断 CaptchaCode -> 通过或抛错。
 *
 * 关键边界条件与坑点：
 * 1. CaptchaCode === 1 表示验证通过，其他值均为失败；容灾票据（trerror_ 前缀）在 CaptchaCode === 21 时返回，业务侧应视为失败并要求重试。
 * 2. SDK client 采用模块级单例延迟初始化，避免 local 模式下因缺少天御配置而在 import 阶段就报错。
 */
import { captcha as tencentCaptcha } from 'tencentcloud-sdk-nodejs-captcha';

import { tencentCaptchaConfig } from '../config/captchaConfig.js';
import { BusinessError } from '../middleware/BusinessError.js';

const CaptchaClient = tencentCaptcha.v20190722.Client;
type CaptchaClientInstance = InstanceType<typeof CaptchaClient>;

let clientInstance: CaptchaClientInstance | null = null;

const getClient = (): CaptchaClientInstance => {
    if (clientInstance) {
        return clientInstance;
    }

    const { secretId, secretKey } = tencentCaptchaConfig;
    if (!secretId || !secretKey) {
        throw new BusinessError('天御验证码服务未正确配置');
    }

    clientInstance = new CaptchaClient({
        credential: { secretId, secretKey },
    });

    return clientInstance;
};

export interface TencentCaptchaVerifyInput {
    ticket: string;
    randstr: string;
    userIp: string;
}

/**
 * 校验天御验证码票据
 * 调用腾讯云 DescribeCaptchaResult 接口，CaptchaCode === 1 为通过，其余均抛 BusinessError
 */
export const verifyTencentCaptchaTicket = async (
    input: TencentCaptchaVerifyInput,
): Promise<void> => {
    const { appId, appSecretKey } = tencentCaptchaConfig;
    if (!appId || !appSecretKey) {
        throw new BusinessError('天御验证码服务未正确配置');
    }

    const client = getClient();
    const response = await client.DescribeCaptchaResult({
        CaptchaType: 9,
        Ticket: input.ticket,
        Randstr: input.randstr,
        UserIp: input.userIp,
        CaptchaAppId: appId,
        AppSecretKey: appSecretKey,
    });

    if (response.CaptchaCode !== 1) {
        throw new BusinessError(
            `验证码校验失败：${response.CaptchaMsg ?? '未知错误'}`,
        );
    }
};
