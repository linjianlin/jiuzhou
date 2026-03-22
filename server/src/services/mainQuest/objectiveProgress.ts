/**
 * 主线目标进度推进
 *
 * 作用：处理各类目标事件（击杀、采集、到达等）推进当前任务节的目标进度，以及同步境界/技能/背包持有类目标。
 * 输入：characterId + MainQuestProgressEvent。
 * 输出：推进结果（是否更新、是否全部完成）。
 *
 * 数据流：
 * 1. updateSectionProgressLegacy：读进度（FOR UPDATE）→ 匹配目标 → 更新进度 → 写回 DB
 * 2. syncCurrentSectionStaticProgress：读进度 → 检查境界/技能目标 → 自动补完
 *
 * 边界条件：
 * 1) 仅在 section_status = 'objectives' 时处理，其余阶段直接返回。
 * 2) syncCurrentSectionStaticProgress 是幂等操作，可在多处安全调用；适合在进入 objectives 阶段时回填“背包里已持有”的收集目标。
 */
import { query } from '../../config/database.js';
import { getRealmOrderIndex } from '../shared/realmRules.js';
import { getTechniqueDefinitions } from '../staticConfigLoader.js';
import { asString, asNumber, asArray, asObject } from '../shared/typeCoercion.js';
import { loadCharacterWritebackRowByCharacterId } from '../playerWritebackCacheService.js';
import { loadPlayerInventoryStatesByCharacterId } from '../playerStateRepository.js';
import { getEnabledMainQuestSectionById } from './shared/questConfig.js';
import type { SectionStatus, MainQuestProgressEvent } from './types.js';
import { updateSectionProgressByEvent } from './progressUpdater.js';

/** 获取境界等级排名（委托 realmRules） */
const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmOrderIndex(realmRaw, subRealmRaw);
};

/**
 * 查询当前任务节里所有 collect 目标对应的背包持有量。
 *
 * 这样进入 objectives 阶段时，前置环节已经获得的任务物品就能一次性回填，
 * 避免“明明背包里已经够了，但仍要额外再捡一次”。
 */
const loadCollectObjectiveItemQtyMap = async (
  characterId: number,
  objectives: Array<{ type?: unknown; params?: unknown }>,
): Promise<Map<string, number>> => {
  const itemIds = Array.from(
    new Set(
      objectives
        .filter((objective) => asString(objective.type) === 'collect')
        .map((objective) => asString(asObject(objective.params).item_id).trim())
        .filter((itemId) => itemId.length > 0),
    ),
  );

  if (itemIds.length === 0) {
    return new Map<string, number>();
  }

  const itemQtyMap = new Map<string, number>();
  const itemIdSet = new Set(itemIds);
  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  for (const row of inventoryStates) {
    if (asString(row.location) !== 'bag') continue;
    const itemId = asString(row.item_def_id).trim();
    if (!itemId) continue;
    if (!itemIdSet.has(itemId)) continue;
    itemQtyMap.set(itemId, (itemQtyMap.get(itemId) ?? 0) + Math.max(0, Math.floor(asNumber(row.qty, 0))));
  }
  return itemQtyMap;
};

/** 同步境界/技能/背包持有目标（幂等） */
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
  const collectObjectiveItemQtyMap = await loadCollectObjectiveItemQtyMap(cid, objectives);

  const characterRow = await loadCharacterWritebackRowByCharacterId(cid);
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

    if (objType === 'collect') {
      const itemId = asString(params.item_id).trim();
      const qtyHave = itemId ? (collectObjectiveItemQtyMap.get(itemId) ?? 0) : 0;
      const nextDone = Math.min(target, qtyHave);
      if (nextDone > done) {
        progressData[objId] = nextDone;
        updated = true;
      }
      continue;
    }

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
  return updateSectionProgressByEvent(characterId, event);
};
