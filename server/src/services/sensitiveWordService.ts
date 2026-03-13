/**
 * 敏感词检测共享服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一组合“本地敏感词词表 + 外部敏感词服务”两种检测来源，输出稳定的命中结果结构。
 * 2) 做什么：给聊天、角色道号、功法命名提供同一套检测与错误归一化入口，避免每个业务模块各写一遍 fetch 和响应解析。
 * 3) 不做什么：不直接决定调用方是否拒绝提交，也不负责数据库落库或 Socket 广播。
 *
 * 输入/输出：
 * - 输入：待检测文本，以及调用方传入的命中/服务不可用提示文案。
 * - 输出：检测结果 `SensitiveWordCheckResult`，或业务可直接消费的 `SensitiveWordGuardResult`。
 *
 * 数据流/状态流：
 * 原始文本 -> 本地词表快速命中 -> （未命中且服务开启时）外部 `/wordscheck` -> 统一命中结构 -> 业务入口决定放行/拦截。
 *
 * 关键边界条件与坑点：
 * 1) 本地词表命中后应立即短路，避免本来就该拦截的输入还去额外访问外部服务，造成重复开销。
 * 2) 外部服务失败时不能偷偷跳过检测，否则“服务开启”会退化成“部分请求不检测”；必须明确返回不可用状态给上层处理。
 */
import { readSensitiveWordServiceConfig } from './sensitiveWordConfig.js';
import { getLocalSensitiveWords } from './sensitiveWordLocalDictionary.js';

export type SensitiveWordSource = 'local' | 'remote' | 'none';

export type SensitiveWordHit = {
  keyword: string;
  category: string;
  position: string;
  level: string;
};

export type SensitiveWordCheckResult = {
  matched: boolean;
  source: SensitiveWordSource;
  sanitizedContent: string;
  hits: SensitiveWordHit[];
};

export type SensitiveWordGuardResult =
  | { success: true; result: SensitiveWordCheckResult }
  | { success: false; code: 'CONTENT_SENSITIVE' | 'SERVICE_UNAVAILABLE'; message: string; result?: SensitiveWordCheckResult };

type SensitiveWordRemoteResponse = {
  code?: string;
  msg?: string;
  return_str?: string;
  word_list?: SensitiveWordHit[];
};

const LOCAL_WORD_CATEGORY = '本地词库';
const LOCAL_WORD_LEVEL = '中';

const normalizeLocalMatchInput = (content: string): string => content.trim().toLowerCase();

const toLocalHits = (content: string): SensitiveWordHit[] => {
  const normalizedContent = normalizeLocalMatchInput(content);
  if (!normalizedContent) return [];

  const hits: SensitiveWordHit[] = [];
  for (const word of getLocalSensitiveWords().values()) {
    if (!word || !normalizedContent.includes(word)) continue;
    hits.push({
      keyword: word,
      category: LOCAL_WORD_CATEGORY,
      position: '',
      level: LOCAL_WORD_LEVEL,
    });
  }
  return hits;
};

const requestSensitiveWordService = async (content: string): Promise<SensitiveWordCheckResult> => {
  const config = readSensitiveWordServiceConfig();
  if (!config.enabled) {
    return {
      matched: false,
      source: 'none',
      sanitizedContent: content,
      hits: [],
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const rawText = await response.text();
      throw new Error(`敏感词检测请求失败：${response.status} ${rawText.slice(0, 200)}`.trim());
    }

    const body = await response.json() as SensitiveWordRemoteResponse;
    if (body.code !== '0') {
      throw new Error(`敏感词检测服务返回异常：${body.msg ?? '未知错误'}`);
    }

    const hits = Array.isArray(body.word_list) ? body.word_list : [];
    return {
      matched: hits.length > 0,
      source: hits.length > 0 ? 'remote' : 'none',
      sanitizedContent: typeof body.return_str === 'string' && body.return_str ? body.return_str : content,
      hits,
    };
  } finally {
    clearTimeout(timer);
  }
};

export const detectSensitiveWords = async (content: string): Promise<SensitiveWordCheckResult> => {
  const localHits = toLocalHits(content);
  if (localHits.length > 0) {
    return {
      matched: true,
      source: 'local',
      sanitizedContent: content,
      hits: localHits,
    };
  }

  return requestSensitiveWordService(content);
};

export const guardSensitiveText = async (
  content: string,
  blockedMessage: string,
  unavailableMessage: string,
): Promise<SensitiveWordGuardResult> => {
  try {
    const result = await detectSensitiveWords(content);
    if (result.matched) {
      return {
        success: false,
        code: 'CONTENT_SENSITIVE',
        message: blockedMessage,
        result,
      };
    }

    return { success: true, result };
  } catch (error) {
    console.error('敏感词检测失败:', error);
    return {
      success: false,
      code: 'SERVICE_UNAVAILABLE',
      message: unavailableMessage,
    };
  }
};
