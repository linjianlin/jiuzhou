/**
 * 腾讯云天御验证码调用 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：封装天御 JS SDK 的动态加载、TencentCaptcha 实例创建与回调处理，返回统一的 ticket/randstr 结果。
 * 2. 做什么：把"加载 SDK 脚本 + 创建实例 + 处理回调 + 错误处理"的流程收敛到单一 Hook，供 AuthCaptchaField 和 MarketCaptchaDialog 复用。
 * 3. 不做什么：不渲染 UI，不提交票据到服务端，也不管理表单状态。
 *
 * 输入/输出：
 * - 输入：天御 CaptchaAppId。
 * - 输出：触发验证码弹窗的函数、SDK 加载状态。
 *
 * 数据流/状态流：
 * - 调用 triggerCaptcha -> 确保 SDK 已加载 -> new TencentCaptcha -> show() -> 用户完成验证 -> 回调返回 ticket/randstr -> resolve Promise。
 *
 * 关键边界条件与坑点：
 * 1. SDK 脚本使用模块级 Promise 缓存，确保多次调用只加载一次，避免重复插入 <script> 标签。
 * 2. 用户主动关闭验证码弹窗（ret === 2）时 reject，调用方需区分"用户取消"和"验证失败"。
 *
 * 复用说明：
 * - 被 AuthCaptchaField（登录/注册）和 MarketCaptchaDialog（坊市验证码）复用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const TENCENT_CAPTCHA_JS_URL = 'https://turing.captcha.qcloud.com/TJCaptcha.js';

let sdkLoadPromise: Promise<void> | null = null;

const ensureSdkLoaded = (): Promise<void> => {
    if (typeof TencentCaptcha !== 'undefined') {
        return Promise.resolve();
    }

    if (!sdkLoadPromise) {
        sdkLoadPromise = new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = TENCENT_CAPTCHA_JS_URL;
            script.onload = () => { resolve(); };
            script.onerror = () => { reject(new Error('天御验证码 SDK 加载失败')); };
            document.head.appendChild(script);
        });
    }

    return sdkLoadPromise;
};

export interface TencentCaptchaTicket {
    ticket: string;
    randstr: string;
}

export interface UseTencentCaptchaResult {
    /** 触发天御验证码弹窗，返回 ticket/randstr；用户取消时 reject */
    triggerCaptcha: () => Promise<TencentCaptchaTicket>;
    /** SDK 是否正在加载 */
    sdkLoading: boolean;
}

export const useTencentCaptcha = (appId: number): UseTencentCaptchaResult => {
    const [sdkLoading, setSdkLoading] = useState(false);
    const appIdRef = useRef(appId);

    useEffect(() => {
        appIdRef.current = appId;
    }, [appId]);

    const triggerCaptcha = useCallback((): Promise<TencentCaptchaTicket> => {
        setSdkLoading(true);

        return ensureSdkLoaded()
            .then(() => {
                setSdkLoading(false);
                return new Promise<TencentCaptchaTicket>((resolve, reject) => {
                    const captcha = new TencentCaptcha(
                        String(appIdRef.current),
                        (result) => {
                            if (result.ret === 0 && result.ticket) {
                                resolve({ ticket: result.ticket, randstr: result.randstr });
                            } else if (result.ret === 2) {
                                reject(new Error('用户取消验证'));
                            } else {
                                reject(
                                    new Error(result.errorMessage ?? '验证码校验失败'),
                                );
                            }
                        },
                        { userLanguage: 'zh-cn' },
                    );
                    captcha.show();
                });
            })
            .catch((error: Error) => {
                setSdkLoading(false);
                throw error;
            });
    }, []);

    return { triggerCaptcha, sdkLoading };
};
