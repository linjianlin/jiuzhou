/**
 * PVE 战斗开启策略
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一描述普通战斗、秘境推进、千层塔在“开战冷却 / 战后冷却”上的服务端判定口径，避免多个调用点各写一套条件。
 * 2. 做什么：让 `pve.ts`、`preparation.ts`、`tower service`、`settlement.ts` 复用同一份策略对象，减少规则漂移。
 * 3. 不做什么：不创建战斗、不查询数据库，也不直接返回业务错误。
 *
 * 输入/输出：
 * - 输入：固定的 PVE/塔战策略对象。
 * - 输出：发起者是否需要校验冷却、队员是否需要校验冷却、战后是否需要进入冷却。
 *
 * 数据流/状态流：
 * - PVE/秘境/千层塔开战入口选择策略 -> 本模块给出冷却判定 -> 调用方执行实际冷却校验或跳过。
 * - 战斗结算阶段根据 battle flow 复用同一策略 -> 决定是否下发战后冷却元数据。
 *
 * 关键边界条件与坑点：
 * 1. 秘境推进与千层塔允许跳过冷却只能通过服务端内部策略切换完成，禁止恢复成可由外部调用方透传的布尔参数。
 * 2. 组队冷却范围当前统一为“仅判断发起者”，若未来规则变化，应只修改本模块，不要回到调用处散落分支。
 */

export type BattleStarterCooldownMode = 'required' | 'skipped';

export type TeamMemberCooldownMode = 'starter_only' | 'all_members';

export type BattleSettlementCooldownMode = 'required' | 'skipped';

export type PveBattleStartPolicy = {
  starterCooldownMode: BattleStarterCooldownMode;
  teamMemberCooldownMode: TeamMemberCooldownMode;
  settlementCooldownMode: BattleSettlementCooldownMode;
};

export const PLAYER_DRIVEN_PVE_BATTLE_START_POLICY: PveBattleStartPolicy = {
  starterCooldownMode: 'required',
  teamMemberCooldownMode: 'starter_only',
  settlementCooldownMode: 'required',
};

/**
 * 普通地图 PVE 会话内续战策略。
 *
 * 作用：
 * - 仅用于 `BattleSession` 已进入 waiting_transition 后的“继续下一场”内部推进；
 * - 跳过重复的 starter cooldown 校验，避免客户端已按 ready 触发 advance 后，
 *   服务端又把同一次推进当成“玩家手动重新开战”再次拦截。
 *
 * 不做什么：
 * - 不取消普通地图本身的战后冷却；
 * - 不对外暴露给普通 `/battle/start` 调用。
 *
 * 关键边界条件与坑点：
 * 1. 这里只跳过“续战入口”的 starter cooldown 再校验，结算阶段仍保留普通地图的冷却写入。
 * 2. 若未来普通地图出现非会话内自动续战场景，必须继续使用 PLAYER_DRIVEN_PVE_BATTLE_START_POLICY，不能误复用本策略。
 */
export const SESSION_FLOW_PVE_BATTLE_START_POLICY: PveBattleStartPolicy = {
  starterCooldownMode: 'skipped',
  teamMemberCooldownMode: 'starter_only',
  settlementCooldownMode: 'required',
};

export const DUNGEON_FLOW_PVE_BATTLE_START_POLICY: PveBattleStartPolicy = {
  starterCooldownMode: 'skipped',
  teamMemberCooldownMode: 'starter_only',
  settlementCooldownMode: 'skipped',
};

export const TOWER_PVE_BATTLE_START_POLICY: PveBattleStartPolicy = {
  starterCooldownMode: 'skipped',
  teamMemberCooldownMode: 'starter_only',
  settlementCooldownMode: 'skipped',
};

export const shouldValidateBattleStarterCooldown = (
  policy: PveBattleStartPolicy,
): boolean => {
  return policy.starterCooldownMode === 'required';
};

export const shouldValidateTeamMemberCooldown = (
  policy: PveBattleStartPolicy,
): boolean => {
  return policy.teamMemberCooldownMode === 'all_members';
};

export const shouldApplyBattleSettlementCooldown = (
  policy: PveBattleStartPolicy,
): boolean => {
  return policy.settlementCooldownMode === 'required';
};
