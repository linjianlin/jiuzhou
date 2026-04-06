#!/usr/bin/env tsx

/**
 * 功法书模型批量联调脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：使用指定或当前环境中的功法文本模型，批量生成若干本功法书候选，并把每次生成结果落盘为 JSON 文件。
 * 2. 做什么：支持显式传入底模，并额外输出一份汇总文件，便于快速观察模型名、seed、底模、功法名、技能数与层级数，集中评估模型生成质量。
 * 3. 不做什么：不写数据库、不生成图片、不发放道具，也不改静态 seed。
 *
 * 输入 / 输出：
 * - 输入：`--count <正整数>`，可选 `--quality <黄|玄|地|天>`、`--type <功法类型>`、`--seed-start <正整数>`、`--base-model <底模>`、`--model-name <模型名>`、`--review-model-name <复评模型名>`、`--output <目录>`。
 * - 输出：默认写入 `server/tmp/technique-book-model-check/<时间戳>/` 下的多个 JSON 文件与 `summary.json`。
 *
 * 数据流 / 状态流：
 * CLI 参数
 * -> 批量决定品质/类型/seed
 * -> 共享联调模块逐本生成 candidate
 * -> 每本立即落独立 JSON
 * -> 汇总结果落 `summary.json`。
 *
 * 复用设计说明：
 * - 模型请求、JSON 清洗、结果校验完全复用 `shared/techniqueModelDebug.ts`，批量脚本只负责调度与文件输出。
 * - 汇总结构与单本结构拆开保存，避免后续再写一套“控制台统计逻辑”和“一套落盘逻辑”。
 *
 * 关键边界条件与坑点：
 * 1. 本脚本默认禁止技能生图，即使图片模型环境变量已配置，也不会触发图片生成，避免测试范围被放大。
 * 2. 只有显式传入 `--review-model-name` 时才会启用复评；未指定时即使环境里存在复评模型配置，也必须直接跳过复评。
 * 3. 若传入 `--seed-start`，每本书会按顺序递增 seed；若不传，则每次调用共享请求构造时各自生成独立 seed。
 */

import '../bootstrap/installConsoleLogger.js';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TechniqueQuality } from '../services/techniqueGenerationService.js';
import type { GeneratedTechniqueType } from '../services/shared/techniqueGenerationConstraints.js';
import {
  generateTechniqueModelDebugResult,
  overrideTechniqueModelName,
  overrideTechniqueReviewModelName,
  parseCliArgMap,
  resolveOptionalPositiveIntegerArg,
  resolveTechniqueDebugBaseModelArg,
  resolveTechniqueQualityArg,
  resolveTechniqueQualityByRandom,
  resolveTechniqueTypeArg,
  resolveTechniqueTypeByRandom,
} from './shared/techniqueModelDebug.js';

type BatchScriptOptions = {
  count: number;
  quality?: TechniqueQuality;
  techniqueType?: GeneratedTechniqueType;
  seedStart?: number;
  baseModel?: string;
  outputDir: string;
  modelName?: string;
  reviewModelName?: string;
};

type BatchSummaryEntry = {
  index: number;
  fileName: string;
  modelName: string;
  seed: number;
  requestedQuality: TechniqueQuality;
  requestedTechniqueType: GeneratedTechniqueType;
  baseModel: string | null;
  techniqueName: string;
  techniqueType: GeneratedTechniqueType;
  skillCount: number;
  layerCount: number;
  balanceReviewEnabled: boolean;
  balanceReviewModelName: string;
  balanceAdjusted: boolean;
  balanceReason: string;
  balanceRiskTags: string[];
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(SCRIPT_DIR, '../..');

const buildDefaultOutputDir = (): string => {
  const iso = new Date().toISOString();
  const timestamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return resolve(SERVER_ROOT, 'tmp', 'technique-book-model-check', timestamp);
};

const normalizeOutputDir = (raw: string | undefined): string => {
  if (!raw || raw.trim().length <= 0) {
    return buildDefaultOutputDir();
  }
  return resolve(raw.trim());
};

const parseBatchScriptOptions = (argv: string[]): BatchScriptOptions => {
  const args = parseCliArgMap(argv);
  const count = resolveOptionalPositiveIntegerArg(args.count, 'count');
  if (!count) {
    throw new Error('CLI 参数 --count 必填，且必须是正整数');
  }

  const quality = resolveTechniqueQualityArg(args.quality);
  if (args.quality && !quality) {
    throw new Error('CLI 参数 --quality 仅支持 黄/玄/地/天');
  }

  const techniqueType = resolveTechniqueTypeArg(args.type);
  if (args.type && !techniqueType) {
    throw new Error('CLI 参数 --type 不是受支持的功法类型');
  }

  return {
    count,
    quality: quality ?? undefined,
    techniqueType: techniqueType ?? undefined,
    seedStart: resolveOptionalPositiveIntegerArg(args['seed-start'], 'seed-start'),
    baseModel: resolveTechniqueDebugBaseModelArg(args['base-model']) ?? undefined,
    outputDir: normalizeOutputDir(args.output),
    modelName: (() => {
      const modelName = args['model-name']?.trim();
      return modelName && modelName.length > 0 ? modelName : undefined;
    })(),
    reviewModelName: (() => {
      const modelName = args['review-model-name']?.trim();
      return modelName && modelName.length > 0 ? modelName : undefined;
    })(),
  };
};

const writeJsonFile = async (filePath: string, value: object): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

async function main(): Promise<void> {
  dotenv.config({ path: resolve(SERVER_ROOT, '.env') });
  const options = parseBatchScriptOptions(process.argv.slice(2));
  overrideTechniqueModelName(options.modelName);
  overrideTechniqueReviewModelName(options.reviewModelName);

  await mkdir(options.outputDir, { recursive: true });

  const summary: BatchSummaryEntry[] = [];
  const generatedAt = new Date().toISOString();

  for (let index = 0; index < options.count; index += 1) {
    const requestedQuality = options.quality ?? resolveTechniqueQualityByRandom();
    const requestedTechniqueType = options.techniqueType ?? resolveTechniqueTypeByRandom();
    const seed = options.seedStart ? options.seedStart + index : undefined;

    const result = await generateTechniqueModelDebugResult({
      quality: requestedQuality,
      techniqueType: requestedTechniqueType,
      seed,
      baseModel: options.baseModel,
      includeSkillIcons: false,
      enableReview: options.reviewModelName !== undefined,
      reviewModelName: options.reviewModelName,
    });

    const fileName = `technique-book-${String(index + 1).padStart(3, '0')}.json`;
    const outputPath = resolve(options.outputDir, fileName);
    await writeJsonFile(outputPath, {
      generatedAt,
      index: index + 1,
      modelName: result.modelName,
      seed: result.seed,
      requestedQuality,
      requestedTechniqueType,
      baseModel: result.baseModel,
      summary: result.summary,
      balanceReview: result.balanceReview,
      candidate: result.candidate,
    });

    summary.push({
      index: index + 1,
      fileName,
      modelName: result.modelName,
      seed: result.seed,
      requestedQuality,
      requestedTechniqueType,
      baseModel: result.baseModel,
      techniqueName: result.summary.techniqueName,
      techniqueType: result.summary.techniqueType,
      skillCount: result.summary.skillCount,
      layerCount: result.summary.layerCount,
      balanceReviewEnabled: result.balanceReview.enabled,
      balanceReviewModelName: result.balanceReview.modelName,
      balanceAdjusted: result.balanceReview.adjusted,
      balanceReason: result.balanceReview.reason,
      balanceRiskTags: [...result.balanceReview.riskTags],
    });

    console.log(
      `[${index + 1}/${options.count}] ${result.summary.techniqueName} ` +
      `(${requestedQuality}/${result.summary.techniqueType}${result.baseModel ? `/${result.baseModel}` : ''}) ` +
      `${result.balanceReview.enabled
        ? (result.balanceReview.adjusted ? ' [已按复评调整]' : ' [复评通过]')
        : ' [未启用复评]'} ` +
      `seed=${result.seed} -> ${fileName}`,
    );
  }

  await writeJsonFile(resolve(options.outputDir, 'summary.json'), {
    generatedAt,
    count: options.count,
    requestedQuality: options.quality ?? null,
    requestedTechniqueType: options.techniqueType ?? null,
    seedStart: options.seedStart ?? null,
    baseModel: options.baseModel ?? null,
    modelNameOverride: options.modelName ?? null,
    reviewModelNameOverride: options.reviewModelName ?? null,
    files: summary,
  });

  console.log(`\n批量功法书测试完成，输出目录：${options.outputDir}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[testTechniqueBookModelBatch] ${message}`);
  process.exit(1);
});
