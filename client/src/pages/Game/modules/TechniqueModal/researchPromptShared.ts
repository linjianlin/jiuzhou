/**
 * 洞府研修提示词前端共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理用户指定提示词的前端裁剪、长度统计、请求值转换与提示文案，避免 `TechniqueModal` 和 `ResearchPanel` 各写一套。
 * 2. 做什么：把输入框前缀、帮助文案、结果标签收敛到单一文案入口，避免界面上出现多套说法。
 * 3. 不做什么：不直接发请求、不持有 React 状态，也不替代服务端最终校验。
 *
 * 输入/输出：
 * - 输入：玩家在输入框中的原始文本，或任务状态里的已选提示词。
 * - 输出：裁剪后的输入值、请求值、字符计数与展示文案。
 *
 * 数据流/状态流：
 * Input 原始值 -> 本模块规范化 -> TechniqueModal 状态 / 生成请求 / 研修结果展示。
 *
 * 关键边界条件与坑点：
 * 1. 前端裁剪只负责帮助玩家更顺手地输入，不能替代服务端校验；真正的合法性仍以后端共享规则为准。
 * 2. 提示词会直接影响 AI 的命名与意象收束语义，因此展示词必须保持直白中性，避免像旧词那样把模型引向单一火属性。
 */

const TECHNIQUE_RESEARCH_BURNING_WORD_CHAR_PATTERN = /^[\p{Script=Han}]$/u;
export const TECHNIQUE_RESEARCH_BURNING_WORD_LABEL = '焚诀';

export const normalizeTechniqueResearchBurningWordInput = (
  raw: string,
  maxLength: number,
): string => {
  if (!raw) return '';
  const hanChars = Array.from(raw.trim()).filter((char) => {
    return TECHNIQUE_RESEARCH_BURNING_WORD_CHAR_PATTERN.test(char);
  });
  return hanChars.slice(0, Math.max(0, maxLength)).join('');
};

export const resolveTechniqueResearchBurningWordDisplayValue = (
  raw: string,
  maxLength: number,
  isComposing: boolean,
): string => {
  if (isComposing) return raw;
  return normalizeTechniqueResearchBurningWordInput(raw, maxLength);
};

export const getTechniqueResearchBurningWordInputLength = (value: string): number => {
  return Array.from(value).length;
};

export const resolveTechniqueResearchBurningWordRequestValue = (
  value: string,
  maxLength: number,
): string | undefined => {
  const normalized = normalizeTechniqueResearchBurningWordInput(value, maxLength);
  return normalized || undefined;
};

export const buildTechniqueResearchBurningWordHelperText = (
  maxLength: number,
): string => {
  return `留空则随机；填写后会按该${TECHNIQUE_RESEARCH_BURNING_WORD_LABEL}收束本次功法意象与风格，不会突破原有强度规则，最多 ${maxLength} 个中文字符。`;
};

export const buildTechniqueResearchBurningWordTagText = (
  burningWordPrompt: string,
): string => {
  return `${TECHNIQUE_RESEARCH_BURNING_WORD_LABEL} ${burningWordPrompt}`;
};
