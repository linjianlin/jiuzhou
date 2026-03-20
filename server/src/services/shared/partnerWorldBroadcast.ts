/**
 * 伙伴世界播报共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一处理“获得天级伙伴”的世界播报口径，供伙伴招募与三魂归契复用。
 * 2) 做什么：把天级判断、角色昵称读取与系统消息模板集中到一个入口，避免不同获得来源各写一份广播分支。
 * 3) 不做什么：不创建伙伴实例，不推进业务任务状态，也不负责前端推送。
 *
 * 输入/输出：
 * - 输入：角色 ID、伙伴定义 ID、伙伴名、来源标签。
 * - 输出：无；副作用是向世界频道发送系统播报。
 *
 * 数据流/状态流：
 * 业务确认收下 -> 本模块校验是否为天级 -> 读取角色昵称 -> 广播世界系统消息。
 *
 * 关键边界条件与坑点：
 * 1) 只有最终获得的是天级伙伴时才播报，不能把预览生成成功也误报给全服。
 * 2) 来源标签由调用方显式传入，避免共享模块反向耦合具体业务文案。
 */
import { getPartnerDefinitionById } from '../staticConfigLoader.js';
import { getCharacterNicknameById } from './characterNickname.js';
import { broadcastWorldSystemMessage } from './worldChatBroadcast.js';

export const broadcastHeavenPartnerAcquired = async (params: {
  characterId: number;
  partnerDefId: string;
  partnerName: string;
  sourceLabel: string;
}): Promise<void> => {
  const definition = getPartnerDefinitionById(params.partnerDefId);
  if (!definition || definition.quality !== '天') {
    return;
  }

  const nickname = await getCharacterNicknameById(params.characterId);
  if (!nickname) {
    return;
  }

  broadcastWorldSystemMessage({
    senderTitle: '天机传音',
    content: `【${params.sourceLabel}】『${nickname}』获得天级伙伴【${params.partnerName}】，灵契共鸣，声传九州！`,
  });
};
