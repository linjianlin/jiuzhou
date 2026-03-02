/**
 * 战斗服务公共类型
 *
 * 作用：定义 battle 子模块间共享的类型，避免循环依赖。
 *
 * 边界条件：
 * 1) BattleResult 是所有战斗接口的统一返回类型
 * 2) StartDungeonPVEBattleOptions 仅 pve.ts 使用，但定义在此避免 pve->state 循环
 */

import type { PoolClient } from "pg";

export interface BattleResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

type QueryExecutor = Pick<PoolClient, "query">;

export type StartDungeonPVEBattleOptions = {
  resourceSyncClient?: QueryExecutor;
  /** 跳过战斗冷却检查（秘境推进时使用，因为秘境战斗由系统驱动，不应受手动发起的冷却限制） */
  skipCooldown?: boolean;
};

export type BattleStartCooldownValidation = {
  message: string;
  retryAfterMs: number;
  cooldownMs: number;
  nextBattleAvailableAt: number;
};
