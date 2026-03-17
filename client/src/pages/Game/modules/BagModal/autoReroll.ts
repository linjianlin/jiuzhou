import type { AffixPoolPreviewAffixEntry, InventoryRerolledAffixDto } from '../../../../services/api';
import type { EquipmentAffix } from './bagShared';

/**
 * 自动洗炼目标工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一处理“目标词条选项构建”“词条命中判定”“自动洗炼可执行次数估算”，供桌面/移动端复用，避免两端各写一套同逻辑。
 * - 不做什么：不直接发起网络请求、不管理 UI 状态、不处理提示文案。
 *
 * 输入/输出（参数/返回值/props）：
 * - buildAutoRerollTargetOptions(poolAffixes, currentAffixes) => AutoRerollTargetOption[]
 * - hasMatchedAutoRerollTargets(affixes, targetKeys) => boolean
 * - getAffordableAutoRerollTimes(input) => number
 *
 * 数据流/状态流（从哪来、怎么变、到哪去）：
 * - 输入来自背包页面的“词条池预览 + 当前装备词条 + 资源余量”。
 * - 在此模块内被标准化为 key 集合与次数数字。
 * - 输出回到桌面/移动端组件，用于渲染选择器、决定何时停止自动洗炼。
 *
 * 关键边界条件与坑点：
 * 1) 词条 key 可能为空字符串：统一 trim 后过滤，避免出现“空目标永远匹配”的假阳性。
 * 2) cost 可能为 0：按 Infinity 处理该资源约束，避免除零报错导致自动洗炼中断。
 */

export type AutoRerollTargetOption = {
  key: string;
  label: string;
};

const normalizeAffixKey = (value: string | undefined): string => value?.trim() ?? '';

const buildOptionLabel = (name: string | undefined, key: string): string => {
  const nameText = name?.trim() ?? '';
  if (!nameText) return key;
  return `${nameText}（${key}）`;
};

export const buildAutoRerollTargetOptions = (
  poolAffixes: AffixPoolPreviewAffixEntry[],
  currentAffixes: EquipmentAffix[],
): AutoRerollTargetOption[] => {
  const optionMap = new Map<string, AutoRerollTargetOption>();

  for (const affix of poolAffixes) {
    const key = normalizeAffixKey(affix.key);
    if (!key) continue;
    optionMap.set(key, {
      key,
      label: buildOptionLabel(affix.name, key),
    });
  }

  for (const affix of currentAffixes) {
    const key = normalizeAffixKey(affix.key);
    if (!key || optionMap.has(key)) continue;
    optionMap.set(key, {
      key,
      label: buildOptionLabel(affix.name, key),
    });
  }

  return [...optionMap.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
};

export const hasMatchedAutoRerollTargets = (
  affixes: Array<InventoryRerolledAffixDto | EquipmentAffix>,
  targetKeys: string[],
): boolean => {
  if (targetKeys.length <= 0) return false;
  const currentKeys = new Set(
    affixes
      .map((affix) => normalizeAffixKey(affix.key))
      .filter((key) => key.length > 0),
  );
  return targetKeys.every((targetKey) => currentKeys.has(normalizeAffixKey(targetKey)));
};

export const getAffordableAutoRerollTimes = (input: {
  rerollScrollOwned: number;
  rerollScrollCost: number;
  spiritStoneOwned: number;
  spiritStoneCost: number;
  silverOwned: number;
  silverCost: number;
  maxAttempts: number;
}): number => {
  const resolveTimesByCost = (owned: number, cost: number): number => {
    if (cost <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(Math.max(0, owned) / cost);
  };

  const limits = [
    resolveTimesByCost(input.rerollScrollOwned, input.rerollScrollCost),
    resolveTimesByCost(input.spiritStoneOwned, input.spiritStoneCost),
    resolveTimesByCost(input.silverOwned, input.silverCost),
    Math.max(0, Math.floor(input.maxAttempts)),
  ];

  return Math.max(0, Math.min(...limits));
};
