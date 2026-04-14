/**
 * 坊市购买专用验证码配置 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：读取并缓存坊市购买专用腾讯验证码配置，供购买按钮在点击时决定是否允许拉起腾讯验证码。
 * 2. 做什么：把“请求配置 + 缓存 + 加载态”收敛到单一 Hook，避免物品购买与伙伴购买各自重复请求。
 * 3. 不做什么：不渲染 UI，不处理验证码票据，也不兼容登录/注册的公共验证码配置。
 *
 * 输入 / 输出：
 * - 输入：`enabled`，控制当前是否需要读取坊市购买配置。
 * - 输出：坊市购买配置、加载态。
 *
 * 数据流 / 状态流：
 * - 首次启用 -> 请求 `/api/market/captcha/config` -> 缓存到模块级变量 -> 后续按钮点击直接复用。
 *
 * 复用设计说明：
 * - 物品坊市与伙伴坊市共享同一份配置缓存，避免同一弹层内重复请求。
 * - 与公共 `useCaptchaConfig` 分离，确保 auth/绑手机与坊市购买的配置边界独立。
 *
 * 关键边界条件与坑点：
 * 1. 这里采用 fail-closed 语义：配置接口失败时默认 `enabled=false`，避免配置异常时静默放行购买。
 * 2. 只有 `enabled=true` 且 `tencentAppId` 有效时才允许购买按钮继续拉起验证码。
 */
import { useEffect, useState } from 'react';

import {
  getMarketPurchaseCaptchaConfig,
  type MarketPurchaseCaptchaConfig,
} from '../../../../services/api/captchaConfig';

const DEFAULT_CONFIG: MarketPurchaseCaptchaConfig = { enabled: false };

let cachedConfig: MarketPurchaseCaptchaConfig | null = null;
let configPromise: Promise<MarketPurchaseCaptchaConfig> | null = null;

const loadConfig = (): Promise<MarketPurchaseCaptchaConfig> => {
  if (cachedConfig) {
    return Promise.resolve(cachedConfig);
  }
  if (!configPromise) {
    configPromise = getMarketPurchaseCaptchaConfig()
      .then((response) => {
        cachedConfig = response.data;
        return cachedConfig;
      })
      .catch(() => {
        cachedConfig = DEFAULT_CONFIG;
        return cachedConfig;
      });
  }
  return configPromise;
};

export interface UseMarketPurchaseCaptchaConfigResult {
  config: MarketPurchaseCaptchaConfig;
  loading: boolean;
}

export const useMarketPurchaseCaptchaConfig = (
  enabled: boolean = true,
): UseMarketPurchaseCaptchaConfigResult => {
  const [config, setConfig] = useState<MarketPurchaseCaptchaConfig>(cachedConfig ?? DEFAULT_CONFIG);
  const loading = enabled && cachedConfig === null;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (cachedConfig) {
      setConfig(cachedConfig);
      return;
    }

    let cancelled = false;
    void loadConfig().then((result) => {
      if (cancelled) {
        return;
      }
      setConfig(result);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return {
    config: enabled && cachedConfig !== null ? cachedConfig : config,
    loading,
  };
};
