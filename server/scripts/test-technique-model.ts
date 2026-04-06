#!/usr/bin/env tsx
/**
 * AI 领悟模型联调脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：读取环境变量中的模型服务配置，调用模型生成一份功法草稿，并打印到控制台；支持可选 seed 复现结果。
 * 2) 不做什么：不写数据库、不创建生成任务、不扣除研修点，仅做模型联调验证。
 *
 * 输入/输出：
 * - 输入：CLI 参数（可选）：`--quality <黄|玄|地|天>`、`--type <功法类型>`、`--seed <正整数>`、`--base-model <底模>`、`--model-name <模型名>`、`--review-model-name <复评模型名>`。
 * - 输出：控制台打印模型响应、结构化 JSON、功法摘要。
 *
 * 数据流/状态流：
 * 解析参数 -> 共享联调模块请求模型并清洗结果 -> 可选挂技能图标 -> 打印结果。
 *
 * 关键边界条件与坑点：
 * 1) 若功法文本模型配置缺失，脚本会直接失败退出。
 * 2) 技能图标仍然只在显式检测到图片模型配置时才会启用，避免单次文本联调误触发生图。
 */
import '../src/bootstrap/installConsoleLogger.js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateTechniqueModelDebugResult,
  isTechniqueSkillImageGenerationConfigured,
  overrideTechniqueModelName,
  overrideTechniqueReviewModelName,
  parseCliArgMap,
  resolveOptionalPositiveIntegerArg,
  resolveTechniqueDebugBaseModelArg,
  resolveTechniqueQualityArg,
  resolveTechniqueQualityByRandom,
  resolveTechniqueTypeArg,
  resolveTechniqueTypeByRandom,
} from '../src/scripts/shared/techniqueModelDebug.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(SCRIPT_DIR, '..');

const printSection = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

const printKeyValue = (label: string, value: string | number): void => {
  console.log(`${label}: ${value}`);
};

const printStringList = (label: string, values: readonly string[]): void => {
  if (values.length <= 0) {
    console.log(`${label}: 无`);
    return;
  }
  console.log(`${label}:`);
  for (const value of values) {
    console.log(`- ${value}`);
  }
};

const main = async (): Promise<void> => {
  dotenv.config({ path: resolve(SERVER_ROOT, '.env') });
  const args = parseCliArgMap(process.argv.slice(2));
  const qualityArg = resolveTechniqueQualityArg(args.quality);
  if (args.quality && !qualityArg) {
    throw new Error('CLI 参数 --quality 仅支持 黄/玄/地/天');
  }
  const quality = qualityArg ?? resolveTechniqueQualityByRandom();

  const techniqueTypeArg = resolveTechniqueTypeArg(args.type);
  if (args.type && !techniqueTypeArg) {
    throw new Error('CLI 参数 --type 不是受支持的功法类型');
  }
  const techniqueType = techniqueTypeArg ?? resolveTechniqueTypeByRandom();
  const seed = resolveOptionalPositiveIntegerArg(args.seed, 'seed');
  const baseModel = resolveTechniqueDebugBaseModelArg(args['base-model']) ?? undefined;
  overrideTechniqueModelName(args['model-name']);
  overrideTechniqueReviewModelName(args['review-model-name']);

  printSection('参数解析');
  printKeyValue('请求品质', quality);
  printKeyValue('请求类型', techniqueType);
  printKeyValue('指定 Seed', seed ?? '未指定');
  printKeyValue('指定底模', baseModel ?? '未指定');
  printKeyValue('主模型覆盖', args['model-name']?.trim() || '未指定');
  printKeyValue('复评模型覆盖', args['review-model-name']?.trim() || '未指定');

  const imageEnabled = isTechniqueSkillImageGenerationConfigured();
  const result = await generateTechniqueModelDebugResult({
    quality,
    techniqueType,
    seed,
    baseModel,
    includeSkillIcons: imageEnabled,
    enableReview: true,
    reviewModelName: args['review-model-name'],
  });

  printSection('生成阶段');
  printKeyValue('首轮模型', result.trace.initialGeneration.modelName);
  printKeyValue('首轮 Seed', result.trace.initialGeneration.seed);
  printKeyValue('首轮尝试次数', result.trace.initialGeneration.attemptCount);
  printKeyValue('首轮耗时(ms)', result.trace.initialGeneration.elapsedMs);
  printKeyValue('首轮用户消息字节数', result.trace.initialGeneration.promptBytes);
  printKeyValue('首轮请求快照字节数', result.trace.initialGeneration.promptSnapshotBytes);
  printKeyValue('首轮功法名', result.trace.initialGeneration.techniqueName);
  printKeyValue('首轮技能数', result.trace.initialGeneration.skillCount);
  printKeyValue('首轮层级数', result.trace.initialGeneration.layerCount);

  printSection('复评阶段');
  printKeyValue('复评模型', result.trace.balanceReview.modelName);
  printKeyValue('复评耗时(ms)', result.trace.balanceReview.elapsedMs);
  printKeyValue('复评请求快照字节数', result.trace.balanceReview.promptSnapshotBytes);
  printKeyValue('复评是否要求调整', result.trace.balanceReview.adjusted ? '是' : '否');
  printKeyValue('复评结论', result.trace.balanceReview.reason);
  printStringList('复评风险标签', result.trace.balanceReview.riskTags);
  printStringList('复评修正规则', result.trace.balanceReview.adjustmentGuidance);

  if (result.trace.balanceReview.adjusted) {
    printSection('二次生成阶段');
    printKeyValue('二次模型', result.trace.finalGeneration.modelName);
    printKeyValue('二次 Seed', result.trace.finalGeneration.seed);
    printKeyValue('二次尝试次数', result.trace.finalGeneration.attemptCount);
    printKeyValue('二次耗时(ms)', result.trace.finalGeneration.elapsedMs);
    printKeyValue('二次用户消息字节数', result.trace.finalGeneration.promptBytes);
    printKeyValue('二次请求快照字节数', result.trace.finalGeneration.promptSnapshotBytes);
    printKeyValue('二次功法名', result.trace.finalGeneration.techniqueName);
    printKeyValue('二次技能数', result.trace.finalGeneration.skillCount);
    printKeyValue('二次层级数', result.trace.finalGeneration.layerCount);
  } else {
    printSection('二次生成阶段');
    printKeyValue('是否跳过', '是，复评判定无需调整');
  }

  printSection('技能图标阶段');
  printKeyValue('技能绘图开关', result.trace.skillIcons.enabled ? '已启用' : '未启用');
  printKeyValue('技能绘图耗时(ms)', result.trace.skillIcons.elapsedMs);
  printKeyValue('挂载图标数量', result.trace.skillIcons.attachedCount);

  printSection('最终结果');
  printKeyValue('最终模型', result.modelName);
  printKeyValue('最终 Seed', result.seed);
  printKeyValue('请求品质', quality);
  printKeyValue('请求类型', techniqueType);
  printKeyValue('底模', result.baseModel ?? '未指定');
  printKeyValue('功法', `${result.summary.techniqueName}（${result.summary.techniqueType}）`);
  printKeyValue('技能数量', result.summary.skillCount);
  printKeyValue('层级数量', result.summary.layerCount);
  printKeyValue('总耗时(ms)', result.trace.totalElapsedMs);
  console.log('\n--- 归一化后结构化输出(JSON) ---');
  console.log(JSON.stringify(result.candidate, null, 2));
};

void main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[test-technique-model] ${msg}`);
  process.exit(1);
});
