/**
 * 角色数据推送工具。
 * 调用 GameServer.pushCharacterUpdate 通知客户端刷新角色数据。
 * 推送失败时静默忽略（不影响主流程）。
 */
import { getGameServer } from '../game/gameServer.js';

export const safePushCharacterUpdate = async (userId: number): Promise<void> => {
  try {
    const gameServer = getGameServer();
    await gameServer.pushCharacterUpdate(userId);
  } catch { /* 推送失败不阻塞主流程 */ }
};
