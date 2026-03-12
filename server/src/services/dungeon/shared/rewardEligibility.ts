/**
 * 秘境可领奖资格工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一封装“开战时固化可领奖角色名单”与“结算时按名单筛选参与者”的规则。
 * - 不做什么：不负责数据库读写、不负责奖励发放本身。
 *
 * 输入/输出：
 * - buildDungeonRewardEligibleCharacterIds 输入参与者列表，输出去重且有序的可领奖角色ID数组。
 * - selectDungeonRewardEligibleParticipants 输入当前参与者列表与 instance_data，输出有领奖资格的参与者列表。
 *
 * 数据流/状态流：
 * 1) startDungeonInstance 在开战提交阶段调用 build*，并把结果写入 instance_data.rewardEligibleCharacterIds。
 * 2) nextDungeonInstance 在通关结算阶段调用 select*，只对筛出的参与者执行发奖与任务事件记录。
 *
 * 关键边界条件与坑点：
 * 1) 资格名单字段缺失或非法时，select* 返回空列表（严格模式，不做“回退到全部参与者”的兼容逻辑）。
 * 2) 输入参与者可能出现非法 characterId 或重复角色，构建与筛选两个函数都会做过滤与去重。
 */

import { asArray, asNumber, asObject } from './typeUtils.js';
import type { DungeonInstanceParticipant } from '../types.js';

/** 秘境实例数据中“可领奖角色ID列表”的固定字段名。 */
export const DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD = 'rewardEligibleCharacterIds' as const;

/** 基于当前参与者生成可领奖角色ID列表（去重 + 升序 + 仅保留正整数）。 */
export const buildDungeonRewardEligibleCharacterIds = (
  participants: DungeonInstanceParticipant[],
): number[] => {
  const uniqueCharacterIds = new Set<number>();
  for (const participant of participants) {
    const characterId = Math.floor(Number(participant.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    uniqueCharacterIds.add(characterId);
  }
  return Array.from(uniqueCharacterIds.values()).sort((left, right) => left - right);
};

/** 从 instance_data 解析可领奖角色ID集合（仅保留正整数，自动去重）。 */
export const parseDungeonRewardEligibleCharacterIdSet = (
  instanceData: unknown,
): Set<number> => {
  const dataObject = asObject(instanceData);
  if (!dataObject) return new Set<number>();

  const rawCharacterIds = asArray(dataObject[DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD]);
  const eligibleCharacterIds = new Set<number>();
  for (const rawId of rawCharacterIds) {
    const parsedCharacterId = Math.floor(asNumber(rawId, 0));
    if (!Number.isFinite(parsedCharacterId) || parsedCharacterId <= 0) continue;
    eligibleCharacterIds.add(parsedCharacterId);
  }

  return eligibleCharacterIds;
};

/** 判断 instance_data 是否显式写入了可领奖名单字段。 */
export const hasDungeonRewardEligibleCharacterIdsField = (
  instanceData: unknown,
): boolean => {
  const dataObject = asObject(instanceData);
  if (!dataObject) return false;
  return Object.prototype.hasOwnProperty.call(dataObject, DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD);
};

/** 基于 instance_data 中固化的名单筛选可领奖参与者（保持原顺序，按角色去重）。 */
export const selectDungeonRewardEligibleParticipants = (
  participants: DungeonInstanceParticipant[],
  instanceData: unknown,
): DungeonInstanceParticipant[] => {
  const eligibleCharacterIds = parseDungeonRewardEligibleCharacterIdSet(instanceData);
  if (eligibleCharacterIds.size === 0) return [];

  const selectedParticipants: DungeonInstanceParticipant[] = [];
  const seenCharacterIds = new Set<number>();
  for (const participant of participants) {
    const characterId = Math.floor(Number(participant.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!eligibleCharacterIds.has(characterId)) continue;
    if (seenCharacterIds.has(characterId)) continue;
    selectedParticipants.push(participant);
    seenCharacterIds.add(characterId);
  }

  return selectedParticipants;
};
