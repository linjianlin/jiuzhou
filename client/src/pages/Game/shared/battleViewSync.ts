/**
 * Game 页 socket 战斗视图接管规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一判定某个 socket `battle:update` 是否应该接管为“队友战斗视图 / 重连战斗视图”，还是应继续保留 BattleArea 已持有的普通地图本地战斗。
 * 2. 做什么：把普通地图本地连战与外部 `reconnectBattleId` 的边界收口，避免多个 socket 分支各自拼条件，反复把普通地图战斗误判成重连战斗。
 * 3. 不做什么：不直接修改 React state、不请求接口，也不决定 BattleArea 的自动下一场策略。
 *
 * 输入/输出：
 * - 输入：当前 socket battleId、队伍身份、Game 当前视图，以及是否已存在当前会话 battleId / 重连 battleId / 本地普通地图战斗上下文。
 * - 输出：`RealtimeBattleViewSyncMode`，供 Game 页决定接管 teamBattleId / reconnectBattleId，或保持本地战斗不变。
 *
 * 数据流/状态流：
 * - socket battle:update -> 本模块判定接管模式 -> Game 页决定是否写入 teamBattleId / reconnectBattleId 或接管 battleSession -> BattleArea 再依据 externalBattleId 决定是否走外部驱动。
 *
 * 关键边界条件与坑点：
 * 1. 普通地图本地战斗在 BattleArea 已经持有时，不能再额外写入 reconnectBattleId；否则 BattleArea 会把“本地连战”误判成“外部战斗等待 onNext”，自动下一场会被掐断。
 * 2. 真正的重连场景仍要允许接管同样的 `battle-*` 战斗，因此只有“已在 battle 视图、已有本地怪物目标、且当前没有任何外部战斗上下文”时，才允许保留本地战斗。
 */

export type RealtimeBattleViewSyncMode =
  | 'keep_local_battle'
  | 'sync_team_battle'
  | 'sync_reconnect_battle';

type ShouldRestoreBattleSessionFromRealtimeParams = {
  syncMode: RealtimeBattleViewSyncMode;
  hasSessionPayload: boolean;
};

type BattleViewMode = 'map' | 'battle';

const PLAIN_MAP_BATTLE_ID_PREFIX = 'battle-';

const isPlainMapBattleId = (battleId: string): boolean => {
  return battleId.startsWith(PLAIN_MAP_BATTLE_ID_PREFIX);
};

export const resolveRealtimeBattleViewSyncMode = (params: {
  battleId: string;
  inTeam: boolean;
  isTeamLeader: boolean;
  viewMode: BattleViewMode;
  hasLocalBattleTargets: boolean;
  currentSessionBattleId: string | null;
  currentReconnectBattleId: string | null;
}): RealtimeBattleViewSyncMode => {
  if (params.inTeam && !params.isTeamLeader) {
    return 'sync_team_battle';
  }

  const hasExternalBattleContext = Boolean(
    params.currentSessionBattleId || params.currentReconnectBattleId,
  );
  const isHoldingLocalPlainMapBattle =
    params.viewMode === 'battle'
    && params.hasLocalBattleTargets
    && isPlainMapBattleId(params.battleId)
    && !hasExternalBattleContext;

  if (isHoldingLocalPlainMapBattle) {
    return 'keep_local_battle';
  }

  return 'sync_reconnect_battle';
};

/**
 * battle realtime 驱动下的 session 恢复策略。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一判定某次 socket 战斗接管后，是否还需要按 battleId 补查 BattleSession，避免 Game 页在 battle_started / battle_finished 两处分支重复拼条件。
 * 2. 做什么：让“队友视角但服务端已附带 session 的秘境/会话战斗”也能恢复成正式 session，上层不再只停留在临时 teamBattleId 回放态。
 * 3. 不做什么：不发请求、不持有 React 状态，也不关心 session 具体内容是否合法。
 *
 * 输入/输出：
 * - 输入：当前接管模式，以及该条 realtime 是否显式携带 session。
 * - 输出：是否应该继续执行按 battleId 的 session 恢复。
 *
 * 数据流/状态流：
 * - Game 收到 battle realtime -> 先决定接管模式 -> 本函数判断是否需要补做 session 恢复 -> Game 再决定是否调用 restoreBattleSessionContext。
 *
 * 关键边界条件与坑点：
 * 1. `keep_local_battle` 必须严格跳过恢复，否则普通地图本地战斗会被误抢成外部 session。
 * 2. `sync_team_battle` 只有在服务端明确附带 session 时才恢复，避免普通组队战斗的高频 `battle_state` 误触发无意义请求。
 */
export const shouldRestoreBattleSessionFromRealtime = (
  params: ShouldRestoreBattleSessionFromRealtimeParams,
): boolean => {
  if (params.syncMode === 'keep_local_battle') {
    return false;
  }
  if (params.syncMode === 'sync_reconnect_battle') {
    return true;
  }
  return params.hasSessionPayload;
};
