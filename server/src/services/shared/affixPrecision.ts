/**
 * 词缀数值精度工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一词缀最终计算结果的小数精度规则，避免配置展开、生成、洗炼、描述展示各自保留不同位数。
 * - 不做什么：不决定词缀成长逻辑，也不负责属性是否取整。
 *
 * 输入/输出：
 * - 输入：原始 number 值、可选展示位数。
 * - 输出：统一四舍五入后的 number / 展示字符串。
 *
 * 数据流/状态流：
 * 词缀配置或运行时结果 -> `roundAffixResultValue` / `formatAffixDisplayNumber` -> 标准化 tiers / modifiers / 描述文案。
 *
 * 关键边界条件与坑点：
 * 1) 这里约束的是“最终计算结果”的精度，不等于作者配置必须只写到同样的小数位。
 * 2) 展示字符串需要去掉尾随 0，避免文案里出现 `12.3400` 这类噪声。
 */

export const AFFIX_RESULT_DECIMAL_PLACES = 6;

export const roundAffixResultValue = (
  value: number,
  decimalPlaces = AFFIX_RESULT_DECIMAL_PLACES,
): number => {
  return Number(value.toFixed(decimalPlaces));
};

export const formatAffixDisplayNumber = (
  value: number,
  decimalPlaces = AFFIX_RESULT_DECIMAL_PLACES,
): string => {
  return Number(value)
    .toFixed(decimalPlaces)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?[1-9])0+$/, '$1');
};
