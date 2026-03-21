/**
 * 千层塔战斗运行时索引。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：维护 `battleId -> tower runtime` 的单一映射，让结算与恢复都能拿到塔层算法生成的怪物与预览数据。
 * 2. 做什么：把 BattleSession 之外的塔专属运行态收口，避免散落在 battle service 或 route 层。
 * 3. 不做什么：不持久化进度，不负责创建 battle session。
 *
 * 输入/输出：
 * - 输入：塔服务在开战时注册的运行时记录。
 * - 输出：结算/恢复阶段按 battleId 读取到的塔层运行时数据。
 *
 * 数据流/状态流：
 * - start tower battle -> register -> settlement / reconnect read -> delete on finish.
 *
 * 关键边界条件与坑点：
 * 1. 该索引只存当前活跃 battle 的塔元数据；战斗结束后必须清理，避免旧 battleId 误命中新 run。
 * 2. 运行时记录里的 `monsters` 必须是已应用塔倍率后的版本，结算不能再回读静态 monster_def。
 */

import type { TowerBattleRuntimeRecord } from './types.js';

const towerBattleRuntimeByBattleId = new Map<string, TowerBattleRuntimeRecord>();

export const registerTowerBattleRuntime = (
  runtime: TowerBattleRuntimeRecord,
): TowerBattleRuntimeRecord => {
  towerBattleRuntimeByBattleId.set(runtime.battleId, runtime);
  return runtime;
};

export const getTowerBattleRuntime = (
  battleId: string,
): TowerBattleRuntimeRecord | null => {
  return towerBattleRuntimeByBattleId.get(battleId) ?? null;
};

export const deleteTowerBattleRuntime = (battleId: string): boolean => {
  return towerBattleRuntimeByBattleId.delete(battleId);
};
