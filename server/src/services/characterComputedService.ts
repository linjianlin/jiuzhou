/**
 * 角色运行时属性服务
 * 作用：
 * 1) 统一在程序中计算角色面板/战斗属性（不再依赖 characters 表持久化属性列）；
 * 2) 为属性计算提供内存 + Redis 缓存；
 * 3) 维护血/灵运行时资源缓存（Redis 为主，内存兜底）。
 *
 * 输入：
 * - userId / characterId
 *
 * 输出：
 * - 角色完整属性快照（含 qixue/lingqi 当前值）
 * - 资源更新结果（用于战斗结算、道具恢复等）
 */
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { query } from '../config/database.js';
import { redis } from '../config/redis.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';
import { deleteCharacterRankSnapshot, upsertCharacterRankSnapshot } from './rankSnapshotService.js';
import {
  getInsightGrowthConfig,
  getItemDefinitionsByIds,
  getItemSetDefinitions,
  getTechniqueLayerDefinitions,
  getTitleDefinitions,
} from './staticConfigLoader.js';
import { extractFlatAffixDeltas, extractPercentAffixDeltas } from './shared/affixModifier.js';
import {
  createCharacterPrimaryAttrs,
  applyCharacterPrimaryAttrsToStats,
  isCharacterPrimaryAttrKey,
  resolveCharacterPrimaryAttrs,
  type CharacterPrimaryAttrKey,
  type CharacterPrimaryAttrs,
} from './shared/characterPrimaryAttrs.js';
import { convertRatingToPercent, getEffectiveLevelByRealm, resolveRatingBaseAttrKey } from './shared/affixRating.js';
import { buildInsightPctBonusByLevel } from './shared/insightRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { calcCharacterStaminaMaxByInsightLevel } from './shared/staminaRules.js';
import {
  TECHNIQUE_PASSIVE_PERCENT_MULTIPLY_KEYS,
  splitTechniquePassiveAttrs,
} from './shared/techniquePassiveAttrs.js';
import { CHARACTER_BASE_COLUMNS_SQL } from './shared/sqlFragments.js';

type JsonRecord = Record<string, unknown>;

interface CharacterBaseRow {
  id: number;
  user_id: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  auto_cast_skills: boolean;
  auto_disassemble_enabled: boolean;
  auto_disassemble_rules: unknown;
  spirit_stones: number;
  silver: number;
  stamina: number;
  realm: string;
  sub_realm: string | null;
  exp: number;
  insight_level: number;
  attribute_points: number;
  jing: number;
  qi: number;
  shen: number;
  attribute_type: string;
  attribute_element: string;
  current_map_id: string;
  current_room_id: string;
}

interface CharacterComputedStats {
  max_qixue: number;
  max_lingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  mingzhong: number;
  shanbi: number;
  zhaojia: number;
  baoji: number;
  baoshang: number;
  jianbaoshang: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
  shuxing_shuzhi: number;
  kongzhi_kangxing: number;
  jin_kangxing: number;
  mu_kangxing: number;
  shui_kangxing: number;
  huo_kangxing: number;
  tu_kangxing: number;
  qixue_huifu: number;
  lingqi_huifu: number;
  sudu: number;
  fuyuan: number;
}

type CharacterBasePublicRow = Omit<CharacterBaseRow, 'insight_level'>;

export interface CharacterComputedRow extends CharacterBasePublicRow, CharacterComputedStats {
  stamina_max: number;
  qixue: number;
  lingqi: number;
}

interface CharacterResourceState {
  qixue: number;
  lingqi: number;
}

interface StaticAttrsCachePayload {
  signature: string;
  attrs: CharacterComputedStats;
  primaryAttrs: CharacterPrimaryAttrs;
}

type BreakthroughPctRewards = Partial<{
  max_qixue: number;
  max_lingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
}>;

type BreakthroughAddPercentRewards = Partial<{
  kongzhi_kangxing: number;
}>;

interface RealmBreakthroughEntry {
  from: string;
  to: string;
  rewards?: {
    pct?: BreakthroughPctRewards;
    addPercent?: BreakthroughAddPercentRewards;
  };
}

interface RealmBreakthroughConfigFile {
  version: number;
  realmOrder: string[];
  breakthroughs: RealmBreakthroughEntry[];
}

type CharacterAttrKey =
  | 'qixue'
  | 'max_qixue'
  | 'lingqi'
  | 'max_lingqi'
  | 'wugong'
  | 'fagong'
  | 'wufang'
  | 'fafang'
  | 'sudu'
  | 'fuyuan'
  | 'mingzhong'
  | 'shanbi'
  | 'zhaojia'
  | 'baoji'
  | 'baoshang'
  | 'jianbaoshang'
  | 'kangbao'
  | 'zengshang'
  | 'zhiliao'
  | 'jianliao'
  | 'xixue'
  | 'lengque'
  | 'shuxing_shuzhi'
  | 'kongzhi_kangxing'
  | 'jin_kangxing'
  | 'mu_kangxing'
  | 'shui_kangxing'
  | 'huo_kangxing'
  | 'tu_kangxing'
  | 'qixue_huifu'
  | 'lingqi_huifu';

const STATIC_ATTR_CACHE_KEY_PREFIX = 'character:computed:static:v4:';
const RESOURCE_CACHE_KEY_PREFIX = 'character:runtime:resource:v1:';
const STATIC_ATTR_CACHE_TTL_SECONDS = 60;
const STATIC_ATTR_MEMORY_TTL_MS = 20_000;
const RESOURCE_MEMORY_TTL_MS = 5 * 60_000;

const staticAttrsMemoryCache = new Map<number, { payload: StaticAttrsCachePayload; expiresAt: number }>();
const resourceMemoryCache = new Map<number, { payload: CharacterResourceState; expiresAt: number }>();

const RATIO_ATTR_KEYS = new Set<CharacterAttrKey>([
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const VALID_TITLE_EFFECT_KEYS = new Set<CharacterAttrKey>([
  'qixue',
  'max_qixue',
  'lingqi',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
  'fuyuan',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
]);

const DEFAULT_ATTRS: CharacterComputedStats = Object.freeze({
  max_qixue: 100,
  max_lingqi: 0,
  wugong: 5,
  fagong: 0,
  wufang: 2,
  fafang: 0,
  mingzhong: 0.9,
  shanbi: 0.05,
  zhaojia: 0.05,
  baoji: 0.1,
  baoshang: 1.5,
  jianbaoshang: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  shuxing_shuzhi: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
  sudu: 1,
  fuyuan: 1,
});

let cachedRealmConfig: RealmBreakthroughConfigFile | null = null;

const clampNumber = (value: number, min: number, max: number): number => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const safeNumber = (value: unknown, fallback: number = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toNonNegativeInt = (value: unknown, fallback: number = 0): number => {
  return Math.max(0, Math.floor(safeNumber(value, fallback)));
};

const toRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
};

const toArray = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const roundRatio = (value: number): number => {
  return Math.round(value * 1_000_000) / 1_000_000;
};

const applyPct = (base: number, pct: number): number => {
  const b = Number.isFinite(base) ? Math.floor(base) : 0;
  const p = Number.isFinite(pct) ? pct : 0;
  if (b <= 0 || p === 0) return b;
  return Math.max(0, Math.floor(b * (1 + p)));
};

const composeRealmText = (realm: string, subRealm: string | null): string => {
  const main = String(realm || '').trim();
  const sub = String(subRealm || '').trim();
  if (!main) return '凡人';
  if (!sub || main === '凡人') return main;
  return `${main}·${sub}`;
};

const pickFirstExistingPath = async (candidates: string[]): Promise<string | null> => {
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch {
      // ignore
    }
  }
  return null;
};

const loadRealmBreakthroughConfig = async (): Promise<RealmBreakthroughConfigFile> => {
  if (cachedRealmConfig) return cachedRealmConfig;
  const envPathRaw = typeof process.env.REALM_CONFIG_PATH === 'string' ? process.env.REALM_CONFIG_PATH.trim() : '';
  const candidates = [
    envPathRaw,
    path.join(process.cwd(), 'src', 'data', 'seeds', 'realm_breakthrough.json'),
    path.join(process.cwd(), 'data', 'seeds', 'realm_breakthrough.json'),
    path.join(process.cwd(), 'dist', 'data', 'seeds', 'realm_breakthrough.json'),
  ].filter((p) => p.length > 0);
  const configPath = await pickFirstExistingPath(candidates);
  if (!configPath) {
    throw new Error('realm_breakthrough.json not found');
  }
  const raw = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as RealmBreakthroughConfigFile;
  if (!parsed || !Array.isArray(parsed.realmOrder) || !Array.isArray(parsed.breakthroughs)) {
    throw new Error('realm_breakthrough.json invalid');
  }
  cachedRealmConfig = parsed;
  return parsed;
};

const buildSignature = (base: CharacterBaseRow): string => {
  return [
    base.jing,
    base.qi,
    base.shen,
    base.realm,
    base.sub_realm || '',
    base.insight_level,
    base.attribute_type,
    base.attribute_element,
  ].join('|');
};

const emptyStats = (): CharacterComputedStats => ({ ...DEFAULT_ATTRS });

const applyAttrDelta = (stats: CharacterComputedStats, keyRaw: string, valueRaw: unknown): void => {
  const key = String(keyRaw || '').trim() as CharacterAttrKey;
  if (!key) return;
  const value = safeNumber(valueRaw);
  if (!Number.isFinite(value) || value === 0) return;

  // 当前资源字段在运行时独立缓存，这里把 qixue/lingqi 视作上限增益。
  const mappedKey: CharacterAttrKey =
    key === 'qixue' ? 'max_qixue' : key === 'lingqi' ? 'max_lingqi' : key;
  if (!(mappedKey in stats)) return;

  if (RATIO_ATTR_KEYS.has(mappedKey)) {
    stats[mappedKey] = Math.max(0, roundRatio(stats[mappedKey] + value));
    return;
  }
  stats[mappedKey] = Math.max(0, Math.round(stats[mappedKey] + value));
};

const normalizeStats = (stats: CharacterComputedStats): CharacterComputedStats => {
  const next: CharacterComputedStats = { ...stats };

  next.max_qixue = Math.max(1, Math.floor(next.max_qixue));
  next.max_lingqi = Math.max(0, Math.floor(next.max_lingqi));
  next.wugong = Math.max(0, Math.floor(next.wugong));
  next.fagong = Math.max(0, Math.floor(next.fagong));
  next.wufang = Math.max(0, Math.floor(next.wufang));
  next.fafang = Math.max(0, Math.floor(next.fafang));
  next.sudu = Math.max(1, Math.floor(next.sudu));
  next.fuyuan = Math.max(1, Math.floor(next.fuyuan));
  next.qixue_huifu = Math.max(0, Math.floor(next.qixue_huifu));
  next.lingqi_huifu = Math.max(0, Math.floor(next.lingqi_huifu));

  const ratioKeys: Array<keyof CharacterComputedStats> = [
    'mingzhong',
    'shanbi',
    'zhaojia',
    'baoji',
    'baoshang',
    'jianbaoshang',
    'kangbao',
    'zengshang',
    'zhiliao',
    'jianliao',
    'xixue',
    'lengque',
    'shuxing_shuzhi',
    'kongzhi_kangxing',
    'jin_kangxing',
    'mu_kangxing',
    'shui_kangxing',
    'huo_kangxing',
    'tu_kangxing',
  ];
  for (const key of ratioKeys) {
    next[key] = Math.max(0, roundRatio(next[key]));
  }
  return next;
};

const parseTitleEffects = (effectsRaw: unknown): Record<string, number> => {
  const source = toRecord(effectsRaw);
  const flat = toRecord(source.flat);
  const candidate = Object.keys(flat).length > 0 ? flat : source;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(candidate)) {
    if (!VALID_TITLE_EFFECT_KEYS.has(key as CharacterAttrKey)) continue;
    const value = safeNumber(raw);
    if (!Number.isFinite(value) || value === 0) continue;
    out[key] = value;
  }
  return out;
};

const applyTechniquePassiveAttrs = (
  stats: CharacterComputedStats,
  passives: Record<string, number>,
  pctModifiers: Record<string, number>,
): void => {
  const splitPassives = splitTechniquePassiveAttrs(passives);

  for (const [key, value] of Object.entries(splitPassives.percentAdditive)) {
    if (!Number.isFinite(value) || value === 0) continue;
    if (!(key in stats)) continue;
    const statKey = key as keyof CharacterComputedStats;
    const base = stats[statKey];
    stats[statKey] = Math.max(0, roundRatio(base + value));
  }

  for (const [key, value] of Object.entries(splitPassives.percentMultiply)) {
    if (!Number.isFinite(value) || value === 0) continue;
    if (!(key in stats)) continue;
    const statKey = key as keyof CharacterComputedStats;
    pctModifiers[statKey] = (pctModifiers[statKey] || 0) + value;
  }

  for (const [key, value] of Object.entries(splitPassives.flatAdditive)) {
    if (!Number.isFinite(value) || value === 0) continue;
    if (!(key in stats)) continue;
    const statKey = key as keyof CharacterComputedStats;
    const base = stats[statKey];
    stats[statKey] = Math.max(0, Math.round(base + value));
  }
};

const loadTechniquePassives = async (characterId: number): Promise<Record<string, number>> => {
  const id = Number(characterId);
  if (!Number.isFinite(id) || id <= 0) return {};

  const passiveRows = await query(
    `
      SELECT technique_id, current_layer, slot_type
      FROM character_technique ct
      WHERE ct.character_id = $1
        AND ct.slot_type IS NOT NULL
    `,
    [id],
  );

  const layersByTechnique = new Map<string, Array<{ layer: number; passives: Array<{ key: string; value: number }> }>>();
  for (const entry of getTechniqueLayerDefinitions()) {
    if (entry.enabled === false) continue;
    const techniqueId = String(entry.technique_id || '').trim();
    const layer = Math.floor(Number(entry.layer) || 0);
    if (!techniqueId || layer <= 0) continue;

    const passives = Array.isArray(entry.passives)
      ? entry.passives
          .map((raw) => {
            const rec = toRecord(raw);
            const key = String(rec.key || '').trim();
            const value = safeNumber(rec.value);
            if (!key || !Number.isFinite(value)) return null;
            return { key, value };
          })
          .filter((v): v is { key: string; value: number } => Boolean(v))
      : [];

    const list = layersByTechnique.get(techniqueId) ?? [];
    list.push({ layer, passives });
    layersByTechnique.set(techniqueId, list);
  }
  for (const list of layersByTechnique.values()) {
    list.sort((left, right) => left.layer - right.layer);
  }

  const passives: Record<string, number> = {};
  for (const row of passiveRows.rows as Array<Record<string, unknown>>) {
    const slotTypeRaw = String(row.slot_type || '');
    const ratio = slotTypeRaw === 'main' ? 1 : slotTypeRaw === 'sub' ? 0.3 : 0;
    if (ratio <= 0) continue;

    const techniqueId = String(row.technique_id || '').trim();
    if (!techniqueId) continue;
    const currentLayer = Math.max(0, Math.floor(Number(row.current_layer) || 0));
    if (currentLayer <= 0) continue;

    const layerRows = layersByTechnique.get(techniqueId) ?? [];
    for (const layerRow of layerRows) {
      if (layerRow.layer > currentLayer) continue;
      for (const passive of layerRow.passives) {
        if (!passive.key || !Number.isFinite(passive.value) || passive.value === 0) continue;
        const effectiveValue = roundRatio(passive.value * ratio);
        passives[passive.key] = roundRatio((passives[passive.key] || 0) + effectiveValue);
      }
    }
  }
  return passives;
};

const applyRealmRewardsToStats = async (
  base: CharacterBaseRow,
  stats: CharacterComputedStats,
  pctModifiers: Record<string, number>,
): Promise<void> => {
  const cfg = await loadRealmBreakthroughConfig();
  const realmText = composeRealmText(base.realm, base.sub_realm);
  const currentIdx = cfg.realmOrder.indexOf(realmText);
  if (currentIdx <= 0) return;

  const rewardByFrom = new Map<string, RealmBreakthroughEntry>();
  for (const row of cfg.breakthroughs) {
    if (!row || typeof row !== 'object') continue;
    const from = String(row.from || '').trim();
    if (!from) continue;
    rewardByFrom.set(from, row);
  }

  for (let i = 0; i < currentIdx; i += 1) {
    const from = cfg.realmOrder[i];
    const to = cfg.realmOrder[i + 1];
    const entry = rewardByFrom.get(from);
    if (!entry || String(entry.to || '').trim() !== to) continue;

    const pct = toRecord(entry.rewards?.pct) as BreakthroughPctRewards;
    const addPercent = toRecord(entry.rewards?.addPercent) as BreakthroughAddPercentRewards;

    if (Number.isFinite(pct.max_qixue)) pctModifiers.max_qixue = (pctModifiers.max_qixue || 0) + Number(pct.max_qixue);
    if (Number.isFinite(pct.max_lingqi)) pctModifiers.max_lingqi = (pctModifiers.max_lingqi || 0) + Number(pct.max_lingqi);
    if (Number.isFinite(pct.wugong)) pctModifiers.wugong = (pctModifiers.wugong || 0) + Number(pct.wugong);
    if (Number.isFinite(pct.fagong)) pctModifiers.fagong = (pctModifiers.fagong || 0) + Number(pct.fagong);
    if (Number.isFinite(pct.wufang)) pctModifiers.wufang = (pctModifiers.wufang || 0) + Number(pct.wufang);
    if (Number.isFinite(pct.fafang)) pctModifiers.fafang = (pctModifiers.fafang || 0) + Number(pct.fafang);

    if (Number.isFinite(addPercent.kongzhi_kangxing)) {
      stats.kongzhi_kangxing = Math.max(0, roundRatio(stats.kongzhi_kangxing + Number(addPercent.kongzhi_kangxing)));
    }
  }
};

const applyInsightRewardsToStats = (
  base: CharacterBaseRow,
  pctModifiers: Record<string, number>,
): void => {
  const insightConfig = getInsightGrowthConfig();
  const insightLevel = Math.max(0, Math.floor(Number(base.insight_level) || 0));
  if (insightLevel <= 0) return;

  const insightBonusPct = buildInsightPctBonusByLevel(insightLevel, insightConfig);
  if (!Number.isFinite(insightBonusPct) || insightBonusPct <= 0) return;

  pctModifiers.max_qixue = (pctModifiers.max_qixue || 0) + insightBonusPct;
  pctModifiers.wugong = (pctModifiers.wugong || 0) + insightBonusPct;
  pctModifiers.fagong = (pctModifiers.fagong || 0) + insightBonusPct;
  pctModifiers.wufang = (pctModifiers.wufang || 0) + insightBonusPct;
  pctModifiers.fafang = (pctModifiers.fafang || 0) + insightBonusPct;
};

interface EquippedAttrBonuses {
  flatStats: CharacterComputedStats;
  pctModifiers: Record<string, number>;
  primaryAttrPctModifiers: Partial<Record<CharacterPrimaryAttrKey, number>>;
}

const loadEquippedAttrBonuses = async (characterId: number, effectiveLevel: number): Promise<EquippedAttrBonuses> => {
  const flatStats = emptyStats();
  for (const key of Object.keys(flatStats) as Array<keyof CharacterComputedStats>) {
    flatStats[key] = 0;
  }
  const pctModifiers: Record<string, number> = {};
  const primaryAttrPctModifiers: Partial<Record<CharacterPrimaryAttrKey, number>> = {};
  const ratingTotals: Partial<Record<CharacterAttrKey, number>> = {};

  const equippedResult = await query(
    `
      SELECT
        ii.affixes,
        ii.strengthen_level,
        ii.refine_level,
        ii.socketed_gems,
        ii.item_def_id,
        ii.quality_rank
      FROM item_instance ii
      WHERE ii.owner_character_id = $1
        AND ii.location = 'equipped'
    `,
    [characterId],
  );

  const itemDefIds = Array.from(
    new Set(
      (equippedResult.rows as Array<Record<string, unknown>>)
        .map((row) => String(row.item_def_id || '').trim())
        .filter((itemDefId) => itemDefId.length > 0),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const setCountMap = new Map<string, number>();
  for (const row of equippedResult.rows as Array<Record<string, unknown>>) {
    const itemDefId = String(row.item_def_id || '').trim();
    if (!itemDefId) continue;
    const def = defs.get(itemDefId);
    if (!def || def.category !== 'equipment') continue;
    const defQualityRank = resolveQualityRankFromName(def.quality, 1);
    const resolvedQualityRank = Number.isFinite(Number(row.quality_rank))
      ? Number(row.quality_rank)
      : defQualityRank;
    const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: def.base_attrs ?? null,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: row.strengthen_level,
      refineLevelRaw: row.refine_level,
      socketedGemsRaw: row.socketed_gems,
    });
    for (const [key, value] of Object.entries(displayBaseAttrs)) {
      const ratingBaseAttrKey = resolveRatingBaseAttrKey(key);
      if (ratingBaseAttrKey && Object.prototype.hasOwnProperty.call(flatStats, ratingBaseAttrKey)) {
        const mappedKey = ratingBaseAttrKey as CharacterAttrKey;
        ratingTotals[mappedKey] = (ratingTotals[mappedKey] || 0) + value;
        continue;
      }
      applyAttrDelta(flatStats, key, value);
    }

    const affixes = toArray(row.affixes);
    for (const affixRaw of affixes) {
      const rows = extractFlatAffixDeltas(affixRaw);
      for (const rowValue of rows) {
        const ratingBaseAttrKey = resolveRatingBaseAttrKey(rowValue.attrKey);
        if (ratingBaseAttrKey && Object.prototype.hasOwnProperty.call(flatStats, ratingBaseAttrKey)) {
          const mappedKey = ratingBaseAttrKey as CharacterAttrKey;
          ratingTotals[mappedKey] = (ratingTotals[mappedKey] || 0) + rowValue.value;
          continue;
        }
        applyAttrDelta(flatStats, rowValue.attrKey, rowValue.value);
      }

      const percentRows = extractPercentAffixDeltas(affixRaw);
      for (const rowValue of percentRows) {
        if (isCharacterPrimaryAttrKey(rowValue.attrKey)) {
          primaryAttrPctModifiers[rowValue.attrKey] = (primaryAttrPctModifiers[rowValue.attrKey] || 0) + rowValue.value;
          continue;
        }
        if (!TECHNIQUE_PASSIVE_PERCENT_MULTIPLY_KEYS.has(rowValue.attrKey)) continue;
        if (!Object.prototype.hasOwnProperty.call(flatStats, rowValue.attrKey)) continue;
        pctModifiers[rowValue.attrKey] = (pctModifiers[rowValue.attrKey] || 0) + rowValue.value;
      }
    }

    const setId = String(def.set_id || '').trim();
    if (setId) setCountMap.set(setId, (setCountMap.get(setId) || 0) + 1);
  }

  const setIds = [...setCountMap.keys()];
  if (setIds.length === 0) {
    return { flatStats, pctModifiers, primaryAttrPctModifiers };
  }

  const staticSetBonusBySetId = new Map<
    string,
    Array<{ piece_count: number; priority: number; effect_defs: unknown[] }>
  >();
  for (const setDef of getItemSetDefinitions()) {
    if (setDef.enabled === false) continue;
    const setId = String(setDef.id || '').trim();
    if (!setId) continue;
    const bonuses = Array.isArray(setDef.bonuses) ? setDef.bonuses : [];
    const normalizedBonuses = bonuses
      .map((bonus) => ({
        piece_count: Math.max(0, Math.floor(Number(bonus.piece_count) || 0)),
        priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
        effect_defs: Array.isArray(bonus.effect_defs) ? bonus.effect_defs : [],
      }))
      .filter((bonus) => bonus.piece_count > 0)
      .sort((left, right) => left.priority - right.priority || left.piece_count - right.piece_count);
    staticSetBonusBySetId.set(setId, normalizedBonuses);
  }

  for (const setId of setIds) {
    const equippedCount = setCountMap.get(setId) || 0;
    const bonusRows = staticSetBonusBySetId.get(setId) ?? [];
    for (const bonus of bonusRows) {
      if (equippedCount < bonus.piece_count) continue;
      for (const effectRaw of bonus.effect_defs) {
        const effect = toRecord(effectRaw);
        if (String(effect.effect_type || '') !== 'buff') continue;
        if (String(effect.trigger || '') !== 'equip') continue;
        if (String(effect.target || '') !== 'self') continue;
        const params = toRecord(effect.params);
        if (String(params.apply_type || '') !== 'flat') continue;
        const attrKey = String(params.attr_key || '').trim();
        if (!attrKey) continue;
        applyAttrDelta(flatStats, attrKey, params.value);
      }
    }
  }

  for (const [attrKey, ratingValue] of Object.entries(ratingTotals)) {
    const rating = safeNumber(ratingValue);
    if (!Number.isFinite(rating) || rating === 0) continue;
    const projectedValue = convertRatingToPercent(attrKey, rating, effectiveLevel);
    if (!Number.isFinite(projectedValue) || projectedValue === 0) continue;
    applyAttrDelta(flatStats, attrKey, projectedValue);
  }

  return { flatStats, pctModifiers, primaryAttrPctModifiers };
};

const loadEquippedTitleEffects = async (characterId: number): Promise<Record<string, number>> => {
  const result = await query(
    `
      SELECT title_id
      FROM character_title ct
      WHERE ct.character_id = $1
        AND ct.is_equipped = true
        AND (ct.expires_at IS NULL OR ct.expires_at > NOW())
      LIMIT 1
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return {};

  const titleId = String(result.rows[0]?.title_id || '').trim();
  if (!titleId) return {};
  const titleDef = getTitleDefinitions().find((row) => row.id === titleId && row.enabled !== false);
  if (!titleDef) return {};
  return parseTitleEffects(titleDef.effects);
};

interface ResolvedStaticAttrs {
  attrs: CharacterComputedStats;
  primaryAttrs: CharacterPrimaryAttrs;
}

const computeStaticAttrs = async (base: CharacterBaseRow): Promise<ResolvedStaticAttrs> => {
  const stats = emptyStats();
  const pctModifiers: Record<string, number> = {};
  const effectiveLevel = getEffectiveLevelByRealm(base.realm, base.sub_realm);

  const [equipBonuses, titleEffects, techniquePassives] = await Promise.all([
    loadEquippedAttrBonuses(base.id, effectiveLevel),
    loadEquippedTitleEffects(base.id),
    loadTechniquePassives(base.id),
  ]);

  const primaryAttrs = resolveCharacterPrimaryAttrs(
    createCharacterPrimaryAttrs({
      jing: base.jing,
      qi: base.qi,
      shen: base.shen,
    }),
    equipBonuses.primaryAttrPctModifiers,
  );

  applyCharacterPrimaryAttrsToStats(stats, primaryAttrs);
  await applyRealmRewardsToStats(base, stats, pctModifiers);
  applyInsightRewardsToStats(base, pctModifiers);

  for (const [key, value] of Object.entries(equipBonuses.flatStats)) {
    applyAttrDelta(stats, key, value);
  }
  for (const [key, value] of Object.entries(equipBonuses.pctModifiers)) {
    if (!Number.isFinite(value) || value === 0) continue;
    pctModifiers[key] = (pctModifiers[key] || 0) + value;
  }
  for (const [key, value] of Object.entries(titleEffects)) {
    applyAttrDelta(stats, key, value);
  }
  applyTechniquePassiveAttrs(stats, techniquePassives, pctModifiers);

  for (const [key, pct] of Object.entries(pctModifiers)) {
    if (pct === 0) continue;
    const statKey = key as keyof CharacterComputedStats;
    if (statKey in stats) {
      stats[statKey] = Math.max(0, Math.floor(stats[statKey] * (1 + pct)));
    }
  }

  return {
    attrs: normalizeStats(stats),
    primaryAttrs,
  };
};

const getStaticCacheKey = (characterId: number): string => {
  return `${STATIC_ATTR_CACHE_KEY_PREFIX}${characterId}`;
};

const getResourceCacheKey = (characterId: number): string => {
  return `${RESOURCE_CACHE_KEY_PREFIX}${characterId}`;
};

const readStaticAttrsFromCache = async (characterId: number): Promise<StaticAttrsCachePayload | null> => {
  const cachedMem = staticAttrsMemoryCache.get(characterId);
  const now = Date.now();
  if (cachedMem && cachedMem.expiresAt > now) return cachedMem.payload;

  try {
    const raw = await redis.get(getStaticCacheKey(characterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StaticAttrsCachePayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.signature !== 'string' || !parsed.attrs || !parsed.primaryAttrs) return null;
    if (
      !Number.isFinite(parsed.primaryAttrs.jing) ||
      !Number.isFinite(parsed.primaryAttrs.qi) ||
      !Number.isFinite(parsed.primaryAttrs.shen)
    ) {
      return null;
    }
    staticAttrsMemoryCache.set(characterId, {
      payload: parsed,
      expiresAt: now + STATIC_ATTR_MEMORY_TTL_MS,
    });
    return parsed;
  } catch {
    return null;
  }
};

const writeStaticAttrsCache = async (characterId: number, payload: StaticAttrsCachePayload): Promise<void> => {
  const now = Date.now();
  staticAttrsMemoryCache.set(characterId, {
    payload,
    expiresAt: now + STATIC_ATTR_MEMORY_TTL_MS,
  });
  try {
    await redis.setex(getStaticCacheKey(characterId), STATIC_ATTR_CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch {
    // ignore redis failure
  }
};

const readResourceStateFromCache = async (characterId: number): Promise<CharacterResourceState | null> => {
  const cachedMem = resourceMemoryCache.get(characterId);
  const now = Date.now();
  if (cachedMem && cachedMem.expiresAt > now) return cachedMem.payload;

  try {
    const raw = await redis.get(getResourceCacheKey(characterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CharacterResourceState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isFinite(parsed.qixue) || !Number.isFinite(parsed.lingqi)) return null;
    const normalized: CharacterResourceState = {
      qixue: Math.floor(parsed.qixue),
      lingqi: Math.floor(parsed.lingqi),
    };
    resourceMemoryCache.set(characterId, {
      payload: normalized,
      expiresAt: now + RESOURCE_MEMORY_TTL_MS,
    });
    return normalized;
  } catch {
    return null;
  }
};

const writeResourceStateCache = async (characterId: number, state: CharacterResourceState): Promise<void> => {
  const normalized: CharacterResourceState = {
    qixue: Math.floor(state.qixue),
    lingqi: Math.floor(state.lingqi),
  };
  const now = Date.now();
  resourceMemoryCache.set(characterId, {
    payload: normalized,
    expiresAt: now + RESOURCE_MEMORY_TTL_MS,
  });
  try {
    await redis.set(getResourceCacheKey(characterId), JSON.stringify(normalized));
  } catch {
    // ignore redis failure
  }
};

const selectBaseCharacterByUserId = async (userId: number): Promise<CharacterBaseRow | null> => {
  const result = await query(
    `
      SELECT
        ${CHARACTER_BASE_COLUMNS_SQL},
        COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.user_id = $1
      LIMIT 1
    `,
    [userId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as CharacterBaseRow;
};

const selectBaseCharacterByCharacterId = async (characterId: number): Promise<CharacterBaseRow | null> => {
  const result = await query(
    `
      SELECT
        ${CHARACTER_BASE_COLUMNS_SQL},
        COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.id = $1
      LIMIT 1
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as CharacterBaseRow;
};

const ensureResourceState = async (
  characterId: number,
  maxQixue: number,
  maxLingqi: number,
): Promise<CharacterResourceState> => {
  const existing = await readResourceStateFromCache(characterId);
  const initState: CharacterResourceState = existing ?? {
    qixue: maxQixue,
    lingqi: 0,
  };
  const normalized: CharacterResourceState = {
    qixue: clampNumber(Math.floor(initState.qixue), 0, maxQixue),
    lingqi: clampNumber(Math.floor(initState.lingqi), 0, maxLingqi),
  };
  if (!existing || existing.qixue !== normalized.qixue || existing.lingqi !== normalized.lingqi) {
    await writeResourceStateCache(characterId, normalized);
  }
  return normalized;
};

const resolveStaticAttrs = async (
  base: CharacterBaseRow,
  bypassStaticCache: boolean,
): Promise<ResolvedStaticAttrs> => {
  const signature = buildSignature(base);
  if (!bypassStaticCache) {
    const cached = await readStaticAttrsFromCache(base.id);
    if (cached && cached.signature === signature) {
      return {
        attrs: cached.attrs,
        primaryAttrs: cached.primaryAttrs,
      };
    }
  }
  const resolved = await computeStaticAttrs(base);
  await writeStaticAttrsCache(base.id, {
    signature,
    attrs: resolved.attrs,
    primaryAttrs: resolved.primaryAttrs,
  });
  return resolved;
};

const buildComputedRow = async (
  base: CharacterBaseRow,
  options?: { bypassStaticCache?: boolean },
): Promise<CharacterComputedRow> => {
  const bypassStaticCache = options?.bypassStaticCache === true;
  const staticSnapshot = await resolveStaticAttrs(base, bypassStaticCache);
  const resources = await ensureResourceState(
    base.id,
    staticSnapshot.attrs.max_qixue,
    staticSnapshot.attrs.max_lingqi,
  );
  const staminaMax = calcCharacterStaminaMaxByInsightLevel(base.insight_level);
  const stamina = clampNumber(Math.floor(Number(base.stamina) || 0), 0, staminaMax);
  const { insight_level: _ignoredInsightLevel, ...baseWithoutInsight } = base;

  return {
    ...baseWithoutInsight,
    ...staticSnapshot.primaryAttrs,
    stamina,
    stamina_max: staminaMax,
    ...staticSnapshot.attrs,
    qixue: resources.qixue,
    lingqi: resources.lingqi,
  };
};

export const getCharacterComputedByUserId = async (
  userId: number,
  options?: { bypassStaticCache?: boolean },
): Promise<CharacterComputedRow | null> => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const base = await selectBaseCharacterByUserId(uid);
  if (!base) return null;
  return buildComputedRow(base, options);
};

export const getCharacterComputedByCharacterId = async (
  characterId: number,
  options?: { bypassStaticCache?: boolean },
): Promise<CharacterComputedRow | null> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const base = await selectBaseCharacterByCharacterId(cid);
  if (!base) return null;
  return buildComputedRow(base, options);
};

export const getCharacterComputedBatchByCharacterIds = async (
  characterIds: number[],
  options?: { bypassStaticCache?: boolean },
): Promise<Map<number, CharacterComputedRow>> => {
  const ids = [...new Set(characterIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, CharacterComputedRow>();
  if (ids.length <= 0) return out;

  const result = await query(
    `
      SELECT
        ${CHARACTER_BASE_COLUMNS_SQL},
        COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.id = ANY($1)
    `,
    [ids],
  );

  const rows = result.rows as CharacterBaseRow[];
  await Promise.all(
    rows.map(async (row) => {
      const computed = await buildComputedRow(row, options);
      out.set(computed.id, computed);
    }),
  );
  return out;
};

export const backfillCharacterRankSnapshots = async (): Promise<void> => {
  type CharacterIdRow = { id: number | string };
  const BATCH_SIZE = 200;
  const result = await query(
    `
      SELECT c.id
      FROM characters c
      LEFT JOIN character_rank_snapshot crs ON crs.character_id = c.id
      WHERE crs.character_id IS NULL
      ORDER BY c.id ASC
    `,
    [],
  );

  const ids = (result.rows as CharacterIdRow[])
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (ids.length <= 0) return;

  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const chunk = ids.slice(index, index + BATCH_SIZE);
    const computedMap = await getCharacterComputedBatchByCharacterIds(chunk, { bypassStaticCache: true });
    for (const computed of computedMap.values()) {
      await upsertCharacterRankSnapshot(computed);
    }
  }
};

export const invalidateCharacterComputedCache = async (characterId: number): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  staticAttrsMemoryCache.delete(cid);
  try {
    await redis.del(getStaticCacheKey(cid));
  } catch {
    // ignore redis failure
  }
  const computed = await getCharacterComputedByCharacterId(cid, { bypassStaticCache: true });
  if (!computed) {
    await deleteCharacterRankSnapshot(cid);
    return;
  }
  await upsertCharacterRankSnapshot(computed);
};

export const invalidateCharacterComputedCacheByUserId = async (userId: number): Promise<void> => {
  const row = await selectBaseCharacterByUserId(userId);
  if (!row) return;
  await invalidateCharacterComputedCache(row.id);
};

export const setCharacterResourcesByCharacterId = async (
  characterId: number,
  next: CharacterResourceState,
  options?: { minQixue?: number },
): Promise<CharacterResourceState | null> => {
  const computed = await getCharacterComputedByCharacterId(characterId);
  if (!computed) return null;
  const minQixue = Math.max(0, Math.floor(safeNumber(options?.minQixue, 0)));
  const normalized: CharacterResourceState = {
    qixue: clampNumber(Math.floor(safeNumber(next.qixue, computed.qixue)), minQixue, computed.max_qixue),
    lingqi: clampNumber(Math.floor(safeNumber(next.lingqi, computed.lingqi)), 0, computed.max_lingqi),
  };
  await writeResourceStateCache(computed.id, normalized);
  return normalized;
};

export const applyCharacterResourceDeltaByCharacterId = async (
  characterId: number,
  delta: Partial<CharacterResourceState>,
  options?: { minQixue?: number },
): Promise<(CharacterResourceState & { max_qixue: number; max_lingqi: number }) | null> => {
  const computed = await getCharacterComputedByCharacterId(characterId);
  if (!computed) return null;
  const minQixue = Math.max(0, Math.floor(safeNumber(options?.minQixue, 0)));
  const nextQixue = clampNumber(
    Math.floor(computed.qixue + safeNumber(delta.qixue, 0)),
    minQixue,
    computed.max_qixue,
  );
  const nextLingqi = clampNumber(
    Math.floor(computed.lingqi + safeNumber(delta.lingqi, 0)),
    0,
    computed.max_lingqi,
  );
  await writeResourceStateCache(computed.id, {
    qixue: nextQixue,
    lingqi: nextLingqi,
  });
  return {
    qixue: nextQixue,
    lingqi: nextLingqi,
    max_qixue: computed.max_qixue,
    max_lingqi: computed.max_lingqi,
  };
};

export const recoverBattleStartResourcesByUserIds = async (userIds: number[]): Promise<void> => {
  const uniq = [...new Set(userIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isFinite(id) && id > 0))];
  if (uniq.length <= 0) return;

  await Promise.all(
    uniq.map(async (userId) => {
      const computed = await getCharacterComputedByUserId(userId);
      if (!computed) return;
      const targetLingqi = Math.max(0, Math.floor(computed.max_lingqi * 0.5));
      await setCharacterResourcesByCharacterId(computed.id, {
        qixue: computed.max_qixue,
        lingqi: Math.max(computed.lingqi, targetLingqi),
      });
    }),
  );
};

export const clearCharacterRuntimeResourceCache = async (characterId: number): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  resourceMemoryCache.delete(cid);
  try {
    await redis.del(getResourceCacheKey(cid));
  } catch {
    // ignore redis failure
  }
};
