/**
 * BattleSession 统一战斗会话类型定义。
 *
 * 作用：
 * - 统一描述普通战斗、秘境战斗、PVP 战斗在“单场 battle 外层”的公共状态；
 * - 把“当前 battleId、会话状态、下一步动作、模式上下文”收敛成服务端单一数据源。
 *
 * 不做什么：
 * - 不定义单场战斗内部单位/日志结构；
 * - 不承载 React/UI 专用字段。
 *
 * 输入/输出：
 * - 输入：服务端启动/推进战斗时写入的会话记录。
 * - 输出：路由、socket、前端统一消费的 `BattleSessionSnapshot`。
 *
 * 数据流：
 * start session -> runtime record -> snapshot -> route/socket -> client active session
 *
 * 边界条件：
 * 1) 上下文按类型严格区分，禁止把 dungeon/pvp 字段混进普通 pve。
 * 2) `currentBattleId` 为空表示当前会话没有进行中的单场战斗，调用方必须看 `nextAction/status` 决定后续动作。
 */

export type BattleSessionType = 'pve' | 'dungeon' | 'pvp' | 'tower';

export type BattleSessionStatus =
  | 'running'
  | 'waiting_transition'
  | 'completed'
  | 'failed'
  | 'abandoned';

export type BattleSessionNextAction =
  | 'none'
  | 'advance'
  | 'return_to_map';

export type BattleSessionResult = 'attacker_win' | 'defender_win' | 'draw' | null;

export interface PveBattleSessionContext {
  monsterIds: string[];
}

export interface DungeonBattleSessionContext {
  instanceId: string;
}

export interface PvpBattleSessionContext {
  opponentCharacterId: number;
  mode: 'arena' | 'challenge';
}

export interface TowerBattleSessionContext {
  runId: string;
  floor: number;
}

export type BattleSessionContext =
  | PveBattleSessionContext
  | DungeonBattleSessionContext
  | PvpBattleSessionContext
  | TowerBattleSessionContext;

export interface BattleSessionRecord {
  sessionId: string;
  type: BattleSessionType;
  ownerUserId: number;
  participantUserIds: number[];
  currentBattleId: string | null;
  status: BattleSessionStatus;
  nextAction: BattleSessionNextAction;
  canAdvance: boolean;
  lastResult: BattleSessionResult;
  context: BattleSessionContext;
  createdAt: number;
  updatedAt: number;
}

export interface BattleSessionSnapshot {
  sessionId: string;
  type: BattleSessionType;
  ownerUserId: number;
  participantUserIds: number[];
  currentBattleId: string | null;
  status: BattleSessionStatus;
  nextAction: BattleSessionNextAction;
  canAdvance: boolean;
  lastResult: BattleSessionResult;
  context: BattleSessionContext;
}
