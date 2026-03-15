/**
 * 验证码配置缓存 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在应用生命周期内只请求一次 /api/captcha/config，缓存验证码提供方配置，供所有验证码组件复用。
 * 2. 做什么：把"请求配置 + 缓存 + 加载态"的逻辑收敛到单一 Hook，避免 AuthCaptchaField 和 MarketCaptchaDialog 各自请求。
 * 3. 不做什么：不渲染 UI，不处理验证码校验，也不管理验证码输入状态。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：当前验证码配置、加载态、是否为天御模式的便捷判断。
 *
 * 数据流/状态流：
 * - 首次调用 -> 请求 /api/captcha/config -> 缓存到模块级变量 -> 后续调用直接返回缓存。
 *
 * 关键边界条件与坑点：
 * 1. 使用模块级 Promise 缓存而非 React state，确保多个组件同时挂载时只发一次请求。
 * 2. 请求失败时回退到 local 模式，保证验证码功能不会因配置接口异常而完全不可用。
 */
import { useEffect, useState } from 'react';

import {
    getCaptchaConfig,
    type CaptchaConfig,
    type CaptchaProvider,
} from '../../services/api/captchaConfig';

const DEFAULT_CONFIG: CaptchaConfig = { provider: 'local' };

let cachedConfig: CaptchaConfig | null = null;
let configPromise: Promise<CaptchaConfig> | null = null;

const loadConfig = (): Promise<CaptchaConfig> => {
    if (cachedConfig) {
        return Promise.resolve(cachedConfig);
    }

    if (!configPromise) {
        configPromise = getCaptchaConfig()
            .then((res) => {
                cachedConfig = res.data;
                return cachedConfig;
            })
            .catch(() => {
                cachedConfig = DEFAULT_CONFIG;
                return cachedConfig;
            });
    }

    return configPromise;
};

export interface UseCaptchaConfigResult {
    config: CaptchaConfig;
    loading: boolean;
    provider: CaptchaProvider;
    isTencent: boolean;
}

export const useCaptchaConfig = (): UseCaptchaConfigResult => {
    const [config, setConfig] = useState<CaptchaConfig>(
        cachedConfig ?? DEFAULT_CONFIG,
    );
    const [loading, setLoading] = useState(cachedConfig === null);

    useEffect(() => {
        if (cachedConfig) {
            setConfig(cachedConfig);
            setLoading(false);
            return;
        }

        void loadConfig().then((result) => {
            setConfig(result);
            setLoading(false);
        });
    }, []);

    return {
        config,
        loading,
        provider: config.provider,
        isTencent: config.provider === 'tencent',
    };
};
