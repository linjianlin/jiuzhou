/**
 * 战斗状态查询
 *
 * 作用：提供 getBattleState 供路由层查询当前战斗状态。
 *
 * 边界条件：
 * 1) 战斗已结束时触发 finishBattle 进行结算
 * 2) 战斗不存在时尝试从已结束缓存中查找
 */

import type { BattleResult } from "./battleTypes.js";
import {
  activeBattles,
  getFinishedBattleResultIfFresh,
} from "./runtime/state.js";
import { finishBattle, getBattleMonsters } from "./settlement.js";

export async function getBattleState(battleId: string): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);

  if (!engine) {
    const cachedResult = getFinishedBattleResultIfFresh(battleId);
    if (cachedResult) return cachedResult;
    return { success: false, message: "战斗不存在" };
  }

  const state = engine.getState();
  if (state.phase === "finished") {
    const monsters = await getBattleMonsters(engine);
    return await finishBattle(battleId, engine, monsters);
  }

  return {
    success: true,
    message: "获取成功",
    data: {
      state,
    },
  };
}
