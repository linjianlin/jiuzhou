/**
 * 九州修仙录 - boardgame.io 游戏定义
 */
import type { Game, Ctx } from 'boardgame.io';
import type { GameState, CharacterAttributes } from './GameState.js';
import { initialGameState, dbToCharacterAttributes } from './GameState.js';
import { query } from '../config/database.js';

// 加点类型
type AttributeKey = 'jing' | 'qi' | 'shen';

// 游戏动作
const moves = {
  // 玩家加入游戏
  joinGame: ({ G, playerID }: { G: GameState; ctx: Ctx; playerID: string }, _userId: number) => {
    if (!G.players[playerID]) {
      G.players[playerID] = {
        id: playerID,
        character: null,
        online: true,
        lastUpdate: Date.now(),
      };
    }
    G.players[playerID].online = true;
    G.players[playerID].lastUpdate = Date.now();
    G.version++;
  },

  // 更新角色数据
  updateCharacter: ({ G, playerID }: { G: GameState; ctx: Ctx; playerID: string }, character: CharacterAttributes) => {
    if (G.players[playerID]) {
      G.players[playerID].character = character;
      G.players[playerID].lastUpdate = Date.now();
      G.version++;
    }
  },

  // 加点操作（同步版本，实际数据库操作在服务端处理）
  addAttributePoint: (
    { G, playerID }: { G: GameState; ctx: Ctx; playerID: string },
    attributeKey: AttributeKey,
    amount: number = 1
  ) => {
    const player = G.players[playerID];
    if (!player?.character) return;

    const character = player.character;
    if (character.attributePoints < amount) return;

    // 更新本地状态
    character[attributeKey] += amount;
    character.attributePoints -= amount;
    player.lastUpdate = Date.now();
    G.version++;
  },

  // 玩家离线
  playerOffline: ({ G, playerID }: { G: GameState; ctx: Ctx; playerID: string }) => {
    if (G.players[playerID]) {
      G.players[playerID].online = false;
      G.players[playerID].lastUpdate = Date.now();
      G.version++;
    }
  },
};

// 九州修仙录游戏定义
export const JiuzhouGame: Game<GameState> = {
  name: 'jiuzhou-xiuxian',
  
  setup: (): GameState => ({
    ...initialGameState,
    players: {},
    version: 0,
  }),

  moves,

  turn: {
    minMoves: 0,
    maxMoves: Infinity,
  },

  endIf: () => false, // 游戏永不结束
};

// 从数据库加载角色数据
export const loadCharacterFromDB = async (userId: number): Promise<CharacterAttributes | null> => {
  try {
    const result = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) return null;
    return dbToCharacterAttributes(result.rows[0]);
  } catch (error) {
    console.error('加载角色数据失败:', error);
    return null;
  }
};

// 保存加点到数据库
export const saveAttributePointsToDB = async (
  userId: number,
  attributeKey: AttributeKey,
  amount: number
): Promise<boolean> => {
  try {
    const updateSQL = `
      UPDATE characters 
      SET ${attributeKey} = ${attributeKey} + $1,
          attribute_points = attribute_points - $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2 AND attribute_points >= $1
      RETURNING *
    `;
    const result = await query(updateSQL, [amount, userId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('保存加点失败:', error);
    return false;
  }
};

export default JiuzhouGame;
