/**
 * 怪物运行时数据解析
 *
 * 作用：
 * - 从静态配置递归解析怪物数据（包括 AI、技能、阶段触发、召唤怪物链）
 * - 将原始配置转换为战斗引擎所需的 MonsterData + SkillData[] + BattleAttrs + aiProfile
 *
 * 不做什么：不管理战斗状态、不执行战斗逻辑。
 *
 * 输入/输出：
 * - resolveOrderedMonsters: monsterIds[] -> { monsters, monsterSkillsMap } | { error }
 * - resolveMonsterRuntime: 递归解析单个怪物（含召唤链检测）
 *
 * 复用点：
 * - pve.ts 和 idleBattleSimulationCore.ts 通过 resolveOrderedMonsters 获取怪物数据
 *
 * 边界条件：
 * 1) resolveMonsterRuntime 使用 resolvingPath 防止循环召唤
 * 2) 怪物配置 enabled === false 时视为不存在
 */

import type {
  BattleAttrs,
  BattleSkill,
  MonsterAIPhaseTrigger,
  MonsterAIProfile,
  SkillEffect,
} from "../../../battle/types.js";
import type { MonsterData, SkillData } from "../../../battle/battleFactory.js";
import {
  type MonsterAIProfileConfig,
  type MonsterDefConfig,
  type MonsterPhaseTriggerConfig,
  type SkillDefConfig,
} from "../../staticConfigLoader.js";
import {
  toNumber,
  toRecord,
  toText,
  toOptionalNumber,
  uniqueStringIds,
} from "./helpers.js";
import {
  toBattleSkillData,
  toBattleSkill,
  cloneBattleSkill,
  cloneSkillEffectList,
} from "./skills.js";
import {
  getEnabledBattleMonsterDefinitionMap,
  getEnabledBattleSkillDefinitionMap,
} from "./staticDefinitionIndex.js";
import {
  normalizeBuffApplyType,
  normalizeBuffAttrKey,
  normalizeBuffKind,
  resolveBuffEffectKey,
} from "../../../battle/utils/buffSpec.js";

// ------ 常量 ------

const MONSTER_PHASE_ACTION_SET = new Set(["enrage", "summon"]);

// ------ 内部类型 ------

export type MonsterRuntimeCacheEntry = {
  monster: MonsterData;
  skills: SkillData[];
  attrs: BattleAttrs;
  battleSkills: BattleSkill[];
  aiProfile: MonsterAIProfile;
};

type MonsterRuntimeResolveResult =
  | { success: true; entry: MonsterRuntimeCacheEntry }
  | { success: false; error: string };

type MonsterRuntimeResolverContext = {
  monsterDefMap: ReadonlyMap<string, MonsterDefConfig>;
  skillDefMap: ReadonlyMap<string, SkillDefConfig>;
  cache: Map<string, MonsterRuntimeCacheEntry>;
};

export type OrderedMonstersResolveResult =
  | {
      success: true;
      monsters: MonsterData[];
      monsterSkillsMap: Record<string, SkillData[]>;
    }
  | { success: false; error: string };

let monsterRuntimeResolverContext: MonsterRuntimeResolverContext | null = null;

// ------ 怪物属性归一化 ------

export function normalizeMonsterBaseAttrs(raw: unknown): MonsterData["base_attrs"] {
  const attrs = toRecord(raw);
  return {
    qixue: toOptionalNumber(attrs.qixue),
    max_qixue: toOptionalNumber(attrs.max_qixue),
    lingqi: toOptionalNumber(attrs.lingqi),
    max_lingqi: toOptionalNumber(attrs.max_lingqi),
    wugong: toOptionalNumber(attrs.wugong),
    fagong: toOptionalNumber(attrs.fagong),
    wufang: toOptionalNumber(attrs.wufang),
    fafang: toOptionalNumber(attrs.fafang),
    sudu: toOptionalNumber(attrs.sudu),
    mingzhong: toOptionalNumber(attrs.mingzhong),
    shanbi: toOptionalNumber(attrs.shanbi),
    zhaojia: toOptionalNumber(attrs.zhaojia),
    baoji: toOptionalNumber(attrs.baoji),
    baoshang: toOptionalNumber(attrs.baoshang),
    jianbaoshang: toOptionalNumber(attrs.jianbaoshang),
    jianfantan: toOptionalNumber(attrs.jianfantan),
    kangbao: toOptionalNumber(attrs.kangbao),
    zengshang: toOptionalNumber(attrs.zengshang),
    zhiliao: toOptionalNumber(attrs.zhiliao),
    jianliao: toOptionalNumber(attrs.jianliao),
    xixue: toOptionalNumber(attrs.xixue),
    lengque: toOptionalNumber(attrs.lengque),
    kongzhi_kangxing: toOptionalNumber(attrs.kongzhi_kangxing),
    jin_kangxing: toOptionalNumber(attrs.jin_kangxing),
    mu_kangxing: toOptionalNumber(attrs.mu_kangxing),
    shui_kangxing: toOptionalNumber(attrs.shui_kangxing),
    huo_kangxing: toOptionalNumber(attrs.huo_kangxing),
    tu_kangxing: toOptionalNumber(attrs.tu_kangxing),
    qixue_huifu: toOptionalNumber(attrs.qixue_huifu),
    lingqi_huifu: toOptionalNumber(attrs.lingqi_huifu),
  };
}

export function extractMonsterAttrsForSummon(def: MonsterDefConfig): BattleAttrs {
  const attrs = normalizeMonsterBaseAttrs(def.base_attrs);
  return {
    max_qixue: toNumber(attrs.max_qixue ?? attrs.qixue) ?? 100,
    max_lingqi: toNumber(attrs.max_lingqi ?? attrs.lingqi) ?? 0,
    wugong: toNumber(attrs.wugong) ?? 0,
    fagong: toNumber(attrs.fagong) ?? 0,
    wufang: toNumber(attrs.wufang) ?? 0,
    fafang: toNumber(attrs.fafang) ?? 0,
    sudu: Math.max(1, toNumber(attrs.sudu) ?? 1),
    mingzhong: toNumber(attrs.mingzhong) ?? 0.9,
    shanbi: toNumber(attrs.shanbi) ?? 0,
    zhaojia: toNumber(attrs.zhaojia) ?? 0,
    baoji: toNumber(attrs.baoji) ?? 0,
    baoshang: toNumber(attrs.baoshang) ?? 0,
    jianbaoshang: toNumber(attrs.jianbaoshang) ?? 0,
    jianfantan: toNumber(attrs.jianfantan) ?? 0,
    kangbao: toNumber(attrs.kangbao) ?? 0,
    zengshang: toNumber(attrs.zengshang) ?? 0,
    zhiliao: toNumber(attrs.zhiliao) ?? 0,
    jianliao: toNumber(attrs.jianliao) ?? 0,
    xixue: toNumber(attrs.xixue) ?? 0,
    lengque: toNumber(attrs.lengque) ?? 0,
    kongzhi_kangxing: toNumber(attrs.kongzhi_kangxing) ?? 0,
    jin_kangxing: toNumber(attrs.jin_kangxing) ?? 0,
    mu_kangxing: toNumber(attrs.mu_kangxing) ?? 0,
    shui_kangxing: toNumber(attrs.shui_kangxing) ?? 0,
    huo_kangxing: toNumber(attrs.huo_kangxing) ?? 0,
    tu_kangxing: toNumber(attrs.tu_kangxing) ?? 0,
    qixue_huifu: toNumber(attrs.qixue_huifu) ?? 0,
    lingqi_huifu: toNumber(attrs.lingqi_huifu) ?? 0,
    realm: toText(def.realm) || "凡人",
    element: toText(def.element) || "none",
  };
}

// ------ 阶段效果解析 ------

export function parsePhaseEffects(
  raw: unknown,
  monsterId: string,
  triggerIndex: number,
):
  | { success: true; effects: SkillEffect[] }
  | { success: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      success: false,
      error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发缺少effects配置`,
    };
  }

  const effects: SkillEffect[] = [];
  for (let i = 0; i < raw.length; i++) {
    const effect = toRecord(raw[i]);
    const effectType = toText(effect.type);
    if (effectType !== "buff" && effectType !== "debuff") {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect仅支持buff/debuff`,
      };
    }

    const buffKind = normalizeBuffKind(effect.buffKind);
    if (buffKind !== "attr") {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect的buffKind必须为attr`,
      };
    }

    const attrKey = normalizeBuffAttrKey(toText(effect.attrKey));
    if (!attrKey) {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect缺少合法attrKey`,
      };
    }

    const applyTypeRaw = toText(effect.applyType);
    const applyType = applyTypeRaw
      ? normalizeBuffApplyType(applyTypeRaw)
      : null;
    if (applyTypeRaw && !applyType) {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect的applyType非法: ${applyTypeRaw}`,
      };
    }

    const value = toNumber(effect.value);
    if (value === null || value <= 0) {
      return {
        success: false,
        error: `怪物[${monsterId}] 第${triggerIndex}条阶段触发第${i + 1}个effect的value必须>0`,
      };
    }

    const durationRaw = toNumber(effect.duration);
    const duration =
      durationRaw === null ? 1 : Math.max(1, Math.floor(durationRaw));
    const stacksRaw = toNumber(effect.stacks);
    const stacks = stacksRaw === null ? 1 : Math.max(1, Math.floor(stacksRaw));
    const buffKeyRaw = toText(effect.buffKey);
    const buffKey = buffKeyRaw || resolveBuffEffectKey({
      type: effectType as "buff" | "debuff",
      buffKind: "attr",
      attrKey,
    });
    effects.push({
      type: effectType,
      buffKind: "attr",
      buffKey,
      attrKey,
      applyType: applyType ?? undefined,
      value,
      duration,
      stacks,
    });
  }
  return { success: true, effects };
}

// ------ 核心递归解析 ------

export function resolveMonsterRuntime(
  monsterId: string,
  monsterDefMap: ReadonlyMap<string, MonsterDefConfig>,
  skillDefMap: ReadonlyMap<string, SkillDefConfig>,
  cache: Map<string, MonsterRuntimeCacheEntry>,
  resolvingPath: Set<string>,
): MonsterRuntimeResolveResult {
  const cached = cache.get(monsterId);
  if (cached) return { success: true, entry: cached };
  if (resolvingPath.has(monsterId)) {
    return { success: false, error: `怪物AI配置存在循环召唤: ${monsterId}` };
  }

  const def = monsterDefMap.get(monsterId);
  if (!def || def.enabled === false) {
    return { success: false, error: `怪物配置不存在或未启用: ${monsterId}` };
  }

  resolvingPath.add(monsterId);
  const aiProfileRaw: MonsterAIProfileConfig = def.ai_profile ?? {};

  const skillIds = uniqueStringIds(
    (Array.isArray(aiProfileRaw.skills) ? aiProfileRaw.skills : [])
      .map((skillId) => String(skillId || "").trim())
      .filter((skillId) => skillId.length > 0),
  );
  const skills: SkillData[] = [];
  for (const skillId of skillIds) {
    const skillDef = skillDefMap.get(skillId);
    if (!skillDef || skillDef.enabled === false) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 引用了不存在的技能: ${skillId}`,
      };
    }
    skills.push(toBattleSkillData(skillDef));
  }

  const skillWeights: Record<string, number> = {};
  const skillWeightRaw = toRecord(aiProfileRaw.skill_weights);
  for (const [skillIdRaw, weightRaw] of Object.entries(skillWeightRaw)) {
    const skillId = String(skillIdRaw || "").trim();
    if (!skillId) continue;
    if (!skillIds.includes(skillId)) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] skill_weights包含未配置技能: ${skillId}`,
      };
    }
    const weight = toNumber(weightRaw);
    if (weight === null || weight <= 0) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 技能权重非法: ${skillId}`,
      };
    }
    skillWeights[skillId] = weight;
  }

  const phaseTriggers: MonsterAIPhaseTrigger[] = [];
  const rawPhaseTriggers = Array.isArray(aiProfileRaw.phase_triggers)
    ? aiProfileRaw.phase_triggers
    : [];
  for (let i = 0; i < rawPhaseTriggers.length; i++) {
    const triggerRaw = (rawPhaseTriggers[i] ?? {}) as MonsterPhaseTriggerConfig;
    const hpPercentRaw = toNumber(triggerRaw.hp_percent);
    if (hpPercentRaw === null || hpPercentRaw <= 0 || hpPercentRaw > 1) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条阶段触发hp_percent非法`,
      };
    }

    const action = toText(triggerRaw.action);
    if (!MONSTER_PHASE_ACTION_SET.has(action)) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条阶段触发action非法: ${action}`,
      };
    }

    const triggerId = `${monsterId}-phase-${i + 1}`;
    if (action === "enrage") {
      const effectResult = parsePhaseEffects(
        triggerRaw.effects,
        monsterId,
        i + 1,
      );
      if (!effectResult.success) {
        resolvingPath.delete(monsterId);
        return { success: false, error: effectResult.error };
      }
      phaseTriggers.push({
        id: triggerId,
        hpPercent: hpPercentRaw,
        action: "enrage",
        effects: effectResult.effects,
        summonCount: 1,
      });
      continue;
    }

    const summonMonsterId = toText(triggerRaw.summon_id);
    if (!summonMonsterId) {
      resolvingPath.delete(monsterId);
      return {
        success: false,
        error: `怪物[${monsterId}] 第${i + 1}条召唤触发缺少summon_id`,
      };
    }
    const summonCountRaw = toNumber(triggerRaw.summon_count);
    const summonCount =
      summonCountRaw === null ? 1 : Math.max(1, Math.floor(summonCountRaw));
    const summonResult = resolveMonsterRuntime(
      summonMonsterId,
      monsterDefMap,
      skillDefMap,
      cache,
      resolvingPath,
    );
    if (!summonResult.success) {
      resolvingPath.delete(monsterId);
      return { success: false, error: summonResult.error };
    }
    phaseTriggers.push({
      id: triggerId,
      hpPercent: hpPercentRaw,
      action: "summon",
      effects: [],
      summonMonsterId,
      summonCount,
      summonTemplate: {
        id: summonMonsterId,
        name: summonResult.entry.monster.name,
        realm: summonResult.entry.monster.realm,
        element: summonResult.entry.monster.element,
        baseAttrs: { ...summonResult.entry.attrs },
        skills: summonResult.entry.battleSkills.map((skill) =>
          cloneBattleSkill(skill),
        ),
        aiProfile: summonResult.entry.aiProfile,
      },
    });
  }

  const aiProfile: MonsterAIProfile = {
    skillIds,
    skillWeights,
    phaseTriggers,
  };
  const monster: MonsterData = {
    id: monsterId,
    name: toText(def.name) || monsterId,
    realm: toText(def.realm) || "凡人",
    element: toText(def.element) || "none",
    attr_variance: def.attr_variance,
    attr_multiplier_min: def.attr_multiplier_min,
    attr_multiplier_max: def.attr_multiplier_max,
    base_attrs: normalizeMonsterBaseAttrs(def.base_attrs),
    skills: [...skillIds],
    ai_profile: aiProfile,
    exp_reward: Math.max(0, Math.floor(Number(def.exp_reward ?? 0) || 0)),
    silver_reward_min: Math.max(
      0,
      Math.floor(Number(def.silver_reward_min ?? 0) || 0),
    ),
    silver_reward_max: Math.max(
      0,
      Math.floor(Number(def.silver_reward_max ?? 0) || 0),
    ),
    kind: toText(def.kind) || "normal",
    drop_pool_id: toText(def.drop_pool_id) || undefined,
  };
  const entry: MonsterRuntimeCacheEntry = {
    monster,
    skills,
    attrs: extractMonsterAttrsForSummon(def),
    battleSkills: skills.map((skill) => toBattleSkill(skill)),
    aiProfile,
  };
  cache.set(monsterId, entry);
  resolvingPath.delete(monsterId);
  return { success: true, entry };
}

// ------ 批量解析 ------

export function resolveOrderedMonsters(
  monsterIds: string[],
): OrderedMonstersResolveResult {
  const ids = monsterIds
    .map((id) => String(id || "").trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return { success: false, error: "请指定战斗目标" };
  }

  const {
    monsterDefMap,
    skillDefMap,
    cache,
  } = getMonsterRuntimeResolverContext();
  const monsters: MonsterData[] = [];
  const monsterSkillsMap: Record<string, SkillData[]> = {};
  for (const id of ids) {
    const runtimeResult = resolveMonsterRuntime(
      id,
      monsterDefMap,
      skillDefMap,
      cache,
      new Set<string>(),
    );
    if (!runtimeResult.success) {
      return { success: false, error: runtimeResult.error };
    }
    monsters.push(runtimeResult.entry.monster);
    monsterSkillsMap[id] = runtimeResult.entry.skills.map((skill) => ({
      ...skill,
      effects: skill.effects.map((effect) => ({ ...effect })),
    }));
  }

  return { success: true, monsters, monsterSkillsMap };
}

function getMonsterRuntimeResolverContext(): MonsterRuntimeResolverContext {
  const monsterDefMap = getEnabledBattleMonsterDefinitionMap();
  const skillDefMap = getEnabledBattleSkillDefinitionMap();
  const currentContext = monsterRuntimeResolverContext;

  if (
    currentContext &&
    currentContext.monsterDefMap === monsterDefMap &&
    currentContext.skillDefMap === skillDefMap
  ) {
    return currentContext;
  }

  const nextContext: MonsterRuntimeResolverContext = {
    monsterDefMap,
    skillDefMap,
    cache: new Map<string, MonsterRuntimeCacheEntry>(),
  };
  monsterRuntimeResolverContext = nextContext;
  return nextContext;
}
