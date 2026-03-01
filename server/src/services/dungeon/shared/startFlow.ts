/**
 * 秘境开启流程编排工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一“先开启战斗，后执行扣费/状态提交”的流程门禁，避免开启失败时发生资源扣减。
 * - 不做什么：不直接操作数据库、不关心具体业务字段，仅编排调用顺序与失败短路。
 *
 * 输入/输出：
 * - 输入：startBattle（开启战斗函数）与 commitOnBattleStarted（战斗成功后的提交函数）。
 * - 输出：成功时返回提交结果，失败时返回标准化 message。
 *
 * 数据流/状态流：
 * - 先调用 startBattle。
 * - 当且仅当 startBattle.success=true 且 battleId 存在时，调用 commitOnBattleStarted。
 * - 任一前置不满足时立即失败返回，后续提交不执行。
 *
 * 关键边界条件与坑点：
 * 1. startBattle 成功但缺少 battleId 视为失败，防止进入“战斗未建立却已扣费”的不一致状态。
 * 2. commitOnBattleStarted 的失败结果必须原样上抛，调用方据此中止流程。
 */

type BattleStartPayload = {
  battleId?: string;
  state?: unknown;
};

type BattleStartResult = {
  success: boolean;
  message?: string;
  data?: BattleStartPayload;
};

type DungeonStartFlowFailure = {
  success: false;
  message: string;
};

export type DungeonStartFlowSuccess<T> = {
  success: true;
  data: T;
};

type CommitOnBattleStarted<T> = (payload: {
  battleId: string;
  state: unknown;
}) => Promise<DungeonStartFlowSuccess<T> | DungeonStartFlowFailure>;

export const runDungeonStartFlow = async <T>(params: {
  startBattle: () => Promise<BattleStartResult>;
  commitOnBattleStarted: CommitOnBattleStarted<T>;
}): Promise<DungeonStartFlowSuccess<T> | DungeonStartFlowFailure> => {
  const battleRes = await params.startBattle();
  const battleId = battleRes.data?.battleId;
  if (!battleRes.success || typeof battleId !== 'string' || battleId.length === 0) {
    return {
      success: false,
      message: battleRes.message || '开启战斗失败',
    };
  }

  return params.commitOnBattleStarted({
    battleId,
    state: battleRes.data?.state,
  });
};
