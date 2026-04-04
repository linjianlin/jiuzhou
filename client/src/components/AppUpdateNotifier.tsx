/**
 * 根部应用更新提示组件。
 *
 * 作用：
 * 1. 在 `AntdApp` 上下文内建立全局单例更新检测，只负责轮询远端版本清单并在发现新版本后提示用户刷新。
 * 2. 复用统一版本服务与共享比较规则，把“是否有新版本”收敛到根组件处理，避免业务页面各自开定时器。
 * 3. 不做什么：不展示常驻 UI、不参与业务路由切换、不处理登录状态，也不接管任何业务接口错误提示。
 *
 * 输入 / 输出：
 * - 输入：无外部 props；内部依赖当前构建版本、版本清单服务与 Ant Design modal 上下文。
 * - 输出：无可见节点；只在检测到新版本时弹出一次刷新确认框。
 *
 * 数据流 / 状态流：
 * 当前构建版本常量
 * -> 组件 mount 后建立低频轮询
 * -> 页面可见时拉取远端 `version.json`
 * -> 共享层比较版本指纹
 * -> 若变化则停止轮询并弹出刷新提示
 * -> 用户确认后刷新页面。
 *
 * 复用设计说明：
 * 1. 所有页面共享同一个根部轮询器，避免登录页、游戏页、设置页各自维护定时器造成重复请求。
 * 2. 版本比较与请求逻辑全部复用服务层/共享层，组件只承接生命周期和交互提示，职责边界清晰。
 * 3. 更新提示文案和轮询间隔来自常量层，后续调整提示策略只改一处即可覆盖所有场景。
 *
 * 关键边界条件与坑点：
 * 1. 已提示过新版本后必须立刻停止轮询，避免用户尚未刷新时持续收到重复弹窗。
 * 2. 页面处于后台标签页时不主动发起检测，只在回到前台后立即补一次，避免挂机场景产生无意义请求。
 */

import { App as AntdApp } from 'antd';
import { useEffect, useEffectEvent, useRef } from 'react';
import {
  APP_VERSION_POLL_INTERVAL_MS,
  APP_VERSION_REFRESH_MODAL_CONTENT,
  APP_VERSION_REFRESH_MODAL_TITLE,
} from '../constants/appVersion';
import { CURRENT_APP_VERSION_META, fetchLatestAppVersionMeta } from '../services/appVersion';
import { hasAppVersionChanged } from '../shared/appVersionShared';

const AppUpdateNotifier: React.FC = () => {
  const { modal } = AntdApp.useApp();
  const hasPromptedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const inflightControllerRef = useRef<AbortController | null>(null);

  const clearPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const checkForUpdate = useEffectEvent(async () => {
    if (import.meta.env.DEV || hasPromptedRef.current || document.visibilityState !== 'visible') {
      return;
    }

    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;

    try {
      const latestVersion = await fetchLatestAppVersionMeta(Date.now().toString(36), controller.signal);
      if (!hasAppVersionChanged(CURRENT_APP_VERSION_META, latestVersion)) {
        return;
      }

      hasPromptedRef.current = true;
      clearPolling();

      modal.confirm({
        title: APP_VERSION_REFRESH_MODAL_TITLE,
        content: APP_VERSION_REFRESH_MODAL_CONTENT,
        centered: true,
        maskClosable: false,
        closable: false,
        okText: '立即刷新',
        cancelText: '稍后刷新',
        onOk: () => {
          window.location.reload();
          return Promise.resolve();
        },
      });
    } catch {
      return;
    } finally {
      if (inflightControllerRef.current === controller) {
        inflightControllerRef.current = null;
      }
    }
  });

  useEffect(() => {
    if (import.meta.env.DEV) {
      return undefined;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkForUpdate();
      }
    };

    timerRef.current = window.setInterval(() => {
      void checkForUpdate();
    }, APP_VERSION_POLL_INTERVAL_MS);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void checkForUpdate();

    return () => {
      clearPolling();
      inflightControllerRef.current?.abort();
      inflightControllerRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkForUpdate]);

  return null;
};

export default AppUpdateNotifier;
