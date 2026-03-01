/**
 * IdleBattleRewardResolver — 挂机战斗奖励统一结算入口
 *
 * 作用：
 *   复用 quickDistributeRewards 作为挂机战斗奖励的唯一结算逻辑，
 *   供普通执行器与 Worker 执行器共同调用，保证奖励规则一致。
 *   不负责战斗模拟，不负责批量落库。
 *
 * 输入/输出：
 *   - resolveIdleBattleRewards(monsterIds, session, userId, battleResult)
 *     输入怪物列表、会话上下文、用户 ID 与战斗胜负；
 *     返回单场奖励快照（exp/silver/items/bagFullFlag）。
 *
 * 数据流：
 *   战斗结果（attacker_win/defender_win/draw）→ rewardResolver
 *   → quickDistributeRewards（统一奖励规则）
 *   → 执行器缓冲区（后续统一落库与汇总）
 *
 * 关键边界条件与坑点：
 *   1. 非 attacker_win 或无 monsterIds 时直接返回零奖励，避免无效 DB 写入。
 *   2. quickDistributeRewards 失败时仅置 bagFullFlag=true，不抛异常，保持挂机循环可持续。
 */

import { battleDropService, type BattleParticipant } from '../battleDropService.js';
import type { IdleSessionRow, RewardItemEntry } from './types.js';

export interface IdleBattleRewardSnapshot {
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  bagFullFlag: boolean;
}

const EMPTY_REWARD: IdleBattleRewardSnapshot = {
  expGained: 0,
  silverGained: 0,
  itemsGained: [],
  bagFullFlag: false,
};

/**
 * 统一计算单场挂机奖励。
 */
export async function resolveIdleBattleRewards(
  monsterIds: string[],
  session: IdleSessionRow,
  userId: number,
  battleResult: 'attacker_win' | 'defender_win' | 'draw',
): Promise<IdleBattleRewardSnapshot> {
  if (battleResult !== 'attacker_win' || monsterIds.length === 0) {
    return EMPTY_REWARD;
  }

  const participant: BattleParticipant = {
    userId,
    characterId: session.characterId,
    nickname: String(session.characterId),
    realm: session.sessionSnapshot.realm,
  };

  const distributeResult = await battleDropService.quickDistributeRewards(monsterIds, [participant], true);
  if (!distributeResult.success) {
    return { ...EMPTY_REWARD, bagFullFlag: true };
  }

  return {
    expGained: distributeResult.rewards.exp,
    silverGained: distributeResult.rewards.silver,
    itemsGained: distributeResult.rewards.items.map((item) => ({
      itemDefId: item.itemDefId,
      itemName: item.itemName,
      quantity: item.quantity,
    })),
    bagFullFlag: false,
  };
}
