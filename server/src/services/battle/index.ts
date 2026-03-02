/**
 * 九州修仙录 - 战斗服务层（导出聚合）
 *
 * 作用：对外暴露战斗模块的公共 API，内部实现已拆分至各子模块。
 * 不做什么：不承载任何业务逻辑。
 *
 * 子模块结构：
 * - shared/helpers.ts      类型转换与通用工具
 * - shared/skills.ts       技能数据加载与转换
 * - shared/monsters.ts     怪物运行时数据解析
 * - shared/effects.ts      套装/词缀效果查询
 * - shared/preparation.ts  战斗准备阶段通用逻辑
 * - runtime/state.ts       全局状态管理
 * - runtime/ticker.ts      tick 驱动与推送
 * - runtime/persistence.ts Redis 持久化
 * - pve.ts                 PVE 战斗发起
 * - pvp.ts                 PVP 战斗与竞技场结算
 * - action.ts              玩家行动与逃离
 * - settlement.ts          战斗结算
 * - lifecycle.ts           恢复/清理/关闭
 * - teamHooks.ts           组队钩子
 * - snapshot.ts            角色战斗快照
 * - queries.ts             状态查询
 * - battleTypes.ts         公共类型
 */

// ------ 类型 ------
export type { BattleResult, StartDungeonPVEBattleOptions } from "./battleTypes.js";

// ------ 常量 ------
export { BATTLE_TICK_MS, BATTLE_START_COOLDOWN_MS } from "./runtime/state.js";

// ------ PVE ------
export { startPVEBattle, startDungeonPVEBattle } from "./pve.js";

// ------ PVP ------
export { startPVPBattle } from "./pvp.js";

// ------ 玩家行动 ------
export { playerAction, abandonBattle } from "./action.js";

// ------ 查询 ------
export { getBattleState } from "./queries.js";
export { isCharacterInBattle } from "./runtime/state.js";

// ------ 生命周期 ------
export { recoverBattlesFromRedis, stopBattleService } from "./lifecycle.js";

// ------ 组队钩子 ------
export { onUserJoinTeam, onUserLeaveTeam, syncBattleStateOnReconnect } from "./teamHooks.js";

// ------ 快照 ------
export { buildCharacterBattleSnapshot } from "./snapshot.js";

// ------ 怪物解析（供 idle 系统使用） ------
export { resolveOrderedMonsters as resolveMonsterDataForBattle } from "./shared/monsters.js";
export type { OrderedMonstersResolveResult } from "./shared/monsters.js";
