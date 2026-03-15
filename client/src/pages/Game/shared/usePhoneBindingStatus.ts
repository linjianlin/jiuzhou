import { useEffect, useReducer, useState } from 'react';
import {
  getPhoneBindingStatus,
  getUnifiedApiErrorMessage,
  type PhoneBindingStatusDto,
} from '../../../services/api';

/**
 * 手机号绑定状态共享 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中拉取并缓存账号手机号绑定状态，供玩家信息和坊市入口复用。
 * 2. 做什么：共享同一 inflight 请求，避免多个组件同时打开时重复请求状态接口。
 * 3. 不做什么：不负责绑定表单提交，也不决定某个业务场景的弹窗提示文案。
 *
 * 输入/输出：
 * - 输入：`enabled`，控制当前组件是否需要订阅手机号绑定状态。
 * - 输出：当前状态、加载态、错误信息和主动刷新方法。
 *
 * 数据流/状态流：
 * 组件挂载 -> 读取共享缓存或发起请求 -> 缓存状态广播 -> PlayerInfo / MarketModal 同步刷新。
 *
 * 关键边界条件与坑点：
 * 1. 状态是账号级共享数据，多个使用方必须共用一份缓存，否则绑定成功后会出现不同面板显示不一致。
 * 2. 读取失败时不能默认为“功能关闭”，否则会把真实配置错误误显示成正常状态。
 */

const SILENT_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;

let cachedStatus: PhoneBindingStatusDto | null = null;
let inflight: Promise<PhoneBindingStatusDto> | null = null;
const listeners = new Set<() => void>();

const emitStatusUpdated = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const loadPhoneBindingStatusInternal = async (forceRefresh: boolean): Promise<PhoneBindingStatusDto> => {
  if (!forceRefresh && cachedStatus) {
    return cachedStatus;
  }
  if (!forceRefresh && inflight) {
    return inflight;
  }

  inflight = (async () => {
    const response = await getPhoneBindingStatus(SILENT_REQUEST_CONFIG);
    if (!response.success || !response.data) {
      throw new Error(getUnifiedApiErrorMessage(response, '读取手机号绑定状态失败'));
    }
    cachedStatus = response.data;
    emitStatusUpdated();
    return response.data;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
};

export const invalidatePhoneBindingStatus = (): void => {
  cachedStatus = null;
  emitStatusUpdated();
};

export const loadPhoneBindingStatus = async (forceRefresh: boolean = false): Promise<PhoneBindingStatusDto> => {
  return loadPhoneBindingStatusInternal(forceRefresh);
};

export const usePhoneBindingStatus = (
  enabled: boolean = true,
): {
  status: PhoneBindingStatusDto | null;
  loading: boolean;
  errorMessage: string | null;
  refresh: () => Promise<PhoneBindingStatusDto>;
} => {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [loading, setLoading] = useState<boolean>(enabled && cachedStatus === null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setErrorMessage(null);
      return;
    }

    const unsubscribe = subscribe(() => rerender());
    setLoading(cachedStatus === null);
    setErrorMessage(null);
    void loadPhoneBindingStatusInternal(false)
      .then(() => {
        setLoading(false);
        setErrorMessage(null);
        rerender();
      })
      .catch((error) => {
        setLoading(false);
        setErrorMessage(getUnifiedApiErrorMessage(error, '读取手机号绑定状态失败'));
      });

    return unsubscribe;
  }, [enabled]);

  return {
    status: cachedStatus,
    loading,
    errorMessage,
    refresh: async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        const nextStatus = await loadPhoneBindingStatusInternal(true);
        setLoading(false);
        rerender();
        return nextStatus;
      } catch (error) {
        setLoading(false);
        const nextErrorMessage = getUnifiedApiErrorMessage(error, '读取手机号绑定状态失败');
        setErrorMessage(nextErrorMessage);
        throw new Error(nextErrorMessage);
      }
    },
  };
};
