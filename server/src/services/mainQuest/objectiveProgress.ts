/**
 * 主线目标进度推进
 *
 * 作用：处理各类目标事件（击杀、采集、到达等）推进当前任务节的目标进度，以及同步境界/技能类静态目标。
 * 输入：characterId + MainQuestProgressEvent。
 * 输出：推进结果（是否更新、是否全部完成）。
 *
 * 数据流：
 * 1. updateSectionProgressLegacy：读进度（FOR UPDATE）→ 匹配目标 → 更新进度 → 写回 DB
 * 2. syncCurrentSectionStaticProgress：读进度 → 检查境界/技能目标 → 自动补完
 *
 * 边界条件：
 * 1) 仅在 section_status = 'objectives' 时处理，其余阶段直接返回。
 * 2) syncCurrentSectionStaticProgress 是幂等操作，可在多处安全调用。
 */
import { query } from '../../config/database.js';
import { getRealmOrderIndex } from '../shared/realmRules.js';
import { getTechniqueDefinitions } from '../staticConfigLoader.js';
import { asString, asNumber, asArray, asObject } from '../shared/typeCoercion.js';
import { getEnabledMainQuestSectionById } from './shared/questConfig.js';
import type { SectionStatus, MainQuestProgressEvent } from './types.js';

/** 获取境界等级排名（委托 realmRules） */
const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmOrderIndex(realmRaw, subRealmRaw);
};

/** 同步境界/技能目标（幂等） */
export const syncCurrentSectionStaticProgress = async (characterId: number): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  const progressRes = await query(
    `SELECT current_section_id, section_status, objectives_progress
     FROM character_main_quest_progress
     WHERE character_id = $1 FOR UPDATE`,
    [cid],
  );
  if (!progressRes.rows?.[0]) {
    return;
  }

  const progress = progressRes.rows[0] as {
    current_section_id?: unknown;
    section_status?: unknown;
    objectives_progress?: unknown;
  };
  if (asString(progress.section_status) !== 'objectives') {
    return;
  }

  const sectionId = asString(progress.current_section_id);
  if (!sectionId) {
    return;
  }

  const section = getEnabledMainQuestSectionById(sectionId);
  if (!section) {
    return;
  }

  const objectives = asArray<{ id?: unknown; type?: unknown; target?: unknown; params?: unknown }>(section.objectives);
  const progressData = asObject(progress.objectives_progress);

  const characterRes = await query(`SELECT realm, sub_realm FROM characters WHERE id = $1 LIMIT 1`, [cid]);
  const characterRow = characterRes.rows?.[0] as { realm?: unknown; sub_realm?: unknown } | undefined;
  const currentRealmRank = getRealmRank(characterRow?.realm, characterRow?.sub_realm);

  const techniqueRes = await query(
    `SELECT technique_id, current_layer FROM character_technique WHERE character_id = $1`,
    [cid],
  );
  const currentTechniqueLayerMap = new Map<string, number>();
  for (const row of techniqueRes.rows ?? []) {
    const record = row as { technique_id?: unknown; current_layer?: unknown };
    const techniqueId = asString(record.technique_id).trim();
    if (!techniqueId) continue;
    const currentLayer = Math.max(0, Math.floor(asNumber(record.current_layer, 0)));
    const prevLayer = currentTechniqueLayerMap.get(techniqueId) ?? 0;
    if (currentLayer > prevLayer) currentTechniqueLayerMap.set(techniqueId, currentLayer);
  }

  let updated = false;
  for (const obj of objectives) {
    const objId = asString(obj.id);
    if (!objId) continue;
    const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
    const done = asNumber(progressData[objId], 0);
    if (done >= target) continue;

    const objType = asString(obj.type);
    const params = asObject(obj.params);

    if (objType === 'upgrade_realm') {
      const requiredRealm = asString(params.realm).trim();
      const requiredRealmRank = getRealmRank(requiredRealm);
      if (!requiredRealm) continue;
      if (requiredRealmRank >= 0 && currentRealmRank >= requiredRealmRank) {
        progressData[objId] = target;
        updated = true;
      }
    }

    if (objType === 'upgrade_technique') {
      const techniqueId = asString(params.technique_id).trim();
      const requiredQuality = asString(params.quality).trim();
      const requiredLayer = Math.max(1, Math.floor(asNumber(params.layer, 1)));

      if (techniqueId) {
        // 按具体功法 ID 匹配
        const currentLayer = currentTechniqueLayerMap.get(techniqueId) ?? 0;
        if (currentLayer >= requiredLayer) {
          progressData[objId] = target;
          updated = true;
        }
      } else if (requiredQuality) {
        // 按品质匹配：玩家拥有任意一门该品质功法且 layer >= 要求即可
        const qualityTechIds = new Set(
          getTechniqueDefinitions()
            .filter((t) => t.enabled !== false && asString(t.quality).trim() === requiredQuality)
            .map((t) => t.id),
        );
        for (const [tid, layer] of currentTechniqueLayerMap) {
          if (qualityTechIds.has(tid) && layer >= requiredLayer) {
            progressData[objId] = target;
            updated = true;
            break;
          }
        }
      }
    }
  }

  if (!updated) {
    return;
  }

  const allDone = objectives.every((obj) => {
    const objId = asString(obj.id);
    if (!objId) return true;
    const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
    return asNumber(progressData[objId], 0) >= target;
  });
  const nextStatus: SectionStatus = allDone ? 'turnin' : 'objectives';
  await query(
    `UPDATE character_main_quest_progress
     SET objectives_progress = $2::jsonb,
         section_status = $3,
         updated_at = NOW()
     WHERE character_id = $1`,
    [cid, JSON.stringify(progressData), nextStatus],
  );
};

/** 处理目标事件推进（旧版，被 service.updateProgress 委托） */
export const updateSectionProgressLegacy = async (
  characterId: number,
  event: MainQuestProgressEvent,
): Promise<{ success: boolean; message: string; updated: boolean; completed: boolean }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在', updated: false, completed: false };

  const progressRes = await query(
    `SELECT current_section_id, section_status, objectives_progress
     FROM character_main_quest_progress
     WHERE character_id = $1 FOR UPDATE`,
    [cid],
  );
  if (!progressRes.rows?.[0]) {
    return { success: false, message: '主线进度不存在', updated: false, completed: false };
  }

  const progress = progressRes.rows[0] as {
    current_section_id?: unknown;
    section_status?: unknown;
    objectives_progress?: unknown;
  };
  if (asString(progress.section_status) !== 'objectives') {
    return { success: true, message: '当前不在目标阶段', updated: false, completed: false };
  }

  const sectionId = asString(progress.current_section_id);
  if (!sectionId) {
    return { success: false, message: '任务节不存在', updated: false, completed: false };
  }

  const section = getEnabledMainQuestSectionById(sectionId);
  if (!section) {
    return { success: false, message: '任务节不存在', updated: false, completed: false };
  }

  const objectives = asArray<{ id?: unknown; type?: unknown; target?: unknown; params?: unknown }>(section.objectives);
  const progressData = asObject(progress.objectives_progress);
  let updated = false;

  for (const obj of objectives) {
    const objId = asString(obj.id);
    const objType = asString(obj.type);
    const target = asNumber(obj.target, 1);
    const params = asObject(obj.params);
    const currentDone = asNumber(progressData[objId], 0);
    if (!objId) continue;
    if (currentDone >= target) continue;

    let matched = false;
    let delta = 0;

    if (event.type === 'talk_npc') {
      if (objType === 'talk_npc' && asString(params.npc_id) === event.npcId) {
        matched = true;
        delta = 1;
      }
    }

    if (event.type === 'kill_monster') {
      if (objType === 'kill_monster' && asString(params.monster_id) === event.monsterId) {
        matched = true;
        delta = Math.max(1, Math.floor(event.count));
      }
    }

    if (event.type === 'gather_resource') {
      if (objType === 'gather_resource' && asString(params.resource_id) === event.resourceId) {
        matched = true;
        delta = Math.max(1, Math.floor(event.count));
      }
    }

    if (event.type === 'collect') {
      if (objType === 'collect' && asString(params.item_id) === event.itemId) {
        matched = true;
        delta = Math.max(1, Math.floor(event.count));
      }
    }

    if (event.type === 'dungeon_clear') {
      if (objType === 'dungeon_clear') {
        const dungeonId = asString(params.dungeon_id);
        const difficultyId = asString(params.difficulty_id);
        const dungeonMatch = !dungeonId || dungeonId === event.dungeonId;
        const difficultyMatch = !difficultyId || difficultyId === asString(event.difficultyId);
        if (dungeonMatch && difficultyMatch) {
          matched = true;
          delta = Math.max(1, Math.floor(event.count));
        }
      }
    }

    if (event.type === 'craft_item') {
      if (objType === 'craft_item') {
        const recipeId = asString(params.recipe_id);
        const recipeType = asString(params.recipe_type);
        const craftKind = asString(params.craft_kind);
        const itemId = asString(params.item_id);

        const recipeMatch = !recipeId || recipeId === asString(event.recipeId);
        const recipeTypeMatch = !recipeType || recipeType === asString(event.recipeType);
        const craftKindMatch = !craftKind || craftKind === asString(event.craftKind);
        const itemMatch = !itemId || itemId === asString(event.itemId);
        if (recipeMatch && recipeTypeMatch && craftKindMatch && itemMatch) {
          matched = true;
          delta = Math.max(1, Math.floor(event.count));
        }
      }
    }

    if (event.type === 'reach') {
      if (objType === 'reach' && asString(params.room_id) === event.roomId) {
        matched = true;
        delta = 1;
      }
    }

    if (event.type === 'upgrade_technique') {
      if (objType === 'upgrade_technique' && event.layer >= asNumber(params.layer, 1)) {
        const techniqueId = asString(params.technique_id).trim();
        const requiredQuality = asString(params.quality).trim();

        if (techniqueId) {
          // 按具体功法 ID 匹配
          if (techniqueId === event.techniqueId) {
            matched = true;
            delta = 1;
          }
        } else if (requiredQuality) {
          // 按品质匹配：查询触发事件的功法品质
          const techDef = getTechniqueDefinitions().find(
            (t) => t.id === event.techniqueId && t.enabled !== false,
          );
          if (techDef && asString(techDef.quality).trim() === requiredQuality) {
            matched = true;
            delta = 1;
          }
        }
      }
    }

    if (event.type === 'upgrade_realm') {
      const requiredRealm = asString(params.realm).trim();
      const requiredRealmRank = getRealmRank(requiredRealm);
      const currentRealmRank = getRealmRank(event.realm);
      if (objType === 'upgrade_realm' && requiredRealm && requiredRealmRank >= 0 && currentRealmRank >= requiredRealmRank) {
        matched = true;
        delta = 1;
      }
    }

    if (matched && delta > 0) {
      progressData[objId] = Math.min(target, currentDone + delta);
      updated = true;
    }
  }

  if (!updated) {
    return { success: true, message: '无匹配目标', updated: false, completed: false };
  }

  const allDone = objectives.every((obj) => {
    const objId = asString(obj.id);
    if (!objId) return true;
    const target = asNumber(obj.target, 1);
    return asNumber(progressData[objId], 0) >= target;
  });

  const newStatus: SectionStatus = allDone ? 'turnin' : 'objectives';
  await query(
    `UPDATE character_main_quest_progress
     SET objectives_progress = $2::jsonb,
         section_status = $3,
         updated_at = NOW()
     WHERE character_id = $1`,
    [cid, JSON.stringify(progressData), newStatus],
  );
  return { success: true, message: 'ok', updated: true, completed: allDone };
};
