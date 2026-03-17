/**
 * 邮件领取货币同步回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定邮件奖励到角色货币补丁的转换规则，确保首页头部金额与邮件领取奖励始终使用同一份增量计算。
 * 2. 做什么：覆盖混合奖励、批量合并与补丁生成场景，防止后续有人在 MailModal 内重新手写银两/灵石加法。
 * 3. 不做什么：不请求接口、不连接 socket，也不验证邮件列表 UI。
 *
 * 输入/输出：
 * - 输入：邮件领取返回的奖励数组、批量累计增量、角色当前货币快照。
 * - 输出：标准化货币增量与角色货币补丁。
 *
 * 数据流/状态流：
 * 邮件接口奖励 DTO -> `mailCharacterCurrency` -> `gameSocket.updateCharacterLocal` 所需补丁。
 *
 * 关键边界条件与坑点：
 * 1. 非货币奖励必须被忽略，否则会把物品/经验错误混入货币累计。
 * 2. 零增量场景必须返回空补丁，避免无意义地广播角色状态更新。
 */

import { describe, expect, it } from 'vitest';

import {
  buildMailClaimCharacterCurrencyPatch,
  collectMailClaimCurrencyDelta,
  EMPTY_MAIL_CLAIM_CURRENCY_DELTA,
  mergeMailClaimCurrencyDelta,
} from '../MailModal/mailCharacterCurrency';

describe('mailCharacterCurrency', () => {
  it('应只提取邮件奖励中的银两与灵石增量', () => {
    const delta = collectMailClaimCurrencyDelta([
      { type: 'silver', amount: 1200 },
      { type: 'item', itemDefId: 'mat-001', quantity: 2, itemName: '玄铁' },
      { type: 'spirit_stones', amount: 30 },
      { type: 'exp', amount: 500 },
      { type: 'silver', amount: 300 },
    ]);

    expect(delta).toEqual({
      silver: 1500,
      spiritStones: 30,
    });
  });

  it('应合并多次邮件领取的货币增量，并生成统一角色货币补丁', () => {
    const totalDelta = mergeMailClaimCurrencyDelta(
      collectMailClaimCurrencyDelta([
        { type: 'silver', amount: 800 },
        { type: 'spirit_stones', amount: 12 },
      ]),
      collectMailClaimCurrencyDelta([
        { type: 'item', itemDefId: 'mat-002', quantity: 1, itemName: '灵木' },
        { type: 'silver', amount: 200 },
      ]),
    );

    const patch = buildMailClaimCharacterCurrencyPatch(
      { silver: 10000, spiritStones: 320 },
      totalDelta,
    );

    expect(totalDelta).toEqual({
      silver: 1000,
      spiritStones: 12,
    });
    expect(patch).toEqual({
      silver: 11000,
      spiritStones: 332,
    });
  });

  it('零增量时不应生成角色货币补丁', () => {
    const patch = buildMailClaimCharacterCurrencyPatch(
      { silver: 500, spiritStones: 18 },
      EMPTY_MAIL_CLAIM_CURRENCY_DELTA,
    );

    expect(patch).toBeNull();
  });
});
