/**
 * 角色战斗技能装载共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一把“技能槽中的主动技能”与“已装备功法解锁的被动技能”合并成战斗可用技能列表。
 * 2) 做什么：集中保留技能 triggerType，避免战斗层和功法服务层各自默认成 active。
 * 3) 不做什么：不读数据库、不处理 UI 展示，也不直接构建 BattleSkill 运行时对象。
 *
 * 输入 / 输出：
 * - 输入：已装备功法列表、技能槽列表、技能定义映射、功法层配置。
 * - 输出：用于战斗装载的结构化技能条目（skillId / upgradeLevel / triggerType）。
 *
 * 数据流 / 状态流：
 * - character_technique / character_skill_slot -> 本模块归一化 -> battle/shared/skills.ts 转成 SkillData
 * - 被动技能不再依赖技能槽；只要功法已装备且层级已解锁，就会自动进入战斗装载结果。
 *
 * 关键边界条件与坑点：
 * 1) 技能槽中的 passive 技能不能继续占用主动出手顺序，否则会出现“被动技能反复占回合释放”。
 * 2) 被动技能需要按已装备功法的解锁层自动补入，但同一 skillId 只应补一次，避免重复触发。
 */

import type { SkillDefConfig } from '../staticConfigLoader.js';
import type { TechniqueLayerStaticRow } from './techniqueUpgradeRules.js';

export type BattleSkillTriggerType = 'active' | 'passive';

export type EquippedTechniqueBattleSkillSource = {
  techniqueId: string;
  currentLayer: number;
};

export type SlottedBattleSkillSource = {
  skillId: string;
  slotIndex: number;
};

export type CharacterBattleSkillEntry = {
  skillId: string;
  upgradeLevel: number;
  triggerType: BattleSkillTriggerType;
};

export const normalizeBattleSkillTriggerType = (
  raw: string | null | undefined,
): BattleSkillTriggerType => {
  return String(raw || '').trim().toLowerCase() === 'passive' ? 'passive' : 'active';
};

export const canEquipBattleSkillToSlot = (
  raw: string | null | undefined,
): boolean => normalizeBattleSkillTriggerType(raw) === 'active';

const buildTechniqueCurrentLayerMap = (
  equippedTechniques: EquippedTechniqueBattleSkillSource[],
): Map<string, number> => {
  const currentLayerByTechnique = new Map<string, number>();
  for (const entry of equippedTechniques) {
    if (!entry.techniqueId) continue;
    const nextLayer = Math.max(0, Math.floor(entry.currentLayer));
    const currentLayer = currentLayerByTechnique.get(entry.techniqueId) ?? 0;
    if (nextLayer > currentLayer) {
      currentLayerByTechnique.set(entry.techniqueId, nextLayer);
    }
  }
  return currentLayerByTechnique;
};

export const buildCharacterBattleSkillEntries = (params: {
  equippedTechniques: EquippedTechniqueBattleSkillSource[];
  slottedSkills: SlottedBattleSkillSource[];
  skillDefs: ReadonlyMap<string, SkillDefConfig>;
  layerRows: TechniqueLayerStaticRow[];
}): CharacterBattleSkillEntry[] => {
  const currentLayerByTechnique = buildTechniqueCurrentLayerMap(params.equippedTechniques);
  if (currentLayerByTechnique.size <= 0) return [];

  const unlockedSkillIdsByTechnique = new Map<string, Set<string>>();
  const upgradedSkillCountByTechniqueAndSkill = new Map<string, number>();

  for (const row of params.layerRows) {
    const currentLayer = currentLayerByTechnique.get(row.techniqueId) ?? 0;
    if (currentLayer <= 0 || row.layer > currentLayer) continue;

    const unlockedSkillIds = unlockedSkillIdsByTechnique.get(row.techniqueId) ?? new Set<string>();
    for (const skillId of row.unlockSkillIds) {
      unlockedSkillIds.add(skillId);
    }
    unlockedSkillIdsByTechnique.set(row.techniqueId, unlockedSkillIds);

    for (const skillId of row.upgradeSkillIds) {
      const key = `${row.techniqueId}:${skillId}`;
      upgradedSkillCountByTechniqueAndSkill.set(key, (upgradedSkillCountByTechniqueAndSkill.get(key) ?? 0) + 1);
    }
  }

  const isUnlockedSkill = (skillId: string): boolean => {
    for (const unlockedSkillIds of unlockedSkillIdsByTechnique.values()) {
      if (unlockedSkillIds.has(skillId)) return true;
    }
    return false;
  };

  const resolveUpgradeLevel = (skillId: string): number => {
    const skillDef = params.skillDefs.get(skillId);
    if (!skillDef || skillDef.source_type !== 'technique' || typeof skillDef.source_id !== 'string' || !skillDef.source_id) {
      return 0;
    }
    const key = `${skillDef.source_id}:${skillId}`;
    return upgradedSkillCountByTechniqueAndSkill.get(key) ?? 0;
  };

  const activeEntries = [...params.slottedSkills]
    .sort((left, right) => left.slotIndex - right.slotIndex)
    .flatMap((entry) => {
      const skillDef = params.skillDefs.get(entry.skillId);
      if (!skillDef || !isUnlockedSkill(entry.skillId)) return [];
      const triggerType = normalizeBattleSkillTriggerType(skillDef.trigger_type);
      if (triggerType !== 'active') return [];
      return [{
        skillId: entry.skillId,
        upgradeLevel: resolveUpgradeLevel(entry.skillId),
        triggerType,
      } satisfies CharacterBattleSkillEntry];
    });

  const passiveSkillIdSet = new Set<string>();
  const passiveEntries: CharacterBattleSkillEntry[] = [];
  for (const equippedTechnique of params.equippedTechniques) {
    const unlockedSkillIds = unlockedSkillIdsByTechnique.get(equippedTechnique.techniqueId);
    if (!unlockedSkillIds) continue;

    for (const skillId of unlockedSkillIds) {
      if (passiveSkillIdSet.has(skillId)) continue;
      const skillDef = params.skillDefs.get(skillId);
      if (!skillDef) continue;
      const triggerType = normalizeBattleSkillTriggerType(skillDef.trigger_type);
      if (triggerType !== 'passive') continue;

      passiveSkillIdSet.add(skillId);
      passiveEntries.push({
        skillId,
        upgradeLevel: resolveUpgradeLevel(skillId),
        triggerType,
      });
    }
  }

  return [...activeEntries, ...passiveEntries];
};
