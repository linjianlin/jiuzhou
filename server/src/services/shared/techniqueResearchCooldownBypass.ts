/**
 * 洞府研修冷却绕过令牌共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义洞府研修无视冷却令牌的静态配置与启用规则，避免 service、route、测试各自硬编码令牌信息。
 * 2. 做什么：统一描述“启用令牌即本次推演无视当前冷却，且不会重置或新增研修冷却”的开关语义。
 * 3. 不做什么：不读取数据库、不扣除背包道具，也不负责前端渲染。
 *
 * 输入/输出：
 * - 输入：前端提交的 `cooldownBypassEnabled` 布尔值。
 * - 输出：是否需要消耗令牌、是否需要绕过冷却的统一布尔判断，以及令牌静态常量。
 *
 * 数据流/状态流：
 * 前端勾选状态 -> 本模块统一解释 -> 研修状态接口 / 创建任务前校验 / 扣除道具。
 *
 * 关键边界条件与坑点：
 * 1. 该令牌唯一职责就是绕过冷却，因此“是否消耗令牌”和“是否绕过冷却”必须共享同一判断，避免出现扣了道具却没跳过冷却的分叉。
 * 2. 令牌配置必须集中在这里；后续如果改道具 ID、消耗数量或文案语义，只改一处即可，避免前后端口径漂移。
 */

export const TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID = 'token-005';
export const TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST = 1;
export const TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN = true;

export const shouldTechniqueResearchUseCooldownBypassToken = (
  cooldownBypassEnabled: boolean,
): boolean => {
  return cooldownBypassEnabled;
};

export const shouldTechniqueResearchBypassCooldownWithToken = (
  cooldownBypassEnabled: boolean,
): boolean => {
  return TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN
    && shouldTechniqueResearchUseCooldownBypassToken(cooldownBypassEnabled);
};
