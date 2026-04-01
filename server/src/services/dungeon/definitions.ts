/**
 * 秘境定义查询（分类/列表/预览）
 *
 * 作用：提供秘境分类统计、列表筛选、详细预览功能。
 * 不做什么：不处理实例创建/战斗/奖励。
 *
 * 输入：筛选条件（type/关键词/境界）、dungeonId、difficultyRank、userId。
 * 输出：分类列表 / 秘境定义列表 / 完整预览数据（含怪物/掉落/进入次数）。
 *
 * 复用点：
 * - getDungeonPreview 被 stageData.ts 的 getDungeonAndDifficulty 调用。
 * - 所有函数通过 service.ts 暴露给路由层。
 *
 * 边界条件：
 * 1) getDungeonPreview 是大函数（约 400 行），负责聚合关卡/波次/怪物/掉落预览信息。
 */

import { query } from '../../config/database.js';
import {
  getItemDefinitionsByIds,
  getMonsterDefinitions,
} from '../staticConfigLoader.js';
import { resolveDropPoolById } from '../dropPoolResolver.js';
import {
  getAdjustedChance,
  getAdjustedWeight,
  normalizeMonsterKind,
  type DropEntrySourceType,
} from '../shared/dropRateMultiplier.js';
import { getAdjustedDropQuantityRange } from '../shared/dropQuantityMultiplier.js';
import { getOnlineBattleCharacterSnapshotByUserId } from '../onlineBattleProjectionService.js';
import { resolveDungeonRewardMultiplier } from './shared/difficulty.js';
import {
  getEnabledDungeonDefs,
  getDungeonDefById,
  getEnabledDungeonDifficultiesByDungeonId,
  getEnabledDungeonStagesByDifficultyId,
  getEnabledDungeonWavesByStageId,
} from './shared/configLoader.js';
import { getDungeonEntryRemaining } from './shared/entryCount.js';
import { asObject, asArray, asNumber, asString, isRealmSufficient } from './shared/typeUtils.js';
import type {
  DungeonType,
  DungeonCategoryDto,
  DungeonDefDto,
  DungeonDifficultyRow,
  DungeonStageRow,
  DungeonWaveRow,
  MonsterLiteRow,
  ItemLiteRow,
} from './types.js';

/** 秘境类型 -> 中文名称映射 */
export const DUNGEON_TYPE_LABEL: Record<DungeonType, string> = {
  material: '材料秘境',
  equipment: '装备秘境',
  trial: '试炼秘境',
  challenge: '挑战秘境',
  event: '活动秘境',
};

/** 获取秘境分类统计 */
export const getDungeonCategories = async (): Promise<DungeonCategoryDto[]> => {
  const defs = getEnabledDungeonDefs();
  const counter = new Map<DungeonType, number>();
  for (const def of defs) {
    counter.set(def.type, (counter.get(def.type) ?? 0) + 1);
  }
  const categories: DungeonCategoryDto[] = [];
  for (const [type, count] of counter.entries()) {
    categories.push({ type, label: DUNGEON_TYPE_LABEL[type], count });
  }

  for (const t of Object.keys(DUNGEON_TYPE_LABEL) as DungeonType[]) {
    if (!categories.some((c) => c.type === t)) {
      categories.push({ type: t, label: DUNGEON_TYPE_LABEL[t], count: 0 });
    }
  }

  return categories;
};

/** 获取秘境列表（支持按类型/关键词/境界筛选） */
export const getDungeonList = async (params: {
  type?: DungeonType;
  q?: string;
  realm?: string;
}): Promise<DungeonDefDto[]> => {
  const keyword = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const list: DungeonDefDto[] = [];
  for (const entry of getEnabledDungeonDefs()) {
    if (params.type && entry.type !== params.type) continue;
    if (keyword) {
      const name = entry.name.toLowerCase();
      const category = (entry.category ?? '').toLowerCase();
      if (!name.includes(keyword) && !category.includes(keyword)) continue;
    }
    const minRealm = entry.min_realm;
    if (params.realm && minRealm && !isRealmSufficient(params.realm, minRealm)) continue;
    list.push({
      ...entry,
      min_realm: minRealm,
    });
  }
  return list.sort((left, right) => right.sort_weight - left.sort_weight || left.id.localeCompare(right.id));
};

/** 获取秘境完整预览（含难度/关卡/波次/怪物/掉落/进入次数） */
export const getDungeonPreview = async (
  dungeonId: string,
  difficultyRank: number = 1,
  userId?: number
): Promise<{
  dungeon: DungeonDefDto | null;
  difficulty: Pick<DungeonDifficultyRow, 'id' | 'name' | 'difficulty_rank'> | null;
  entry: {
    daily_limit: number;
    weekly_limit: number;
    daily_used: number;
    weekly_used: number;
    daily_remaining: number | null;
    weekly_remaining: number | null;
  } | null;
  stages: Array<
    Pick<DungeonStageRow, 'id' | 'stage_index' | 'name' | 'type'> & {
      waves: Array<{
        wave_index: number;
        spawn_delay_sec: number;
        monsters: Array<{
          id: string;
          name: string;
          realm: string | null;
          level: number;
          avatar: string | null;
          kind: string | null;
          count: number;
          drop_pool_id: string | null;
          drop_preview: Array<{
            item_id: string;
            mode: 'prob' | 'weight';
            chance: number | null;
            weight: number | null;
            qty_min: number;
            qty_max: number;
          }>;
        }>;
      }>;
    }
  >;
  drop_items: Array<{ id: string; name: string; quality: string | null }>;
  drop_sources: Array<{ pool_id: string; from: string }>;
} | null> => {
  const dungeon = getDungeonDefById(dungeonId);
  if (!dungeon) return null;

  const entry =
    typeof userId === 'number' && Number.isFinite(userId)
      ? await (async () => {
        const snapshot = await getOnlineBattleCharacterSnapshotByUserId(userId);
        const characterId = snapshot?.characterId ?? null;
        if (!characterId) return null;
        return getDungeonEntryRemaining(characterId, dungeonId, dungeon.daily_limit, dungeon.weekly_limit);
      })()
      : null;

  const diffRow =
    getEnabledDungeonDifficultiesByDungeonId(dungeonId).find((entry) => entry.difficulty_rank === difficultyRank) ??
    null;
  if (!diffRow) {
    return { dungeon, difficulty: null, entry, stages: [], drop_items: [], drop_sources: [] };
  }
  const dungeonRewardMultiplier = resolveDungeonRewardMultiplier(diffRow.reward_mult);

  const stages = getEnabledDungeonStagesByDifficultyId(diffRow.id);

  const stageIds = stages.map((s) => s.id);
  const waves: DungeonWaveRow[] = stageIds.flatMap((stageId) => getEnabledDungeonWavesByStageId(stageId));

  const monsterIdSet = new Set<string>();
  for (const w of waves) {
    for (const m of asArray(w.monsters)) {
      const obj = asObject(m);
      const monsterId = obj?.monster_def_id;
      if (typeof monsterId === 'string' && monsterId) monsterIdSet.add(monsterId);
    }
  }
  const monsterIds = Array.from(monsterIdSet);

  const monstersRes =
    monsterIds.length === 0
      ? { rows: [] as MonsterLiteRow[] }
      : {
        rows: getMonsterDefinitions()
          .filter((entry) => entry.enabled !== false)
          .filter((entry) => monsterIds.includes(entry.id))
          .sort((left, right) => Number(left.level ?? 0) - Number(right.level ?? 0) || String(left.id).localeCompare(String(right.id)))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            realm: entry.realm ?? null,
            level: Number(entry.level ?? 0),
            avatar: entry.avatar ?? null,
            kind: entry.kind ?? null,
            drop_pool_id: entry.drop_pool_id ?? null,
          } as MonsterLiteRow)),
      };
  const monsters = monstersRes.rows as MonsterLiteRow[];

  const stageNameById = new Map(stages.map((s) => [s.id, s.name ?? `第${s.stage_index}关`]));
  const monsterById = new Map(monsters.map((m) => [m.id, m]));

  const monsterDropPoolIds: string[] = [];
  const monsterDropPoolIdSet = new Set<string>();
  for (const m of monsters) {
    const poolId = typeof m.drop_pool_id === 'string' ? m.drop_pool_id : null;
    if (!poolId) continue;
    if (monsterDropPoolIdSet.has(poolId)) continue;
    monsterDropPoolIdSet.add(poolId);
    monsterDropPoolIds.push(poolId);
  }

  type DropPreviewRow = {
    drop_pool_id: string;
    mode: 'prob' | 'weight';
    item_def_id: string;
    chance: number;
    weight: number;
    chance_add_by_monster_realm: number;
    qty_min: number;
    qty_max: number;
    qty_min_add_by_monster_realm: number;
    qty_max_add_by_monster_realm: number;
    qty_multiply_by_monster_realm: number;
    sourceType: DropEntrySourceType;
    sourcePoolId: string;
    sort_order: number;
  };

  const dropPreviewRows: DropPreviewRow[] = [];
  for (const poolId of monsterDropPoolIds) {
    const pool = resolveDropPoolById(poolId);
    if (!pool) continue;
    const mode: 'prob' | 'weight' = pool.mode;
    for (const entry of pool.entries) {
      if (!entry.show_in_ui) continue;
      const itemDefId = entry.item_def_id.trim();
      if (!itemDefId) continue;
      dropPreviewRows.push({
        drop_pool_id: poolId,
        mode,
        item_def_id: itemDefId,
        chance: asNumber(entry.chance, 0),
        weight: asNumber(entry.weight, 0),
        chance_add_by_monster_realm: asNumber(entry.chance_add_by_monster_realm, 0),
        qty_min: entry.qty_min,
        qty_max: entry.qty_max,
        qty_min_add_by_monster_realm: entry.qty_min_add_by_monster_realm,
        qty_max_add_by_monster_realm: entry.qty_max_add_by_monster_realm,
        qty_multiply_by_monster_realm: asNumber(entry.qty_multiply_by_monster_realm, 1),
        sourceType: entry.sourceType,
        sourcePoolId: entry.sourcePoolId,
        sort_order: Math.max(0, Math.floor(asNumber(entry.sort_order, 0))),
      });
    }
  }

  dropPreviewRows.sort(
    (left, right) =>
      left.drop_pool_id.localeCompare(right.drop_pool_id) ||
      left.sort_order - right.sort_order ||
      left.item_def_id.localeCompare(right.item_def_id),
  );

  const dropPreviewItemIds = Array.from(new Set(dropPreviewRows.map((row) => row.item_def_id)));
  const dropPreviewItemDefs = getItemDefinitionsByIds(dropPreviewItemIds);
  const dropPreviewItemMap = new Map<string, { id: string; name: string; quality: string | null; icon: string | null }>();
  for (const itemId of dropPreviewItemIds) {
    const def = dropPreviewItemDefs.get(itemId);
    if (!def || def.enabled === false) continue;
    dropPreviewItemMap.set(itemId, {
      id: itemId,
      name: String(def.name || itemId),
      quality: typeof def.quality === 'string' ? def.quality : null,
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }

  const dropPreviewByPoolId = new Map<
    string,
    Array<{
      mode: 'prob' | 'weight';
      item_def_id: string;
      chance: number;
      weight: number;
      chance_add_by_monster_realm: number;
      qty_min: number;
      qty_max: number;
      qty_min_add_by_monster_realm: number;
      qty_max_add_by_monster_realm: number;
      qty_multiply_by_monster_realm: number;
      sourceType: DropEntrySourceType;
      sourcePoolId: string;
      sort_order: number;
    }>
  >();

  for (const r of dropPreviewRows) {
    const poolId = String(r.drop_pool_id || '');
    if (!poolId) continue;
    const mode = r.mode;
    const list = dropPreviewByPoolId.get(poolId) ?? [];
    list.push({
      mode,
      item_def_id: r.item_def_id,
      chance: mode === 'prob' ? r.chance : 0,
      weight: mode === 'weight' ? r.weight : 0,
      chance_add_by_monster_realm: r.chance_add_by_monster_realm,
      qty_min: r.qty_min,
      qty_max: r.qty_max,
      qty_min_add_by_monster_realm: r.qty_min_add_by_monster_realm,
      qty_max_add_by_monster_realm: r.qty_max_add_by_monster_realm,
      qty_multiply_by_monster_realm: r.qty_multiply_by_monster_realm,
      sourceType: r.sourceType,
      sourcePoolId: r.sourcePoolId,
      sort_order: r.sort_order,
    });
    dropPreviewByPoolId.set(poolId, list);
  }

  const buildMonsterDropPreview = (
    rows: Array<{
      mode: 'prob' | 'weight';
      item_def_id: string;
      chance: number;
      weight: number;
      chance_add_by_monster_realm: number;
      qty_min: number;
      qty_max: number;
      qty_min_add_by_monster_realm: number;
      qty_max_add_by_monster_realm: number;
      qty_multiply_by_monster_realm: number;
      sourceType: DropEntrySourceType;
      sourcePoolId: string;
      sort_order: number;
    }>,
    monsterKind: string | null,
    monsterRealm: string | null,
  ): Array<{
    item_id: string;
    mode: 'prob' | 'weight';
    chance: number | null;
    weight: number | null;
    qty_min: number;
    qty_max: number;
  }> => {
    const kind = normalizeMonsterKind(monsterKind);
    const options = {
      isDungeonBattle: true,
      monsterKind: kind,
      monsterRealm,
      dungeonRewardMultiplier,
    };
    return rows
      .map((r) => {
        const quantityRange = getAdjustedDropQuantityRange({
          itemDefId: r.item_def_id,
          qtyMin: r.qty_min,
          qtyMax: r.qty_max,
          qtyMinAddByMonsterRealm: r.qty_min_add_by_monster_realm,
          qtyMaxAddByMonsterRealm: r.qty_max_add_by_monster_realm,
          sourceType: r.sourceType,
          sourcePoolId: r.sourcePoolId,
          dropMultiplierOptions: options,
          qtyMultiplyByMonsterRealm: r.qty_multiply_by_monster_realm,
          monsterRealm,
        });
        return {
          item_id: r.item_def_id,
          mode: r.mode,
          chance: r.mode === 'prob'
            ? getAdjustedChance(r.chance, r.sourceType, r.sourcePoolId, {
              ...options,
              chanceAddByMonsterRealm: r.chance_add_by_monster_realm,
            })
            : null,
          weight: r.mode === 'weight' ? getAdjustedWeight(r.weight, r.sourceType, r.sourcePoolId, options) : null,
          qty_min: quantityRange.qtyMin,
          qty_max: quantityRange.qtyMax,
        };
      });
  };

  const wavesByStageId = new Map<string, DungeonWaveRow[]>();
  for (const w of waves) {
    const sid = asString(w.stage_id, '');
    if (!sid) continue;
    const list = wavesByStageId.get(sid) ?? [];
    list.push(w);
    wavesByStageId.set(sid, list);
  }

  const stagesWithWaves = stages.map((s) => {
    const stageWaves = wavesByStageId.get(s.id) ?? [];
    return {
      id: s.id,
      stage_index: s.stage_index,
      name: s.name,
      type: s.type,
      waves: stageWaves.map((w) => {
        const waveIndex = asNumber(w.wave_index, 1);
        const spawnDelaySec = asNumber(w.spawn_delay_sec, 0);
        const waveMonsters: Array<{
          id: string;
          name: string;
          realm: string | null;
          level: number;
          avatar: string | null;
          kind: string | null;
          count: number;
          drop_pool_id: string | null;
          drop_preview: Array<{
            item_id: string;
            mode: 'prob' | 'weight';
            chance: number | null;
            weight: number | null;
            qty_min: number;
            qty_max: number;
          }>;
        }> = [];

        for (const m of asArray(w.monsters)) {
          const obj = asObject(m);
          if (!obj) continue;
          const monsterId = asString(obj.monster_def_id, '');
          if (!monsterId) continue;
          const count = Math.max(1, Math.floor(asNumber(obj.count, 1)));
          const monster = monsterById.get(monsterId) ?? null;
          const poolId = monster && typeof monster.drop_pool_id === 'string' ? monster.drop_pool_id : null;
          const monsterKind = monster?.kind ?? null;
          const previewRows = poolId ? dropPreviewByPoolId.get(poolId) ?? [] : [];
          const dropPreview = previewRows.length > 0
            ? buildMonsterDropPreview(previewRows, monsterKind, monster?.realm ?? null)
            : [];
          waveMonsters.push({
            id: monsterId,
            name: monster?.name ?? monsterId,
            realm: monster?.realm ?? null,
            level: asNumber(monster?.level, 1),
            avatar: monster?.avatar ?? null,
            kind: monster?.kind ?? null,
            count,
            drop_pool_id: poolId,
            drop_preview: dropPreview,
          });
        }

        return {
          wave_index: waveIndex,
          spawn_delay_sec: spawnDelaySec,
          monsters: waveMonsters,
        };
      }),
    };
  });

  const dropItems: Array<{ item_def_id: string; from: string }> = [];
  const firstClear = asObject(diffRow.first_clear_rewards);
  for (const it of asArray(firstClear?.items)) {
    const obj = asObject(it);
    const itemDefId = obj?.item_def_id;
    if (typeof itemDefId === 'string' && itemDefId) {
      dropItems.push({ item_def_id: itemDefId, from: `${diffRow.name}·首通` });
    }
  }

  const dropIdSet = new Set<string>();
  const itemIds: string[] = [];
  for (const d of dropItems) {
    if (dropIdSet.has(d.item_def_id)) continue;
    dropIdSet.add(d.item_def_id);
    itemIds.push(d.item_def_id);
  }

  const itemDefs = getItemDefinitionsByIds(itemIds);
  const itemMap = new Map<string, ItemLiteRow>();
  for (const itemId of itemIds) {
    const def = itemDefs.get(itemId);
    if (!def || def.enabled === false) continue;
    itemMap.set(itemId, {
      id: itemId,
      name: String(def.name || itemId),
      quality: typeof def.quality === 'string' ? def.quality : null,
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }

  const drop_items = Array.from(new Set(
    Array.from(dropPreviewItemMap.values()).map((it) => ({
      id: it.id,
      name: it.name,
      quality: it.quality ?? null,
    }))
  )).sort((a, b) => a.id.localeCompare(b.id));

  const drop_sources: Array<{ pool_id: string; from: string }> = [
    ...monsterDropPoolIds.map((poolId) => ({ pool_id: poolId, from: '击杀掉落' })),
    ...dropItems.map((d) => ({ pool_id: d.item_def_id, from: d.from })),
  ];

  return {
    dungeon,
    difficulty: { id: diffRow.id, name: diffRow.name, difficulty_rank: diffRow.difficulty_rank },
    entry,
    stages: stagesWithWaves,
    drop_items,
    drop_sources,
  };
};
