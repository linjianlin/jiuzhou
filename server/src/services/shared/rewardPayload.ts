/**
 * 通用奖励载荷共享工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义“可配置奖励载荷”的类型、归一化、预览与发奖映射，供兑换码、邮件附件等多条链路复用。
 * 2. 做什么：把历史奖励字段的兼容读取收口到单一模块，避免 mail / redeemCode / webhook 各写一套兼容分支。
 * 3. 不做什么：不直接写数据库、不执行真实发奖，也不处理 UI 文案。
 *
 * 输入/输出：
 * - 输入：原始奖励对象、旧字段邮件附件、或规范化后的奖励载荷。
 * - 输出：规范奖励载荷、发奖器入参、以及可安全展示的奖励预览列表。
 *
 * 数据流/状态流：
 * webhook / 兑换码 / 邮件服务 -> 本模块归一化 -> 主线发奖器 / 邮件列表展示。
 *
 * 关键边界条件与坑点：
 * 1. 历史数据兼容只能在这里做，调用方一律只消费规范化后的结构，避免 fallback 逻辑向业务层扩散。
 * 2. 预览列表只描述“领取前可展示的奖励”，不会提前模拟功能解锁的副作用伙伴发放。
 */
import { getTechniqueDefinitions } from '../staticConfigLoader.js';
import { resolveRewardItemDisplayMeta } from './rewardDisplay.js';
import { asArray, asNumber, asString } from './typeCoercion.js';
import type { RewardResult } from '../mainQuest/types.js';

export type GrantedRewardItemPayload = {
  itemDefId: string;
  quantity: number;
  itemName?: string;
  itemIcon?: string | null;
};

export type GrantedRewardPayload = {
  exp?: number;
  silver?: number;
  spiritStones?: number;
  items?: GrantedRewardItemPayload[];
  techniques?: string[];
  titles?: string[];
  unlockFeatures?: string[];
};

export type GrantedRewardPreviewResult = Exclude<
  RewardResult,
  | { type: 'chapter_exp' }
  | { type: 'chapter_silver' }
  | { type: 'chapter_spirit_stones' }
  | { type: 'partner' }
>;

const normalizeStringList = (raw: unknown): string[] => {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const row of asArray<unknown>(raw)) {
    const value = asString(row).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  return list;
};

const normalizeGrantedRewardItems = (raw: unknown): GrantedRewardItemPayload[] => {
  const normalized: GrantedRewardItemPayload[] = [];
  for (const row of asArray<unknown>(raw)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const source = row as Record<string, unknown>;
    const itemDefId = asString(source.itemDefId ?? source.item_def_id).trim();
    const quantity = Math.max(0, Math.floor(asNumber(source.quantity ?? source.qty, 0)));
    if (!itemDefId || quantity <= 0) continue;
    const itemName = asString(source.itemName ?? source.item_name).trim();
    const itemIcon = asString(source.itemIcon ?? source.item_icon).trim();
    normalized.push({
      itemDefId,
      quantity,
      ...(itemName ? { itemName } : {}),
      ...(itemIcon ? { itemIcon } : {}),
    });
  }
  return normalized;
};

export const normalizeGrantedRewardPayload = (raw: unknown): GrantedRewardPayload => {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const exp = Math.max(0, Math.floor(asNumber(source.exp, 0)));
  const silver = Math.max(0, Math.floor(asNumber(source.silver, 0)));
  const spiritStones = Math.max(
    0,
    Math.floor(asNumber(source.spiritStones ?? source.spirit_stones, 0)),
  );
  const items = normalizeGrantedRewardItems(source.items);
  const techniques = normalizeStringList(source.techniques);
  const titles = normalizeStringList([
    ...asArray<unknown>(source.titles),
    source.title,
  ]);
  const unlockFeatures = normalizeStringList(
    source.unlockFeatures ?? source.unlock_features,
  );

  return {
    ...(exp > 0 ? { exp } : {}),
    ...(silver > 0 ? { silver } : {}),
    ...(spiritStones > 0 ? { spiritStones } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(techniques.length > 0 ? { techniques } : {}),
    ...(titles.length > 0 ? { titles } : {}),
    ...(unlockFeatures.length > 0 ? { unlockFeatures } : {}),
  };
};

export const hasGrantedRewardPayload = (payload: GrantedRewardPayload): boolean => {
  return Boolean(
    (payload.exp && payload.exp > 0)
      || (payload.silver && payload.silver > 0)
      || (payload.spiritStones && payload.spiritStones > 0)
      || (payload.items && payload.items.length > 0)
      || (payload.techniques && payload.techniques.length > 0)
      || (payload.titles && payload.titles.length > 0)
      || (payload.unlockFeatures && payload.unlockFeatures.length > 0),
  );
};

export const buildGrantRewardsInput = (payload: GrantedRewardPayload): {
  exp?: number;
  silver?: number;
  spirit_stones?: number;
  items?: Array<{ item_def_id: string; quantity: number }>;
  techniques?: string[];
  titles?: string[];
  unlock_features?: string[];
} => {
  return {
    ...(payload.exp && payload.exp > 0 ? { exp: payload.exp } : {}),
    ...(payload.silver && payload.silver > 0 ? { silver: payload.silver } : {}),
    ...(payload.spiritStones && payload.spiritStones > 0
      ? { spirit_stones: payload.spiritStones }
      : {}),
    ...(payload.items && payload.items.length > 0
      ? {
          items: payload.items.map((item) => ({
            item_def_id: item.itemDefId,
            quantity: item.quantity,
          })),
        }
      : {}),
    ...(payload.techniques && payload.techniques.length > 0
      ? { techniques: [...payload.techniques] }
      : {}),
    ...(payload.titles && payload.titles.length > 0
      ? { titles: [...payload.titles] }
      : {}),
    ...(payload.unlockFeatures && payload.unlockFeatures.length > 0
      ? { unlock_features: [...payload.unlockFeatures] }
      : {}),
  };
};

export const buildGrantedRewardPreview = (
  payload: GrantedRewardPayload,
): GrantedRewardPreviewResult[] => {
  const rewards: GrantedRewardPreviewResult[] = [];

  if (payload.exp && payload.exp > 0) {
    rewards.push({ type: 'exp', amount: payload.exp });
  }
  if (payload.silver && payload.silver > 0) {
    rewards.push({ type: 'silver', amount: payload.silver });
  }
  if (payload.spiritStones && payload.spiritStones > 0) {
    rewards.push({ type: 'spirit_stones', amount: payload.spiritStones });
  }
  for (const item of payload.items ?? []) {
    const meta = resolveRewardItemDisplayMeta(item.itemDefId);
    const itemName = asString(item.itemName).trim() || meta.name || undefined;
    const itemIcon = asString(item.itemIcon).trim() || meta.icon || undefined;
    rewards.push({
      type: 'item',
      itemDefId: item.itemDefId,
      quantity: item.quantity,
      itemName,
      itemIcon,
    });
  }
  for (const techniqueId of payload.techniques ?? []) {
    const definition = getTechniqueDefinitions().find(
      (entry) => entry.id === techniqueId && entry.enabled !== false,
    );
    rewards.push({
      type: 'technique',
      techniqueId,
      techniqueName: asString(definition?.name) || undefined,
      techniqueIcon: asString(definition?.icon) || undefined,
    });
  }
  for (const title of payload.titles ?? []) {
    rewards.push({ type: 'title', title });
  }
  for (const featureCode of payload.unlockFeatures ?? []) {
    rewards.push({ type: 'feature_unlock', featureCode });
  }

  return rewards;
};
