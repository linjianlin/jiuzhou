/**
 * 角色战斗快照构建
 *
 * 作用：将角色属性、技能、套装效果打包为 IdleSession 所需的战斗快照。
 *
 * 输入/输出：
 * - buildCharacterBattleSnapshot: characterId -> snapshot | null
 *
 * 复用点：idleSessionService.ts 在 startIdleSession 时调用。
 *
 * 边界条件：
 * 1) 快照一次性生成，后续战斗均使用此快照，不随角色实时属性变化
 * 2) setBonusEffects 包含套装效果和词缀效果
 */

import type {
  BattleAttrs,
  BattleSkill,
  BattleSetBonusEffect,
} from "../../battle/types.js";
import type { CharacterData } from "../../battle/battleFactory.js";
import {
  getCharacterComputedByCharacterId,
} from "../characterComputedService.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { attachSetBonusEffectsToCharacterData } from "./shared/effects.js";
import { getCharacterBattleSkillData } from "./shared/skills.js";

export async function buildCharacterBattleSnapshot(
  characterId: number,
): Promise<{
  baseAttrs: BattleAttrs;
  skills: BattleSkill[];
  setBonusEffects: BattleSetBonusEffect[];
  realm: string;
  nickname: string;
} | null> {
  const base = await getCharacterComputedByCharacterId(characterId);
  if (!base) return null;

  const characterData = await attachSetBonusEffectsToCharacterData(
    characterId,
    base as CharacterData,
  );
  const skillDataList = await getCharacterBattleSkillData(characterId);

  const baseAttrs: BattleAttrs = {
    max_qixue: characterData.max_qixue,
    max_lingqi: characterData.max_lingqi,
    wugong: characterData.wugong,
    fagong: characterData.fagong,
    wufang: characterData.wufang,
    fafang: characterData.fafang,
    sudu: characterData.sudu,
    mingzhong: characterData.mingzhong,
    shanbi: characterData.shanbi,
    zhaojia: characterData.zhaojia,
    baoji: characterData.baoji,
    baoshang: characterData.baoshang,
    kangbao: characterData.kangbao,
    zengshang: characterData.zengshang,
    zhiliao: characterData.zhiliao,
    jianliao: characterData.jianliao,
    xixue: characterData.xixue,
    lengque: characterData.lengque,
    kongzhi_kangxing: characterData.kongzhi_kangxing,
    jin_kangxing: characterData.jin_kangxing,
    mu_kangxing: characterData.mu_kangxing,
    shui_kangxing: characterData.shui_kangxing,
    huo_kangxing: characterData.huo_kangxing,
    tu_kangxing: characterData.tu_kangxing,
    qixue_huifu: characterData.qixue_huifu,
    lingqi_huifu: characterData.lingqi_huifu,
    realm: normalizeRealmKeepingUnknown(characterData.realm, null),
    element: characterData.attribute_element,
  };

  const skills: BattleSkill[] = skillDataList.map((data) => ({
    id: data.id,
    name: data.name,
    source: "innate" as const,
    cost: {
      lingqi: data.cost_lingqi || 0,
      qixue: data.cost_qixue || 0,
    },
    cooldown: data.cooldown || 0,
    targetType: (data.target_type ||
      "single_enemy") as BattleSkill["targetType"],
    targetCount: data.target_count || 1,
    damageType: data.damage_type as BattleSkill["damageType"],
    element: data.element || "none",
    effects: data.effects || [],
    triggerType: "active" as const,
    aiPriority: data.ai_priority || 50,
  }));

  return {
    baseAttrs,
    skills,
    setBonusEffects: characterData.setBonusEffects ?? [],
    realm: String(characterData.realm || "凡人"),
    nickname: String(characterData.nickname || "无名修士"),
  };
}
