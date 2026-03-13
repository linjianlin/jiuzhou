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
 * 2) 批量生成默认串行执行，避免短时间并发压垮第三方配额；数量由统一图片配置控制。
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import {
  downloadImageBuffer,
  generateConfiguredImageAsset,
} from '../ai/imageModelClient.js';
import { readImageModelConfig } from '../ai/modelConfig.js';

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
export const TECHNIQUE_SKILL_IMAGE_OUTPUT_MAX_EDGE = 256;
export const TECHNIQUE_SKILL_IMAGE_OUTPUT_WEBP_QUALITY = 82;

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asBool = (raw: unknown, fallback: boolean): boolean => {
  const text = asString(raw).toLowerCase();
  if (!text) return fallback;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false;
  return fallback;
};

const ensureImageDir = async (): Promise<string> => {
  const dir = path.join(__dirname, '../../../uploads/techniques');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const getDebugEnabled = (): boolean => asBool(process.env.AI_TECHNIQUE_IMAGE_DEBUG, false);

const debugLog = (...args: unknown[]): void => {
  if (!getDebugEnabled()) return;
  console.log('[technique-image]', ...args);
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
  debugLog(
    'provider=',
    cfg.provider,
    'endpoint=',
    cfg.endpoint,
    'model=',
    cfg.modelName,
    'skillId=',
    input.skillId,
  );

  try {
    const generated = await generateConfiguredImageAsset(prompt);
    if (!generated) {
      debugLog('skip: image config missing');
      return null;
    }

    if (generated.asset.b64) {
      const localPath = await saveB64ImageToLocal(generated.asset.b64, input.skillId);
      if (localPath) {
        debugLog('saved from b64:', localPath);
        return localPath;
      }
      debugLog('b64 returned but local save failed');
    }

    if (generated.asset.url) {
      try {
        const buffer = await downloadImageBuffer(generated.asset.url, generated.timeoutMs);
        const localPath = await saveImageBufferToLocal(buffer, input.skillId);
        if (localPath) {
          debugLog('saved from url:', localPath);
          return localPath;
        }
        debugLog('url returned but local save failed, fallback remote url');
      } catch (error) {
        debugLog('download url failed, fallback remote url:', error instanceof Error ? error.message : String(error));
        return generated.asset.url;
      }
      return generated.asset.url;
    }

    debugLog('empty image asset returned');
    return null;
  } catch (error) {
    debugLog('generate failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
};

export const generateTechniqueSkillIconMap = async (
  inputs: TechniqueSkillImageInput[],
): Promise<Map<string, string>> => {
  const cfg = readImageModelConfig();
  if (!cfg) return new Map();

  const out = new Map<string, string>();
  const list = inputs.slice(0, cfg.maxSkills);
  for (const input of list) {
    const icon = await generateTechniqueSkillIcon(input);
    if (!icon) continue;
    out.set(input.skillId, icon);
  }
  return out;
};
