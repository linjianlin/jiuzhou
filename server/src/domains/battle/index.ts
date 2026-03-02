/**
 * 战斗领域门面
 * 作用：为路由层提供稳定导入入口，内部实现仍由 services 承载。
 */
import {
  abandonBattle,
  getBattleState,
  recoverBattlesFromRedis,
  startDungeonPVEBattle,
  startPVEBattle,
  startPVPBattle,
  playerAction,
  isCharacterInBattle,
} from '../../services/battle/index.js';

export const battleService = {
  startPVEBattle,
  startDungeonPVEBattle,
  startPVPBattle,
  playerAction,
  getBattleState,
  abandonBattle,
  isCharacterInBattle,
  recoverBattlesFromRedis,
};

export {
  abandonBattle,
  getBattleState,
  recoverBattlesFromRedis,
  startDungeonPVEBattle,
  startPVEBattle,
  startPVPBattle,
  playerAction,
  isCharacterInBattle,
} from '../../services/battle/index.js';

export {
  onUserJoinTeam,
  onUserLeaveTeam,
  syncBattleStateOnReconnect,
} from '../../services/battle/index.js';

export {
  stopBattleService,
} from '../../services/battle/index.js';

export {
  buildCharacterBattleSnapshot,
} from '../../services/battle/index.js';

export {
  resolveMonsterDataForBattle,
} from '../../services/battle/index.js';

export {
  BATTLE_TICK_MS,
  BATTLE_START_COOLDOWN_MS,
} from '../../services/battle/index.js';

export type { BattleResult, StartDungeonPVEBattleOptions } from '../../services/battle/index.js';
