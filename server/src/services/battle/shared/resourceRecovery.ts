/**
 * 战斗资源恢复共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装战前资源恢复、战斗胜利后恢复与失败扣血，避免同一套“批量读角色 -> 计算目标资源 -> 写回缓存”逻辑散落在开战和结算链路里。
 * 2. 做什么：复用 `characterComputedService` 的批量读取与免重复读写入入口，把原先逐角色串行的资源恢复改成批量读取后并行写回。
 * 3. 不做什么：不处理奖励发放，也不负责 websocket 推送。
 *
 * 输入/输出：
 * - buildBattleStartRecoveredResourceState(computed)：输入角色属性快照，输出开战前应恢复到的资源状态。
 * - buildVictoryRecoveredResourceState(computed)：输入角色属性快照，输出战斗胜利后应恢复到的资源状态。
 * - buildFailureReducedResourceState(computed)：输入角色属性快照，输出战斗失败后应扣减到的资源状态。
 * - recoverBattleStartResourcesByUserIds(userIds)：输入参与用户 ID 列表，批量恢复开战资源。
 * - restoreCharacterResourcesAfterVictoryByCharacterIds(characterIds)：输入参战角色 ID 列表，批量恢复胜利后资源。
 * - applyBattleFailureResourceLossByCharacterIds(characterIds)：输入参战角色 ID 列表，批量扣减失败惩罚气血。
 *
 * 数据流/状态流：
 * - 开战：battle start -> 本模块批量读取 userId 对应角色 -> 统一计算战前资源 -> 回写运行时资源缓存。
 * - 结算：battle finish -> 本模块批量读取 characterId -> 统一计算回血结果 -> 回写运行时资源缓存。
 *
 * 关键边界条件与坑点：
 * 1. 这里只允许依赖批量查询入口，不能回退到逐角色 `getCharacterComputedBy*`，否则高并发时仍会把延迟摊回 N 次查询。
 * 2. 写回的是运行时资源缓存，不是直接更新 battle state；调用方仍需保证调用时机在战斗注册/结算流程的正确阶段。
 */

import type { CharacterComputedRow } from '../../characterComputedService.js';
import {
  getOnlineBattleCharacterSnapshotsByCharacterIds,
  getOnlineBattleCharacterSnapshotsByUserIds,
  persistOnlineBattleCharacterSnapshotsBatch,
  type OnlineBattleCharacterSnapshot,
} from '../../onlineBattleProjectionService.js';

type CharacterResourceState = {
  qixue: number;
  lingqi: number;
};

const buildRecoveredSnapshots = (
  snapshots: Iterable<OnlineBattleCharacterSnapshot>,
  buildNextState: (computed: CharacterComputedRow) => CharacterResourceState,
): OnlineBattleCharacterSnapshot[] => {
  const nextSnapshots: OnlineBattleCharacterSnapshot[] = [];

  for (const snapshot of snapshots) {
    const next = buildNextState(snapshot.computed);
    nextSnapshots.push({
      ...snapshot,
      computed: {
        ...snapshot.computed,
        qixue: Math.min(snapshot.computed.max_qixue, Math.max(0, Math.floor(next.qixue))),
        lingqi: Math.min(snapshot.computed.max_lingqi, Math.max(0, Math.floor(next.lingqi))),
      },
    });
  }

  return nextSnapshots;
};

export const buildBattleStartRecoveredResourceState = (
  computed: CharacterComputedRow,
): CharacterResourceState => {
  const targetLingqi = Math.max(0, Math.floor(computed.max_lingqi * 0.5));
  return {
    qixue: computed.max_qixue,
    lingqi: Math.max(computed.lingqi, targetLingqi),
  };
};

export const buildVictoryRecoveredResourceState = (
  computed: CharacterComputedRow,
): CharacterResourceState => {
  const healAmount = Math.floor(computed.max_qixue * 0.3);
  return {
    qixue: Math.min(computed.max_qixue, computed.qixue + healAmount),
    lingqi: computed.lingqi,
  };
};

export const buildFailureReducedResourceState = (
  computed: CharacterComputedRow,
): CharacterResourceState => {
  const lossAmount = Math.floor(computed.max_qixue * 0.1);
  return {
    qixue: Math.max(1, computed.qixue - lossAmount),
    lingqi: computed.lingqi,
  };
};

export const recoverBattleStartResourcesByUserIds = async (
  userIds: number[],
): Promise<void> => {
  const computedMap = await getOnlineBattleCharacterSnapshotsByUserIds(userIds);
  const nextSnapshots = buildRecoveredSnapshots(
    computedMap.values(),
    buildBattleStartRecoveredResourceState,
  );
  await persistOnlineBattleCharacterSnapshotsBatch(nextSnapshots);
};

export const restoreCharacterResourcesAfterVictoryByCharacterIds = async (
  characterIds: number[],
): Promise<void> => {
  const computedMap = await getOnlineBattleCharacterSnapshotsByCharacterIds(characterIds);
  const nextSnapshots = buildRecoveredSnapshots(
    computedMap.values(),
    buildVictoryRecoveredResourceState,
  );
  await persistOnlineBattleCharacterSnapshotsBatch(nextSnapshots);
};

export const applyBattleFailureResourceLossByCharacterIds = async (
  characterIds: number[],
): Promise<void> => {
  const computedMap = await getOnlineBattleCharacterSnapshotsByCharacterIds(characterIds);
  const nextSnapshots = buildRecoveredSnapshots(
    computedMap.values(),
    buildFailureReducedResourceState,
  );
  await persistOnlineBattleCharacterSnapshotsBatch(nextSnapshots);
};
