/**
 * 邮件批量领取停止态回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证批量领取在“请求进行中被停止”时会显式标记需要刷新角色数据，避免继续使用可能缺失最后一笔的本地货币增量。
 * 2. 做什么：验证正常完成时仍走本地增量同步，不把所有场景都退化成全量刷新。
 * 3. 不做什么：不连接真实接口、不渲染 MailModal，也不覆盖 toast 文案。
 *
 * 输入/输出：
 * - 输入：模拟的邮件列表接口、邮件领取接口响应，以及 AbortSignal。
 * - 输出：`runMailBatchClaim` 的执行结果对象。
 *
 * 数据流/状态流：
 * Mail API mock -> `runMailBatchClaim` -> 停止/完成结果 -> MailModal 的角色同步分支。
 *
 * 关键边界条件与坑点：
 * 1. “停止”问题只发生在领取请求已经发出但响应被 abort 截断时，因此测试必须把中止动作放进领取请求进行中。
 * 2. 正常完成场景必须同时断言 `shouldRefreshCharacter` 为 `false`，避免把修复误做成粗暴的全量刷新兜底。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimMailAttachments,
  getMailList,
  type MailDto,
} from '../../../../services/api';
import { runMailBatchClaim } from '../MailModal/mailBatchClaim';

vi.mock('../../../../services/api', () => ({
  getMailList: vi.fn(),
  claimMailAttachments: vi.fn(),
}));

vi.mock('../../../../services/api/error', () => ({
  getUnifiedApiErrorMessage: vi.fn((_: unknown, fallback: string) => fallback),
}));

const createMailDto = (overrides?: Partial<MailDto>): MailDto => ({
  id: 1,
  senderType: 'system',
  senderName: '系统',
  mailType: 'system',
  title: '批量领取测试邮件',
  content: 'test',
  attachSilver: 0,
  attachSpiritStones: 0,
  attachItems: [],
  attachRewards: [{ type: 'silver', amount: 100 }],
  readAt: null,
  claimedAt: null,
  expireAt: null,
  createdAt: '2026-03-17T00:00:00.000Z',
  ...overrides,
});

describe('runMailBatchClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMailList).mockResolvedValue({
      success: true,
      data: {
        mails: [createMailDto()],
        total: 1,
        unreadCount: 1,
        unclaimedCount: 1,
        page: 1,
        pageSize: 100,
      },
    });
  });

  it('领取请求进行中停止时应标记需要刷新角色数据', async () => {
    const controller = new AbortController();

    vi.mocked(claimMailAttachments).mockImplementation(async () => {
      controller.abort();
      throw new Error('request aborted after server commit');
    });

    const result = await runMailBatchClaim({
      initialUnclaimedCount: 1,
      autoDisassemble: false,
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: 'stopped',
      claimedCount: 0,
      processedCount: 0,
      currencyDelta: {
        silver: 0,
        spiritStones: 0,
      },
      shouldRefreshCharacter: true,
    });
  });

  it('正常完成时不应要求刷新角色数据', async () => {
    vi.mocked(claimMailAttachments).mockResolvedValue({
      success: true,
      message: '领取成功',
      rewards: [{ type: 'silver', amount: 100 }],
    });

    const result = await runMailBatchClaim({
      initialUnclaimedCount: 1,
      autoDisassemble: false,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'completed',
      claimedCount: 1,
      processedCount: 1,
      currencyDelta: {
        silver: 100,
        spiritStones: 0,
      },
      shouldRefreshCharacter: false,
    });
  });
});
