/**
 * 秘境参与收益策略工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一解析角色“秘境免体力模式”设置，并推导该角色在秘境中的体力扣减与奖励资格。
 * - 做什么：提供批量读取角色秘境收益策略的单一入口，避免开战校验与结算资格各自查一遍字段。
 * - 不做什么：不直接扣除体力、不直接发放奖励、不写入秘境实例快照。
 *
 * 输入/输出：
 * - resolveDungeonBenefitPolicy 输入角色的 `dungeon_no_stamina_cost` 原始值，输出结构化策略。
 * - loadDungeonBenefitPolicyMap 输入角色 ID 列表，输出 `characterId -> policy` 的 Map。
 *
 * 数据流/状态流：
 * 1) 角色设置页保存 `dungeon_no_stamina_cost` 到 characters 表。
 * 2) startDungeonInstance 开战前批量读取本模块策略，决定“谁需要扣体力”“谁具备奖励资格”。
 * 3) 结算阶段只消费开战时固化的奖励资格名单，避免中途改设置导致结果漂移。
 *
 * 关键边界条件与坑点：
 * 1) `dungeon_no_stamina_cost=true` 时，必须同时生效“免体力 + 无奖励”两条规则，不能只关闭其中一条。
 * 2) 批量读取只返回数据库中存在的角色；调用方必须自行校验缺失角色，避免把脏数据当成默认值继续执行。
 */

import { query } from '../../../config/database.js';

export interface DungeonBenefitPolicy {
  skipStaminaCost: boolean;
  rewardEligible: boolean;
}

export const resolveDungeonBenefitPolicy = (dungeonNoStaminaCost: unknown): DungeonBenefitPolicy => {
  const skipStaminaCost = dungeonNoStaminaCost === true;
  return {
    skipStaminaCost,
    rewardEligible: !skipStaminaCost,
  };
};

export const loadDungeonBenefitPolicyMap = async (
  characterIds: number[],
): Promise<Map<number, DungeonBenefitPolicy>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  const out = new Map<number, DungeonBenefitPolicy>();
  if (normalizedCharacterIds.length <= 0) return out;

  const result = await query(
    `
      SELECT id, dungeon_no_stamina_cost
      FROM characters
      WHERE id = ANY($1::int[])
    `,
    [normalizedCharacterIds],
  );

  for (const row of result.rows as Array<{ id: unknown; dungeon_no_stamina_cost: unknown }>) {
    const characterId = Math.floor(Number(row.id));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    out.set(characterId, resolveDungeonBenefitPolicy(row.dungeon_no_stamina_cost));
  }

  return out;
};
