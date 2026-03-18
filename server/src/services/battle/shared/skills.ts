/**
 * 战斗技能数据加载与转换
 *
 * 作用：
 * - 从静态配置和角色技能槽位加载并转换技能数据为战斗引擎所需格式
 * - 提供技能升级规则解析、应用、深拷贝等工具函数
 *
 * 不做什么：不执行战斗逻辑、不操作状态。
 *
 * 输入/输出：
 * - getCharacterBattleSkillData: characterId -> SkillData[]
 * - toBattleSkillData: SkillDefConfig -> SkillData
 * - toBattleSkill: SkillData -> BattleSkill
 *
 * 复用点：
 * - pve.ts / pvp.ts / snapshot.ts / preparation.ts 中调用 getCharacterBattleSkillData
 * - monsters.ts 中调用 toBattleSkillData / toBattleSkill / cloneBattleSkill
 *
 * 边界条件：
 * 1) getCharacterBattleSkillData 按槽位顺序返回，同 skillId 可出现多次（不去重）
 * 2) 升级规则按 layer 升序排列后截取到 upgradeLevel
 */

import type {
  BattleSkill,
  SkillEffect,
} from "../../../battle/types.js";
import type { SkillData } from "../../../battle/battleFactory.js";
import type { SkillDefConfig } from "../../staticConfigLoader.js";
import { getSkillDefinitions } from "../../staticConfigLoader.js";
import { characterTechniqueService } from "../../characterTechniqueService.js";
import { normalizeSkillCost } from "../../../shared/skillCost.js";
import {
  toNumber,
  toRecord,
  toText,
  uniqueStringIds,
} from "./helpers.js";
import { normalizeBattleSkillTriggerType } from "../../shared/characterBattleSkillLoadout.js";

// ------ 常量 ------

const MONSTER_SKILL_TARGET_TYPE_SET = new Set<BattleSkill["targetType"]>([
  "self",
  "single_enemy",
  "single_ally",
  "all_enemy",
  "all_ally",
  "random_enemy",
  "random_ally",
]);

// ------ 基础转换 ------

export function normalizeSkillTargetType(raw: unknown): BattleSkill["targetType"] {
  const target = toText(raw);
  return MONSTER_SKILL_TARGET_TYPE_SET.has(target as BattleSkill["targetType"])
    ? (target as BattleSkill["targetType"])
    : "single_enemy";
}

export function normalizeSkillDamageType(raw: unknown): BattleSkill["damageType"] {
  const value = toText(raw);
  if (value === "physical" || value === "magic" || value === "true")
    return value;
  return undefined;
}

export function cloneSkillEffectList(raw: unknown): SkillEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillEffect[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    out.push({ ...(row as SkillEffect) });
  }
  return out;
}

/** 静态配置行 -> 战斗用 SkillData */
export function toBattleSkillData(row: SkillDefConfig): SkillData {
  const cost = normalizeSkillCost(row);
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    cost_lingqi: cost.lingqi ?? 0,
    cost_lingqi_rate: cost.lingqiRate ?? 0,
    cost_qixue: cost.qixue ?? 0,
    cost_qixue_rate: cost.qixueRate ?? 0,
    cooldown: Math.max(0, Math.floor(Number(row.cooldown ?? 0) || 0)),
    target_type: String(row.target_type || "single_enemy"),
    target_count: Math.max(1, Math.floor(Number(row.target_count ?? 1) || 1)),
    damage_type: String(row.damage_type || "none"),
    element: String(row.element || "none"),
    effects: cloneSkillEffectList(row.effects),
    trigger_type: normalizeBattleSkillTriggerType(row.trigger_type),
    ai_priority: Math.max(0, Math.floor(Number(row.ai_priority ?? 50) || 50)),
  };
}

/** SkillData -> 战斗引擎 BattleSkill */
export function toBattleSkill(skill: SkillData): BattleSkill {
  return {
    id: skill.id,
    name: skill.name,
    source: "innate",
    cost: {
      lingqi: skill.cost_lingqi,
      lingqiRate: skill.cost_lingqi_rate,
      qixue: skill.cost_qixue,
      qixueRate: skill.cost_qixue_rate,
    },
    cooldown: skill.cooldown,
    targetType: normalizeSkillTargetType(skill.target_type),
    targetCount: Math.max(1, Math.floor(skill.target_count || 1)),
    damageType: normalizeSkillDamageType(skill.damage_type),
    element: String(skill.element || "none"),
    effects: skill.effects.map((effect) => ({ ...effect })),
    triggerType: normalizeBattleSkillTriggerType(skill.trigger_type),
    aiPriority: Math.max(0, Math.floor(skill.ai_priority || 0)),
  };
}

export function cloneBattleSkill(skill: BattleSkill): BattleSkill {
  return {
    ...skill,
    cost: { ...skill.cost },
    effects: skill.effects.map((effect) => ({ ...effect })),
  };
}

// ------ 伤害效果判断 ------

function cloneEffects(raw: unknown[]): unknown[] {
  return raw.map((effect) => {
    if (!effect || typeof effect !== "object" || Array.isArray(effect))
      return effect;
    return { ...(effect as Record<string, unknown>) };
  });
}

export function isDamageEffect(effect: unknown): effect is Record<string, unknown> {
  return Boolean(
    effect &&
    typeof effect === "object" &&
    !Array.isArray(effect) &&
    (effect as Record<string, unknown>).type === "damage",
  );
}

export function findFirstDamageEffect(
  effects: unknown[],
): Record<string, unknown> | null {
  for (const effect of effects) {
    if (isDamageEffect(effect)) return { ...effect };
  }
  return null;
}

export function hasDamageEffect(effects: unknown[]): boolean {
  return effects.some((effect) => isDamageEffect(effect));
}

// ------ 技能升级规则 ------

type SkillUpgradeRule = {
  layer: number;
  changes: Record<string, unknown>;
};

export function parseSkillUpgradeRules(raw: unknown): SkillUpgradeRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: SkillUpgradeRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = toRecord(raw[i]);
    const changes = toRecord(row.changes);
    if (Object.keys(changes).length === 0) continue;
    const layer = Math.max(1, Math.floor(toNumber(row.layer) ?? i + 1));
    rules.push({ layer, changes });
  }
  rules.sort((a, b) => a.layer - b.layer);
  return rules;
}

export function applySkillUpgradeChanges(
  base: {
    cost_lingqi: number;
    cost_lingqi_rate: number;
    cost_qixue: number;
    cost_qixue_rate: number;
    cooldown: number;
    target_count: number;
    effects: unknown[];
    ai_priority: number;
  },
  changes: Record<string, unknown>,
): void {
  const preservedDamageEffect = findFirstDamageEffect(base.effects);

  const targetCount = toNumber(changes.target_count);
  if (targetCount !== null) {
    base.target_count = Math.max(1, Math.floor(targetCount));
  }

  const cooldownDelta = toNumber(changes.cooldown);
  if (cooldownDelta !== null) {
    base.cooldown = Math.max(0, Math.floor(base.cooldown + cooldownDelta));
  }

  const costLingqiDelta = toNumber(changes.cost_lingqi);
  if (costLingqiDelta !== null) {
    base.cost_lingqi = Math.max(
      0,
      Math.floor(base.cost_lingqi + costLingqiDelta),
    );
  }
  const costLingqiRateDelta = toNumber(changes.cost_lingqi_rate);
  if (costLingqiRateDelta !== null) {
    base.cost_lingqi_rate = Math.max(0, base.cost_lingqi_rate + costLingqiRateDelta);
  }

  const costQixueDelta = toNumber(changes.cost_qixue);
  if (costQixueDelta !== null) {
    base.cost_qixue = Math.max(0, Math.floor(base.cost_qixue + costQixueDelta));
  }
  const costQixueRateDelta = toNumber(changes.cost_qixue_rate);
  if (costQixueRateDelta !== null) {
    base.cost_qixue_rate = Math.max(0, base.cost_qixue_rate + costQixueRateDelta);
  }

  const aiPriorityDelta = toNumber(changes.ai_priority);
  if (aiPriorityDelta !== null) {
    base.ai_priority = Math.max(
      0,
      Math.floor(base.ai_priority + aiPriorityDelta),
    );
  }

  if (Array.isArray(changes.effects)) {
    const nextEffects = cloneEffects(changes.effects);
    if (preservedDamageEffect && !hasDamageEffect(nextEffects)) {
      nextEffects.unshift({ ...preservedDamageEffect });
    }
    base.effects = nextEffects;
  }
  const addEffect = changes.addEffect;
  if (addEffect && typeof addEffect === "object" && !Array.isArray(addEffect)) {
    base.effects = [
      ...base.effects,
      { ...(addEffect as Record<string, unknown>) },
    ];
  }
}

// ------ 角色战斗技能加载 ------

/**
 * 加载角色战斗技能数据
 *
 * 数据流：
 * characterTechniqueService.getBattleSkills -> 技能槽位列表
 * -> getSkillDefinitions 查静态配置 -> 应用升级规则 -> SkillData[]
 */
export async function getCharacterBattleSkillData(
  characterId: number,
): Promise<SkillData[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const battleSkillsRes =
    await characterTechniqueService.getBattleSkills(characterId);
  if (!battleSkillsRes.success || !battleSkillsRes.data) return [];

  const orderedSkillSlots = battleSkillsRes.data
    .map((s) => ({
      skillId: String(s?.skillId ?? "").trim(),
      upgradeLevel: Math.max(0, Math.floor(toNumber(s?.upgradeLevel) ?? 0)),
      triggerType: normalizeBattleSkillTriggerType(s?.triggerType),
    }))
    .filter((x) => x.skillId.length > 0);

  const orderedSkillIds = orderedSkillSlots.map((x) => x.skillId);

  if (orderedSkillIds.length === 0) return [];

  const uniqIds = uniqueStringIds(orderedSkillIds);
  const idSet = new Set(uniqIds);
  const byId = new Map<
    string,
    ReturnType<typeof getSkillDefinitions>[number]
  >();
  for (const row of getSkillDefinitions()) {
    if (row.enabled === false) continue;
    if (!idSet.has(row.id)) continue;
    byId.set(row.id, row);
  }

  const skills: SkillData[] = [];
  for (const slot of orderedSkillSlots) {
    const row = byId.get(slot.skillId);
    if (!row) continue;

    const skillData = {
      cost_lingqi: Math.max(0, Math.floor(Number(row.cost_lingqi ?? 0) || 0)),
      cost_lingqi_rate: Math.max(0, Number(row.cost_lingqi_rate ?? 0) || 0),
      cost_qixue: Math.max(0, Math.floor(Number(row.cost_qixue ?? 0) || 0)),
      cost_qixue_rate: Math.max(0, Number(row.cost_qixue_rate ?? 0) || 0),
      cooldown: Math.max(0, Math.floor(Number(row.cooldown ?? 0) || 0)),
      target_count: Math.max(1, Math.floor(Number(row.target_count ?? 1) || 1)),
      effects: cloneSkillEffectList(
        Array.isArray(row.effects) ? row.effects : (row.effects ?? []),
      ),
      ai_priority: Math.max(0, Math.floor(Number(row.ai_priority ?? 50) || 50)),
    };

    if (slot.upgradeLevel > 0) {
      const rules = parseSkillUpgradeRules(row.upgrades);
      const applyRules = rules.slice(0, slot.upgradeLevel);
      for (const rule of applyRules) {
        applySkillUpgradeChanges(skillData, rule.changes);
      }
    }

    skills.push({
      id: String(row.id),
      name: String(row.name || row.id),
      cost_lingqi: skillData.cost_lingqi,
      cost_lingqi_rate: skillData.cost_lingqi_rate,
      cost_qixue: skillData.cost_qixue,
      cost_qixue_rate: skillData.cost_qixue_rate,
      cooldown: skillData.cooldown,
      target_type: String(row.target_type || "single_enemy"),
      target_count: skillData.target_count,
      damage_type: String(row.damage_type || "none"),
      element: String(row.element || "none"),
      effects: skillData.effects,
      trigger_type: slot.triggerType,
      ai_priority: skillData.ai_priority,
    });
  }

  return skills;
}
