/**
 * 装备自动洗炼控制 Hook
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一管理自动洗炼的目标状态、词条池预取、执行循环与结果回调，让桌面端和移动端只关心 UI。
 * - 做什么：把“自动洗炼能否开始”的判断集中在一个入口，避免两个组件各写一套禁用条件。
 * - 不做什么：不渲染具体控件、不决定桌面/移动端布局，也不自行刷新库存 UI。
 *
 * 输入/输出：
 * - 输入：当前装备、洗炼状态快照、角色资源、启用开关，以及成功后需要执行的刷新回调。
 * - 输出：自动洗炼目标选择状态、可用性、词条池预览控制器与执行函数。
 *
 * 数据流/状态流：
 * - 当前装备/洗炼状态 -> 本 Hook 计算目标选项与禁用态；
 * - 点击开始自动洗炼 -> 调用共享执行器 -> 成功后通知外层刷新库存与锁定索引。
 *
 * 关键边界条件与坑点：
 * 1) 词条池未就绪时必须禁止自动洗炼，否则目标下拉会只剩当前词条，用户会误以为目标池不完整。
 * 2) 自动洗炼中如果已经成功洗出若干次再失败，仍需刷新外层库存状态，否则界面会停留在旧词条。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  rerollInventoryAffixes,
  type AffixPoolPreviewResponse,
} from '../../../../services/api';
import { type BagItem, normalizeAffixLockIndexes } from './bagShared';
import {
  buildAutoRerollTargetOptions,
  getAffordableAutoRerollTimes,
  hasMatchedAutoRerollTargets,
  normalizeAutoRerollTargetKeys,
  runAutoRerollUntilMatch,
  type AutoRerollMatchMode,
} from './autoReroll';
import {
  AUTO_REROLL_FEATURE_DISABLED_MESSAGE,
  AUTO_REROLL_FEATURE_ENABLED,
} from './autoRerollFeature';
import { useAffixPoolPreview } from './useAffixPoolPreview';

type AutoRerollMessageApi = {
  success: (content: string) => void;
  warning: (content: string) => void;
  error: (content: string) => void;
};

interface AutoRerollStateSnapshot {
  affixes: NonNullable<BagItem['equip']>['affixes'];
  maxLockCount: number;
  lockIndexes: number[];
  rerollScrollQty: number;
  rerollScrollOwned: number;
  spiritStoneCost: number;
  silverCost: number;
}

interface UseAutoRerollControllerOptions {
  item: BagItem | null;
  rerollState: AutoRerollStateSnapshot | null;
  enabled: boolean;
  playerSilver: number;
  playerSpiritStones: number;
  messageApi: AutoRerollMessageApi;
  onLockIndexesChange: (lockIndexes: number[]) => void;
  onRerollCommitted: () => Promise<void>;
  onInventoryChanged: () => void;
}

type AutoRerollPoolPreviewData = NonNullable<AffixPoolPreviewResponse['data']> | null;

export const useAutoRerollController = ({
  item,
  rerollState,
  enabled,
  playerSilver,
  playerSpiritStones,
  messageApi,
  onLockIndexesChange,
  onRerollCommitted,
  onInventoryChanged,
}: UseAutoRerollControllerOptions): {
  autoRerollTargetKeys: string[];
  setAutoRerollTargetKeys: (targetKeys: string[]) => void;
  autoRerollMatchMode: AutoRerollMatchMode;
  setAutoRerollMatchMode: (mode: AutoRerollMatchMode) => void;
  autoRerollMaxAttempts: number;
  setAutoRerollMaxAttempts: (maxAttempts: number) => void;
  autoRerollSubmitting: boolean;
  autoRerollOptions: Array<{ key: string; label: string }>;
  autoRerollDisabled: boolean;
  poolPreviewOpen: boolean;
  poolPreviewLoading: boolean;
  poolPreviewData: AutoRerollPoolPreviewData;
  poolPreviewReady: boolean;
  poolPreviewErrorMessage: string;
  openPoolPreview: () => Promise<void>;
  closePoolPreview: () => void;
  handleAutoReroll: () => Promise<void>;
} => {
  const [autoRerollTargetKeys, setAutoRerollTargetKeys] = useState<string[]>([]);
  const [autoRerollMatchMode, setAutoRerollMatchMode] = useState<AutoRerollMatchMode>('all');
  const [autoRerollMaxAttempts, setAutoRerollMaxAttempts] = useState(50);
  const [autoRerollSubmitting, setAutoRerollSubmitting] = useState(false);
  const autoRerollFeatureEnabled = enabled && AUTO_REROLL_FEATURE_ENABLED;

  const {
    poolPreviewOpen,
    poolPreviewLoading,
    poolPreviewData,
    poolPreviewReady,
    poolPreviewErrorMessage,
    openPoolPreview,
    closePoolPreview,
  } = useAffixPoolPreview({
    itemId: item?.id ?? null,
    enabled: autoRerollFeatureEnabled,
    autoLoad: autoRerollFeatureEnabled,
  });

  useEffect(() => {
    setAutoRerollTargetKeys([]);
    setAutoRerollSubmitting(false);
  }, [item?.id]);

  const autoRerollOptions = useMemo(() => {
    return buildAutoRerollTargetOptions(
      poolPreviewData?.affixes ?? [],
      rerollState?.affixes ?? [],
    );
  }, [poolPreviewData?.affixes, rerollState?.affixes]);

  const normalizedTargetKeys = useMemo(() => {
    return normalizeAutoRerollTargetKeys(autoRerollTargetKeys);
  }, [autoRerollTargetKeys]);

  const autoRerollDisabled =
    !autoRerollFeatureEnabled ||
    autoRerollSubmitting ||
    !poolPreviewReady ||
    !rerollState ||
    rerollState.affixes.length <= 0 ||
    !!item?.locked ||
    normalizedTargetKeys.length <= 0;

  const handleAutoReroll = useCallback(async () => {
    if (!item || item.category !== 'equipment' || !item.equip) return;
    if (!rerollState || rerollState.affixes.length <= 0) return;
    if (!AUTO_REROLL_FEATURE_ENABLED) {
      messageApi.warning(AUTO_REROLL_FEATURE_DISABLED_MESSAGE);
      return;
    }

    if (!poolPreviewReady) {
      if (poolPreviewLoading) {
        messageApi.warning('词条池加载中，请稍后再试');
        return;
      }
      if (poolPreviewErrorMessage) {
        messageApi.warning(poolPreviewErrorMessage);
        return;
      }
      messageApi.warning('词条池尚未就绪，请稍后再试');
      return;
    }

    if (normalizedTargetKeys.length <= 0) {
      messageApi.warning('请先设置目标词条');
      return;
    }
    if (hasMatchedAutoRerollTargets(rerollState.affixes, normalizedTargetKeys, autoRerollMatchMode)) {
      messageApi.success('当前词条已满足目标，无需自动洗炼');
      return;
    }
    if (item.locked) {
      messageApi.warning('物品已锁定，无法自动洗炼');
      return;
    }

    const lockIndexes = normalizeAffixLockIndexes(
      rerollState.lockIndexes,
      rerollState.affixes.length,
    ).slice(0, rerollState.maxLockCount);
    const maxTimes = getAffordableAutoRerollTimes({
      rerollScrollOwned: rerollState.rerollScrollOwned,
      rerollScrollCost: rerollState.rerollScrollQty,
      spiritStoneOwned: playerSpiritStones,
      spiritStoneCost: rerollState.spiritStoneCost,
      silverOwned: playerSilver,
      silverCost: rerollState.silverCost,
      maxAttempts: autoRerollMaxAttempts,
    });

    if (maxTimes <= 0) {
      messageApi.warning('资源不足或最大次数不足，无法开始自动洗炼');
      return;
    }

    setAutoRerollSubmitting(true);
    try {
      const result = await runAutoRerollUntilMatch({
        itemId: item.id,
        lockIndexes,
        initialAffixes: rerollState.affixes,
        targetKeys: normalizedTargetKeys,
        matchMode: autoRerollMatchMode,
        maxAttempts: maxTimes,
        reroll: rerollInventoryAffixes,
      });

      onLockIndexesChange(
        normalizeAffixLockIndexes(
          result.latestLockIndexes,
          rerollState.affixes.length,
        ),
      );

      if (result.attempts > 0) {
        await onRerollCommitted();
        onInventoryChanged();
      }

      if (result.stopReason === 'matched') {
        if (result.attempts <= 0) {
          messageApi.success('当前词条已满足目标，无需自动洗炼');
          return;
        }
        messageApi.success(`自动洗炼完成，已命中目标词条（第${result.attempts}次）`);
        return;
      }

      if (result.stopReason === 'request_failed') {
        messageApi.warning(result.failureMessage);
        return;
      }

      messageApi.warning(`自动洗炼结束，达到最大尝试次数（${maxTimes}次）`);
    } finally {
      setAutoRerollSubmitting(false);
    }
  }, [
    autoRerollMatchMode,
    autoRerollMaxAttempts,
    item,
    messageApi,
    normalizedTargetKeys,
    onInventoryChanged,
    onLockIndexesChange,
    onRerollCommitted,
    playerSilver,
    playerSpiritStones,
    poolPreviewErrorMessage,
    poolPreviewLoading,
    poolPreviewReady,
    rerollState,
  ]);

  return {
    autoRerollTargetKeys,
    setAutoRerollTargetKeys,
    autoRerollMatchMode,
    setAutoRerollMatchMode,
    autoRerollMaxAttempts,
    setAutoRerollMaxAttempts,
    autoRerollSubmitting,
    autoRerollOptions,
    autoRerollDisabled,
    poolPreviewOpen,
    poolPreviewLoading,
    poolPreviewData,
    poolPreviewReady,
    poolPreviewErrorMessage,
    openPoolPreview,
    closePoolPreview,
    handleAutoReroll,
  };
};
