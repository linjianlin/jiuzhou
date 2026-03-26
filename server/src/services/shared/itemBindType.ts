/**
 * 物品绑定态标准化工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一后端对 `bind_type` 的标准化口径，把空值、空字符串、大小写不一致统一收敛成稳定字符串。
 * - 做什么：提供与运行时标准化一致的 SQL 表达式，给堆叠查询与热点索引复用。
 * - 做什么：为背包整理、入包堆叠、装备解绑等链路提供单一绑定态入口，避免“玩家看起来同一种未绑定，服务端却按不同值分组”。
 * - 不做什么：不负责绑定业务规则判定，不决定是否允许交易/解绑，也不做前端展示映射。
 *
 * 输入/输出：
 * - 输入：`string | null | undefined` 的原始 `bind_type`。
 * - 输出：标准化后的绑定态字符串；空语义统一输出为 `none`。
 *
 * 数据流/状态流：
 * - 调用方从数据库、静态配置或请求参数拿到原始绑定态；
 * - 本模块负责做最小必要的 trim + lowercase + 空语义归一；
 * - 调用方再基于标准化结果做分组、比较或回写。
 *
 * 关键边界条件与坑点：
 * 1. 历史数据可能存在 `NULL / '' / ' NONE '` 这类“玩家视角未绑定、存储值却不一致”的情况，不先归一就会导致堆叠分组失真。
 * 2. 未知非空绑定值必须原样保留其语义，只做大小写与首尾空白标准化，避免把新绑定类型误吞成 `none`。
 */

export const normalizeItemBindType = (
  value: string | null | undefined,
): string => {
  if (typeof value !== "string") {
    return "none";
  }
  const normalized = value.trim().toLowerCase();
  return normalized || "none";
};

export const buildNormalizedItemBindTypeSql = (
  columnExpression: string,
): string => {
  return `COALESCE(NULLIF(LOWER(BTRIM(${columnExpression})), ''), 'none')`;
};
