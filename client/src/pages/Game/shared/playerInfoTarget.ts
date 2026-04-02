/**
 * 玩家信息目标构建工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中把不同模块拿到的玩家最小展示字段转换成 `InfoModal` 可消费的 `player` 目标结构。
 * 2. 做什么：统一昵称、称号、境界、头像与月卡状态的基础清洗口径，避免聊天、队伍、排行再次各写一套玩家详情入口对象。
 * 3. 不做什么：不拉取玩家完整详情，不补充装备/功法占位数据，也不处理点击或弹窗状态。
 *
 * 输入 / 输出：
 * - 输入：玩家 id、昵称、可选称号、月卡状态、性别、境界、头像。
 * - 输出：`MapObjectDto` 中 `type === 'player'` 的最小可展示对象。
 *
 * 数据流 / 状态流：
 * 各模块已有玩家摘要 DTO -> 本工具标准化 -> `InfoModal` 先渲染基础信息 -> 命中真实角色 id 时再由详情接口补全。
 *
 * 复用设计说明：
 * 1. 玩家详情弹窗入口在聊天、队伍、排行榜都会出现，抽成纯函数后只保留一个对象拼装入口。
 * 2. 这些字段属于高频业务变化点，后续如果玩家列表还要补签名、头衔描述等信息，只需要扩这一处。
 *
 * 关键边界条件与坑点：
 * 1. `id` 必须由调用方传入最终值；本工具不猜测角色 id，避免把临时会话标识误当成真实角色详情 id。
 * 2. 未知信息只做最小展示值归一化，不写伪造装备/功法占位，避免弹窗在详情返回前出现误导内容。
 */
import type { MapObjectDto } from '../../../services/api';

export interface PlayerInfoTargetInput {
  id: string;
  name: string;
  title?: string;
  monthCardActive?: boolean;
  gender?: string;
  realm?: string;
  avatar?: string | null;
}

const normalizeText = (value: string | null | undefined): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
};

export const buildPlayerInfoTarget = (input: PlayerInfoTargetInput): Extract<MapObjectDto, { type: 'player' }> => {
  return {
    type: 'player',
    id: input.id,
    name: normalizeText(input.name) ?? '未知',
    title: normalizeText(input.title),
    monthCardActive: input.monthCardActive === true,
    gender: normalizeText(input.gender) ?? '-',
    realm: normalizeText(input.realm) ?? '-',
    avatar: input.avatar ?? null,
  };
};
