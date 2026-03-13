import fs from 'fs';
import path from 'path';

/**
 * 本地敏感词词库读取模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中读取项目内置的敏感词 JSON 词库，并提供带 mtime 热更新的内存缓存。
 * 2) 做什么：为共享敏感词检测服务提供零网络依赖的本地短路能力，避免角色命名、聊天、功法命名各自重复读文件。
 * 3) 不做什么：不做外部服务请求，也不决定命中后是拒绝、替换还是仅记录日志。
 *
 * 输入/输出：
 * - 输入：磁盘上的敏感词 JSON 文件。
 * - 输出：统一的小写 `Set<string>` 词库。
 *
 * 数据流/状态流：
 * JSON 文件 -> 解析与归一化 -> 内存缓存 -> 共享敏感词检测服务复用。
 *
 * 关键边界条件与坑点：
 * 1) 词库文件可能在源码目录或构建目录下，路径探测必须集中，否则不同运行方式会各写一套查找逻辑。
 * 2) 文件缺失时返回空词库而不是抛错，保证“本地词库不可用”和“外部服务启停”彼此解耦。
 */

type SensitiveWordFile = {
  words?: string[];
};

const CANDIDATE_PATHS = [
  path.join(process.cwd(), 'server', 'src', 'data', 'seeds', 'technique_name_sensitive_words.json'),
  path.join(process.cwd(), 'src', 'data', 'seeds', 'technique_name_sensitive_words.json'),
  path.join(process.cwd(), 'dist', 'data', 'seeds', 'technique_name_sensitive_words.json'),
];

let cachedWords = new Set<string>();
let cachedMtimeMs = -1;
let cachedPath: string | null = null;

const resolveSensitiveWordFilePath = (): string | null => {
  if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
  const matched = CANDIDATE_PATHS.find((filePath) => fs.existsSync(filePath)) ?? null;
  cachedPath = matched;
  return matched;
};

const parseSensitiveWords = (raw: SensitiveWordFile): Set<string> => {
  if (!Array.isArray(raw.words)) return new Set();
  const normalized = raw.words
    .map((word) => (typeof word === 'string' ? word.trim().toLowerCase() : ''))
    .filter((word): word is string => word.length > 0);
  return new Set(normalized);
};

export const getLocalSensitiveWords = (): Set<string> => {
  const filePath = resolveSensitiveWordFilePath();
  if (!filePath) {
    cachedWords = new Set();
    cachedMtimeMs = -1;
    return cachedWords;
  }

  try {
    const stat = fs.statSync(filePath);
    const mtimeMs = Number(stat.mtimeMs) || 0;
    if (mtimeMs === cachedMtimeMs) {
      return cachedWords;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SensitiveWordFile;
    cachedWords = parseSensitiveWords(parsed);
    cachedMtimeMs = mtimeMs;
    return cachedWords;
  } catch {
    cachedWords = new Set();
    cachedMtimeMs = -1;
    return cachedWords;
  }
};
