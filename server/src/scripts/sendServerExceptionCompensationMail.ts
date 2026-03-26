#!/usr/bin/env tsx

/**
 * 服务器异常补偿邮件批量发送脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按“近 N 天活跃角色”统一筛选目标，并向这些角色批量发送服务器异常补偿邮件。
 * 2. 做什么：默认以 dry-run 输出补偿范围与邮件模板，只有显式 `--execute` 才真正写入邮件表。
 * 3. 不做什么：不修改活跃口径定义、不绕过现有邮件服务，也不处理除本次“回元散 x10”之外的其他补偿模板。
 *
 * 输入/输出：
 * - 输入：CLI 参数 `--dry-run | --execute`、`--active-window-days=<N>`、`--report-file=<path>`。
 * - 输出：控制台摘要，以及可选 JSON 报告；执行模式下会批量写入系统补偿邮件。
 *
 * 数据流/状态流：
 * CLI 参数 -> 活跃角色筛选模块 -> 补偿模板模块 -> dry-run 摘要 / execute 批量邮件服务 -> 可选报告落盘。
 *
 * 关键边界条件与坑点：
 * 1. 活跃口径默认沿用在线战斗投影的 7 天窗口；若运营口径临时调整，必须通过 `--active-window-days` 显式指定，不能在脚本里偷偷改默认值。
 * 2. 执行模式不会为每个角色单独回显 mailId；追踪批次应使用统一的 `sourceRefId=batchId` 和 `metadata`。
 */

import '../bootstrap/installConsoleLogger.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { pool } from '../config/database.js';
import { mailService, type BulkMailRecipient } from '../services/mailService.js';
import {
  DEFAULT_RECENT_ACTIVE_CHARACTER_WINDOW_DAYS,
  loadRecentActiveCharacters,
  type RecentActiveCharacter,
} from './shared/recentActiveCharacterSelector.js';
import {
  buildServerExceptionCompensationRewardPayload,
  resolveServerExceptionCompensationConfig,
} from './shared/serverExceptionCompensationMail.js';

type ScriptMode = 'dry-run' | 'execute';

type CliOptions = {
  mode: ScriptMode;
  activeWindowDays: number;
  reportFilePath: string | null;
};

type ScriptExecutionSummary = {
  success: boolean;
  sentCount: number;
  message: string;
};

type ServerExceptionCompensationReport = {
  mode: ScriptMode;
  batchId: string | null;
  activeWindowDays: number;
  rewardItemDefId: string;
  rewardItemName: string;
  rewardItemQty: number;
  expireDays: number;
  mailTitle: string;
  mailContent: string;
  targetCount: number;
  generatedAt: string;
  execution: ScriptExecutionSummary | null;
  targets: RecentActiveCharacter[];
};

const HELP_TEXT = `服务器异常补偿邮件脚本

用法：
  pnpm --filter ./server mail:server-exception-compensation -- --dry-run
  pnpm --filter ./server mail:server-exception-compensation -- --execute
  pnpm --filter ./server mail:server-exception-compensation -- --execute --active-window-days=3
  pnpm --filter ./server mail:server-exception-compensation -- --dry-run --report-file=./tmp/server-exception-mail.json

说明：
  - 默认模式为 dry-run，不会真实发邮件。
  - 活跃口径默认近 ${DEFAULT_RECENT_ACTIVE_CHARACTER_WINDOW_DAYS} 天，复用 online-battle 预热逻辑：
    GREATEST(users.last_login, characters.updated_at, characters.last_offline_at)。
`;

const normalizeText = (value: string): string => value.trim();

const parsePositiveIntegerArg = (rawValue: string, flagName: string): number => {
  const value = Math.floor(Number(rawValue));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} 必须为正整数`);
  }
  return value;
};

const parseCliOptions = (argv: readonly string[]): CliOptions => {
  let mode: ScriptMode = 'dry-run';
  let activeWindowDays = DEFAULT_RECENT_ACTIVE_CHARACTER_WINDOW_DAYS;
  let reportFilePath: string | null = null;

  for (const arg of argv) {
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    if (arg === '--execute') {
      mode = 'execute';
      continue;
    }
    if (arg === '--dry-run') {
      mode = 'dry-run';
      continue;
    }
    if (arg.startsWith('--active-window-days=')) {
      activeWindowDays = parsePositiveIntegerArg(
        normalizeText(arg.slice('--active-window-days='.length)),
        '--active-window-days',
      );
      continue;
    }
    if (arg.startsWith('--report-file=')) {
      const value = normalizeText(arg.slice('--report-file='.length));
      if (!value) {
        throw new Error('--report-file 不能为空');
      }
      reportFilePath = value;
      continue;
    }

    throw new Error(`不支持的参数：${arg}\n\n${HELP_TEXT}`);
  }

  return {
    mode,
    activeWindowDays,
    reportFilePath,
  };
};

const resolveFilePath = (filePath: string): string => {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
};

const ensureParentDirectory = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(resolveFilePath(filePath)), { recursive: true });
};

const writeReportFile = async (
  filePath: string,
  report: ServerExceptionCompensationReport,
): Promise<void> => {
  const resolvedPath = resolveFilePath(filePath);
  await ensureParentDirectory(resolvedPath);
  await fs.writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

const printTargetPreview = (targets: readonly RecentActiveCharacter[]): void => {
  const preview = targets.slice(0, 10);
  if (preview.length <= 0) {
    console.log('目标预览：无命中角色');
    return;
  }

  console.log('目标预览（最多 10 条）：');
  for (const target of preview) {
    console.log(
      `- 角色#${target.characterId}【${target.characterNickname}】 userId=${target.userId} 最近活跃=${target.lastActiveAt}`,
    );
  }

  if (targets.length > preview.length) {
    console.log(`- 其余 ${targets.length - preview.length} 名角色已省略`);
  }
};

const printReportSummary = (report: ServerExceptionCompensationReport): void => {
  console.log(`模式：${report.mode}`);
  console.log(`活跃窗口：近 ${report.activeWindowDays} 天`);
  console.log(`补偿邮件：${report.mailTitle}`);
  console.log(`补偿内容：${report.mailContent}`);
  console.log(
    `附件奖励：${report.rewardItemName}（${report.rewardItemDefId}）x${report.rewardItemQty}`,
  );
  console.log(`邮件有效期：${report.expireDays} 天`);
  console.log(`命中活跃角色：${report.targetCount}`);
  printTargetPreview(report.targets);
};

const main = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));
  const compensationConfig = resolveServerExceptionCompensationConfig();
  const targets = await loadRecentActiveCharacters(options.activeWindowDays);

  const report: ServerExceptionCompensationReport = {
    mode: options.mode,
    batchId: null,
    activeWindowDays: options.activeWindowDays,
    rewardItemDefId: compensationConfig.itemDefId,
    rewardItemName: compensationConfig.itemName,
    rewardItemQty: compensationConfig.itemQty,
    expireDays: compensationConfig.expireDays,
    mailTitle: compensationConfig.title,
    mailContent: compensationConfig.content,
    targetCount: targets.length,
    generatedAt: new Date().toISOString(),
    execution: null,
    targets,
  };

  printReportSummary(report);

  if (options.mode === 'execute') {
    if (targets.length <= 0) {
      report.execution = {
        success: true,
        sentCount: 0,
        message: '没有命中活跃角色，本次无需发放补偿邮件',
      };
      console.log(report.execution.message);
    } else {
      const batchId = randomUUID();
      report.batchId = batchId;

      const recipients: BulkMailRecipient[] = targets.map((target) => ({
        recipientUserId: target.userId,
        recipientCharacterId: target.characterId,
      }));

      const result = await mailService.sendBulkMail({
        recipients,
        senderType: 'system',
        senderName: '系统',
        mailType: 'reward',
        title: compensationConfig.title,
        content: compensationConfig.content,
        attachRewards: buildServerExceptionCompensationRewardPayload(),
        expireDays: compensationConfig.expireDays,
        source: compensationConfig.source,
        sourceRefId: batchId,
        metadata: {
          compensationType: 'server_exception',
          activeWindowDays: options.activeWindowDays,
          rewardItemDefId: compensationConfig.itemDefId,
          rewardItemName: compensationConfig.itemName,
          rewardItemQty: compensationConfig.itemQty,
          batchId,
        },
      });

      report.execution = {
        success: result.success,
        sentCount: result.sentCount,
        message: result.message,
      };

      console.log(
        result.success
          ? `执行完成：${result.message}`
          : `执行失败：${result.message}`,
      );
    }
  }

  if (options.reportFilePath) {
    await writeReportFile(options.reportFilePath, report);
    console.log(`报告已写入：${resolveFilePath(options.reportFilePath)}`);
  }
};

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : '服务器异常补偿脚本执行失败');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
