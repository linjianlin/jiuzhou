/**
 * 邮件领取货币同步模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析邮件领取返回里的银两/灵石奖励，并生成可直接写回全局角色状态的货币补丁，避免单封领取与批量领取各自维护一套累加逻辑。
 * 2. 做什么：把“货币增量提取”“多次领取增量合并”“角色货币补丁生成”收口到同一模块，降低后续新增邮件领取入口时的重复修改面。
 * 3. 不做什么：不发请求、不直接操作 socket，也不处理物品/经验等非货币奖励展示。
 *
 * 输入/输出：
 * - 输入：邮件领取接口返回的奖励数组、或多次领取累积出的货币增量、或当前角色的货币快照。
 * - 输出：标准化的货币增量对象，以及可直接传给 `gameSocket.updateCharacterLocal` 的货币补丁。
 *
 * 数据流/状态流：
 * 邮件领取响应 -> `collectMailClaimCurrencyDelta` -> 批量/单封增量合并 -> `buildMailClaimCharacterCurrencyPatch` -> Game 头部读取的全局角色状态。
 *
 * 关键边界条件与坑点：
 * 1. 邮件奖励里可能混有物品、经验、伙伴等类型，这里只允许银两/灵石进入货币同步，避免把非货币奖励误写进角色状态。
 * 2. 批量领取会连续触发多次单封领取请求，因此必须先合并全部货币增量，再统一生成补丁，避免多处散落手写加法。
 */

import type { GrantedRewardResultDto } from '../../../../services/reward';

export interface MailClaimCurrencyDelta {
  silver: number;
  spiritStones: number;
}

export interface MailCharacterCurrencySnapshot {
  silver: number;
  spiritStones: number;
}

export const EMPTY_MAIL_CLAIM_CURRENCY_DELTA: MailClaimCurrencyDelta = {
  silver: 0,
  spiritStones: 0,
};

export const collectMailClaimCurrencyDelta = (
  rewards: GrantedRewardResultDto[] | null | undefined,
): MailClaimCurrencyDelta => {
  let silver = 0;
  let spiritStones = 0;

  for (const reward of rewards ?? []) {
    if (reward.type === 'silver') {
      silver += reward.amount;
      continue;
    }
    if (reward.type === 'spirit_stones') {
      spiritStones += reward.amount;
    }
  }

  return { silver, spiritStones };
};

export const mergeMailClaimCurrencyDelta = (
  current: MailClaimCurrencyDelta,
  incoming: MailClaimCurrencyDelta,
): MailClaimCurrencyDelta => {
  return {
    silver: current.silver + incoming.silver,
    spiritStones: current.spiritStones + incoming.spiritStones,
  };
};

export const hasMailClaimCurrencyDelta = (
  delta: MailClaimCurrencyDelta,
): boolean => {
  return delta.silver > 0 || delta.spiritStones > 0;
};

export const buildMailClaimCharacterCurrencyPatch = (
  current: MailCharacterCurrencySnapshot | null,
  delta: MailClaimCurrencyDelta,
): MailCharacterCurrencySnapshot | null => {
  if (!current || !hasMailClaimCurrencyDelta(delta)) {
    return null;
  }

  return {
    silver: current.silver + delta.silver,
    spiritStones: current.spiritStones + delta.spiritStones,
  };
};
