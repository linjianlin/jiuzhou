/**
 * AutoSkillPolicyGuard — 自动技能策略结构守卫
 *
 * 作用：
 *   提供统一的运行时结构检查，判断任意值是否是“可用”的自动技能策略。
 *   不负责排序、不负责纠错，不替代路由层的严格校验。
 *
 * 输入/输出：
 *   - hasConfiguredAutoSkillPolicy(policy: unknown): policy is AutoSkillPolicy
 *     输入任意值，返回是否满足“slots 为非空数组”。
 *
 * 数据流：
 *   持久化会话快照（session_snapshot.autoSkillPolicy）→ 执行器读取 →
 *   Guard 判定可用性 → 可用则注入技能选择器，不可用则走默认 AI。
 *
 * 关键边界条件与坑点：
 *   1. 仅做最小结构守卫（slots 非空数组），不做向后兼容转换，避免隐式改写业务语义。
 *   2. 该守卫用于运行期防崩溃；策略合法性与字段级错误仍由 validateAutoSkillPolicy 负责。
 */

import type { AutoSkillPolicy } from './types.js';

/**
 * 判断策略是否可用于战斗执行器。
 */
export function hasConfiguredAutoSkillPolicy(policy: unknown): policy is AutoSkillPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    return false;
  }

  const slots = (policy as { slots?: unknown }).slots;
  return Array.isArray(slots) && slots.length > 0;
}
