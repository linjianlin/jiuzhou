/**
 * 九州修仙录 - 角色功法服务
 * 功能：功法状态查询、修炼升级、装备功法、技能配置、属性计算
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import {
  consumeCharacterStoredResourcesAndMaterialsAtomically,
} from './inventory/shared/consume.js';
import { updateSectionProgress } from './mainQuest/index.js';
import { updateAchievementProgress } from './achievementService.js';
import { isCharacterInBattle } from './battle/index.js';
import { scheduleCharacterBattleLoadoutRefreshByCharacterId } from './battle/shared/profileCache.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import { scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId } from './onlineBattleProjectionService.js';
import { getItemDefinitionById } from './staticConfigLoader.js';
import {
  getItemMetaMap,
  getTechniqueLayerByTechniqueAndLayerStatic,
  getTechniqueLayersByTechniqueIdStatic,
  resolveTechniqueCostMultiplierByQuality,
  scaleTechniqueBaseCostByQuality,
  type TechniqueLayerStaticRow,
} from './shared/techniqueUpgradeRules.js';
import {
  cleanupPersistedIdleConfigAutoSkillPolicy,
} from './idle/idleAutoSkillPolicy.js';
import {
  getCharacterVisibleTechniqueDefMap,
  getEnabledSkillDefMap,
  loadCharacterAvailableSkillEntries,
  listCharacterAvailableSkillIdSet,
} from './shared/characterAvailableSkills.js';
import { loadCharacterBattleSkillEntries } from './shared/characterBattleSkills.js';

// ============================================
// 类型定义
// ============================================
export interface CharacterTechnique {
  id: number;
  character_id: number;
  technique_id: string;
  current_layer: number;
  slot_type: 'main' | 'sub' | null;
  slot_index: number | null;
  acquired_at: Date;
  // 关联的功法定义
  technique_name?: string;
  technique_type?: string;
  technique_quality?: string;
  max_layer?: number;
  attribute_type?: string;
  attribute_element?: string;
}

export interface CharacterSkillSlot {
  slot_index: number;
  skill_id: string;
  skill_name?: string;
  skill_icon?: string;
}

export interface TechniquePassive {
  key: string;
  value: number;
}

export interface UpgradeCost {
  spirit_stones: number;
  exp: number;
  materials: { itemId: string; qty: number; itemName?: string; itemIcon?: string | null }[];
}

export interface ServiceResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}


// ============================================
// 辅助函数
// ============================================
const asStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

type SkillSlotLite = {
  slotIndex: number;
  skillId: string;
};

type ReconciledSkillSlot = SkillSlotLite & {
  skillName: string;
};

const filterSkillSlotsByAvailableSkillSet = (
  slots: SkillSlotLite[],
  availableSkillIds: Set<string>,
): SkillSlotLite[] => {
  if (slots.length === 0) return [];
  if (availableSkillIds.size === 0) return [];
  return slots.filter((slot) => availableSkillIds.has(slot.skillId));
};

const buildReconciledSkillSlots = (slots: SkillSlotLite[]): ReconciledSkillSlot[] => {
  const skillMap = getEnabledSkillDefMap();
  return slots
    .map((slot) => {
      const def = skillMap.get(slot.skillId);
      return {
        slotIndex: slot.slotIndex,
        skillId: slot.skillId,
        skillName: String(def?.name || slot.skillId),
      };
    })
    .sort((left, right) => left.slotIndex - right.slotIndex);
};

const buildTechniqueSwitchMessage = (baseMessage: string, removedSlots: ReconciledSkillSlot[]): string => {
  if (removedSlots.length === 0) return baseMessage;
  const removedText = removedSlots
    .map((entry) => `${entry.slotIndex}号位${entry.skillName}`)
    .join('、');
  return `${baseMessage}，已自动卸下不兼容技能：${removedText}`;
};

const reconcileEquippedSkillSlots = async (characterId: number): Promise<ReconciledSkillSlot[]> => {
  const availableSkillIds = await listCharacterAvailableSkillIdSet(characterId);
  const removedResult =
    availableSkillIds.size === 0
      ? await query(
          `DELETE FROM character_skill_slot
           WHERE character_id = $1
           RETURNING slot_index, skill_id`,
          [characterId],
        )
      : await query(
          `DELETE FROM character_skill_slot
           WHERE character_id = $1
             AND NOT (skill_id = ANY($2::text[]))
           RETURNING slot_index, skill_id`,
          [characterId, Array.from(availableSkillIds)],
        );

  const removedSlots: SkillSlotLite[] = (removedResult.rows as Array<Record<string, unknown>>)
    .map((row) => {
      const slotIndex = Number(row.slot_index ?? 0) || 0;
      const skillId = typeof row.skill_id === 'string' ? row.skill_id.trim() : '';
      if (!skillId || slotIndex <= 0) return null;
      return { slotIndex, skillId };
    })
    .filter((entry): entry is SkillSlotLite => Boolean(entry));

  return buildReconciledSkillSlots(removedSlots);
};

/**
 * 功法变更后的战斗状态刷新入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理功法升级、装备、卸下后的属性缓存失效与在线战斗快照刷新。
 * 2. 做什么：复用 `invalidateCharacterComputedCache` 内置的 battle loadout 刷新，避免多个写链路重复拼同一套刷新顺序。
 * 3. 不做什么：不处理技能槽顺序变更；那类改动走独立的技能槽刷新入口。
 *
 * 输入/输出：
 * - 输入：characterId。
 * - 输出：Promise<void>；副作用是事务提交后让后续战斗读取到最新功法属性与技能装配。
 *
 * 数据流/状态流：
 * 功法写库成功 -> 本入口 -> invalidateCharacterComputedCache
 * -> scheduleCharacterBattleLoadoutRefreshByCharacterId
 * -> scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId。
 *
 * 关键边界条件与坑点：
 * 1. 必须先失效 computed，再刷新在线战斗快照；否则快照重建会读到旧属性或旧 loadout。
 * 2. invalidateCharacterComputedCache 已经负责调度 battle loadout 刷新，这里不能再重复调同一层刷新。
 */
const refreshCharacterBattleStateAfterTechniqueMutation = async (
  characterId: number,
): Promise<void> => {
  await invalidateCharacterComputedCache(characterId);
  await scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId(characterId);
};

/**
 * 技能槽变更后的战斗状态刷新入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理主动技能槽写入后的 battle loadout 刷新与在线战斗快照刷新。
 * 2. 做什么：避免 equipSkill / unequipSkill 各自维护一套刷新调用，导致技能栏与战斗入口读取口径漂移。
 * 3. 不做什么：不触发属性重算；技能槽顺序调整本身不改变 computed 属性。
 *
 * 输入/输出：
 * - 输入：characterId。
 * - 输出：Promise<void>；副作用是事务提交后让新战斗读取到最新技能槽顺序。
 *
 * 数据流/状态流：
 * 技能槽写库成功 -> 本入口 -> scheduleCharacterBattleLoadoutRefreshByCharacterId
 * -> scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId。
 *
 * 关键边界条件与坑点：
 * 1. 这里只适用于技能槽变化；若同时影响角色属性，必须走功法刷新入口。
 * 2. 在线战斗入口优先读取 OnlineBattleCharacterSnapshot.loadout，只刷新 loadout 但不刷新 snapshot 仍会拿到旧技能集。
 */
const refreshCharacterBattleStateAfterSkillSlotMutation = async (
  characterId: number,
): Promise<void> => {
  await scheduleCharacterBattleLoadoutRefreshByCharacterId(characterId);
  await scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId(characterId);
};

/**
 * 角色功法服务
 *
 * 作用：管理角色功法的修炼升级、装备/卸下、技能配置、被动属性计算
 * 不做：不处理路由层参数校验、不做权限判断
 *
 * 数据流：
 * - 读方法直接查询 character_technique / character_skill_slot 表
 * - 写方法通过 @Transactional 保证事务原子性，内部统一使用 query() 访问数据库
 *
 * 边界条件：
 * 1) upgradeTechnique / equipTechnique / unequipTechnique / equipSkill 使用 @Transactional
 * 2) 纯读方法（getCharacterTechniques / getEquippedTechniques 等）不加 @Transactional
 */
class CharacterTechniqueService {
  // ============================================
  // 1. 获取角色已学习的功法列表（纯读，不加 @Transactional）
  // ============================================
  async getCharacterTechniques(
    characterId: number
  ): Promise<ServiceResult<CharacterTechnique[]>> {
    const result = await query(
      `
        SELECT id, character_id, technique_id, current_layer, slot_type, slot_index, acquired_at
        FROM character_technique
        WHERE character_id = $1
      `,
      [characterId],
    );
    const techniqueMap = getCharacterVisibleTechniqueDefMap();
    const rowsWithRank: Array<CharacterTechnique & { __quality_rank: number }> = [];
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
      const def = techniqueMap.get(techniqueId);
      if (!def) continue;
      rowsWithRank.push({
        id: Number(row.id ?? 0) || 0,
        character_id: Number(row.character_id ?? 0) || 0,
        technique_id: techniqueId,
        current_layer: Number(row.current_layer ?? 1) || 1,
        slot_type: row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null,
        slot_index: row.slot_index === null || row.slot_index === undefined ? null : Number(row.slot_index),
        acquired_at: row.acquired_at instanceof Date ? row.acquired_at : new Date(String(row.acquired_at ?? '')),
        technique_name: def.name,
        technique_type: def.type,
        technique_quality: def.quality,
        max_layer: Number(def.max_layer ?? 1),
        attribute_type: def.attribute_type ?? 'physical',
        attribute_element: def.attribute_element ?? 'none',
        __quality_rank: resolveTechniqueCostMultiplierByQuality(def.quality),
      });
    }
    const rows = rowsWithRank
      .sort((left, right) => {
        const rank = (slotType: CharacterTechnique['slot_type']): number => (slotType === 'main' ? 0 : slotType === 'sub' ? 1 : 2);
        const slotCmp = rank(left.slot_type) - rank(right.slot_type);
        if (slotCmp !== 0) return slotCmp;
        const leftIndex = left.slot_index ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = right.slot_index ?? Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return right.__quality_rank - left.__quality_rank;
      })
      .map(({ __quality_rank, ...entry }) => entry);
    return { success: true, message: '获取成功', data: rows };
  }

  // ============================================
  // 2. 获取角色已装备的功法（主+副）（纯读，不加 @Transactional）
  // ============================================
  async getEquippedTechniques(
    characterId: number
  ): Promise<ServiceResult<{ main: CharacterTechnique | null; subs: CharacterTechnique[] }>> {
    const all = await this.getCharacterTechniques(characterId);
    if (!all.success) return { success: false, message: all.message };

    let main: CharacterTechnique | null = null;
    const subs: CharacterTechnique[] = [];

    for (const row of all.data ?? []) {
      if (!row.slot_type) continue;
      if (row.slot_type === 'main') {
        main = row;
      } else if (row.slot_type === 'sub') {
        subs.push(row);
      }
    }

    return { success: true, message: '获取成功', data: { main, subs } };
  }


  // ============================================
  // 3. 获取功法升级消耗（纯读，不加 @Transactional）
  // ============================================
  async getTechniqueUpgradeCost(
    characterId: number,
    techniqueId: string
  ): Promise<ServiceResult<UpgradeCost & { currentLayer: number; maxLayer: number }>> {
    // 获取角色当前功法层数
    const ctResult = await query(
      'SELECT current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      return { success: false, message: '未学习该功法' };
    }
    const currentLayer = ctResult.rows[0].current_layer;

    // 获取功法最大层数
    const techniqueDef = getCharacterVisibleTechniqueDefMap().get(techniqueId) ?? null;
    if (!techniqueDef) {
      return { success: false, message: '功法不存在' };
    }
    const maxLayer = Number(techniqueDef.max_layer ?? 1);
    const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(techniqueDef.quality);

    if (currentLayer >= maxLayer) {
      return { success: false, message: '已达最高层数' };
    }

    // 获取下一层消耗
    const nextLayer = currentLayer + 1;
    const layer = getTechniqueLayerByTechniqueAndLayerStatic(techniqueId, nextLayer);
    if (!layer) {
      return { success: false, message: '层级配置不存在' };
    }

    const rawMaterials = layer.costMaterials;
    const metaMap = await getItemMetaMap(rawMaterials.map((m) => m.itemId));
    const materials = rawMaterials.map((m) => {
      const meta = metaMap.get(m.itemId) ?? null;
      return { itemId: m.itemId, qty: m.qty, itemName: meta?.name, itemIcon: meta?.icon };
    });
    return {
      success: true,
      message: '获取成功',
      data: {
        currentLayer,
        maxLayer,
        spirit_stones: scaleTechniqueBaseCostByQuality(layer.costSpiritStones, qualityMultiplier),
        exp: scaleTechniqueBaseCostByQuality(layer.costExp, qualityMultiplier),
        materials
      }
    };
  }


  // ============================================
  // 4. 修炼升级功法（写操作，@Transactional）
  // ============================================
  @Transactional
  async upgradeTechnique(
    characterId: number,
    techniqueId: string
  ): Promise<ServiceResult<{ newLayer: number; unlockedSkills: string[]; upgradedSkills: string[] }>> {
    // 获取角色当前功法层数
    const ctResult = await query(
      'SELECT id, current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2 FOR UPDATE',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      return { success: false, message: '未学习该功法' };
    }
    const currentLayer = ctResult.rows[0].current_layer;
    const ctId = ctResult.rows[0].id;

    // 获取功法最大层数
    const techniqueDef = getCharacterVisibleTechniqueDefMap().get(techniqueId) ?? null;
    if (!techniqueDef) {
      return { success: false, message: '功法不存在' };
    }
    const maxLayer = Number(techniqueDef.max_layer ?? 1);
    const techName = techniqueDef.name;
    const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(techniqueDef.quality);

    if (currentLayer >= maxLayer) {
      return { success: false, message: '已达最高层数' };
    }

    // 获取下一层消耗和奖励
    const nextLayer = currentLayer + 1;
    const layer = getTechniqueLayerByTechniqueAndLayerStatic(techniqueId, nextLayer);
    if (!layer) {
      return { success: false, message: '层级配置不存在' };
    }

    const costStones = scaleTechniqueBaseCostByQuality(layer.costSpiritStones, qualityMultiplier);
    const costExp = scaleTechniqueBaseCostByQuality(layer.costExp, qualityMultiplier);
    const costMaterials = layer.costMaterials;

    const consumeResourceResult = await consumeCharacterStoredResourcesAndMaterialsAtomically(characterId, {
      spiritStones: costStones,
      exp: costExp,
      materials: costMaterials.map((mat) => ({
        itemId: mat.itemId,
        qty: mat.qty,
        itemName: getItemDefinitionById(mat.itemId)?.name ?? mat.itemId,
      })),
    });
    if (!consumeResourceResult.success) {
      return { success: false, message: consumeResourceResult.message };
    }

    // 升级功法层数
    await query(
      'UPDATE character_technique SET current_layer = $1, updated_at = NOW() WHERE id = $2',
      [nextLayer, ctId]
    );
    await refreshCharacterBattleStateAfterTechniqueMutation(characterId);

    await updateSectionProgress(characterId, { type: 'upgrade_technique', techniqueId, layer: nextLayer });
    await updateAchievementProgress(characterId, 'skill:level:any', 1);
    await updateAchievementProgress(characterId, `skill:level:layer:${nextLayer}`, 1);
    await updateAchievementProgress(characterId, `skill:level:${techniqueId}`, 1);

    return {
      success: true,
      message: `${techName}修炼至第${nextLayer}层`,
      data: {
        newLayer: nextLayer,
        unlockedSkills: layer.unlockSkillIds || [],
        upgradedSkills: layer.upgradeSkillIds || []
      }
    };
  }


  // ============================================
  // 5. 装备功法到槽位（写操作，@Transactional）
  // ============================================
  @Transactional
  async equipTechnique(
    characterId: number,
    techniqueId: string,
    slotType: 'main' | 'sub',
    slotIndex?: number // sub时需要指定1-3
  ): Promise<ServiceResult> {
    // 检查是否在战斗中
    if (isCharacterInBattle(characterId)) {
      return { success: false, message: '战斗中无法切换功法' };
    }

    // 检查是否已学习该功法
    const ctResult = await query(
      'SELECT id, slot_type, slot_index FROM character_technique WHERE character_id = $1 AND technique_id = $2 FOR UPDATE',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      return { success: false, message: '未学习该功法' };
    }

    const ct = ctResult.rows[0];
    const wasMain = ct.slot_type === 'main';

    // 如果已装备在目标位置，无需操作
    if (ct.slot_type === slotType && (slotType === 'main' || ct.slot_index === slotIndex)) {
      return { success: true, message: '功法已在该位置' };
    }

    if (slotType === 'main') {
      // 卸下当前主功法
      await query(
        `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
         WHERE character_id = $1 AND slot_type = 'main'`,
        [characterId]
      );
    } else {
      // 副功法槽位验证
      if (!slotIndex || slotIndex < 1 || slotIndex > 3) {
        return { success: false, message: '副功法槽位必须为1-3' };
      }

      // 卸下当前槽位的功法
      await query(
        `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
         WHERE character_id = $1 AND slot_type = 'sub' AND slot_index = $2`,
        [characterId, slotIndex]
      );
    }

    // 装备新功法
    await query(
      `UPDATE character_technique SET slot_type = $1, slot_index = $2, updated_at = NOW()
       WHERE id = $3`,
      [slotType, slotType === 'main' ? null : slotIndex, ct.id]
    );

    // 如果装备了主功法，更新角色属性类型
    if (slotType === 'main') {
      const techniqueDef = getCharacterVisibleTechniqueDefMap().get(techniqueId) ?? null;
      if (techniqueDef) {
        await query(
          'UPDATE characters SET attribute_type = $1, attribute_element = $2, updated_at = NOW() WHERE id = $3',
          [techniqueDef.attribute_type ?? 'physical', techniqueDef.attribute_element ?? 'none', characterId]
        );
      }
    } else if (wasMain) {
      const mainResult = await query(
        `SELECT technique_id
         FROM character_technique
         WHERE character_id = $1 AND slot_type = 'main'
         LIMIT 1`,
        [characterId]
      );
      if (mainResult.rows.length > 0) {
        const mainTechniqueId = typeof mainResult.rows[0].technique_id === 'string' ? mainResult.rows[0].technique_id : '';
        const mainDef = getCharacterVisibleTechniqueDefMap().get(mainTechniqueId) ?? null;
        await query(
          'UPDATE characters SET attribute_type = $1, attribute_element = $2, updated_at = NOW() WHERE id = $3',
          [mainDef?.attribute_type ?? 'physical', mainDef?.attribute_element ?? 'none', characterId]
        );
      } else {
        await query(
          `UPDATE characters SET attribute_type = 'physical', attribute_element = 'none', updated_at = NOW() WHERE id = $1`,
          [characterId]
        );
      }
    }
    const removedSlots = await reconcileEquippedSkillSlots(characterId);
    await cleanupPersistedIdleConfigAutoSkillPolicy(characterId);
    await refreshCharacterBattleStateAfterTechniqueMutation(characterId);
    return {
      success: true,
      message: buildTechniqueSwitchMessage('装备成功', removedSlots),
    };
  }

  // ============================================
  // 6. 卸下功法（写操作，@Transactional）
  // ============================================
  @Transactional
  async unequipTechnique(
    characterId: number,
    techniqueId: string
  ): Promise<ServiceResult> {
    // 检查是否在战斗中
    if (isCharacterInBattle(characterId)) {
      return { success: false, message: '战斗中无法切换功法' };
    }

    const result = await query(
      `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
       WHERE character_id = $1 AND technique_id = $2 AND slot_type IS NOT NULL
       RETURNING slot_type`,
      [characterId, techniqueId]
    );

    if (result.rowCount === 0) {
      return { success: false, message: '功法未装备' };
    }

    // 如果卸下的是主功法，重置角色属性类型
    if (result.rows[0].slot_type === 'main') {
      await query(
        `UPDATE characters SET attribute_type = 'physical', attribute_element = 'none', updated_at = NOW() WHERE id = $1`,
        [characterId]
      );
    }
    const removedSlots = await reconcileEquippedSkillSlots(characterId);
    await cleanupPersistedIdleConfigAutoSkillPolicy(characterId);
    await refreshCharacterBattleStateAfterTechniqueMutation(characterId);
    return {
      success: true,
      message: buildTechniqueSwitchMessage('卸下成功', removedSlots),
    };
  }

  // ============================================
  // 6.1 散去未装配功法（写操作，@Transactional）
  // ============================================
  @Transactional
  async dissipateTechnique(
    characterId: number,
    techniqueId: string,
  ): Promise<ServiceResult> {
    const result = await query(
      `SELECT id, technique_id, slot_type, slot_index
       FROM character_technique
       WHERE character_id = $1 AND technique_id = $2
       FOR UPDATE`,
      [characterId, techniqueId],
    );

    if (result.rows.length === 0) {
      return { success: false, message: '未学习该功法' };
    }

    const row = result.rows[0] as Record<string, unknown>;
    const slotType = row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null;
    if (slotType) {
      return { success: false, message: '已运功的功法不可散功，请先取消运功' };
    }

    const techniqueRowId = Number(row.id ?? 0) || 0;
    if (techniqueRowId <= 0) {
      return { success: false, message: '功法记录异常' };
    }

    await query(
      `DELETE FROM character_technique
       WHERE id = $1`,
      [techniqueRowId],
    );

    return {
      success: true,
      message: '散功成功',
    };
  }


  // ============================================
  // 7. 获取角色可用技能列表（从已装备功法解锁的技能）（纯读，不加 @Transactional）
  // ============================================
  async getAvailableSkills(
    characterId: number
  ): Promise<ServiceResult<{
    skillId: string;
    skillName: string;
    skillIcon: string;
    techniqueId: string;
    techniqueName: string;
    // 完整技能数据
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
    effects: unknown[];
  }[]>> {
    const skills = (await loadCharacterAvailableSkillEntries(characterId)).map((row) => ({
      skillId: row.skillId,
      skillName: row.skillName,
      skillIcon: row.skillIcon,
      techniqueId: row.techniqueId,
      techniqueName: row.techniqueName,
      description: row.description,
      costLingqi: row.costLingqi,
      costLingqiRate: row.costLingqiRate,
      costQixue: row.costQixue,
      costQixueRate: row.costQixueRate,
      cooldown: row.cooldown,
      targetType: row.targetType,
      targetCount: row.targetCount,
      damageType: row.damageType,
      element: row.element,
      effects: row.effects,
    }));

    return { success: true, message: '获取成功', data: skills };
  }

  // ============================================
  // 8. 获取角色已装备的技能槽（纯读，不加 @Transactional）
  // ============================================
  async getEquippedSkills(
    characterId: number
  ): Promise<ServiceResult<CharacterSkillSlot[]>> {
    const result = await query(
      `
        SELECT slot_index, skill_id
        FROM character_skill_slot
        WHERE character_id = $1
        ORDER BY slot_index
      `,
      [characterId],
    );
    const slots: SkillSlotLite[] = (result.rows as Array<Record<string, unknown>>)
      .map((row) => {
        const skillId = typeof row.skill_id === 'string' ? row.skill_id.trim() : '';
        const slotIndex = Number(row.slot_index ?? 0) || 0;
        if (!skillId || slotIndex <= 0) return null;
        return { slotIndex, skillId };
      })
      .filter((entry): entry is SkillSlotLite => Boolean(entry));

    const skillMap = getEnabledSkillDefMap();
    const rows = slots.map((slot) => {
      const def = skillMap.get(slot.skillId);
      return {
        slot_index: slot.slotIndex,
        skill_id: slot.skillId,
        skill_name: String(def?.name || slot.skillId),
        skill_icon: String(def?.icon || ''),
      };
    });
    return { success: true, message: '获取成功', data: rows };
  }

  // ============================================
  // 9. 装备技能到槽位（写操作，@Transactional）
  // ============================================
  @Transactional
  async equipSkill(
    characterId: number,
    skillId: string,
    slotIndex: number
  ): Promise<ServiceResult> {
    if (slotIndex < 1 || slotIndex > 10) {
      return { success: false, message: '技能槽位必须为1-10' };
    }

    /**
     * 角色技能槽写入串行化锁（基于角色行锁）
     *
     * 作用（做什么 / 不做什么）：
     * 1) 做什么：在事务内通过 `characters` 主键行 `FOR UPDATE` 将同一角色的技能槽写操作串行化，消除并发装配时的唯一键竞态。
     * 2) 不做什么：不负责角色存在性报错语义，不改变技能可用性与槽位替换规则。
     *
     * 输入/输出：
     * - 输入：characterId（当前角色ID）
     * - 输出：无返回值；成功即表示本事务已拿到该角色写锁。
     *
     * 数据流/状态流：
     * - 先拿角色行锁，再做可用技能校验、同技能迁移与槽位 upsert；
     * - 并发事务会在这里排队，直到前一个事务提交/回滚后再继续。
     *
     * 关键边界条件与坑点：
     * 1) 必须放在 `@Transactional` 方法内部，否则 `FOR UPDATE` 只能在单语句生命周期内生效，无法实现跨语句串行化。
     * 2) 锁粒度固定为“单角色”，因此只会阻塞同角色并发写，不会放大到全表级别。
     */
    await query('SELECT id FROM characters WHERE id = $1 FOR UPDATE', [characterId]);

    // 检查技能是否可用（来自已装备功法且已解锁）
    const available = await loadCharacterAvailableSkillEntries(characterId);
    if (!available.some((entry) => entry.skillId === skillId)) {
      return { success: false, message: '技能不可用（未解锁或功法未装备）' };
    }

    // 检查技能是否已装备在其他槽位
    const existResult = await query(
      'SELECT slot_index FROM character_skill_slot WHERE character_id = $1 AND skill_id = $2',
      [characterId, skillId]
    );
    if (existResult.rows.length > 0 && existResult.rows[0].slot_index !== slotIndex) {
      // 从原槽位移除
      await query(
        'DELETE FROM character_skill_slot WHERE character_id = $1 AND skill_id = $2',
        [characterId, skillId]
      );
    }

    // 装备到目标槽位（替换原有技能）
    await query(`
      INSERT INTO character_skill_slot (character_id, slot_index, skill_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (character_id, slot_index) DO UPDATE SET skill_id = $3, updated_at = NOW()
    `, [characterId, slotIndex, skillId]);
    await refreshCharacterBattleStateAfterSkillSlotMutation(characterId);
    return { success: true, message: '装备成功' };
  }

  // ============================================
  // 10. 卸下技能（单条 DELETE，不需要 @Transactional）
  // ============================================
  async unequipSkill(
    characterId: number,
    slotIndex: number
  ): Promise<ServiceResult> {
    const result = await query(
      'DELETE FROM character_skill_slot WHERE character_id = $1 AND slot_index = $2',
      [characterId, slotIndex]
    );

    if (result.rowCount === 0) {
      return { success: false, message: '该槽位无技能' };
    }

    await refreshCharacterBattleStateAfterSkillSlotMutation(characterId);
    return { success: true, message: '卸下成功' };
  }


  // ============================================
  // 11. 计算功法被动加成（用于战斗和属性面板）（纯读，不加 @Transactional）
  // ============================================
  private calcTechniquePassiveEffectiveValue(value: number, ratio: number): number {
    // 百分比统一为比例值后，需要保留更高精度，避免 30% 副功法把小数加成截断成 0。
    return Math.round(value * ratio * 10000) / 10000;
  }

  async calculateTechniquePassives(
    characterId: number
  ): Promise<ServiceResult<Record<string, number>>> {
    const equippedTechniqueRows = await query(
      `
        SELECT technique_id, current_layer, slot_type
        FROM character_technique ct
        WHERE ct.character_id = $1
          AND ct.slot_type IS NOT NULL
      `,
      [characterId],
    );

    const passives: Record<string, number> = {};

    for (const row of equippedTechniqueRows.rows as Array<Record<string, unknown>>) {
      const slotType = row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null;
      if (!slotType) continue;

      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id.trim() : '';
      if (!techniqueId) continue;
      const currentLayer = Math.max(0, Math.floor(Number(row.current_layer ?? 0) || 0));
      if (currentLayer <= 0) continue;

      const ratio = slotType === 'main' ? 1 : 0.3;
      const layerRows = getTechniqueLayersByTechniqueIdStatic(techniqueId).filter((entry) => entry.layer <= currentLayer);
      for (const layerRow of layerRows) {
        for (const p of layerRow.passives) {
          if (typeof p.key !== 'string' || p.key.length === 0) continue;
          if (typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
          const effectiveValue = this.calcTechniquePassiveEffectiveValue(p.value, ratio);
          passives[p.key] = (passives[p.key] || 0) + effectiveValue;
        }
      }
    }

    return { success: true, message: '计算成功', data: passives };
  }

  // ============================================
  // 12. 获取角色战斗技能列表（用于战斗系统）（纯读，不加 @Transactional）
  // ============================================
  async getBattleSkills(
    characterId: number
  ): Promise<ServiceResult<{ skillId: string; upgradeLevel: number }[]>> {
    const skills = await loadCharacterBattleSkillEntries(characterId);
    if (skills.length === 0) {
      return { success: true, message: '无装备技能', data: [] };
    }
    return { success: true, message: '获取成功', data: skills };
  }

  // ============================================
  // 13. 获取完整的角色功法状态（用于前端展示）（纯读，不加 @Transactional）
  // ============================================
  async getCharacterTechniqueStatus(
    characterId: number
  ): Promise<ServiceResult<{
    techniques: CharacterTechnique[];
    equippedMain: CharacterTechnique | null;
    equippedSubs: CharacterTechnique[];
    equippedSkills: CharacterSkillSlot[];
    availableSkills: {
      skillId: string;
      skillName: string;
      skillIcon: string;
      techniqueId: string;
      techniqueName: string;
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
      effects: unknown[];
    }[];
    passives: Record<string, number>;
  }>> {
    const [techniquesRes, equippedRes, skillsRes, availableRes, passivesRes] = await Promise.all([
      this.getCharacterTechniques(characterId),
      this.getEquippedTechniques(characterId),
      this.getEquippedSkills(characterId),
      this.getAvailableSkills(characterId),
      this.calculateTechniquePassives(characterId)
    ]);

    if (!techniquesRes.success || !equippedRes.success || !skillsRes.success ||
        !availableRes.success || !passivesRes.success) {
      return { success: false, message: '获取功法状态失败' };
    }

    const availableSkills = availableRes.data!;
    const availableSkillIdSet = new Set(availableSkills.map((entry) => entry.skillId));
    const equippedSkillSlots: SkillSlotLite[] = (skillsRes.data ?? [])
      .map((entry) => {
        const skillId = typeof entry.skill_id === 'string' ? entry.skill_id.trim() : '';
        const slotIndex = Number(entry.slot_index ?? 0) || 0;
        if (!skillId || slotIndex <= 0) return null;
        return { slotIndex, skillId };
      })
      .filter((entry): entry is SkillSlotLite => Boolean(entry));
    const filteredSlots = filterSkillSlotsByAvailableSkillSet(equippedSkillSlots, availableSkillIdSet);
    const skillMap = getEnabledSkillDefMap();
    const filteredEquippedSkills: CharacterSkillSlot[] = filteredSlots.map((entry) => {
      const def = skillMap.get(entry.skillId);
      return {
        slot_index: entry.slotIndex,
        skill_id: entry.skillId,
        skill_name: String(def?.name || entry.skillId),
        skill_icon: String(def?.icon || ''),
      };
    });

    return {
      success: true,
      message: '获取成功',
      data: {
        techniques: techniquesRes.data!,
        equippedMain: equippedRes.data!.main,
        equippedSubs: equippedRes.data!.subs,
        equippedSkills: filteredEquippedSkills,
        availableSkills,
        passives: passivesRes.data!
      }
    };
  }
}

export const characterTechniqueService = new CharacterTechniqueService();
