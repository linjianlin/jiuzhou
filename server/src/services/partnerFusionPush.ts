/**
 * 三魂归契状态 Socket 推送模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“读取最新三魂归契状态并推送给当前在线用户”收口为单一入口，避免路由和 runner 重复拼装状态。
 * 2. 做什么：复用 `partnerFusionService.getFusionStatus`，保证伙伴弹窗状态与结果提示共用同一真值来源。
 * 3. 不做什么：不负责创建任务、确认结果或执行 AI 生成，也不替代结果提示事件 `partnerFusionResult`。
 *
 * 输入/输出：
 * - 输入：`characterId`，以及可选 `userId`。
 * - 输出：无；副作用是向在线用户发送 `partnerFusion:update`。
 *
 * 数据流/状态流：
 * route / worker / runner 写入归契状态 -> notifyPartnerFusionStatus -> 读取最新状态 -> emit `partnerFusion:update`。
 *
 * 关键边界条件与坑点：
 * 1. 预览生成成功后，主线程必须先完成动态伙伴/功法快照刷新，再推送状态；否则前端会先收到结果却读不到完整预览。
 * 2. 推送失败只能记日志，不能回滚已经落库的归契任务状态。
 */
import { getGameServer } from '../game/gameServer.js';
import { getCharacterUserId } from './sect/db.js';
import { partnerFusionService } from './partnerFusionService.js';

export const notifyPartnerFusionStatus = async (
  characterId: number,
  userId?: number,
): Promise<void> => {
  try {
    const resolvedUserId = userId ?? await getCharacterUserId(characterId);
    if (!resolvedUserId) return;

    const result = await partnerFusionService.getFusionStatus(characterId);
    if (!result.success || !result.data) return;

    getGameServer().emitToUser(resolvedUserId, 'partnerFusion:update', {
      characterId,
      status: result.data,
    });
  } catch (error) {
    console.error(`[partnerFusion] 推送归契状态失败: characterId=${characterId}`, error);
  }
};
