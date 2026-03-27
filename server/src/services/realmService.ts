import { query } from "../config/database.js";
import { Transactional } from "../decorators/transactional.js";
import { readFile, stat } from "fs/promises";
import path from "path";
import { updateSectionProgress } from "./mainQuest/index.js";
import { updateAchievementProgress } from "./achievementService.js";
import { invalidateCharacterComputedCache } from "./characterComputedService.js";
import { scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId } from "./onlineBattleProjectionService.js";
import { schedulePartnerRankSnapshotRefreshByCharacterId } from "./partnerRankSnapshotService.js";
import {
  getDungeonDefinitions,
  getDungeonDifficultyById,
  getItemDefinitionsByIds,
  getMainQuestChapterById,
  getTechniqueDefinitions,
} from "./staticConfigLoader.js";

export type RealmRequirementStatus = "done" | "todo" | "unknown";

export interface RealmRequirementView {
  id: string;
  title: string;
  detail: string;
  status: RealmRequirementStatus;
  sourceType?: string;
  sourceRef?: string;
}

export interface RealmCostView {
  id: string;
  title: string;
  detail: string;
  type: "exp" | "spirit_stones" | "item";
  status?: RealmRequirementStatus;
  amount?: number;
  itemDefId?: string;
  itemName?: string;
  itemIcon?: string;
  qty?: number;
}

export interface RealmRewardView {
  id: string;
  title: string;
  detail: string;
}

export interface RealmBreakthroughResult {
  success: boolean;
  message: string;
  data?: {
    fromRealm: string;
    newRealm: string;
    spentExp: number;
    spentSpiritStones: number;
    spentItems: {
      itemDefId: string;
      qty: number;
      name?: string;
      icon?: string;
    }[];
    gainedAttributePoints: number;
    currentExp: number;
    currentSpiritStones: number;
  };
}

type ExpMinRequirement = {
  id: string;
  type: "exp_min";
  min: number;
  title: string;
};
type SpiritStonesMinRequirement = {
  id: string;
  type: "spirit_stones_min";
  min: number;
  title: string;
};
type TechniqueLayerMinRequirement = {
  id: string;
  type: "technique_layer_min";
  techniqueId: string;
  minLayer: number;
  title: string;
};
type MainTechniqueLayerMinRequirement = {
  id: string;
  type: "main_technique_layer_min";
  minLayer: number;
  title: string;
};
type MainAndSubTechniqueLayerMinRequirement = {
  id: string;
  type: "main_and_sub_technique_layer_min";
  minLayer: number;
  title: string;
};
type TechniquesCountMinLayerRequirement = {
  id: string;
  type: "techniques_count_min_layer";
  minCount: number;
  minLayer: number;
  title: string;
};
type ItemQtyMinRequirement = {
  id: string;
  type: "item_qty_min";
  itemDefId: string;
  qty: number;
  title: string;
};
type DungeonClearMinRequirement = {
  id: string;
  type: "dungeon_clear_min";
  title: string;
  minCount: number;
  dungeonId?: string;
  difficultyId?: string;
};
type MainQuestChapterCompletedRequirement = {
  id: string;
  type: "main_quest_chapter_completed";
  title: string;
  chapterId: string;
};
type VersionLockedRequirement = {
  id: string;
  type: "version_locked";
  title: string;
  reason?: string;
};

type BreakthroughRequirement =
  | ExpMinRequirement
  | SpiritStonesMinRequirement
  | TechniqueLayerMinRequirement
  | MainTechniqueLayerMinRequirement
  | MainAndSubTechniqueLayerMinRequirement
  | TechniquesCountMinLayerRequirement
  | ItemQtyMinRequirement
  | DungeonClearMinRequirement
  | MainQuestChapterCompletedRequirement
  | VersionLockedRequirement
  | { id: string; type: string; title: string };

type CostExp = { type: "exp"; amount: number };
type CostSpiritStones = { type: "spirit_stones"; amount: number };
type CostItems = { type: "items"; items: { itemDefId: string; qty: number }[] };
type BreakthroughCost =
  | CostExp
  | CostSpiritStones
  | CostItems
  | { type: string };

type RewardConfig = {
  attributePoints?: number;
  pct?: Partial<{
    max_qixue: number;
    max_lingqi: number;
    wugong: number;
    fagong: number;
    wufang: number;
    fafang: number;
  }>;
  addPercent?: Partial<{
    kongzhi_kangxing: number;
  }>;
};

type BreakthroughConfig = {
  from: string;
  to: string;
  requirements?: BreakthroughRequirement[];
  costs?: BreakthroughCost[];
  rewards?: RewardConfig;
};

type RealmBreakthroughConfigFile = {
  version: number;
  realmOrder: string[];
  breakthroughs: BreakthroughConfig[];
};

type EquippedMainTechniqueRow = {
  technique_id: string | null;
  current_layer: number | string | null;
};

type EquippedSubTechniqueRow = {
  technique_id: string | null;
  current_layer: number | string | null;
  slot_index: number | string | null;
};

type CharacterRealmRow = {
  id: number | string | null;
  realm: string | null;
  sub_realm: string | null;
  exp: number | string | null;
  spirit_stones: number | string | null;
  attribute_points: number | string | null;
};

type BreakthroughCharacterState = {
  characterId: number;
  realm: string;
  subRealm: string;
  fromRealm: string;
  exp: number;
  spiritStones: number;
  attributePoints: number;
  nextRealm: string | null;
  breakthroughConfig: BreakthroughConfig | null;
};

const isExpMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is ExpMinRequirement =>
  requirement.type === "exp_min" && "min" in requirement;

const isSpiritStonesMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is SpiritStonesMinRequirement =>
  requirement.type === "spirit_stones_min" && "min" in requirement;

const isTechniqueLayerMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is TechniqueLayerMinRequirement =>
  requirement.type === "technique_layer_min" && "techniqueId" in requirement;

const isMainTechniqueLayerMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is MainTechniqueLayerMinRequirement =>
  requirement.type === "main_technique_layer_min" && "minLayer" in requirement;

const isMainAndSubTechniqueLayerMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is MainAndSubTechniqueLayerMinRequirement =>
  requirement.type === "main_and_sub_technique_layer_min" &&
  "minLayer" in requirement;

const isTechniquesCountMinLayerRequirement = (
  requirement: BreakthroughRequirement,
): requirement is TechniquesCountMinLayerRequirement =>
  requirement.type === "techniques_count_min_layer" &&
  "minCount" in requirement &&
  "minLayer" in requirement;

const isItemQtyMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is ItemQtyMinRequirement =>
  requirement.type === "item_qty_min" && "itemDefId" in requirement;

const isDungeonClearMinRequirement = (
  requirement: BreakthroughRequirement,
): requirement is DungeonClearMinRequirement =>
  requirement.type === "dungeon_clear_min" && "minCount" in requirement;

const isMainQuestChapterCompletedRequirement = (
  requirement: BreakthroughRequirement,
): requirement is MainQuestChapterCompletedRequirement =>
  requirement.type === "main_quest_chapter_completed" && "chapterId" in requirement;

const isVersionLockedRequirement = (
  requirement: BreakthroughRequirement,
): requirement is VersionLockedRequirement =>
  requirement.type === "version_locked";

const isExpCost = (cost: BreakthroughCost): cost is CostExp =>
  cost.type === "exp" && "amount" in cost;

const isSpiritStonesCost = (cost: BreakthroughCost): cost is CostSpiritStones =>
  cost.type === "spirit_stones" && "amount" in cost;

const isItemsCost = (cost: BreakthroughCost): cost is CostItems =>
  cost.type === "items" && "items" in cost;

let cachedConfig: RealmBreakthroughConfigFile | null = null;
let cachedConfigPath: string | null = null;

const pickFirstExistingPath = async (
  candidates: string[],
): Promise<string | null> => {
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch (error) {
        // 如果是事务中止错误，必须重新抛出
        if (error && typeof error === 'object' && 'code' in error && error.code === '25P02') {
          throw error;
        }
        console.warn('操作失败（已忽略）:', error);
      }
  }
  return null;
};

const loadConfig = async (): Promise<RealmBreakthroughConfigFile> => {
  if (cachedConfig) return cachedConfig;

  const envPathRaw =
    typeof process.env.REALM_CONFIG_PATH === "string"
      ? process.env.REALM_CONFIG_PATH.trim()
      : "";
  const candidates = [
    envPathRaw,
    path.join(process.cwd(), "src", "data", "seeds", "realm_breakthrough.json"),
    path.join(process.cwd(), "data", "seeds", "realm_breakthrough.json"),
    path.join(
      process.cwd(),
      "dist",
      "data",
      "seeds",
      "realm_breakthrough.json",
    ),
  ].filter((p) => !!p);

  const configPath = await pickFirstExistingPath(candidates);
  if (!configPath) {
    throw new Error("realm_breakthrough.json not found");
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as RealmBreakthroughConfigFile;
  if (
    !parsed ||
    !Array.isArray(parsed.realmOrder) ||
    !Array.isArray(parsed.breakthroughs)
  ) {
    throw new Error("realm_breakthrough.json invalid");
  }
  cachedConfig = parsed;
  cachedConfigPath = configPath;
  return parsed;
};

const getRealmIndex = (realmOrder: string[], realm: string): number => {
  const idx = realmOrder.indexOf(realm);
  return idx >= 0 ? idx : 0;
};

const getNextRealmName = (
  realmOrder: string[],
  currentRealm: string,
): string | null => {
  const idx = getRealmIndex(realmOrder, currentRealm);
  return idx + 1 < realmOrder.length ? realmOrder[idx + 1] : null;
};

const getBreakthroughConfig = (
  cfg: RealmBreakthroughConfigFile,
  fromRealm: string,
): BreakthroughConfig | null => {
  const b = cfg.breakthroughs.find((x) => x.from === fromRealm);
  return b ?? null;
};

const getItemDefMap = async (
  itemDefIds: string[],
): Promise<Record<string, { name: string; icon: string | null }>> => {
  const ids = Array.from(
    new Set(itemDefIds.map((s) => String(s || "").trim()).filter((s) => !!s)),
  );
  if (ids.length === 0) return {};
  const defs = getItemDefinitionsByIds(ids);
  const out: Record<string, { name: string; icon: string | null }> = {};
  for (const id of ids) {
    const def = defs.get(id);
    if (!def) continue;
    out[id] = {
      name: String(def.name || id),
      icon:
        typeof def.icon === "string" && def.icon.trim().length > 0
          ? def.icon
          : null,
    };
  }
  return out;
};

const getTechniqueDefMap = async (
  techniqueIds: string[],
): Promise<Record<string, { name: string }>> => {
  const ids = Array.from(
    new Set(techniqueIds.map((s) => String(s || "").trim()).filter((s) => !!s)),
  );
  if (ids.length === 0) return {};
  const out: Record<string, { name: string }> = {};
  for (const entry of getTechniqueDefinitions()) {
    if (entry.enabled === false) continue;
    if (!ids.includes(entry.id)) continue;
    out[String(entry.id)] = { name: String(entry.name || entry.id) };
  }
  return out;
};

const getDungeonDefMap = async (
  dungeonIds: string[],
): Promise<Record<string, { name: string }>> => {
  const ids = Array.from(
    new Set(dungeonIds.map((s) => String(s || "").trim()).filter((s) => !!s)),
  );
  if (ids.length === 0) return {};
  const out: Record<string, { name: string }> = {};
  for (const entry of getDungeonDefinitions()) {
    if (entry.enabled === false) continue;
    if (!ids.includes(entry.id)) continue;
    out[String(entry.id)] = { name: String(entry.name || entry.id) };
  }
  return out;
};

const getDungeonDifficultyMap = async (
  difficultyIds: string[],
): Promise<Record<string, { name: string }>> => {
  const ids = Array.from(
    new Set(
      difficultyIds.map((s) => String(s || "").trim()).filter((s) => !!s),
    ),
  );
  if (ids.length === 0) return {};
  const out: Record<string, { name: string }> = {};
  for (const id of ids) {
    const def = getDungeonDifficultyById(id);
    if (!def || def.enabled === false) continue;
    out[id] = { name: String(def.name || id) };
  }
  return out;
};

const getItemQtyInBag = async (
  characterId: number,
  itemDefId: string,
): Promise<number> => {
  const res = await query(
    `
      SELECT COALESCE(SUM(qty), 0)::int AS qty
      FROM item_instance
      WHERE owner_character_id = $1 AND location = 'bag' AND item_def_id = $2
    `,
    [characterId, itemDefId],
  );
  return Number(res.rows?.[0]?.qty ?? 0) || 0;
};

const getEquippedMainTechnique = async (
  characterId: number,
): Promise<{ techniqueId: string; name: string; layer: number } | null> => {
  const nameByTechniqueId = new Map(
    getTechniqueDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, String(entry.name || entry.id)] as const),
  );
  const res = await query<EquippedMainTechniqueRow>(
    `
      SELECT ct.technique_id, ct.current_layer
      FROM character_technique ct
      WHERE ct.character_id = $1 AND ct.slot_type = 'main'
      LIMIT 1
    `,
    [characterId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const techniqueId = String(row.technique_id || "").trim();
  const name = nameByTechniqueId.get(techniqueId) || techniqueId || "主功法";
  const layer = Number(row.current_layer ?? 0) || 0;
  if (!techniqueId) return null;
  return { techniqueId, name, layer };
};

const getEquippedSubTechniques = async (
  characterId: number,
): Promise<
  Array<{ techniqueId: string; name: string; layer: number; slotIndex: number }>
> => {
  const nameByTechniqueId = new Map(
    getTechniqueDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, String(entry.name || entry.id)] as const),
  );
  const res = await query<EquippedSubTechniqueRow>(
    `
      SELECT ct.technique_id, ct.current_layer, ct.slot_index
      FROM character_technique ct
      WHERE ct.character_id = $1 AND ct.slot_type = 'sub'
      ORDER BY ct.slot_index ASC
    `,
    [characterId],
  );
  return res.rows
    .map((row) => {
      const techniqueId = String(row.technique_id || "").trim();
      const name =
        nameByTechniqueId.get(techniqueId) || techniqueId || "副功法";
      const layer = Number(row.current_layer ?? 0) || 0;
      const slotIndex = Number(row.slot_index ?? 0) || 0;
      if (!techniqueId || slotIndex <= 0) return null;
      return { techniqueId, name, layer, slotIndex };
    })
    .filter(
      (
        x,
      ): x is {
        techniqueId: string;
        name: string;
        layer: number;
        slotIndex: number;
      } => Boolean(x),
    );
};

const getTechniqueLayer = async (
  characterId: number,
  techniqueId: string,
): Promise<number> => {
  const res = await query(
    "SELECT current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
    [characterId, techniqueId],
  );
  return Number(res.rows?.[0]?.current_layer ?? 0) || 0;
};

const getTechniquesCountMinLayer = async (
  characterId: number,
  minLayer: number,
): Promise<number> => {
  const res = await query(
    "SELECT COUNT(1)::int AS cnt FROM character_technique WHERE character_id = $1 AND current_layer >= $2",
    [characterId, minLayer],
  );
  return Number(res.rows?.[0]?.cnt ?? 0) || 0;
};

const getDungeonClearCount = async (args: {
  characterId: number;
  dungeonId?: string;
  difficultyId?: string;
}): Promise<number> => {
  const { characterId } = args;
  const dungeonId = String(args.dungeonId || "").trim();
  const difficultyId = String(args.difficultyId || "").trim();

  const where: string[] = ["character_id = $1", `result = 'cleared'`];
  const values: Array<number | string> = [characterId];

  if (dungeonId) {
    values.push(dungeonId);
    where.push(`dungeon_id = $${values.length}`);
  }
  if (difficultyId) {
    values.push(difficultyId);
    where.push(`difficulty_id = $${values.length}`);
  }

  const res = await query(
    `
      SELECT COUNT(1)::int AS cnt
      FROM dungeon_record
      WHERE ${where.join(" AND ")}
    `,
    values,
  );
  return Number(res.rows?.[0]?.cnt ?? 0) || 0;
};

const getCompletedMainQuestChapterSet = async (
  characterId: number,
): Promise<Set<string>> => {
  const res = await query(
    `
      SELECT completed_chapters
      FROM character_main_quest_progress
      WHERE character_id = $1
      LIMIT 1
    `,
    [characterId],
  );

  const raw = res.rows?.[0]?.completed_chapters;
  const values = Array.isArray(raw) ? raw : [];
  const chapterSet = new Set<string>();
  for (const value of values) {
    const chapterId = String(value ?? "").trim();
    if (!chapterId) continue;
    chapterSet.add(chapterId);
  }
  return chapterSet;
};

const loadBreakthroughCharacterRow = async (
  userId: number,
  forUpdate: boolean,
): Promise<CharacterRealmRow | null> => {
  const result = await query<CharacterRealmRow>(
    `SELECT
       id, realm, sub_realm, exp, spirit_stones, attribute_points
     FROM characters
     WHERE user_id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return result.rows[0] ?? null;
};

const resolveBreakthroughCharacterState = (
  row: CharacterRealmRow,
  cfg: RealmBreakthroughConfigFile,
): BreakthroughCharacterState => {
  const characterId = Number(row.id ?? 0) || 0;
  const realm = typeof row.realm === 'string' ? row.realm.trim() : '凡人';
  const subRealm = typeof row.sub_realm === 'string' ? row.sub_realm.trim() : '';
  const fromRealm = realm === '凡人' || !subRealm ? realm : `${realm}·${subRealm}`;
  const nextRealm = getNextRealmName(cfg.realmOrder, fromRealm);

  return {
    characterId,
    realm,
    subRealm,
    fromRealm,
    exp: Number(row.exp ?? 0) || 0,
    spiritStones: Number(row.spirit_stones ?? 0) || 0,
    attributePoints: Number(row.attribute_points ?? 0) || 0,
    nextRealm,
    breakthroughConfig: nextRealm ? getBreakthroughConfig(cfg, fromRealm) : null,
  };
};

const getFirstUnmetRequirement = (
  requirements: RealmRequirementView[],
): RealmRequirementView | null => {
  return requirements.find((requirement) => requirement.status !== 'done') ?? null;
};

const buildRequirementFailureResult = (
  requirement: RealmRequirementView,
): RealmBreakthroughResult => {
  if (requirement.sourceType === 'version_gate') {
    return {
      success: false,
      message: requirement.detail || '当前版本暂未开放',
    };
  }

  return {
    success: false,
    message: `条件未满足：${requirement.title}`,
  };
};

const getVolatileBreakthroughRequirements = (
  requirements: BreakthroughRequirement[],
): BreakthroughRequirement[] => {
  return requirements.filter(
    (requirement) =>
      requirement.type === 'main_technique_layer_min'
      || requirement.type === 'main_and_sub_technique_layer_min',
  );
};

const evaluateRequirements = async (args: {
  characterId: number;
  exp: number;
  spiritStones: number;
  requirements: BreakthroughRequirement[];
}): Promise<RealmRequirementView[]> => {
  const { characterId, exp, spiritStones } = args;
  const reqs = Array.isArray(args.requirements) ? args.requirements : [];

  const itemIds: string[] = [];
  const techniqueIds: string[] = [];
  const dungeonIds: string[] = [];
  const difficultyIds: string[] = [];
  for (const r of reqs) {
    if (isItemQtyMinRequirement(r)) {
      itemIds.push(String(r.itemDefId || ""));
    }
    if (isTechniqueLayerMinRequirement(r)) {
      techniqueIds.push(String(r.techniqueId || ""));
    }
    if (isDungeonClearMinRequirement(r)) {
      dungeonIds.push(String(r.dungeonId || ""));
      difficultyIds.push(String(r.difficultyId || ""));
    }
  }
  const itemMap = await getItemDefMap(itemIds);
  const techniqueMap = await getTechniqueDefMap(techniqueIds);
  const dungeonMap = await getDungeonDefMap(dungeonIds);
  const difficultyMap = await getDungeonDifficultyMap(difficultyIds);

  const out: RealmRequirementView[] = [];
  const mainTech = await getEquippedMainTechnique(characterId);
  let equippedSubs: Array<{
    techniqueId: string;
    name: string;
    layer: number;
    slotIndex: number;
  }> | null = null;
  let completedChapterSet: Set<string> | null = null;
  const dungeonClearCountCache = new Map<string, number>();

  const getCachedDungeonClearCount = async (
    dungeonId?: string,
    difficultyId?: string,
  ): Promise<number> => {
    const d = String(dungeonId || "").trim();
    const diff = String(difficultyId || "").trim();
    const cacheKey = `${d}|${diff}`;
    if (dungeonClearCountCache.has(cacheKey))
      return dungeonClearCountCache.get(cacheKey) || 0;
    const cnt = await getDungeonClearCount({
      characterId,
      dungeonId: d,
      difficultyId: diff,
    });
    dungeonClearCountCache.set(cacheKey, cnt);
    return cnt;
  };

  for (const r of reqs) {
    const id = String(r.id || "");
    const title = String(r.title || "条件");

    if (isExpMinRequirement(r)) {
      const min = Number(r.min ?? 0) || 0;
      const ok = exp >= min;
      out.push({
        id: id || `exp-${min}`,
        title,
        detail: `经验 ≥ ${min.toLocaleString()}（当前 ${exp.toLocaleString()}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isSpiritStonesMinRequirement(r)) {
      const min = Number(r.min ?? 0) || 0;
      const ok = spiritStones >= min;
      out.push({
        id: id || `ss-${min}`,
        title,
        detail: `灵石 ≥ ${min.toLocaleString()}（当前 ${spiritStones.toLocaleString()}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isTechniqueLayerMinRequirement(r)) {
      const techniqueId = String(r.techniqueId || "").trim();
      const minLayer = Number(r.minLayer ?? 0) || 0;
      const layer = techniqueId
        ? await getTechniqueLayer(characterId, techniqueId)
        : 0;
      const ok = layer >= minLayer;
      const techName = techniqueMap[techniqueId]?.name || techniqueId || "功法";
      out.push({
        id: id || `${techniqueId}-${minLayer}`,
        title,
        detail: `${techName} ≥ ${minLayer} 层（当前 ${layer}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isMainTechniqueLayerMinRequirement(r)) {
      const minLayer = Number(r.minLayer ?? 0) || 0;
      const layer = mainTech?.layer ?? 0;
      const ok = layer >= minLayer;
      if (!mainTech) {
        out.push({
          id: id || `maintech-${minLayer}`,
          title,
          detail: `未装备主功法（需要 ≥ ${minLayer} 层）`,
          status: "todo",
        });
        continue;
      }
      out.push({
        id: id || `maintech-${minLayer}`,
        title,
        detail: `${mainTech.name}（主功法）≥ ${minLayer} 层（当前 ${layer}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isMainAndSubTechniqueLayerMinRequirement(r)) {
      const minLayer = Number(r.minLayer ?? 0) || 0;
      if (!mainTech) {
        out.push({
          id: id || `main-sub-${minLayer}`,
          title,
          detail: `未装备主功法（需要主功法≥${minLayer}且副功法≥${minLayer}）`,
          status: "todo",
        });
        continue;
      }

      if (!equippedSubs)
        equippedSubs = await getEquippedSubTechniques(characterId);
      const okMain = (mainTech.layer ?? 0) >= minLayer;
      const bestSub = equippedSubs.reduce(
        (acc, cur) => (!acc || cur.layer > acc.layer ? cur : acc),
        null as {
          techniqueId: string;
          name: string;
          layer: number;
          slotIndex: number;
        } | null,
      );
      const okSub = equippedSubs.some((s) => (s.layer ?? 0) >= minLayer);
      const subText = bestSub
        ? `${bestSub.name}（副${bestSub.slotIndex} 当前 ${bestSub.layer}）`
        : "未装备副功法";
      out.push({
        id: id || `main-sub-${minLayer}`,
        title,
        detail: `${mainTech.name}（主 当前 ${mainTech.layer}）≥${minLayer}；${subText} ≥${minLayer}`,
        status: okMain && okSub ? "done" : "todo",
      });
      continue;
    }

    if (isTechniquesCountMinLayerRequirement(r)) {
      const minLayer = Number(r.minLayer ?? 0) || 0;
      const minCount = Number(r.minCount ?? 0) || 0;
      const cnt = await getTechniquesCountMinLayer(
        characterId,
        minLayer,
      );
      const ok = cnt >= minCount;
      out.push({
        id: id || `techcnt-${minCount}-${minLayer}`,
        title,
        detail: `至少 ${minCount} 门功法 ≥ ${minLayer} 层（当前 ${cnt}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isItemQtyMinRequirement(r)) {
      const itemDefId = String(r.itemDefId || "").trim();
      const qtyNeed = Number(r.qty ?? 0) || 0;
      const qtyHave = itemDefId
        ? await getItemQtyInBag(characterId, itemDefId)
        : 0;
      const ok = qtyHave >= qtyNeed;
      const meta = itemMap[itemDefId];
      const itemName = meta?.name || itemDefId || "材料";
      out.push({
        id: id || `item-${itemDefId}`,
        title,
        detail: `${itemName} × ${qtyNeed}（当前 ${qtyHave}）`,
        status: ok ? "done" : "todo",
      });
      continue;
    }

    if (isDungeonClearMinRequirement(r)) {
      const minCount = Math.max(1, Number(r.minCount ?? 0) || 1);
      const dungeonId = String(r.dungeonId || "").trim();
      const difficultyId = String(r.difficultyId || "").trim();
      const clearCount = await getCachedDungeonClearCount(
        dungeonId,
        difficultyId,
      );
      const ok = clearCount >= minCount;
      const dungeonName = dungeonId
        ? (dungeonMap[dungeonId]?.name ?? "目标秘境")
        : "";
      const difficultyName = difficultyId
        ? (difficultyMap[difficultyId]?.name ?? "指定难度")
        : "";
      const scopeText = dungeonId
        ? difficultyId
          ? `${dungeonName}（${difficultyName}）`
          : dungeonName
        : difficultyId
          ? `任意秘境（${difficultyName}）`
          : "任意秘境";

      out.push({
        id:
          id ||
          `dungeon-clear-${dungeonId || "any"}-${difficultyId || "any"}-${minCount}`,
        title,
        detail: `${scopeText} 通关 ≥ ${minCount} 次（当前 ${clearCount}）`,
        status: ok ? "done" : "todo",
        sourceType: "dungeon_record",
        sourceRef: difficultyId
          ? `dungeon:${dungeonId || "*"}|difficulty:${difficultyId}`
          : dungeonId
            ? `dungeon:${dungeonId}`
            : "dungeon:*",
      });
      continue;
    }

    if (isMainQuestChapterCompletedRequirement(r)) {
      const chapterId = String(r.chapterId || "").trim();
      if (!completedChapterSet) {
        completedChapterSet = await getCompletedMainQuestChapterSet(
          characterId,
        );
      }
      const done = chapterId ? completedChapterSet.has(chapterId) : false;
      const chapterName = chapterId
        ? (getMainQuestChapterById(chapterId)?.name ?? chapterId)
        : "指定主线章节";
      out.push({
        id: id || `main-quest-chapter-${chapterId || "unknown"}`,
        title,
        detail: `${chapterName}（当前${done ? "已完成" : "未完成"}）`,
        status: done ? "done" : "todo",
        sourceType: "main_quest",
        sourceRef: chapterId ? `chapter:${chapterId}` : "chapter:*",
      });
      continue;
    }

    if (isVersionLockedRequirement(r)) {
      const reason =
        String(r.reason || "").trim() || "当前版本暂未开放";
      out.push({
        id: id || `version-locked-${Math.random().toString(36).slice(2)}`,
        title,
        detail: reason,
        status: "todo",
        sourceType: "version_gate",
        sourceRef: "realm:version_gate",
      });
      continue;
    }

    out.push({
      id: id || `unknown-${Math.random().toString(36).slice(2)}`,
      title,
      detail: "条件未接入",
      status: "unknown",
    });
  }

  return out;
};

const buildCostsView = async (args: {
  costs: BreakthroughCost[];
  characterId?: number;
  currentExp?: number;
  currentSpiritStones?: number;
}): Promise<{
  exp: number;
  spiritStones: number;
  items: { itemDefId: string; qty: number }[];
  view: RealmCostView[];
  affordable: boolean;
}> => {
  const costs = Array.isArray(args.costs) ? args.costs : [];
  const characterId = Number(args.characterId ?? 0) || 0;
  const currentExp = Number(args.currentExp ?? NaN);
  const currentSpiritStones = Number(args.currentSpiritStones ?? NaN);

  let costExp = 0;
  let costSpiritStones = 0;
  const costItems: { itemDefId: string; qty: number }[] = [];

  for (const c of costs) {
    if (isExpCost(c)) {
      costExp += Math.max(0, Number(c.amount ?? 0) || 0);
    } else if (isSpiritStonesCost(c)) {
      costSpiritStones += Math.max(0, Number(c.amount ?? 0) || 0);
    } else if (isItemsCost(c)) {
      const items = Array.isArray(c.items) ? c.items : [];
      for (const it of items) {
        const itemDefId = String(it.itemDefId || "").trim();
        const qty = Math.max(0, Number(it.qty ?? 0) || 0);
        if (!itemDefId || qty <= 0) continue;
        costItems.push({ itemDefId, qty });
      }
    }
  }

  const itemDefIds = costItems.map((x) => x.itemDefId);
  const itemMap = await getItemDefMap(itemDefIds);

  const view: RealmCostView[] = [];
  if (costExp > 0) {
    const ok = Number.isFinite(currentExp) ? currentExp >= costExp : true;
    view.push({
      id: "cost-exp",
      title: "经验",
      detail: Number.isFinite(currentExp)
        ? `需要 ${costExp.toLocaleString()}（当前 ${currentExp.toLocaleString()}）`
        : costExp.toLocaleString(),
      type: "exp",
      status: ok ? "done" : "todo",
      amount: costExp,
    });
  }

  if (costSpiritStones > 0) {
    const ok = Number.isFinite(currentSpiritStones)
      ? currentSpiritStones >= costSpiritStones
      : true;
    view.push({
      id: "cost-spirit-stones",
      title: "灵石",
      detail: Number.isFinite(currentSpiritStones)
        ? `需要 ${costSpiritStones.toLocaleString()}（当前 ${currentSpiritStones.toLocaleString()}）`
        : costSpiritStones.toLocaleString(),
      type: "spirit_stones",
      status: ok ? "done" : "todo",
      amount: costSpiritStones,
    });
  }

  for (const it of costItems) {
    const meta = itemMap[it.itemDefId];
    const have =
      characterId > 0
        ? await getItemQtyInBag(characterId, it.itemDefId)
        : NaN;
    const ok = Number.isFinite(have) ? have >= it.qty : true;
    view.push({
      id: `cost-item-${it.itemDefId}`,
      title: meta?.name || it.itemDefId,
      detail: Number.isFinite(have)
        ? `×${it.qty}（当前 ${have}）`
        : `×${it.qty}`,
      type: "item",
      status: ok ? "done" : "todo",
      itemDefId: it.itemDefId,
      itemName: meta?.name,
      itemIcon: meta?.icon ?? undefined,
      qty: it.qty,
    });
  }

  const affordable = view.every((v) => v.status !== "todo");
  return {
    exp: costExp,
    spiritStones: costSpiritStones,
    items: costItems,
    view,
    affordable,
  };
};

const buildRewardsView = (rewards?: RewardConfig): RealmRewardView[] => {
  const r = rewards || {};
  const out: RealmRewardView[] = [];
  const ap = Math.max(0, Number(r.attributePoints ?? 0) || 0);
  if (ap > 0) out.push({ id: "ap", title: "属性点", detail: `+${ap}` });

  const pct = r.pct || {};
  const addPercent = r.addPercent || {};

  const addPctRow = (
    key: keyof NonNullable<RewardConfig["pct"]>,
    title: string,
  ) => {
    const v = Number(pct[key] ?? 0) || 0;
    if (v !== 0) {
      const pctText = (v * 100).toFixed(2).replace(/\.?0+$/, "");
      out.push({
        id: `pct-${key}`,
        title,
        detail: `${v > 0 ? "+" : ""}${pctText}%`,
      });
    }
  };

  addPctRow("max_qixue", "最大气血");
  addPctRow("max_lingqi", "最大灵气");
  addPctRow("wugong", "物攻");
  addPctRow("fagong", "法攻");
  addPctRow("wufang", "物防");
  addPctRow("fafang", "法防");

  const kk = Number(addPercent.kongzhi_kangxing ?? 0) || 0;
  if (kk !== 0) {
    const kkText = (kk * 100).toFixed(2).replace(/\.?0+$/, "");
    out.push({
      id: "add-kongzhi",
      title: "控制抗性",
      detail: `${kk > 0 ? "+" : ""}${kkText}%`,
    });
  }

  return out;
};

const consumeItemFromBagTx = async (
  characterId: number,
  itemDefId: string,
  qty: number,
): Promise<{ success: boolean; message: string }> => {
  let remaining = Math.max(0, Math.floor(qty));
  if (!itemDefId || remaining <= 0) return { success: true, message: "ok" };

  while (remaining > 0) {
    const res = await query(
      `
        SELECT id, qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND item_def_id = $2
          AND location = 'bag'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, itemDefId],
    );

    if (res.rows.length === 0) return { success: false, message: "材料不足" };

    const row = res.rows[0] as { id?: unknown; qty?: unknown };
    const instanceId = Number(row.id ?? 0) || 0;
    const hasQty = Number(row.qty ?? 0) || 0;
    if (instanceId <= 0 || hasQty <= 0)
      return { success: false, message: "材料数据异常" };

    if (hasQty <= remaining) {
      await query(
        "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
        [instanceId, characterId],
      );
      remaining -= hasQty;
    } else {
      await query(
        "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        [remaining, instanceId, characterId],
      );
      remaining = 0;
    }
  }

  return { success: true, message: "ok" };
};

class RealmService {
  /**
   * 获取境界总览（纯读，不需要事务）
   * - 加载配置、查询角色信息
   * - 评估突破条件、消耗、奖励
   * - 返回是否可突破
   */
  async getOverview(userId: number): Promise<{
    success: boolean;
    message: string;
    data?: {
      configPath: string | null;
      realmOrder: string[];
      currentRealm: string;
      currentIndex: number;
      nextRealm: string | null;
      exp: number;
      spiritStones: number;
      requirements: RealmRequirementView[];
      costs: RealmCostView[];
      rewards: RealmRewardView[];
      canBreakthrough: boolean;
    };
  }> {
    const cfg = await loadConfig();

    const res = await query(
      "SELECT id, realm, sub_realm, exp, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    if (res.rows.length === 0) return { success: false, message: "角色不存在" };

    const row = res.rows[0] as {
      id?: unknown;
      realm?: unknown;
      sub_realm?: unknown;
      exp?: unknown;
      spirit_stones?: unknown;
    };
    const characterId = Number(row.id ?? 0) || 0;
    const realm = typeof row.realm === "string" ? row.realm.trim() : "凡人";
    const subRealm =
      typeof row.sub_realm === "string" ? row.sub_realm.trim() : "";
    const currentRealm =
      realm === "凡人" || !subRealm ? realm : `${realm}·${subRealm}`;
    const exp = Number(row.exp ?? 0) || 0;
    const spiritStones = Number(row.spirit_stones ?? 0) || 0;

    const currentIndex = getRealmIndex(cfg.realmOrder, currentRealm);
    const nextRealm = getNextRealmName(cfg.realmOrder, currentRealm);
    const bt = nextRealm ? getBreakthroughConfig(cfg, currentRealm) : null;

    const requirements = bt
      ? await evaluateRequirements({
          characterId,
          exp,
          spiritStones,
          requirements: bt.requirements ?? [],
        })
      : [];

    const costsBuilt = bt
      ? await buildCostsView({
          costs: bt.costs ?? [],
          characterId,
          currentExp: exp,
          currentSpiritStones: spiritStones,
        })
      : null;
    const costs = costsBuilt?.view ?? [];
    const rewards = buildRewardsView(bt?.rewards);

    const canBreakthrough =
      !!nextRealm &&
      bt?.to === nextRealm &&
      requirements.every((r) => r.status === "done") &&
      (costsBuilt ? costsBuilt.affordable : true);

    return {
      success: true,
      message: "ok",
      data: {
        configPath: cachedConfigPath,
        realmOrder: cfg.realmOrder,
        currentRealm,
        currentIndex,
        nextRealm,
        exp,
        spiritStones,
        requirements,
        costs,
        rewards,
        canBreakthrough,
      },
    };
  }

  /**
   * 突破到下一境界（写操作，需要事务）
   * - 校验条件、扣除消耗、更新境界
   * - 事务提交后清除角色计算缓存
   */
  @Transactional
  async breakthroughToNextRealm(userId: number): Promise<RealmBreakthroughResult> {
    const cfg = await loadConfig();

    const previewRow = await loadBreakthroughCharacterRow(userId, false);
    if (!previewRow)
      return { success: false, message: "角色不存在" };

    const previewState = resolveBreakthroughCharacterState(previewRow, cfg);
    const characterId = previewState.characterId;
    const fromRealm = previewState.fromRealm;
    const nextRealm = previewState.nextRealm;
    if (!nextRealm) return { success: false, message: "已达最高境界" };

    const bt = previewState.breakthroughConfig;
    if (!bt || bt.to !== nextRealm)
      return { success: false, message: "下一境界配置不存在" };

    const previewRequirementViews = await evaluateRequirements({
      characterId,
      exp: previewState.exp,
      spiritStones: previewState.spiritStones,
      requirements: bt.requirements ?? [],
    });
    const previewUnmetRequirement = getFirstUnmetRequirement(previewRequirementViews);
    if (previewUnmetRequirement) {
      return buildRequirementFailureResult(previewUnmetRequirement);
    }

    const costsBuilt = await buildCostsView({
      costs: bt.costs ?? [],
    });
    if (previewState.exp < costsBuilt.exp)
      return { success: false, message: `经验不足，需要 ${costsBuilt.exp}` };
    if (previewState.spiritStones < costsBuilt.spiritStones)
      return {
        success: false,
        message: `灵石不足，需要 ${costsBuilt.spiritStones}`,
      };

    const itemDefIds = costsBuilt.items.map((x) => x.itemDefId);
    const itemMap = await getItemDefMap(itemDefIds);

    for (const it of costsBuilt.items) {
      const have = await getItemQtyInBag(characterId, it.itemDefId);
      if (have < it.qty) {
        const meta = itemMap[it.itemDefId];
        return {
          success: false,
          message: `材料不足：${meta?.name || it.itemDefId}`,
        };
      }
    }

    const lockedRow = await loadBreakthroughCharacterRow(userId, true);
    if (!lockedRow) {
      return { success: false, message: '角色不存在' };
    }
    const lockedState = resolveBreakthroughCharacterState(lockedRow, cfg);
    if (lockedState.fromRealm !== fromRealm) {
      return { success: false, message: '角色状态已变化，请重试' };
    }

    const volatileRequirements = getVolatileBreakthroughRequirements(bt.requirements ?? []);
    if (volatileRequirements.length > 0) {
      const volatileRequirementViews = await evaluateRequirements({
        characterId,
        exp: lockedState.exp,
        spiritStones: lockedState.spiritStones,
        requirements: volatileRequirements,
      });
      const volatileUnmetRequirement = getFirstUnmetRequirement(volatileRequirementViews);
      if (volatileUnmetRequirement) {
        return buildRequirementFailureResult(volatileUnmetRequirement);
      }
    }

    if (lockedState.exp < costsBuilt.exp) {
      return { success: false, message: `经验不足，需要 ${costsBuilt.exp}` };
    }
    if (lockedState.spiritStones < costsBuilt.spiritStones) {
      return {
        success: false,
        message: `灵石不足，需要 ${costsBuilt.spiritStones}`,
      };
    }

    for (const it of costsBuilt.items) {
      const consumeRes = await consumeItemFromBagTx(
        characterId,
        it.itemDefId,
        it.qty,
      );
      if (!consumeRes.success)
        return { success: false, message: consumeRes.message };
    }

    const rewards = bt.rewards || {};
    const apAdd = Math.max(0, Number(rewards.attributePoints ?? 0) || 0);

    const newExp = lockedState.exp - costsBuilt.exp;
    const newSpiritStones = lockedState.spiritStones - costsBuilt.spiritStones;
    const newAttributePoints = lockedState.attributePoints + apAdd;

    await query(
      `
        UPDATE characters
        SET realm = $1,
            sub_realm = NULL,
            exp = $2,
            spirit_stones = $3,
            attribute_points = $4,
            updated_at = NOW()
        WHERE id = $5
      `,
      [bt.to, newExp, newSpiritStones, newAttributePoints, characterId],
    );

    await updateSectionProgress(characterId, {
      type: "upgrade_realm",
      realm: bt.to,
    });
    await updateAchievementProgress(characterId, `realm:reach:${bt.to}`, 1);

    // 清除角色计算缓存（不依赖事务，放在方法末尾即可）
    await invalidateCharacterComputedCache(characterId);
    await schedulePartnerRankSnapshotRefreshByCharacterId(characterId);
    await scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId(characterId);

    const spentItems = costsBuilt.items.map((x) => {
      const meta = itemMap[x.itemDefId];
      return {
        itemDefId: x.itemDefId,
        qty: x.qty,
        name: meta?.name,
        icon: meta?.icon ?? undefined,
      };
    });

    return {
      success: true,
      message: `突破至${bt.to}成功`,
      data: {
        fromRealm,
        newRealm: bt.to,
        spentExp: costsBuilt.exp,
        spentSpiritStones: costsBuilt.spiritStones,
        spentItems,
        gainedAttributePoints: apAdd,
        currentExp: newExp,
        currentSpiritStones: newSpiritStones,
      },
    };
  }

  /**
   * 突破到指定目标境界（委托给 breakthroughToNextRealm）
   * - 校验目标是否为下一境界
   * - 不需要 @Transactional，由 breakthroughToNextRealm 管理事务
   */
  async breakthroughToTargetRealm(
    userId: number,
    targetRealm: string,
  ): Promise<RealmBreakthroughResult> {
    const target = typeof targetRealm === "string" ? targetRealm.trim() : "";
    if (!target) return { success: false, message: "目标境界无效" };

    const cfg = await loadConfig();
    if (!cfg.realmOrder.includes(target))
      return { success: false, message: "目标境界未开放" };

    const overview = await this.getOverview(userId);
    if (!overview.success) return { success: false, message: overview.message };
    const nextRealm = overview.data?.nextRealm ?? null;
    if (!nextRealm) return { success: false, message: "已达最高境界" };
    if (nextRealm !== target)
      return { success: false, message: "只能突破到下一境界" };

    return this.breakthroughToNextRealm(userId);
  }
}

export const realmService = new RealmService();
