/**
 * 功法被动属性分类共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中声明功法被动里哪些键属于“百分比直接相加”，哪些键属于“按当前面板乘区放大”。
 * 2) 做什么：为人物属性结算与伙伴属性结算提供同一份被动拆分结果，避免两边各自维护一套 key 判断。
 * 3) 不做什么：不负责读取功法层配置，不直接修改数据库，也不决定最终四舍五入策略。
 *
 * 输入/输出：
 * - 输入：已经按功法层累计好的 `Record<string, number>` 被动属性。
 * - 输出：拆分后的 `flatAdditive / percentAdditive / percentMultiply` 三组被动。
 *
 * 数据流/状态流：
 * technique_layer 静态配置 -> 各业务先累计层被动 -> 本模块分类 -> characterComputedService / partnerRules 各自按场景结算。
 *
 * 关键边界条件与坑点：
 * 1) `wugong / fagong / wufang / fafang / max_qixue` 在当前规则里是乘区百分比，不能被当成固定值直接加，否则升层后面板几乎不变化。
 * 2) 本模块只做分类，不做数值归一化；调用方若需要整数化或保留小数，必须在自己的结算阶段处理，避免共享层偷改显示精度。
 */

export const TECHNIQUE_PASSIVE_PERCENT_ADDITIVE_KEYS = new Set<string>([
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

export const TECHNIQUE_PASSIVE_PERCENT_MULTIPLY_KEYS = new Set<string>([
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'max_qixue',
]);

export interface SplitTechniquePassiveAttrsResult {
  flatAdditive: Record<string, number>;
  percentAdditive: Record<string, number>;
  percentMultiply: Record<string, number>;
}

export const splitTechniquePassiveAttrs = (
  passives: Record<string, number>,
): SplitTechniquePassiveAttrsResult => {
  const flatAdditive: Record<string, number> = {};
  const percentAdditive: Record<string, number> = {};
  const percentMultiply: Record<string, number> = {};

  for (const [key, value] of Object.entries(passives)) {
    if (!Number.isFinite(value) || value === 0) continue;

    if (TECHNIQUE_PASSIVE_PERCENT_ADDITIVE_KEYS.has(key)) {
      percentAdditive[key] = (percentAdditive[key] ?? 0) + value;
      continue;
    }

    if (TECHNIQUE_PASSIVE_PERCENT_MULTIPLY_KEYS.has(key)) {
      percentMultiply[key] = (percentMultiply[key] ?? 0) + value;
      continue;
    }

    flatAdditive[key] = (flatAdditive[key] ?? 0) + value;
  }

  return {
    flatAdditive,
    percentAdditive,
    percentMultiply,
  };
};
