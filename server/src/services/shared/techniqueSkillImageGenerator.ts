/**
 * 生成功法技能图标（绘图 AI）
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：根据功法与技能语义调用绘图模型，生成技能图标并写入本地 uploads 目录，返回可访问路径。
 * 2) 做什么：复用统一图片 client，把 provider 协议差异从业务模块中移除，避免技能图标与伙伴头像重复维护一套请求逻辑。
 * 3) 不做什么：不负责业务状态机、不负责数据库写入、不抛出阻断主流程异常（失败时返回 null）。
 *
 * 输入/输出：
 * - 输入：技能语义上下文（功法名、技能名、描述、元素、效果摘要等）。
 * - 输出：`/uploads/techniques/*.webp` 或远端 URL；失败返回 null。
 *
 * 数据流/状态流：
 * 上下文 -> prompt 拼装 -> imageModelClient -> 解析 b64/url -> 本地落盘(可选) -> 返回图标路径。
 *
 * 关键边界条件与坑点：
 * 1) 外部模型可能返回空图片资源，解析失败必须静默回退，不能影响主链路。
 * 2) 批量生成采用固定 3 并发，既缩短多技能等待时间，也避免把第三方配额压力一次性放大到“全量 Promise.all”。
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import {
  downloadImageBuffer,
  generateConfiguredImageAsset,
  OPENAI_IMAGE_GENERATION_MAX_RETRIES,
} from '../ai/imageModelClient.js';
import { readImageModelConfig } from '../ai/modelConfig.js';
import {
  debugImageGenerationLog,
  summarizeImageGenerationError,
} from './imageGenerationDebugShared.js';

export type TechniqueSkillImageInput = {
  skillId: string;
  techniqueName: string;
  techniqueType: string;
  techniqueQuality: string;
  techniqueElement: string;
  skillName: string;
  skillDescription: string;
  skillEffects: unknown[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_IMAGE_PREFIX = '/uploads/techniques';
export const TECHNIQUE_SKILL_IMAGE_CONCURRENCY = 5;
export const TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE = 256;
export const TECHNIQUE_SKILL_IMAGE_OUTPUT_WEBP_QUALITY = 82;

const ensureImageDir = async (): Promise<string> => {
  const dir = path.join(__dirname, '../../../uploads/techniques');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

export const buildTechniqueSkillImagePrompt = (input: TechniqueSkillImageInput): string => {
  return [
    ` - 生成2D中国仙侠游戏《九州修仙录》技能图标《${input.skillName}》`,
    ` - 技能描述：${input.skillDescription}`,
    ' - 铺满整个画布，单主体，背景简化，强对比，避免细碎噪点，满画幅无边框无留白',
    ' - 不要任何文字、英文',
  ].join('\n');
};

const getSafeSkillId = (skillId: string): string => {
  return (skillId || 'skill')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'skill';
};

/**
 * 压缩模型输出后的技能图片
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一把模型原始图片压缩为更适合前端加载的 WebP，并限制最大边长，避免落盘原图过大。
 * 2) 做什么：作为 b64 与远端 URL 两条图片来源链路的共同压缩入口，减少重复处理逻辑。
 * 3) 不做什么：不负责网络下载、不负责文件命名、不区分具体模型来源。
 *
 * 输入/输出：
 * - 输入：模型输出的原始图片 Buffer。
 * - 输出：压缩后的 WebP Buffer；压缩失败返回 null。
 *
 * 数据流/状态流：
 * 模型原始字节 -> compressTechniqueSkillImageBuffer -> saveImageBufferToLocal -> uploads/techniques。
 *
 * 关键边界条件与坑点：
 * 1) 只允许缩小不允许放大，避免小图被错误重采样导致发糊。
 * 2) 图像可能带有 EXIF 方向信息，压缩前需自动旋正，否则前端显示方向可能异常。
 */
export const compressTechniqueSkillImageBuffer = async (buffer: Buffer): Promise<Buffer | null> => {
  if (buffer.length <= 0) return null;
  try {
    const compressed = await sharp(buffer)
      .rotate()
      .resize({
        width: TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE,
        height: TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: TECHNIQUE_SKILL_IMAGE_OUTPUT_WEBP_QUALITY,
        effort: 4,
      })
      .toBuffer();
    return compressed.length > 0 ? compressed : null;
  } catch {
    return null;
  }
};

const saveImageBufferToLocal = async (buffer: Buffer, skillId: string): Promise<string | null> => {
  try {
    if (buffer.length <= 0) return null;
    const compressedBuffer = await compressTechniqueSkillImageBuffer(buffer);
    if (!compressedBuffer || compressedBuffer.length <= 0) return null;
    const dir = await ensureImageDir();
    const safeSkillId = getSafeSkillId(skillId);
    const fileName = `tech-skill-${Date.now()}-${safeSkillId}.webp`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, compressedBuffer);
    return `${LOCAL_IMAGE_PREFIX}/${fileName}`;
  } catch {
    return null;
  }
};

const saveB64ImageToLocal = async (b64: string, skillId: string): Promise<string | null> => {
  if (!b64) return null;
  return saveImageBufferToLocal(Buffer.from(b64, 'base64'), skillId);
};

export const generateTechniqueSkillIcon = async (input: TechniqueSkillImageInput): Promise<string | null> => {
  const cfg = readImageModelConfig();
  if (!cfg) return null;

  const prompt = buildTechniqueSkillImagePrompt(input);
  debugImageGenerationLog(
    'technique-image',
    'provider=',
    cfg.provider,
    'endpoint=',
    cfg.endpoint,
    'model=',
    cfg.modelName,
    'retry=',
    cfg.provider === 'openai' ? OPENAI_IMAGE_GENERATION_MAX_RETRIES : 'none',
    'skillId=',
    input.skillId,
  );

  try {
    const generated = await generateConfiguredImageAsset(prompt);
    if (!generated) {
      debugImageGenerationLog('technique-image', 'skip: image config missing');
      return null;
    }

    if (generated.asset.b64) {
      const localPath = await saveB64ImageToLocal(generated.asset.b64, input.skillId);
      if (localPath) {
        debugImageGenerationLog('technique-image', 'saved from b64:', localPath);
        return localPath;
      }
      debugImageGenerationLog('technique-image', 'b64 returned but local save failed');
    }

    if (generated.asset.url) {
      try {
        const buffer = await downloadImageBuffer(generated.asset.url, generated.timeoutMs);
        const localPath = await saveImageBufferToLocal(buffer, input.skillId);
        if (localPath) {
          debugImageGenerationLog('technique-image', 'saved from url:', localPath);
          return localPath;
        }
        debugImageGenerationLog('technique-image', 'url returned but local save failed, fallback remote url');
      } catch (error) {
        debugImageGenerationLog(
          'technique-image',
          'download url failed, fallback remote url:',
          summarizeImageGenerationError(error instanceof Error ? error : String(error)),
        );
        return generated.asset.url;
      }
      return generated.asset.url;
    }

    debugImageGenerationLog('technique-image', 'empty image asset returned');
    return null;
  } catch (error) {
    debugImageGenerationLog(
      'technique-image',
      'generate failed:',
      summarizeImageGenerationError(error instanceof Error ? error : String(error)),
    );
    return null;
  }
};

/**
 * 批量技能图标并发执行器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中控制功法技能图标批量请求的固定并发上限，供 `generateTechniqueSkillIconMap` 复用。
 * 2) 做什么：让“并发数控制”与“结果映射聚合”留在同一模块内，避免调用方自己切片后再复制一遍批量调度逻辑。
 * 3) 不做什么：不改动单技能生图细节，也不处理默认图标回退，这些仍由上层入口负责。
 *
 * 输入/输出：
 * - 输入：待生成的技能图片输入数组。
 * - 输出：成功生成的 `[skillId, iconPath]` 列表；单项失败会被自动过滤。
 *
 * 数据流/状态流：
 * inputs -> 固定并发 worker 拉取下一个任务 -> generateTechniqueSkillIcon -> 成功结果聚合 -> generateTechniqueSkillIconMap。
 *
 * 关键边界条件与坑点：
 * 1) 这里必须保留“跳过失败项”的语义，不能因为一张图失败就让整批 Promise 拒绝，否则会破坏上层默认图标回退。
 * 2) `nextIndex` 只作为批次内游标使用，不跨请求共享状态，因此并发上限必须收敛在函数作用域内，避免多批次互相干扰。
 */
const generateTechniqueSkillIconEntries = async (
  inputs: TechniqueSkillImageInput[],
): Promise<Array<readonly [string, string]>> => {
  if (inputs.length <= 0) return [];

  const results: Array<readonly [string, string] | null> = new Array(inputs.length).fill(null);
  let nextIndex = 0;
  const workerCount = Math.min(TECHNIQUE_SKILL_IMAGE_CONCURRENCY, inputs.length);

  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const input = inputs[currentIndex];
      const icon = await generateTechniqueSkillIcon(input);
      if (!icon) continue;
      results[currentIndex] = [input.skillId, icon];
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((entry): entry is readonly [string, string] => entry !== null);
};

export const generateTechniqueSkillIconMap = async (
  inputs: TechniqueSkillImageInput[],
): Promise<Map<string, string>> => {
  const cfg = readImageModelConfig();
  if (!cfg) return new Map();

  const list = inputs.slice(0, cfg.maxSkills);
  return new Map<string, string>(await generateTechniqueSkillIconEntries(list));
};
