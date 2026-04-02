/**
 * 云游奇遇幕数规划规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中声明云游故事允许的目标幕数范围，并根据 `storySeed` 为每条故事确定固定总幕数。
 * 2. 做什么：把“同一条故事每天推进时仍命中同一个目标幕数”的规则收敛为纯函数，避免 service 和测试各自复制计算逻辑。
 * 3. 不做什么：不决定单幕剧情内容，不调用 AI，也不处理数据库读写。
 *
 * 输入/输出：
 * - 输入：故事种子 `storySeed`。
 * - 输出：该故事固定的目标总幕数，范围始终落在 5 到 15 幕之间。
 *
 * 数据流/状态流：
 * createTodayEpisode 生成或读取 `storySeed` -> 本模块计算 `targetEpisodeCount` -> service 把目标幕数传给 AI 并据此校验结局时机。
 *
 * 复用设计说明：
 * - 幕数范围与种子到幕数的映射属于稳定业务规则，单独放在纯函数模块里，能让服务层、测试层共享同一入口。
 * - 后续若要调整幕数范围或改分布算法，只需要修改这一处，不会在 prompt 入参、结局校验和测试里散落重复逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 目标幕数必须是“同一 storySeed 恒定映射到同一结果”，否则跨天推进时故事会在不同总幕数之间漂移。
 * 2. 输出值必须始终落在闭区间 5 到 15 内，否则服务层的结局时机和前端预期会失真。
 */

export const WANDER_MIN_TARGET_EPISODE_COUNT = 1;
export const WANDER_MAX_TARGET_EPISODE_COUNT = 2;

const WANDER_TARGET_EPISODE_RANGE_SIZE =
  WANDER_MAX_TARGET_EPISODE_COUNT - WANDER_MIN_TARGET_EPISODE_COUNT + 1;

export const resolveWanderTargetEpisodeCount = (storySeed: number): number => {
  const normalizedStorySeed = Math.abs(Math.trunc(storySeed));
  return WANDER_MIN_TARGET_EPISODE_COUNT + (normalizedStorySeed % WANDER_TARGET_EPISODE_RANGE_SIZE);
};
