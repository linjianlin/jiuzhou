import { useEffect, useReducer } from 'react';
import { getGameItemTaxonomy } from '../../../services/api';
import { applyGameItemTaxonomy } from './itemTaxonomy';

/**
 * 全局分类字典加载 Hook
 *
 * 作用：
 * - 按需拉取后端权威 taxonomy，并应用到前端共享字典。
 * - 通过订阅通知触发使用方重渲染，让各模块读取到最新分类口径。
 *
 * 输入/输出：
 * - 输入：`enabled` 控制是否在当前组件场景下触发加载。
 * - 输出：`taxonomyReady` 与 `reloadTaxonomy`，供调用方感知/主动刷新。
 *
 * 数据流/状态流：
 * - 组件挂载 -> ensure 加载（去重并发）-> apply -> 广播更新。
 * - 组件卸载 -> 解除订阅。
 *
 * 关键边界条件与坑点：
 * 1) 多处同时打开（背包/坊市/设置）会并发触发加载，必须共享同一 inflight Promise 防止重复请求。
 * 2) 拉取失败时保留当前字典（通常是默认基线），不清空已生效分类，避免 UI 突然失去选项。
 */

let taxonomyReady = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emitTaxonomyUpdated = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const ensureGameItemTaxonomyLoaded = async (): Promise<void> => {
  if (taxonomyReady) return;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await getGameItemTaxonomy();
    if (!res?.success || !res.data?.taxonomy) return;
    applyGameItemTaxonomy(res.data.taxonomy);
    taxonomyReady = true;
    emitTaxonomyUpdated();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
};

export const loadGameItemTaxonomy = async (): Promise<void> => {
  await ensureGameItemTaxonomyLoaded();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useGameItemTaxonomy = (enabled: boolean = true): {
  taxonomyReady: boolean;
  reloadTaxonomy: () => Promise<void>;
} => {
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribe(() => rerender());
    void ensureGameItemTaxonomyLoaded().then(() => {
      rerender();
    });
    return unsubscribe;
  }, [enabled]);

  return {
    taxonomyReady,
    reloadTaxonomy: async () => {
      taxonomyReady = false;
      await loadGameItemTaxonomy();
      rerender();
    },
  };
};
