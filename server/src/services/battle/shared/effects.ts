/**
 * 装备套装效果 / 词缀效果查询与合并
 *
 * 作用：
 * - 查询角色已装备物品的套装效果（BattleSetBonusEffect）
 * - 查询角色已装备物品的词缀效果
 * - 合并两类效果到 CharacterData
 *
 * 不做什么：不修改角色数据、不参与战斗计算。
 *
 * 输入/输出：
 * - getCharacterBattleSetBonusEffects: characterId -> BattleSetBonusEffect[]
 * - getCharacterBattleAffixEffects: characterId -> BattleSetBonusEffect[]
 * - attachSetBonusEffectsToCharacterData: (characterId, data) -> data（附加 setBonusEffects）
 *
 * 复用点：
 * - pve.ts / pvp.ts / preparation.ts / snapshot.ts 中调用 attachSetBonusEffectsToCharacterData
 *
 * 边界条件：
 * 1) 查询失败时回退为基础角色数据（不中断战斗流程）
 * 2) 套装效果按 priority -> pieceCount 升序排列
 */

import { query } from "../../../config/database.js";
import type { BattleSetBonusEffect } from "../../../battle/types.js";
import type { CharacterData } from "../../../battle/battleFactory.js";
import {
  getItemDefinitionsByIds,
  getItemSetDefinitions,
  type ItemDefConfig,
} from "../../staticConfigLoader.js";
import {
  extractBattleAffixEffectsFromEquippedItems,
  type BattleAffixEffectSource,
} from "../../battleAffixEffectService.js";
import { toNumber, toRecord, toText } from "./helpers.js";

// ------ 常量 ------

const BATTLE_SET_BONUS_TRIGGER_SET = new Set([
  "on_turn_start",
  "on_skill",
  "after_skill",
  "on_hit",
  "on_crit",
  "on_be_hit",
  "on_heal",
]);

const BATTLE_SET_BONUS_EFFECT_TYPE_SET = new Set([
  "buff",
  "debuff",
  "damage",
  "heal",
  "resource",
  "shield",
  "mark",
  "spell_projection",
  "defer_damage",
  "extra_action",
]);

const BATTLE_EFFECT_QUERY_BATCH_SIZE = 200;
const BATTLE_EFFECT_QUERY_CONCURRENCY = 2;

type EquippedBattleEffectRow = {
  owner_character_id: number;
  item_instance_id?: number;
  item_def_id: string;
  affixes: unknown;
};

const groupEquippedBattleEffectRowsByCharacterId = (
  rows: EquippedBattleEffectRow[],
): Map<number, EquippedBattleEffectRow[]> => {
  const result = new Map<number, EquippedBattleEffectRow[]>();

  for (const row of rows) {
    const characterId = Math.floor(Number(row.owner_character_id) || 0);
    if (characterId <= 0) continue;

    const currentRows = result.get(characterId) ?? [];
    currentRows.push(row);
    result.set(characterId, currentRows);
  }

  return result;
};

const mergeEquippedBattleEffectRowsMap = (
  target: Map<number, EquippedBattleEffectRow[]>,
  source: Map<number, EquippedBattleEffectRow[]>,
): void => {
  for (const [characterId, rows] of source.entries()) {
    const currentRows = target.get(characterId) ?? [];
    currentRows.push(...rows);
    target.set(characterId, currentRows);
  }
};

const splitIntoChunks = <T>(values: T[], size: number): T[][] => {
  if (values.length <= 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const buildStaticSetBonusBySetId = (): Map<
  string,
  { setName: string; bonuses: Array<{ piece_count: number; priority: number; effect_defs: unknown[] }> }
> => {
  const staticSetMap = new Map<
    string,
    { setName: string; bonuses: Array<{ piece_count: number; priority: number; effect_defs: unknown[] }> }
  >();

  for (const setDef of getItemSetDefinitions()) {
    if (setDef.enabled === false) continue;
    const setId = toText(setDef.id);
    if (!setId) continue;
    const bonuses = Array.isArray(setDef.bonuses) ? setDef.bonuses : [];
    const sortedBonuses = bonuses
      .map((bonus) => ({
        piece_count: Math.max(1, Math.floor(Number(bonus.piece_count) || 1)),
        priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
        effect_defs: Array.isArray(bonus.effect_defs) ? bonus.effect_defs : [],
      }))
      .sort(
        (left, right) =>
          left.priority - right.priority || left.piece_count - right.piece_count,
      );
    staticSetMap.set(setId, {
      setName: toText(setDef.name) || setId,
      bonuses: sortedBonuses,
    });
  }

  return staticSetMap;
};

const buildCharacterBattleSetBonusEffectsFromRows = (
  rows: EquippedBattleEffectRow[],
  defs: ReadonlyMap<string, ItemDefConfig>,
  staticSetBonusBySetId: ReadonlyMap<string, { setName: string; bonuses: Array<{ piece_count: number; priority: number; effect_defs: unknown[] }> }>,
): BattleSetBonusEffect[] => {
  const setCountMap = new Map<string, number>();
  for (const row of rows) {
    const itemDefId = toText(row.item_def_id);
    if (!itemDefId) continue;
    const setId = toText(defs.get(itemDefId)?.set_id);
    if (!setId) continue;
    setCountMap.set(setId, (setCountMap.get(setId) ?? 0) + 1);
  }

  const out: BattleSetBonusEffect[] = [];
  for (const [setId, equippedCount] of setCountMap.entries()) {
    const setConfig = staticSetBonusBySetId.get(setId);
    if (!setConfig) continue;

    for (const bonus of setConfig.bonuses) {
      if (equippedCount < bonus.piece_count) continue;
      for (const raw of bonus.effect_defs) {
        const effectRow = toRecord(raw);
        const trigger = toText(effectRow.trigger);
        const effectType = toText(effectRow.effect_type);
        if (!BATTLE_SET_BONUS_TRIGGER_SET.has(trigger)) continue;
        if (!BATTLE_SET_BONUS_EFFECT_TYPE_SET.has(effectType)) continue;

        const targetRaw = toText(effectRow.target);
        const target = targetRaw === "enemy" ? "enemy" : "self";
        const params = toRecord(effectRow.params);
        const duration = toNumber(effectRow.duration_round);
        const element = toText(effectRow.element);

        out.push({
          setId,
          setName: setConfig.setName,
          pieceCount: bonus.piece_count,
          trigger: trigger as BattleSetBonusEffect["trigger"],
          target,
          effectType: effectType as BattleSetBonusEffect["effectType"],
          durationRound:
            duration === null ? undefined : Math.max(1, Math.floor(duration)),
          element: element || undefined,
          params,
        });
      }
    }
  }

  return out;
};

const buildCharacterBattleAffixEffectsFromRows = (
  rows: EquippedBattleEffectRow[],
  defs: ReadonlyMap<string, ItemDefConfig>,
): BattleSetBonusEffect[] => {
  const sources: BattleAffixEffectSource[] = [];

  for (const row of rows) {
    const itemInstanceId = Math.floor(toNumber(row.item_instance_id) ?? 0);
    if (itemInstanceId <= 0) continue;
    const itemDefId = toText(row.item_def_id);
    if (!itemDefId) continue;
    const itemDef = defs.get(itemDefId);
    if (!itemDef || itemDef.category !== "equipment") continue;

    sources.push({
      itemInstanceId,
      itemName: toText(itemDef.name),
      affixesRaw: row.affixes,
    });
  }

  return extractBattleAffixEffectsFromEquippedItems(sources);
};

const loadEquippedBattleEffectRowsMap = async (
  characterIds: number[],
): Promise<Map<number, EquippedBattleEffectRow[]>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  const result = new Map<number, EquippedBattleEffectRow[]>();
  if (normalizedCharacterIds.length <= 0) {
    return result;
  }

  const characterIdChunks = splitIntoChunks(
    normalizedCharacterIds,
    BATTLE_EFFECT_QUERY_BATCH_SIZE,
  );

  for (const chunkGroup of splitIntoChunks(
    characterIdChunks,
    BATTLE_EFFECT_QUERY_CONCURRENCY,
  )) {
    const queryResults = await Promise.all(
      chunkGroup.map((characterIdChunk) => query(
        `
          SELECT owner_character_id, id AS item_instance_id, item_def_id, affixes
          FROM item_instance
          WHERE owner_character_id = ANY($1)
            AND location = 'equipped'
        `,
        [characterIdChunk],
      )),
    );

    for (const queryResult of queryResults) {
      mergeEquippedBattleEffectRowsMap(
        result,
        groupEquippedBattleEffectRowsByCharacterId(queryResult.rows as EquippedBattleEffectRow[]),
      );
    }
  }

  return result;
};

// ------ 套装效果 ------

export async function getCharacterBattleSetBonusEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT item_def_id
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
    `,
    [characterId],
  );

  const rows = result.rows as EquippedBattleEffectRow[];
  const itemDefIds = Array.from(new Set(rows.map((row) => toText(row.item_def_id)).filter((itemDefId) => itemDefId.length > 0)));
  const defs = getItemDefinitionsByIds(itemDefIds);
  return buildCharacterBattleSetBonusEffectsFromRows(rows, defs, buildStaticSetBonusBySetId());
}

// ------ 词缀效果 ------

export async function getCharacterBattleAffixEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT id AS item_instance_id, item_def_id, affixes
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
      ORDER BY id ASC
    `,
    [characterId],
  );

  const rows = result.rows as EquippedBattleEffectRow[];
  const itemDefIds = Array.from(new Set(rows.map((row) => toText(row.item_def_id)).filter((itemDefId) => itemDefId.length > 0)));
  const defs = getItemDefinitionsByIds(itemDefIds);
  return buildCharacterBattleAffixEffectsFromRows(rows, defs);
}

// ------ 合并到角色数据 ------

export async function attachSetBonusEffectsToCharacterData<T extends CharacterData>(
  characterId: number,
  data: T,
): Promise<T> {
  try {
    const [setBonusEffects, affixEffects] = await Promise.all([
      getCharacterBattleSetBonusEffects(characterId),
      getCharacterBattleAffixEffects(characterId),
    ]);
    const mergedEffects = [...setBonusEffects, ...affixEffects];
    if (mergedEffects.length === 0) return data;
    return {
      ...data,
      setBonusEffects: mergedEffects,
    };
  } catch (error) {
    console.warn("[battle] 读取角色战斗效果失败，已回退为基础角色数据:", error);
    return data;
  }
}

export const loadCharacterBattleEffectsMap = async (
  characterIds: number[],
): Promise<Map<number, BattleSetBonusEffect[]>> => {
  const rowsByCharacterId = await loadEquippedBattleEffectRowsMap(characterIds);
  const result = new Map<number, BattleSetBonusEffect[]>();
  if (rowsByCharacterId.size <= 0) {
    return result;
  }

  const itemDefIds = Array.from(
    new Set(
      Array.from(rowsByCharacterId.values())
        .flatMap((rows) => rows.map((row) => toText(row.item_def_id)))
        .filter((itemDefId) => itemDefId.length > 0),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const staticSetBonusBySetId = buildStaticSetBonusBySetId();

  for (const [characterId, rows] of rowsByCharacterId.entries()) {
    const setBonusEffects = buildCharacterBattleSetBonusEffectsFromRows(rows, defs, staticSetBonusBySetId);
    const affixEffects = buildCharacterBattleAffixEffectsFromRows(rows, defs);
    result.set(characterId, [...setBonusEffects, ...affixEffects]);
  }

  return result;
};
