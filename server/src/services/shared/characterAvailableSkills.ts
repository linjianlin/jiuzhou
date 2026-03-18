/**
 * 角色当前可用技能共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一解析“角色当前已装备功法可解锁出的技能全集”，供功法服务与挂机配置复用。
 * 2. 做什么：集中维护功法可见性、技能启用态与层数解锁口径，避免不同入口各自拼技能列表。
 * 3. 不做什么：不负责角色技能槽写入、不负责挂机配置持久化，也不处理 HTTP 请求参数。
 *
 * 输入/输出：
 * - 输入：characterId。
 * - 输出：当前可用技能明细列表，或仅包含 skillId 的集合。
 *
 * 数据流/状态流：
 * character_technique 已装备功法 -> technique_layer 静态层配置 -> skill_def 静态技能定义
 * -> 本模块组装当前角色可用技能 -> 功法面板 / 挂机策略归一化复用。
 *
 * 关键边界条件与坑点：
 * 1. 只认“当前已装备功法且层数已解锁”的技能，未装备功法或更高层技能必须直接排除。
 * 2. 功法定义与技能定义都要过滤 disabled/不可见项，避免不同消费方看到不一致的技能集合。
 */

import { query } from '../../config/database.js';
import {
  isManualSkillTriggerType,
  resolveSkillTriggerType,
} from '../../shared/skillTriggerType.js';
import { getSkillDefinitions, getTechniqueDefinitions, type SkillDefConfig } from '../staticConfigLoader.js';
import { buildEffectiveTechniqueSkillData } from './techniqueSkillProgression.js';
import { isCharacterVisibleTechniqueDefinition } from './techniqueUsageScope.js';
import {
  buildTechniqueSkillUpgradeCountMap,
  getTechniqueLayersByTechniqueIdsStatic,
  type TechniqueLayerStaticRow,
} from './techniqueUpgradeRules.js';

type EquippedTechniqueLite = {
  techniqueId: string;
  currentLayer: number;
  slotType: 'main' | 'sub';
  slotIndex: number | null;
};

type EquippedTechniqueRow = {
  technique_id: string;
  current_layer: number;
  slot_type: 'main' | 'sub' | null;
  slot_index: number | null;
};

export type CharacterAvailableSkillEntry = {
  skillId: string;
  techniqueId: string;
  techniqueName: string;
  skillName: string;
  skillIcon: string;
  description: string | null;
  costLingqi: number;
  costLingqiRate: number;
  costQixue: number;
  costQixueRate: number;
  cooldown: number;
  targetType: string;
  targetCount: number;
  damageType: string | null;
  element: string;
  effects: NonNullable<SkillDefConfig['effects']>;
};

export const getCharacterVisibleTechniqueDefMap = () => {
  return new Map(
    getTechniqueDefinitions()
      .filter((entry) => entry.enabled !== false)
      .filter((entry) => isCharacterVisibleTechniqueDefinition(entry))
      .map((entry) => [entry.id, entry] as const),
  );
};

export const getEnabledSkillDefMap = () => {
  return new Map(
    getSkillDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );
};

const loadEquippedTechniqueLite = async (characterId: number): Promise<EquippedTechniqueLite[]> => {
  const result = await query(
    `
      SELECT technique_id, current_layer, slot_type, slot_index
      FROM character_technique
      WHERE character_id = $1 AND slot_type IS NOT NULL
    `,
    [characterId],
  );

  return (result.rows as EquippedTechniqueRow[])
    .map((row) => {
      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
      const currentLayer = Number(row.current_layer ?? 0) || 0;
      const slotType = row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null;
      const slotIndex = row.slot_index === null || row.slot_index === undefined ? null : Number(row.slot_index);
      if (!techniqueId || !slotType) return null;
      return {
        techniqueId,
        currentLayer,
        slotType,
        slotIndex: Number.isFinite(slotIndex ?? NaN) ? Math.floor(Number(slotIndex)) : null,
      };
    })
    .filter((entry): entry is EquippedTechniqueLite => Boolean(entry));
};

export const loadCharacterAvailableSkillEntries = async (
  characterId: number,
): Promise<CharacterAvailableSkillEntry[]> => {
  const equipped = await loadEquippedTechniqueLite(characterId);
  if (equipped.length === 0) return [];

  const techniqueIds = Array.from(new Set(equipped.map((entry) => entry.techniqueId)));
  const layerRows = getTechniqueLayersByTechniqueIdsStatic(techniqueIds);

  const techniqueMap = getCharacterVisibleTechniqueDefMap();
  const skillMap = getEnabledSkillDefMap();
  const maxLayerByTechnique = new Map(equipped.map((entry) => [entry.techniqueId, entry.currentLayer] as const));
  const unlockedByTechnique = new Map<string, Set<string>>();
  const layerRowsByTechnique = new Map<string, TechniqueLayerStaticRow[]>();
  for (const row of layerRows) {
    const rows = layerRowsByTechnique.get(row.techniqueId) ?? [];
    rows.push(row);
    layerRowsByTechnique.set(row.techniqueId, rows);
  }
  const upgradeCountByTechnique = new Map<string, Map<string, number>>();
  for (const equippedEntry of equipped) {
    upgradeCountByTechnique.set(
      equippedEntry.techniqueId,
      buildTechniqueSkillUpgradeCountMap(
        layerRowsByTechnique.get(equippedEntry.techniqueId) ?? [],
        equippedEntry.currentLayer,
      ),
    );
  }

  for (const row of layerRows) {
    const techniqueId = row.techniqueId;
    const layer = row.layer;
    const maxLayer = maxLayerByTechnique.get(techniqueId) ?? 0;
    if (!techniqueId || layer <= 0 || layer > maxLayer) continue;
    const unlockedSkillIds = row.unlockSkillIds;
    const unlockedSet = unlockedByTechnique.get(techniqueId) ?? new Set<string>();
    for (const skillId of unlockedSkillIds) {
      unlockedSet.add(skillId);
    }
    unlockedByTechnique.set(techniqueId, unlockedSet);
  }

  const dedup = new Set<string>();
  const entries: CharacterAvailableSkillEntry[] = [];
  for (const equippedEntry of equipped) {
    const techniqueDef = techniqueMap.get(equippedEntry.techniqueId);
    const techniqueName = String(techniqueDef?.name || equippedEntry.techniqueId);
    const skillIds = Array.from(unlockedByTechnique.get(equippedEntry.techniqueId) ?? []);
    for (const skillId of skillIds) {
      const skillDef = skillMap.get(skillId);
      if (!skillDef) continue;
      const dedupKey = `${equippedEntry.techniqueId}:${skillId}`;
      if (dedup.has(dedupKey)) continue;
      dedup.add(dedupKey);
      const upgradeLevel = upgradeCountByTechnique.get(equippedEntry.techniqueId)?.get(skillId) ?? 0;
      const effectiveSkill = buildEffectiveTechniqueSkillData(skillDef, upgradeLevel);
      const resolvedTriggerType = resolveSkillTriggerType({
        triggerType: skillDef.trigger_type,
        effects: effectiveSkill.effects,
      });
      if (!isManualSkillTriggerType(resolvedTriggerType)) continue;
      entries.push({
        skillId,
        techniqueId: equippedEntry.techniqueId,
        techniqueName,
        skillName: String(skillDef.name || skillId),
        skillIcon: String(skillDef.icon || ''),
        description: typeof skillDef.description === 'string' ? skillDef.description : null,
        costLingqi: effectiveSkill.cost_lingqi,
        costLingqiRate: effectiveSkill.cost_lingqi_rate,
        costQixue: effectiveSkill.cost_qixue,
        costQixueRate: effectiveSkill.cost_qixue_rate,
        cooldown: effectiveSkill.cooldown,
        targetType: String(skillDef.target_type || ''),
        targetCount: effectiveSkill.target_count,
        damageType: typeof skillDef.damage_type === 'string' ? skillDef.damage_type : null,
        element: String(skillDef.element || 'none'),
        effects: effectiveSkill.effects,
      });
    }
  }

  return entries.sort(
    (left, right) => left.techniqueName.localeCompare(right.techniqueName) || left.skillName.localeCompare(right.skillName),
  );
};

export const listCharacterAvailableSkillIdSet = async (characterId: number): Promise<Set<string>> => {
  const availableSkills = await loadCharacterAvailableSkillEntries(characterId);
  return new Set(availableSkills.map((entry) => entry.skillId));
};
