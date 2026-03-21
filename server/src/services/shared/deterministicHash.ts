/**
 * 稳定 hash / 伪随机共享工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为塔层生成、任务定向挑选等“同输入必得同结果”的业务提供统一 hash 与取样能力，避免各模块各写一版字符串散列。
 * 2. 做什么：把“按 scope + seed 生成稳定索引/小数”的规则集中在单一纯函数模块里，便于复用与测试。
 * 3. 不做什么：不负责业务池构建，不依赖数据库，也不做时间相关随机。
 *
 * 输入/输出：
 * - 输入：字符串种子、候选数组、序号。
 * - 输出：稳定的 `u32`、`0~1` 小数、数组索引或候选项。
 *
 * 数据流/状态流：
 * - 业务方拼好稳定 seed -> 本模块输出 hash / index -> 业务方据此选择怪物、奖励或其他配置项。
 *
 * 关键边界条件与坑点：
 * 1. 所有输入都必须由调用方先归一化为稳定文本；如果把不稳定字段拼进去，输出也会随之漂移。
 * 2. `pickDeterministicItem` 只负责“稳定选取”，不会处理空数组；调用方必须先保证候选池非空。
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const hashTextU32 = (value: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

export const hashTextUnitFloat = (value: string): number => {
  return hashTextU32(value) / 0xffffffff;
};

export const buildDeterministicScopedSeed = (
  scope: string,
  seed: string,
  offset: number = 0,
): string => {
  return `${scope}::${seed}::${Math.max(0, Math.floor(offset))}`;
};

export const pickDeterministicIndex = (params: {
  seed: string;
  length: number;
  offset?: number;
}): number => {
  if (!Number.isInteger(params.length) || params.length <= 0) {
    throw new Error('deterministic hash 缺少可选长度');
  }
  const scopedSeed = buildDeterministicScopedSeed('pick-index', params.seed, params.offset ?? 0);
  return hashTextU32(scopedSeed) % params.length;
};

export const pickDeterministicItem = <T>(params: {
  seed: string;
  items: readonly T[];
  offset?: number;
}): T => {
  const index = pickDeterministicIndex({
    seed: params.seed,
    length: params.items.length,
    offset: params.offset,
  });
  return params.items[index] as T;
};
