/**
 * 伙伴系统服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一处理伙伴总览、出战切换、经验灌注、打书、主线发放初始伙伴和战斗快照构建。
 * 2) 不做什么：不解析 HTTP 参数，不直接决定 HTTP 参数结构；伙伴功法直接复用现有角色功法静态配置，不额外维护第二套功法定义。
 *
 * 输入/输出：
 * - 输入：characterId / userId、partnerId、经验预算、功法书信息、静态配置。
 * - 输出：统一 `{ success, message, data }` 结果，以及可复用的伙伴战斗成员快照。
 *
 * 数据流/状态流：
 * route / mainQuest / itemService / pve -> partnerService -> partnerRules + staticConfig + SQL -> DTO / 战斗快照。
 *
 * 关键边界条件与坑点：
 * 1) 伙伴升级与打书都必须在事务内锁定角色与伙伴行，避免经验双花和并发覆盖。
 * 2) 伙伴属性只由模板 + 成长值 + 等级 + 已学伙伴功法决定，严禁混入角色装备、悟道或套装属性。
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from './featureUnlockService.js';
import {
  getPartnerDefinitionById,
  getPartnerDefinitions,
  getPartnerGrowthConfig,
  getItemDefinitionById,
  getSkillDefinitions,
  getTechniqueDefinitions,
  type PartnerDefConfig,
  type TechniqueDefConfig,
} from './staticConfigLoader.js';
import type {
  CharacterData,
  SkillData,
} from '../battle/battleFactory.js';
import { toBattleSkillData } from './battle/shared/skills.js';
import { resolveGeneratedTechniqueBookDisplay } from './shared/generatedTechniqueBookView.js';
import {
  calcPartnerUpgradeExpByTargetLevel,
  PARTNER_GROWTH_KEYS,
  buildPartnerBattleAttrs,
  listReplaceablePartnerTechniqueIds,
  mergePartnerTechniquePassives,
  resolvePartnerInjectPlan,
  type PartnerGrowthValues,
  type PartnerLearnedTechniqueState,
} from './shared/partnerRules.js';
import { setCharacterPartnerActivation } from './shared/partnerActivation.js';
import { resolveTechniqueBookLearning } from './shared/techniqueBookRules.js';
import {
  getItemMetaMap,
  getTechniqueLayerByTechniqueAndLayerStatic,
  getTechniqueLayersByTechniqueIdStatic,
  resolveTechniqueCostMultiplierByQuality,
  scaleTechniqueBaseCostByQuality,
} from './shared/techniqueUpgradeRules.js';

const STARTER_PARTNER_DEF_ID = 'partner-qingmu-xiaoou';

type PartnerRow = {
  id: number;
  character_id: number;
  partner_def_id: string;
  nickname: string;
  level: number;
  progress_exp: number;
  growth_max_qixue: number;
  growth_wugong: number;
  growth_fagong: number;
  growth_wufang: number;
  growth_fafang: number;
  growth_sudu: number;
  is_active: boolean;
  obtained_from: string;
  obtained_ref_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PartnerTechniqueRow = {
  id: number;
  partner_id: number;
  technique_id: string;
  current_layer: number;
  is_innate: boolean;
  learned_from_item_def_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type CharacterPartnerContextRow = {
  characterId: number;
  userId: number;
  exp: number;
  spiritStones: number;
  realm: string;
  subRealm: string | null;
};

export interface PartnerGrowthDto {
  max_qixue: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  sudu: number;
}

export interface PartnerComputedAttrsDto {
  qixue: number;
  max_qixue: number;
  lingqi: number;
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
  sudu: number;
  kongzhi_kangxing: number;
  jin_kangxing: number;
  mu_kangxing: number;
  shui_kangxing: number;
  huo_kangxing: number;
  tu_kangxing: number;
  qixue_huifu: number;
  lingqi_huifu: number;
}

export type PartnerPassiveAttrsDto = Record<string, number>;

export interface PartnerTechniqueSkillDto {
  id: string;
  name: string;
  icon: string;
  description?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
}

export interface PartnerTechniqueDto {
  techniqueId: string;
  name: string;
  description: string | null;
  icon: string | null;
  quality: string;
  currentLayer: number;
  maxLayer: number;
  isInnate: boolean;
  skillIds: string[];
  skills: PartnerTechniqueSkillDto[];
  passiveAttrs: PartnerPassiveAttrsDto;
}

export interface PartnerTechniqueUpgradeCostDto {
  currentLayer: number;
  maxLayer: number;
  nextLayer: number;
  spiritStones: number;
  exp: number;
  materials: Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null }>;
}

export interface PartnerUpgradeTechniqueResultDto {
  partner: PartnerDetailDto;
  updatedTechnique: PartnerTechniqueDto;
  newLayer: number;
}

export interface PartnerBookDto {
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  techniqueId: string;
  techniqueName: string;
  quality: string;
  qty: number;
}

export interface PartnerDetailDto {
  id: number;
  partnerDefId: string;
  nickname: string;
  name: string;
  description: string;
  avatar: string | null;
  element: string;
  role: string;
  quality: string;
  level: number;
  progressExp: number;
  nextLevelCostExp: number;
  slotCount: number;
  isActive: boolean;
  obtainedFrom: string | null;
  growth: PartnerGrowthDto;
  computedAttrs: PartnerComputedAttrsDto;
  techniques: PartnerTechniqueDto[];
}

export interface PartnerOverviewDto {
  unlocked: true;
  featureCode: string;
  characterExp: number;
  activePartnerId: number | null;
  partners: PartnerDetailDto[];
  books: PartnerBookDto[];
}

export interface PartnerInjectResultDto {
  partner: PartnerDetailDto;
  spentExp: number;
  characterExp: number;
  levelsGained: number;
}

export interface PartnerLearnTechniqueResultDto {
  partner: PartnerDetailDto;
  learnedTechnique: PartnerTechniqueDto;
  replacedTechnique: PartnerTechniqueDto | null;
  remainingBooks: PartnerBookDto[];
}

export interface PartnerRewardDto {
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
}

export interface CreatePartnerInstanceResult {
  reward: PartnerRewardDto;
  activated: boolean;
}

export interface PartnerResult<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
}

export interface PartnerBattleMember {
  data: CharacterData;
  skills: SkillData[];
}

type PartnerTechniqueStaticMeta = {
  definition: TechniqueDefConfig;
  currentLayer: number;
  maxLayer: number;
  skillIds: string[];
  passiveAttrs: Array<{ key: string; value: number }>;
};

type EffectivePartnerTechniqueEntry = {
  row: PartnerTechniqueRow | null;
  techniqueId: string;
  currentLayer: number;
  isInnate: boolean;
  learnedFromItemDefId: string | null;
};

const normalizeInteger = (value: unknown, minimum: number = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.floor(parsed));
};

const normalizeText = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const randomIntInclusive = (min: number, max: number): number => {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
};

const toPartnerGrowth = (row: PartnerRow): PartnerGrowthValues => ({
  max_qixue: normalizeInteger(row.growth_max_qixue),
  wugong: normalizeInteger(row.growth_wugong),
  fagong: normalizeInteger(row.growth_fagong),
  wufang: normalizeInteger(row.growth_wufang),
  fafang: normalizeInteger(row.growth_fafang),
  sudu: normalizeInteger(row.growth_sudu),
});

const toPartnerGrowthDto = (growth: PartnerGrowthValues): PartnerGrowthDto => ({
  max_qixue: growth.max_qixue,
  wugong: growth.wugong,
  fagong: growth.fagong,
  wufang: growth.wufang,
  fafang: growth.fafang,
  sudu: growth.sudu,
});

type PartnerItemInstanceRow = {
  id: number;
  item_def_id: string;
  qty: number;
  location: string;
  location_slot: number | null;
  metadata: object | null;
};

const loadCharacterPartnerContext = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterPartnerContextRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, user_id, exp, spirit_stones, realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  const row = result.rows[0] as Record<string, unknown>;
  return {
    characterId: normalizeInteger(row.id),
    userId: normalizeInteger(row.user_id),
    exp: normalizeInteger(row.exp),
    spiritStones: normalizeInteger(row.spirit_stones),
    realm: normalizeText(row.realm) || '凡人',
    subRealm: normalizeText(row.sub_realm) || null,
  };
};

const loadPartnerRows = async (
  characterId: number,
  forUpdate: boolean,
): Promise<PartnerRow[]> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner
      WHERE character_id = $1
      ORDER BY is_active DESC, created_at ASC, id ASC
      ${lockSql}
    `,
    [characterId],
  );
  return result.rows as PartnerRow[];
};

const loadSinglePartnerRow = async (
  characterId: number,
  partnerId: number,
  forUpdate: boolean,
): Promise<PartnerRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner
      WHERE id = $1 AND character_id = $2
      LIMIT 1
      ${lockSql}
    `,
    [partnerId, characterId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as PartnerRow;
};

const loadPartnerTechniqueRows = async (
  partnerIds: number[],
  forUpdate: boolean,
): Promise<Map<number, PartnerTechniqueRow[]>> => {
  const normalizedPartnerIds = [
    ...new Set(
      partnerIds.map((partnerId) => normalizeInteger(partnerId)).filter((partnerId) => partnerId > 0),
    ),
  ];
  const resultMap = new Map<number, PartnerTechniqueRow[]>();
  if (normalizedPartnerIds.length <= 0) return resultMap;

  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner_technique
      WHERE partner_id = ANY($1)
      ORDER BY created_at ASC, id ASC
      ${lockSql}
    `,
    [normalizedPartnerIds],
  );

  for (const rawRow of result.rows as PartnerTechniqueRow[]) {
    const partnerId = normalizeInteger(rawRow.partner_id);
    const currentList = resultMap.get(partnerId) ?? [];
    currentList.push(rawRow);
    resultMap.set(partnerId, currentList);
  }
  return resultMap;
};

const getPartnerTechniqueStaticMeta = (
  techniqueId: string,
  currentLayerRaw: unknown,
): PartnerTechniqueStaticMeta | null => {
  const normalizedTechniqueId = normalizeText(techniqueId);
  if (!normalizedTechniqueId) return null;

  const definition =
    getTechniqueDefinitions().find(
      (entry) => entry.id === normalizedTechniqueId && entry.enabled !== false,
    ) ?? null;
  if (!definition) return null;

  const layerRows = getTechniqueLayersByTechniqueIdStatic(normalizedTechniqueId);
  const maxLayer = Math.max(
    normalizeInteger(definition.max_layer, 1),
    layerRows[layerRows.length - 1]?.layer ?? 1,
  );
  const currentLayer = Math.min(
    Math.max(1, normalizeInteger(currentLayerRaw, 1)),
    maxLayer,
  );
  const activeLayerRows = layerRows.filter((entry) => entry.layer <= currentLayer);
  const skillIds = [
    ...new Set(
      activeLayerRows.flatMap((entry) =>
        entry.unlockSkillIds
          .map((skillId) => normalizeText(skillId))
          .filter((skillId) => skillId.length > 0),
      ),
    ),
  ];
  const passiveAttrs = activeLayerRows.flatMap((entry) =>
    entry.passives
      .map((passive) => ({
        key: normalizeText(passive.key),
        value: Number(passive.value) || 0,
      }))
      .filter((passive) => passive.key.length > 0),
  );

  return {
    definition,
    currentLayer,
    maxLayer,
    skillIds,
    passiveAttrs,
  };
};

const toPartnerPassiveAttrsDto = (
  passiveAttrs: Array<{ key: string; value: number }>,
): PartnerPassiveAttrsDto => {
  const merged: PartnerPassiveAttrsDto = {};
  for (const passive of passiveAttrs) {
    const key = normalizeText(passive.key);
    if (!key) continue;
    const value = Number(passive.value) || 0;
    merged[key] = Number(merged[key] ?? 0) + value;
  }
  return merged;
};

const toPartnerComputedAttrsDto = (
  finalAttrs: Record<string, number | string | undefined>,
): PartnerComputedAttrsDto => {
  const maxQixue = normalizeInteger(finalAttrs.max_qixue, 1);
  const maxLingqi = normalizeInteger(finalAttrs.max_lingqi);
  return {
    qixue: maxQixue,
    max_qixue: maxQixue,
    lingqi: maxLingqi,
    max_lingqi: maxLingqi,
    wugong: Number(finalAttrs.wugong) || 0,
    fagong: Number(finalAttrs.fagong) || 0,
    wufang: Number(finalAttrs.wufang) || 0,
    fafang: Number(finalAttrs.fafang) || 0,
    mingzhong: Number(finalAttrs.mingzhong) || 0,
    shanbi: Number(finalAttrs.shanbi) || 0,
    zhaojia: Number(finalAttrs.zhaojia) || 0,
    baoji: Number(finalAttrs.baoji) || 0,
    baoshang: Number(finalAttrs.baoshang) || 0,
    jianbaoshang: Number(finalAttrs.jianbaoshang) || 0,
    kangbao: Number(finalAttrs.kangbao) || 0,
    zengshang: Number(finalAttrs.zengshang) || 0,
    zhiliao: Number(finalAttrs.zhiliao) || 0,
    jianliao: Number(finalAttrs.jianliao) || 0,
    xixue: Number(finalAttrs.xixue) || 0,
    lengque: Number(finalAttrs.lengque) || 0,
    sudu: Math.max(1, Number(finalAttrs.sudu) || 1),
    kongzhi_kangxing: Number(finalAttrs.kongzhi_kangxing) || 0,
    jin_kangxing: Number(finalAttrs.jin_kangxing) || 0,
    mu_kangxing: Number(finalAttrs.mu_kangxing) || 0,
    shui_kangxing: Number(finalAttrs.shui_kangxing) || 0,
    huo_kangxing: Number(finalAttrs.huo_kangxing) || 0,
    tu_kangxing: Number(finalAttrs.tu_kangxing) || 0,
    qixue_huifu: Number(finalAttrs.qixue_huifu) || 0,
    lingqi_huifu: Number(finalAttrs.lingqi_huifu) || 0,
  };
};

const loadPartnerBooks = async (characterId: number): Promise<PartnerBookDto[]> => {
  const result = await query(
    `
      SELECT id, item_def_id, qty, location, location_slot, metadata
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'bag'
        AND qty > 0
      ORDER BY location_slot ASC NULLS LAST, id ASC
    `,
    [characterId],
  );

  const books: PartnerBookDto[] = [];
  for (const row of result.rows as PartnerItemInstanceRow[]) {
    const itemDefId = normalizeText(row.item_def_id);
    if (!itemDefId) continue;
    const itemDef = getItemDefinitionById(itemDefId);
    const learning = resolveTechniqueBookLearning({
      itemDef,
      metadata: row.metadata,
    });
    if (!itemDef || !learning) continue;
    const techniqueMeta = getPartnerTechniqueStaticMeta(learning.techniqueId, 1);
    if (!techniqueMeta) continue;
    const generatedDisplay = resolveGeneratedTechniqueBookDisplay(itemDefId, row.metadata);
    books.push({
      itemInstanceId: normalizeInteger(row.id, 1),
      itemDefId,
      name:
        normalizeText(generatedDisplay?.name) ||
        normalizeText(itemDef.name) ||
        itemDefId,
      icon: normalizeText(itemDef.icon) || null,
      techniqueId: learning.techniqueId,
      techniqueName:
        normalizeText(generatedDisplay?.generatedTechniqueName) ||
        normalizeText(techniqueMeta.definition.name) ||
        learning.techniqueId,
      quality:
        normalizeText(generatedDisplay?.quality) ||
        normalizeText(itemDef.quality) ||
        normalizeText(techniqueMeta.definition.quality) ||
        '黄',
      qty: normalizeInteger(row.qty, 1),
    });
  }

  return books;
};

const buildPartnerTechniqueDto = (
  entry: EffectivePartnerTechniqueEntry,
  meta: PartnerTechniqueStaticMeta,
): PartnerTechniqueDto => {
  const skillDefinitionMap = new Map(
    getSkillDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );
  const skills = meta.skillIds
    .map((skillId) => skillDefinitionMap.get(skillId))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => ({
      id: entry.id,
      name: normalizeText(entry.name) || entry.id,
      icon: normalizeText(entry.icon) || '',
      description: normalizeText(entry.description) || undefined,
      cost_lingqi: typeof entry.cost_lingqi === 'number' ? entry.cost_lingqi : undefined,
      cost_lingqi_rate: typeof entry.cost_lingqi_rate === 'number' ? entry.cost_lingqi_rate : undefined,
      cost_qixue: typeof entry.cost_qixue === 'number' ? entry.cost_qixue : undefined,
      cost_qixue_rate: typeof entry.cost_qixue_rate === 'number' ? entry.cost_qixue_rate : undefined,
      cooldown: typeof entry.cooldown === 'number' ? entry.cooldown : undefined,
      target_type: normalizeText(entry.target_type) || undefined,
      target_count: typeof entry.target_count === 'number' ? entry.target_count : undefined,
      damage_type: normalizeText(entry.damage_type) || null,
      element: normalizeText(entry.element) || undefined,
      effects: Array.isArray(entry.effects) ? entry.effects : undefined,
    }));

  return {
    techniqueId: entry.techniqueId,
    name: normalizeText(meta.definition.name) || meta.definition.id,
    description: normalizeText(meta.definition.description) || null,
    icon: normalizeText(meta.definition.icon) || null,
    quality: normalizeText(meta.definition.quality) || '黄',
    currentLayer: meta.currentLayer,
    maxLayer: meta.maxLayer,
    isInnate: entry.isInnate,
    skillIds: meta.skillIds,
    skills,
    passiveAttrs: toPartnerPassiveAttrsDto(meta.passiveAttrs),
  };
};

const getPartnerInnateTechniqueIds = (definition: PartnerDefConfig): string[] => {
  const ids = Array.isArray(definition.innate_technique_ids)
    ? definition.innate_technique_ids
        .map((entry) => normalizeText(entry))
        .filter((entry) => entry.length > 0)
    : [];
  return [...new Set(ids)];
};

const buildEffectivePartnerTechniqueEntries = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
): EffectivePartnerTechniqueEntry[] => {
  const innateTechniqueIds = getPartnerInnateTechniqueIds(definition);
  const innateTechniqueIdSet = new Set(innateTechniqueIds);
  const rowMap = new Map(
    techniqueRows.map((row) => [normalizeText(row.technique_id), row] as const),
  );
  const entries: EffectivePartnerTechniqueEntry[] = [];

  for (const techniqueId of innateTechniqueIds) {
    const row = rowMap.get(techniqueId) ?? null;
    entries.push({
      row,
      techniqueId,
      currentLayer: row ? normalizeInteger(row.current_layer, 1) : 1,
      isInnate: true,
      learnedFromItemDefId: row?.learned_from_item_def_id ?? null,
    });
  }

  for (const row of techniqueRows) {
    const techniqueId = normalizeText(row.technique_id);
    if (!techniqueId || innateTechniqueIdSet.has(techniqueId)) continue;
    if (row.is_innate) continue;
    entries.push({
      row,
      techniqueId,
      currentLayer: normalizeInteger(row.current_layer, 1),
      isInnate: false,
      learnedFromItemDefId: row.learned_from_item_def_id ?? null,
    });
  }

  return entries;
};

const findEffectivePartnerTechniqueEntry = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
  techniqueIdRaw: string,
): EffectivePartnerTechniqueEntry | null => {
  const techniqueId = normalizeText(techniqueIdRaw);
  if (!techniqueId) return null;
  return buildEffectivePartnerTechniqueEntries(definition, techniqueRows)
    .find((entry) => entry.techniqueId === techniqueId) ?? null;
};

const buildPartnerDetail = (params: {
  row: PartnerRow;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
}): PartnerDetailDto => {
  const { row, definition, techniqueRows } = params;
  const config = getPartnerGrowthConfig();
  const growth = toPartnerGrowth(row);
  const effectiveTechniqueEntries = buildEffectivePartnerTechniqueEntries(
    definition,
    techniqueRows,
  );
  const techniqueEntries = effectiveTechniqueEntries.map((entry) => {
    const meta = getPartnerTechniqueStaticMeta(
      entry.techniqueId,
      entry.currentLayer,
    );
    if (!meta) {
      throw new Error(`伙伴功法不存在: ${entry.techniqueId}`);
    }
    return {
      entry,
      meta,
    };
  });
  const techniques = techniqueEntries.map((entry) =>
    buildPartnerTechniqueDto(entry.entry, entry.meta),
  );
  const passiveAttrs = mergePartnerTechniquePassives(
    techniqueEntries.map((entry) => entry.meta.passiveAttrs),
  );
  const element = normalizeText(definition.attribute_element) || 'none';
  const finalAttrs = buildPartnerBattleAttrs({
    baseAttrs: definition.base_attrs,
    level: row.level,
    levelAttrGains: definition.level_attr_gains,
    passiveAttrs,
    element,
  });

  return {
    id: row.id,
    partnerDefId: definition.id,
    nickname: normalizeText(row.nickname) || normalizeText(definition.name),
    name: normalizeText(definition.name) || definition.id,
    description: normalizeText(definition.description),
    avatar: normalizeText(definition.avatar) || null,
    element,
    role: normalizeText(definition.role) || '伙伴',
    quality: normalizeText(definition.quality) || '黄',
    level: normalizeInteger(row.level, 1),
    progressExp: normalizeInteger(row.progress_exp),
    nextLevelCostExp: calcPartnerUpgradeExpByTargetLevel(
      normalizeInteger(row.level, 1) + 1,
      config,
    ),
    slotCount: Math.max(0, normalizeInteger(definition.max_technique_slots)),
    isActive: Boolean(row.is_active),
    obtainedFrom: normalizeText(row.obtained_from) || null,
    growth: toPartnerGrowthDto(growth),
    computedAttrs: toPartnerComputedAttrsDto(finalAttrs),
    techniques,
  };
};

const buildPartnerDetailWithNextLevel = (params: {
  row: PartnerRow;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
}): PartnerDetailDto => {
  return buildPartnerDetail(params);
};

const buildPartnerDetails = (params: {
  rows: PartnerRow[];
  techniqueMap: Map<number, PartnerTechniqueRow[]>;
}): PartnerDetailDto[] => {
  return params.rows.map((row) => {
    const definition = getPartnerDefinitionById(row.partner_def_id);
    if (!definition) {
      throw new Error(`伙伴模板不存在: ${row.partner_def_id}`);
    }
    const techniqueRows = params.techniqueMap.get(row.id) ?? [];
    return buildPartnerDetail({
      row,
      definition,
      techniqueRows,
    });
  });
};

const buildTechniqueStateList = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
): PartnerLearnedTechniqueState[] => {
  return buildEffectivePartnerTechniqueEntries(definition, techniqueRows).map((entry) => ({
    techniqueId: entry.techniqueId,
    isInnate: entry.isInnate,
  }));
};

const assertPartnerSystemUnlocked = async (
  characterId: number,
): Promise<PartnerResult> => {
  const unlocked = await isFeatureUnlocked(
    characterId,
    PARTNER_SYSTEM_FEATURE_CODE,
  );
  if (!unlocked) {
    return { success: false, message: '伙伴系统尚未解锁' };
  }
  return { success: true, message: 'ok' };
};

const buildPartnerTechniqueUpgradeCost = async (params: {
  techniqueId: string;
  techniqueMeta: PartnerTechniqueStaticMeta;
}): Promise<PartnerTechniqueUpgradeCostDto | null> => {
  const { techniqueId, techniqueMeta } = params;
  if (techniqueMeta.currentLayer >= techniqueMeta.maxLayer) return null;
  const nextLayer = techniqueMeta.currentLayer + 1;
  const nextLayerConfig = getTechniqueLayerByTechniqueAndLayerStatic(
    techniqueId,
    nextLayer,
  );
  if (!nextLayerConfig) return null;
  const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(
    techniqueMeta.definition.quality,
  );
  const metaMap = await getItemMetaMap(
    nextLayerConfig.costMaterials.map((entry) => entry.itemId),
  );
  return {
    currentLayer: techniqueMeta.currentLayer,
    maxLayer: techniqueMeta.maxLayer,
    nextLayer,
    spiritStones: scaleTechniqueBaseCostByQuality(
      nextLayerConfig.costSpiritStones,
      qualityMultiplier,
    ),
    exp: scaleTechniqueBaseCostByQuality(
      nextLayerConfig.costExp,
      qualityMultiplier,
    ),
    materials: nextLayerConfig.costMaterials.map((entry) => {
      const meta = metaMap.get(entry.itemId) ?? null;
      return {
        itemId: entry.itemId,
        qty: entry.qty,
        itemName: meta?.name,
        itemIcon: meta?.icon,
      };
    }),
  };
};

const buildPartnerRewardDto = (
  partnerId: number,
  definition: PartnerDefConfig,
): PartnerRewardDto => ({
  partnerId,
  partnerDefId: definition.id,
  partnerName: normalizeText(definition.name) || definition.id,
  partnerAvatar: normalizeText(definition.avatar) || null,
});

/**
 * 创建伙伴实例共享入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把“根据伙伴定义创建实例”收敛成单入口，供初始伙伴发放与 AI 招募确认复用。
 * 2) 做什么：统一处理成长初值、首个伙伴自动出战、来源字段写入，避免两条获得链路各写一套插入 SQL。
 * 3) 不做什么：不负责功能解锁、不负责招募扣费，也不刷新前端总览。
 *
 * 输入/输出：
 * - 输入：角色ID、伙伴定义、来源字段、可选昵称。
 * - 输出：新伙伴奖励 DTO 与是否自动出战。
 *
 * 数据流/状态流：
 * starter reward / recruit confirm -> createPartnerInstanceFromDefinition -> character_partner -> partnerService/buildActivePartnerBattleMember。
 *
 * 关键边界条件与坑点：
 * 1) 插入前必须校验所有天生功法都能在统一功法入口读到，否则战斗构建会在运行时爆炸。
 * 2) 新获得伙伴默认保持未出战，把“是否携带伙伴战斗”的决定完全交给玩家显式控制。
 */
const createPartnerInstanceFromDefinition = async (params: {
  characterId: number;
  definition: PartnerDefConfig;
  obtainedFrom: string;
  obtainedRefId?: string;
  nickname?: string;
}): Promise<CreatePartnerInstanceResult> => {
  const { characterId, definition, obtainedFrom, obtainedRefId, nickname } = params;
  const growthValues = Object.fromEntries(
    PARTNER_GROWTH_KEYS.map((key) => [key, 1000]),
  ) as PartnerGrowthValues;

  const innateTechniqueIds = getPartnerInnateTechniqueIds(definition);
  for (const techniqueId of innateTechniqueIds) {
    const techniqueMeta = getPartnerTechniqueStaticMeta(techniqueId, 1);
    if (!techniqueMeta) {
      throw new Error(`伙伴天生功法不存在: ${techniqueId}`);
    }
  }

  const activated = false;
  const insertResult = await query(
    `
      INSERT INTO character_partner (
        character_id,
        partner_def_id,
        nickname,
        level,
        progress_exp,
        growth_max_qixue,
        growth_wugong,
        growth_fagong,
        growth_wufang,
        growth_fafang,
        growth_sudu,
        is_active,
        obtained_from,
        obtained_ref_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 1, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING id
    `,
    [
      characterId,
      definition.id,
      normalizeText(nickname) || normalizeText(definition.name) || definition.id,
      growthValues.max_qixue,
      growthValues.wugong,
      growthValues.fagong,
      growthValues.wufang,
      growthValues.fafang,
      growthValues.sudu,
      activated,
      obtainedFrom,
      normalizeText(obtainedRefId) || null,
    ],
  );
  const partnerId = normalizeInteger(insertResult.rows[0]?.id, 1);
  return {
    reward: buildPartnerRewardDto(partnerId, definition),
    activated,
  };
};

class PartnerService {
  async listLearnTechniqueBooks(characterId: number): Promise<PartnerBookDto[]> {
    return loadPartnerBooks(characterId);
  }

  async getOverview(characterId: number): Promise<PartnerResult<PartnerOverviewDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      const rows = await loadPartnerRows(characterId, false);
      const techniqueMap = await loadPartnerTechniqueRows(
        rows.map((row) => row.id),
        false,
      );
      const partners = buildPartnerDetails({
        rows,
        techniqueMap,
      });
      const books = await loadPartnerBooks(characterId);

      return {
        success: true,
        message: 'ok',
        data: {
          unlocked: true,
          featureCode: PARTNER_SYSTEM_FEATURE_CODE,
          characterExp: character.exp,
          activePartnerId:
            partners.find((entry) => entry.isActive)?.id ?? null,
          partners,
          books,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴总览读取失败：${reason}` };
    }
  }

  @Transactional
  async activate(
    characterId: number,
    partnerId: number,
  ): Promise<PartnerResult<{ activePartnerId: number; partner: PartnerDetailDto }>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, true);
      if (!character) return { success: false, message: '角色不存在' };

      const targetPartner = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!targetPartner) return { success: false, message: '伙伴不存在' };

      if (!targetPartner.is_active) {
        await setCharacterPartnerActivation({
          characterId,
          partnerId,
          execute: query,
        });
      }

      const rows = await loadPartnerRows(characterId, false);
      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const refreshedPartner = rows.find((row) => row.id === partnerId);
      if (!refreshedPartner) {
        return { success: false, message: '伙伴状态刷新失败' };
      }
      const partnerDef = getPartnerDefinitionById(refreshedPartner.partner_def_id);
      if (!partnerDef) {
        throw new Error(`伙伴模板不存在: ${refreshedPartner.partner_def_id}`);
      }
      const partner = buildPartnerDetailWithNextLevel({
        row: refreshedPartner,
        definition: partnerDef,
        techniqueRows: techniqueMap.get(partnerId) ?? [],
      });

      return {
        success: true,
        message: '出战伙伴已切换',
        data: {
          activePartnerId: partnerId,
          partner,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴切换失败：${reason}` };
    }
  }

  @Transactional
  async dismiss(
    characterId: number,
  ): Promise<PartnerResult<{ activePartnerId: null }>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, true);
      if (!character) return { success: false, message: '角色不存在' };

      await setCharacterPartnerActivation({
        characterId,
        partnerId: null,
        execute: query,
      });

      return {
        success: true,
        message: '出战伙伴已下阵',
        data: {
          activePartnerId: null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴下阵失败：${reason}` };
    }
  }

  @Transactional
  async injectExp(
    characterId: number,
    partnerId: number,
    exp: number,
  ): Promise<PartnerResult<PartnerInjectResultDto>> {
    try {
      const injectExpBudget = normalizeInteger(exp);
      if (injectExpBudget <= 0) {
        return { success: false, message: 'exp 参数无效，需为大于 0 的整数' };
      }

      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, true);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };

      const injectPlan = resolvePartnerInjectPlan({
        beforeLevel: partnerRow.level,
        beforeProgressExp: partnerRow.progress_exp,
        characterExp: character.exp,
        injectExpBudget,
        config: getPartnerGrowthConfig(),
      });
      if (injectPlan.spentExp <= 0) {
        return { success: false, message: '角色经验不足' };
      }

      await query(
        `
          UPDATE characters
          SET exp = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [characterId, injectPlan.remainingCharacterExp],
      );
      await query(
        `
          UPDATE character_partner
          SET level = $2,
              progress_exp = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [partnerId, injectPlan.afterLevel, injectPlan.afterProgressExp],
      );

      const refreshedPartner = await loadSinglePartnerRow(characterId, partnerId, false);
      if (!refreshedPartner) {
        return { success: false, message: '伙伴刷新失败' };
      }
      const partnerDef = getPartnerDefinitionById(refreshedPartner.partner_def_id);
      if (!partnerDef) {
        throw new Error(`伙伴模板不存在: ${refreshedPartner.partner_def_id}`);
      }
      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const partner = buildPartnerDetailWithNextLevel({
        row: refreshedPartner,
        definition: partnerDef,
        techniqueRows: techniqueMap.get(partnerId) ?? [],
      });

      await invalidateCharacterComputedCache(characterId);

      return {
        success: true,
        message: '伙伴灌注成功',
        data: {
          partner,
          spentExp: injectPlan.spentExp,
          characterExp: injectPlan.remainingCharacterExp,
          levelsGained: injectPlan.gainedLevels,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴灌注失败：${reason}` };
    }
  }

  async getTechniqueUpgradeCost(
    characterId: number,
    partnerId: number,
    techniqueId: string,
  ): Promise<PartnerResult<PartnerTechniqueUpgradeCostDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, false);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, false);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      const partnerDef = getPartnerDefinitionById(partnerRow.partner_def_id);
      if (!partnerDef) {
        throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
      }

      const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const techniqueRows = techniqueMap.get(partnerId) ?? [];
      const techniqueEntry = findEffectivePartnerTechniqueEntry(
        partnerDef,
        techniqueRows,
        techniqueId,
      );
      if (!techniqueEntry) return { success: false, message: '该伙伴未学习此功法' };

      const techniqueMeta = getPartnerTechniqueStaticMeta(
        techniqueEntry.techniqueId,
        techniqueEntry.currentLayer,
      );
      if (!techniqueMeta) {
        return { success: false, message: '伙伴功法不存在或未开放' };
      }

      const cost = await buildPartnerTechniqueUpgradeCost({
        techniqueId: techniqueEntry.techniqueId,
        techniqueMeta,
      });
      if (!cost) {
        return { success: false, message: '已达最高层数' };
      }

      return {
        success: true,
        message: '获取成功',
        data: cost,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴功法消耗读取失败：${reason}` };
    }
  }

  @Transactional
  async upgradeTechnique(
    characterId: number,
    partnerId: number,
    techniqueId: string,
  ): Promise<PartnerResult<PartnerUpgradeTechniqueResultDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(characterId, true);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(characterId, partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };
      const partnerDef = getPartnerDefinitionById(partnerRow.partner_def_id);
      if (!partnerDef) {
        throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
      }

      const persistedTechniqueMap = await loadPartnerTechniqueRows([partnerId], true);
      const techniqueRows = persistedTechniqueMap.get(partnerId) ?? [];
      const techniqueEntry = findEffectivePartnerTechniqueEntry(
        partnerDef,
        techniqueRows,
        techniqueId,
      );
      if (!techniqueEntry) return { success: false, message: '该伙伴未学习此功法' };

      const techniqueMeta = getPartnerTechniqueStaticMeta(
        techniqueEntry.techniqueId,
        techniqueEntry.currentLayer,
      );
      if (!techniqueMeta) {
        return { success: false, message: '伙伴功法不存在或未开放' };
      }

      const cost = await buildPartnerTechniqueUpgradeCost({
        techniqueId: techniqueEntry.techniqueId,
        techniqueMeta,
      });
      if (!cost) {
        return { success: false, message: '已达最高层数' };
      }

      if (character.spiritStones < cost.spiritStones) {
        return {
          success: false,
          message: `灵石不足，需要${cost.spiritStones}，当前${character.spiritStones}`,
        };
      }
      if (character.exp < cost.exp) {
        return {
          success: false,
          message: `经验不足，需要${cost.exp}，当前${character.exp}`,
        };
      }

      for (const material of cost.materials) {
        const materialResult = await query(
          `
            SELECT COALESCE(SUM(qty), 0) AS total
            FROM item_instance
            WHERE owner_character_id = $1
              AND item_def_id = $2
              AND location IN ('bag', 'warehouse')
          `,
          [characterId, material.itemId],
        );
        const totalQty = normalizeInteger(materialResult.rows[0]?.total);
        if (totalQty < material.qty) {
          return {
            success: false,
            message: `材料不足：${material.itemName ?? material.itemId}，需要${material.qty}，当前${totalQty}`,
          };
        }
      }

      await query(
        `
          UPDATE characters
          SET spirit_stones = spirit_stones - $2,
              exp = exp - $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [characterId, cost.spiritStones, cost.exp],
      );

      for (const material of cost.materials) {
        let remainingQty = material.qty;
        const itemsResult = await query(
          `
            SELECT id, qty
            FROM item_instance
            WHERE owner_character_id = $1
              AND item_def_id = $2
              AND location IN ('bag', 'warehouse')
            ORDER BY qty ASC
            FOR UPDATE
          `,
          [characterId, material.itemId],
        );

        for (const item of itemsResult.rows as Array<{ id: number; qty: number }>) {
          if (remainingQty <= 0) break;
          if (item.qty <= remainingQty) {
            await query('DELETE FROM item_instance WHERE id = $1', [item.id]);
            remainingQty -= item.qty;
            continue;
          }
          await query(
            'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
            [remainingQty, item.id],
          );
          remainingQty = 0;
        }
      }

      if (techniqueEntry.row) {
        await query(
          `
            UPDATE character_partner_technique
            SET current_layer = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [techniqueEntry.row.id, cost.nextLayer],
        );
      } else {
        await query(
          `
            INSERT INTO character_partner_technique (
              partner_id,
              technique_id,
              current_layer,
              is_innate,
              learned_from_item_def_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, TRUE, NULL, NOW(), NOW())
          `,
          [partnerId, techniqueEntry.techniqueId, cost.nextLayer],
        );
      }

      const refreshedTechniqueMap = await loadPartnerTechniqueRows([partnerId], false);
      const partner = buildPartnerDetailWithNextLevel({
        row: partnerRow,
        definition: partnerDef,
        techniqueRows: refreshedTechniqueMap.get(partnerId) ?? [],
      });
      const updatedTechnique =
        partner.techniques.find((entry) => entry.techniqueId === techniqueId) ?? null;
      if (!updatedTechnique) {
        return { success: false, message: '伙伴功法刷新失败' };
      }

      await invalidateCharacterComputedCache(characterId);

      return {
        success: true,
        message: `${updatedTechnique.name}修炼至第${cost.nextLayer}层`,
        data: {
          partner,
          updatedTechnique,
          newLayer: cost.nextLayer,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴功法升级失败：${reason}` };
    }
  }

  async learnTechniqueByItem(params: {
    characterId: number;
    partnerId: number;
    itemDefId: string;
    techniqueId: string;
  }): Promise<PartnerResult<PartnerLearnTechniqueResultDto>> {
    try {
      const unlockState = await assertPartnerSystemUnlocked(params.characterId);
      if (!unlockState.success) {
        return { success: false, message: unlockState.message };
      }

      const character = await loadCharacterPartnerContext(params.characterId, true);
      if (!character) return { success: false, message: '角色不存在' };

      const partnerRow = await loadSinglePartnerRow(params.characterId, params.partnerId, true);
      if (!partnerRow) return { success: false, message: '伙伴不存在' };

      const partnerDef = getPartnerDefinitionById(partnerRow.partner_def_id);
      if (!partnerDef) {
        throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
      }

      const techniqueMeta = getPartnerTechniqueStaticMeta(params.techniqueId, 1);
      if (!techniqueMeta) {
        return { success: false, message: '伙伴功法不存在或未开放' };
      }

      const techniqueMap = await loadPartnerTechniqueRows([params.partnerId], true);
      const currentTechniqueRows = techniqueMap.get(params.partnerId) ?? [];
      if (currentTechniqueRows.some((row) => row.technique_id === params.techniqueId)) {
        return { success: false, message: '该伙伴已学习此功法' };
      }

      const maxTechniqueSlots = normalizeInteger(partnerDef.max_technique_slots);
      const replaceableTechniqueIds = listReplaceablePartnerTechniqueIds(
        buildTechniqueStateList(partnerDef, currentTechniqueRows),
        maxTechniqueSlots,
      );

      let replacedTechniqueId: string | null = null;
      if (currentTechniqueRows.length < maxTechniqueSlots) {
        await query(
          `
            INSERT INTO character_partner_technique (
              partner_id,
              technique_id,
              current_layer,
              is_innate,
              learned_from_item_def_id,
              created_at,
              updated_at
            )
            VALUES ($1, $2, 1, FALSE, $3, NOW(), NOW())
          `,
          [params.partnerId, params.techniqueId, params.itemDefId],
        );
      } else {
        if (replaceableTechniqueIds.length <= 0) {
          return { success: false, message: '当前只有天生功法，无法继续打书' };
        }
        replacedTechniqueId =
          replaceableTechniqueIds[
            randomIntInclusive(0, replaceableTechniqueIds.length - 1)
          ] ?? null;
        if (!replacedTechniqueId) {
          return { success: false, message: '可覆盖功法选择失败' };
        }
        const replacedRow =
          currentTechniqueRows.find((row) => row.technique_id === replacedTechniqueId) ?? null;
        await query(
          `
            UPDATE character_partner_technique
            SET technique_id = $2,
                current_layer = 1,
                is_innate = FALSE,
                learned_from_item_def_id = $3,
                updated_at = NOW()
            WHERE partner_id = $1 AND technique_id = $4
          `,
          [params.partnerId, params.techniqueId, params.itemDefId, replacedTechniqueId],
        );
        const replacedTechniqueMeta = replacedRow
          ? getPartnerTechniqueStaticMeta(
              replacedRow.technique_id,
              replacedRow.current_layer,
            )
          : null;
        const replacedTechnique =
          replacedRow && replacedTechniqueMeta
            ? buildPartnerTechniqueDto({
                row: replacedRow,
                techniqueId: replacedRow.technique_id,
                currentLayer: normalizeInteger(replacedRow.current_layer, 1),
                isInnate: false,
                learnedFromItemDefId: replacedRow.learned_from_item_def_id ?? null,
              }, replacedTechniqueMeta)
            : null;

        const refreshedTechniqueMap = await loadPartnerTechniqueRows([params.partnerId], false);
        const partner = buildPartnerDetailWithNextLevel({
          row: partnerRow,
          definition: partnerDef,
          techniqueRows: refreshedTechniqueMap.get(params.partnerId) ?? [],
        });
        const learnedTechnique = partner.techniques.find(
          (entry) => entry.techniqueId === params.techniqueId,
        );
        if (!learnedTechnique) {
          return { success: false, message: '伙伴功法刷新失败' };
        }

        return {
          success: true,
          message: '伙伴打书成功，原功法已被覆盖',
          data: {
            partner,
            learnedTechnique,
            replacedTechnique,
            remainingBooks: await loadPartnerBooks(params.characterId),
          },
        };
      }

      const refreshedTechniqueMap = await loadPartnerTechniqueRows([params.partnerId], false);
      const partner = buildPartnerDetailWithNextLevel({
        row: partnerRow,
        definition: partnerDef,
        techniqueRows: refreshedTechniqueMap.get(params.partnerId) ?? [],
      });
      const learnedTechnique = partner.techniques.find(
        (entry) => entry.techniqueId === params.techniqueId,
      );
      if (!learnedTechnique) {
        return { success: false, message: '伙伴功法刷新失败' };
      }

      return {
        success: true,
        message: '伙伴学习功法成功',
        data: {
          partner,
          learnedTechnique,
          replacedTechnique: null,
          remainingBooks: await loadPartnerBooks(params.characterId),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `伙伴打书失败：${reason}` };
    }
  }

  async buildActivePartnerBattleMember(params: {
    characterId: number;
    userId: number;
  }): Promise<PartnerBattleMember | null> {
    const rows = await query(
      `
        SELECT *
        FROM character_partner
        WHERE character_id = $1 AND is_active = TRUE
        LIMIT 1
      `,
      [params.characterId],
    );
    if (rows.rows.length <= 0) return null;
    const partnerRow = rows.rows[0] as PartnerRow;
    const partnerDef = getPartnerDefinitionById(partnerRow.partner_def_id);
    if (!partnerDef) {
      throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
    }

    const techniqueMap = await loadPartnerTechniqueRows([partnerRow.id], false);
    const techniqueRows = techniqueMap.get(partnerRow.id) ?? [];
    const effectiveTechniqueEntries = buildEffectivePartnerTechniqueEntries(
      partnerDef,
      techniqueRows,
    );
    const techniqueEntries = effectiveTechniqueEntries.map((entry) => {
      const meta = getPartnerTechniqueStaticMeta(
        entry.techniqueId,
        entry.currentLayer,
      );
      if (!meta) {
        throw new Error(`伙伴功法不存在: ${entry.techniqueId}`);
      }
      return {
        entry,
        meta,
      };
    });
    const techniqueDtos = techniqueEntries.map((entry) =>
      buildPartnerTechniqueDto(entry.entry, entry.meta),
    );
    const passiveAttrs = mergePartnerTechniquePassives(
      techniqueEntries.map((entry) => entry.meta.passiveAttrs),
    );
      const finalAttrs = buildPartnerBattleAttrs({
        baseAttrs: partnerDef.base_attrs,
        level: partnerRow.level,
        levelAttrGains: partnerDef.level_attr_gains,
        passiveAttrs,
        element: normalizeText(partnerDef.attribute_element) || 'none',
    });

    const skillDefinitionMap = new Map(
      getSkillDefinitions()
        .filter((entry) => entry.enabled !== false)
        .map((entry) => [entry.id, entry] as const),
    );
    const skillIds = [
      ...new Set(
        techniqueDtos.flatMap((entry) => entry.skillIds).filter((entry) => entry.length > 0),
      ),
    ];
    const skills = skillIds
      .map((skillId) => skillDefinitionMap.get(skillId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => toBattleSkillData(entry));

    const attributeElement = normalizeText(partnerDef.attribute_element) || 'none';
    const data: CharacterData = {
      user_id: params.userId,
      id: partnerRow.id,
      nickname: normalizeText(partnerRow.nickname) || normalizeText(partnerDef.name),
      realm: '',
      sub_realm: null,
      attribute_element: attributeElement,
      qixue: normalizeInteger(finalAttrs.max_qixue, 1),
      max_qixue: normalizeInteger(finalAttrs.max_qixue, 1),
      lingqi: normalizeInteger(finalAttrs.max_lingqi),
      max_lingqi: normalizeInteger(finalAttrs.max_lingqi),
      wugong: Number(finalAttrs.wugong) || 0,
      fagong: Number(finalAttrs.fagong) || 0,
      wufang: Number(finalAttrs.wufang) || 0,
      fafang: Number(finalAttrs.fafang) || 0,
      sudu: Math.max(1, Number(finalAttrs.sudu) || 1),
      mingzhong: Number(finalAttrs.mingzhong) || 0,
      shanbi: Number(finalAttrs.shanbi) || 0,
      zhaojia: Number(finalAttrs.zhaojia) || 0,
      baoji: Number(finalAttrs.baoji) || 0,
      baoshang: Number(finalAttrs.baoshang) || 0,
      jianbaoshang: Number(finalAttrs.jianbaoshang) || 0,
      kangbao: Number(finalAttrs.kangbao) || 0,
      zengshang: Number(finalAttrs.zengshang) || 0,
      zhiliao: Number(finalAttrs.zhiliao) || 0,
      jianliao: Number(finalAttrs.jianliao) || 0,
      xixue: Number(finalAttrs.xixue) || 0,
      lengque: Number(finalAttrs.lengque) || 0,
      kongzhi_kangxing: Number(finalAttrs.kongzhi_kangxing) || 0,
      jin_kangxing: Number(finalAttrs.jin_kangxing) || 0,
      mu_kangxing: Number(finalAttrs.mu_kangxing) || 0,
      shui_kangxing: Number(finalAttrs.shui_kangxing) || 0,
      huo_kangxing: Number(finalAttrs.huo_kangxing) || 0,
      tu_kangxing: Number(finalAttrs.tu_kangxing) || 0,
      qixue_huifu: Number(finalAttrs.qixue_huifu) || 0,
      lingqi_huifu: Number(finalAttrs.lingqi_huifu) || 0,
      setBonusEffects: [],
    };

    return { data, skills };
  }

  async grantStarterPartner(params: {
    characterId: number;
    obtainedFrom: string;
    obtainedRefId?: string;
  }): Promise<PartnerRewardDto> {
    const definition =
      getPartnerDefinitionById(STARTER_PARTNER_DEF_ID) ??
      getPartnerDefinitions().find((entry) => entry.enabled !== false) ??
      null;
    if (!definition) {
      throw new Error('未找到可发放的初始伙伴模板');
    }
    const created = await createPartnerInstanceFromDefinition({
      characterId: params.characterId,
      definition,
      obtainedFrom: params.obtainedFrom,
      obtainedRefId: params.obtainedRefId,
    });
    return created.reward;
  }

  async createPartnerInstanceFromDefinition(params: {
    characterId: number;
    definition: PartnerDefConfig;
    obtainedFrom: string;
    obtainedRefId?: string;
    nickname?: string;
  }): Promise<CreatePartnerInstanceResult> {
    return createPartnerInstanceFromDefinition(params);
  }
}

export const partnerService = new PartnerService();
export default partnerService;
