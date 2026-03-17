/**
 * 邮件跨页批量领取执行模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“跨页扫描邮件列表并逐封领取附件”的批处理流程收口到单一模块，供 MailModal 复用，避免分页遍历、停止判断、进度回调散落在组件里。
 * 2. 做什么：统一管理静默请求、进度推进与停止信号，保证“批量领取”和“中途停止”走同一条数据流。
 * 3. 不做什么：不负责任何 UI 渲染、不直接弹 toast，也不修改 React 组件状态。
 *
 * 输入/输出：
 * - 输入：初始未领取总数、AbortSignal、可选进度回调。
 * - 输出：批量领取执行结果（完成 / 停止 / 失败）、已成功领取数量，以及角色货币是否必须回源刷新的精确信号。
 *
 * 数据流/状态流：
 * MailModal -> 本模块按页拉取邮件 -> 逐封调用领取接口 -> 回调进度 -> 返回批处理结果 -> MailModal 刷新列表与提示文案。
 *
 * 关键边界条件与坑点：
 * 1. 邮件列表按 created_at DESC 稳定排序，claimedAt 变化不会改顺序，所以可以安全按页扫描；但本轮批处理不承诺包含执行期间新到达的邮件。
 * 2. “停止”只保证中断当前未完成的后续请求；若某一封领取请求已经落到服务端并成功执行，这封邮件仍会被正常领取，前端只能在下一步停止。
 */

import type { AxiosRequestConfig } from 'axios';
import { claimMailAttachments, getMailList, type MailDto } from '../../../../services/api';
import { getUnifiedApiErrorMessage } from '../../../../services/api/error';
import {
  collectMailClaimCurrencyDelta,
  EMPTY_MAIL_CLAIM_CURRENCY_DELTA,
  mergeMailClaimCurrencyDelta,
  type MailClaimCurrencyDelta,
} from './mailCharacterCurrency';

const MAIL_BATCH_PAGE_SIZE = 100;
const SILENT_BATCH_REQUEST_META = { autoErrorToast: false } as const;

type MailBatchClaimProgress = {
  total: number;
  current: number;
  claimedCount: number;
};

type MailBatchClaimBaseResult = {
  claimedCount: number;
  processedCount: number;
  currencyDelta: MailClaimCurrencyDelta;
  shouldRefreshCharacter: boolean;
};

export type MailBatchClaimResult =
  | ({ status: 'completed' } & MailBatchClaimBaseResult)
  | ({ status: 'stopped' } & MailBatchClaimBaseResult)
  | ({ status: 'failed'; errorMessage: string } & MailBatchClaimBaseResult);

export interface RunMailBatchClaimArgs {
  initialUnclaimedCount: number;
  autoDisassemble: boolean;
  signal: AbortSignal;
  onProgress?: (progress: MailBatchClaimProgress) => void;
}

const hasUnclaimedAttachments = (mail: MailDto): boolean => {
  return !mail.claimedAt && mail.attachRewards.length > 0;
};

const buildBatchRequestConfig = (signal: AbortSignal): AxiosRequestConfig => {
  return {
    signal,
    meta: SILENT_BATCH_REQUEST_META,
  };
};

const emitProgress = (
  args: RunMailBatchClaimArgs,
  processedCount: number,
  claimedCount: number,
): void => {
  args.onProgress?.({
    total: args.initialUnclaimedCount,
    current: processedCount,
    claimedCount,
  });
};

export const runMailBatchClaim = async (
  args: RunMailBatchClaimArgs,
): Promise<MailBatchClaimResult> => {
  const requestConfig = buildBatchRequestConfig(args.signal);
  let claimedCount = 0;
  let processedCount = 0;
  let page = 1;
  let totalPages = 1;
  let currencyDelta = EMPTY_MAIL_CLAIM_CURRENCY_DELTA;
  let claimRequestInFlight = false;

  emitProgress(args, processedCount, claimedCount);

  try {
    while (page <= totalPages) {
      if (args.signal.aborted) {
        return {
          status: 'stopped',
          claimedCount,
          processedCount,
          currencyDelta,
          shouldRefreshCharacter: false,
        };
      }

      const listRes = await getMailList(page, MAIL_BATCH_PAGE_SIZE, requestConfig);
      const pageData = listRes.data;
      if (!pageData) {
        return {
          status: 'failed',
          claimedCount,
          processedCount,
          currencyDelta,
          shouldRefreshCharacter: false,
          errorMessage: '加载邮件列表失败',
        };
      }

      totalPages = Math.max(1, Math.ceil(pageData.total / MAIL_BATCH_PAGE_SIZE));

      for (const mail of pageData.mails) {
        if (!hasUnclaimedAttachments(mail)) {
          continue;
        }
        if (args.signal.aborted) {
          return {
            status: 'stopped',
            claimedCount,
            processedCount,
            currencyDelta,
            shouldRefreshCharacter: false,
          };
        }

        claimRequestInFlight = true;
        const claimRes = await claimMailAttachments(mail.id, args.autoDisassemble, requestConfig);
        claimRequestInFlight = false;
        claimedCount += 1;
        processedCount += 1;
        currencyDelta = mergeMailClaimCurrencyDelta(
          currencyDelta,
          collectMailClaimCurrencyDelta(claimRes.rewards),
        );
        emitProgress(args, processedCount, claimedCount);
      }

      if (pageData.mails.length < MAIL_BATCH_PAGE_SIZE) {
        break;
      }
      page += 1;
    }

    return {
      status: 'completed',
      claimedCount,
      processedCount,
      currencyDelta,
      shouldRefreshCharacter: false,
    };
  } catch (error) {
    const shouldRefreshCharacter = args.signal.aborted && claimRequestInFlight;
    claimRequestInFlight = false;

    if (args.signal.aborted) {
      return {
        status: 'stopped',
        claimedCount,
        processedCount,
        currencyDelta,
        shouldRefreshCharacter,
      };
    }

    return {
      status: 'failed',
      claimedCount,
      processedCount,
      currencyDelta,
      shouldRefreshCharacter: false,
      errorMessage: getUnifiedApiErrorMessage(error, '领取失败'),
    };
  }
};
