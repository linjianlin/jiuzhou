/**
 * 伙伴展示共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴行数据、伙伴功法行数据与“伙伴实例 -> 展示 DTO”的组装逻辑，供伙伴总览、伙伴坊市与战斗构建复用。
 * 2. 做什么：统一维护伙伴属性、功法、成长值的读取口径，避免不同服务各自拼接 DTO 导致字段漂移。
 * 3. 不做什么：不处理 HTTP 参数，不处理坊市成交、不决定伙伴是否允许上架或培养。
 *
 * 输入/输出：
 * - 输入：`character_partner` / `character_partner_technique` 行、伙伴模板、功法静态配置。
 * - 输出：伙伴展示 DTO、功法 DTO，以及可复用的伙伴行查询函数。
 *
 * 数据流/状态流：
 * - service 查询伙伴与功法行 -> 本模块统一组装 -> 伙伴总览 / 伙伴坊市 / 战斗服务消费。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴属性只允许由模板、等级、成长值和已学功法被动共同决定，禁止在不同消费方各自追加隐藏加成。
 * 2. 天生功法和后天功法必须走同一套有效功法合并规则，否则伙伴总览与坊市展示会出现技能层级不一致。
 */
import { query } from '../../config/database.js';
import type { SkillData } from '../../battle/battleFactory.js';
import type { SkillTriggerType } from '../../shared/skillTriggerType.js';
import { resolveSkillTriggerType } from '../../shared/skillTriggerType.js';
import {
  getPartnerDefinitionById,
  getPartnerDefinitionsByIds,
  getPartnerGrowthConfig,
  getSkillDefinitions,
  getTechniqueDefinitions,
  type PartnerDefConfig,
  type TechniqueDefConfig,
} from '../staticConfigLoader.js';
import {
  buildEffectiveTechniqueSkillData,
  cloneSkillEffectList,
} from './techniqueSkillProgression.js';
import {
  buildTechniqueUnlockedSkillIdSet,
  buildTechniqueSkillUpgradeCountMap,
  getTechniqueLayersByTechniqueIdStatic,
} from './techniqueUpgradeRules.js';
import {
  buildPartnerBattleAttrs,
  calcPartnerUpgradeExpByTargetLevel,
  mergePartnerTechniquePassives,
  type PartnerGrowthValues,
} from './partnerRules.js';
import type { PartnerFusionLockState, PartnerFusionLockStatus } from './partnerFusionState.js';
import {
  resolvePartnerLevelLimit,
  type PartnerOwnerRealmContext,
} from './partnerLevelLimit.js';

export type PartnerTradeStatus = 'none' | 'market_listed';

export type PartnerRow = {
  id: number;
  character_id: number;
  partner_def_id: string;
  nickname: string;
  description: string | null;
  avatar: string | null;
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

export type PartnerTechniqueRow = {
  id: number;
  partner_id: number;
  technique_id: string;
  current_layer: number;
  is_innate: boolean;
  learned_from_item_def_id: string | null;
  created_at: Date;
  updated_at: Date;
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
  jianfantan: number;
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

export type PartnerBaseAttrsDto = Omit<PartnerComputedAttrsDto, 'qixue' | 'lingqi'>;

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
  effects?: object[];
  trigger_type?: SkillTriggerType;
  ai_priority?: number;
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

export interface PartnerEffectiveSkillEntry {
  skillId: string;
  skillName: string;
  skillIcon: string;
  skillDescription?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: object[];
  trigger_type?: SkillTriggerType;
  ai_priority?: number;
  sourceTechniqueId: string;
  sourceTechniqueName: string;
  sourceTechniqueQuality: string;
}

export interface PartnerDisplayDto {
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
  currentEffectiveLevel: number;
  progressExp: number;
  nextLevelCostExp: number;
  slotCount: number;
  isActive: boolean;
  obtainedFrom: string | null;
  growth: PartnerGrowthDto;
  levelAttrGains: PartnerBaseAttrsDto;
  computedAttrs: PartnerComputedAttrsDto;
  techniques: PartnerTechniqueDto[];
}

export interface PartnerDetailDto extends PartnerDisplayDto {
  tradeStatus: PartnerTradeStatus;
  marketListingId: number | null;
  fusionStatus: PartnerFusionLockStatus;
  fusionJobId: string | null;
}

export type PartnerTechniqueStaticMeta = {
  definition: TechniqueDefConfig;
  currentLayer: number;
  maxLayer: number;
  skillIds: string[];
  passiveAttrs: Array<{ key: string; value: number }>;
};

export type EffectivePartnerTechniqueEntry = {
  row: PartnerTechniqueRow | null;
  techniqueId: string;
  currentLayer: number;
  isInnate: boolean;
  learnedFromItemDefId: string | null;
};

export const normalizeInteger = (value: number | string | bigint | null | undefined, minimum: number = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.floor(parsed));
};

export const normalizeText = (value: string | null | undefined): string => {
  return typeof value === 'string' ? value.trim() : '';
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

export const loadPartnerRows = async (
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

export const loadSinglePartnerRow = async (
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

export const loadSinglePartnerRowById = async (
  partnerId: number,
  forUpdate: boolean,
): Promise<PartnerRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [partnerId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as PartnerRow;
};

const loadPartnerOwnerRealmContext = async (
  characterId: number,
): Promise<PartnerOwnerRealmContext | null> => {
  const result = await query(
    `
      SELECT realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  const row = result.rows[0] as { realm: string | null; sub_realm: string | null };
  return {
    realm: normalizeText(row.realm) || '凡人',
    subRealm: normalizeText(row.sub_realm) || null,
  };
};

export const loadPartnerDisplayById = async (
  partnerId: number,
): Promise<PartnerDisplayDto | null> => {
  const normalizedPartnerId = normalizeInteger(partnerId);
  if (normalizedPartnerId <= 0) return null;

  const partnerRow = await loadSinglePartnerRowById(normalizedPartnerId, false);
  if (!partnerRow) return null;

  const ownerRealm = await loadPartnerOwnerRealmContext(partnerRow.character_id);
  if (!ownerRealm) return null;

  const definition = await getPartnerDefinitionById(partnerRow.partner_def_id);
  if (!definition) return null;

  const techniqueMap = await loadPartnerTechniqueRows([normalizedPartnerId], false);
  return buildPartnerDisplay({
    row: partnerRow,
    definition,
    techniqueRows: techniqueMap.get(normalizedPartnerId) ?? [],
    ownerRealm,
  });
};

export const loadPartnerTechniqueRows = async (
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

export const getPartnerTechniqueStaticMeta = (
  techniqueId: string,
  currentLayerRaw: number | string | bigint | null | undefined,
): PartnerTechniqueStaticMeta | null => {
  const normalizedTechniqueId = normalizeText(techniqueId);
  if (!normalizedTechniqueId) return null;

  const definition =
    getTechniqueDefinitions().find(
      (entry) => entry.id === normalizedTechniqueId && entry.enabled !== false,
    ) ?? null;
  if (!definition) return null;

  return buildPartnerTechniqueStaticMeta(definition, normalizedTechniqueId, currentLayerRaw);
};

const buildPartnerTechniqueStaticMeta = (
  definition: TechniqueDefConfig,
  techniqueId: string,
  currentLayerRaw: number | string | bigint | null | undefined,
): PartnerTechniqueStaticMeta | null => {
  const layerRows = getTechniqueLayersByTechniqueIdStatic(techniqueId);
  const maxLayer = Math.max(
    normalizeInteger(definition.max_layer, 1),
    layerRows[layerRows.length - 1]?.layer ?? 1,
  );
  const currentLayer = Math.min(
    Math.max(1, normalizeInteger(currentLayerRaw, 1)),
    maxLayer,
  );
  const activeLayerRows = layerRows.filter((entry) => entry.layer <= currentLayer);
  const skillIds = Array.from(buildTechniqueUnlockedSkillIdSet(activeLayerRows, currentLayer));
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

const getEnabledSkillDefinitionMap = () => {
  return new Map(
    getSkillDefinitions()
      .filter((skillDef) => skillDef.enabled !== false)
      .map((skillDef) => [skillDef.id, skillDef] as const),
  );
};

const buildPartnerTechniqueSkills = (
  meta: PartnerTechniqueStaticMeta,
): PartnerTechniqueSkillDto[] => {
  const skillDefinitionMap = getEnabledSkillDefinitionMap();
  const upgradeCountBySkillId = buildTechniqueSkillUpgradeCountMap(
    getTechniqueLayersByTechniqueIdStatic(meta.definition.id),
    meta.currentLayer,
  );
  return meta.skillIds
    .map((skillId) => skillDefinitionMap.get(skillId))
    .filter((skillDef): skillDef is NonNullable<typeof skillDef> => Boolean(skillDef))
    .map((skillDef) => {
      const effectiveSkill = buildEffectiveTechniqueSkillData(
        skillDef,
        upgradeCountBySkillId.get(skillDef.id) ?? 0,
      );
      const triggerType = resolveSkillTriggerType({
        triggerType: skillDef.trigger_type,
        effects: effectiveSkill.effects,
      });

      return {
        id: skillDef.id,
        name: normalizeText(skillDef.name) || skillDef.id,
        icon: normalizeText(skillDef.icon) || '',
        description: normalizeText(skillDef.description) || undefined,
        cost_lingqi: effectiveSkill.cost_lingqi,
        cost_lingqi_rate: effectiveSkill.cost_lingqi_rate,
        cost_qixue: effectiveSkill.cost_qixue,
        cost_qixue_rate: effectiveSkill.cost_qixue_rate,
        cooldown: effectiveSkill.cooldown,
        target_type: normalizeText(skillDef.target_type) || undefined,
        target_count: effectiveSkill.target_count,
        damage_type: normalizeText(skillDef.damage_type) || null,
        element: normalizeText(skillDef.element) || undefined,
        effects: effectiveSkill.effects,
        trigger_type: triggerType,
        ai_priority: effectiveSkill.ai_priority,
      };
    });
};

/**
 * 伙伴有效技能条目转战斗 SkillData。
 *
 * 作用：
 * 1. 统一把伙伴当前已解锁且已应用层数强化的技能条目转成战斗输入。
 * 2. 让普通战斗与挂机快照复用同一份升级后技能数据，避免再次回查静态技能表时退回初始层效果。
 * 3. 不负责筛选技能可用性与排序，调用方应先传入已完成归一化的有效技能列表。
 *
 * 边界条件：
 * 1. `effects` 必须在这里重新克隆一份，避免同一个伙伴技能实例被多个战斗态共享数组引用。
 * 2. 缺省字段只补战斗引擎要求的最小默认值，不在这里额外做兼容分支。
 */
export const toPartnerBattleSkillData = (
  skill: PartnerEffectiveSkillEntry,
): SkillData => {
  return {
    id: skill.skillId,
    name: skill.skillName,
    cost_lingqi: Number(skill.cost_lingqi) || 0,
    cost_lingqi_rate: Number(skill.cost_lingqi_rate) || 0,
    cost_qixue: Number(skill.cost_qixue) || 0,
    cost_qixue_rate: Number(skill.cost_qixue_rate) || 0,
    cooldown: Math.max(0, normalizeInteger(skill.cooldown)),
    target_type: normalizeText(skill.target_type) || 'single_enemy',
    target_count: Math.max(1, normalizeInteger(skill.target_count, 1)),
    damage_type: normalizeText(skill.damage_type) || 'none',
    element: normalizeText(skill.element) || 'none',
    effects: cloneSkillEffectList(skill.effects),
    trigger_type: skill.trigger_type ?? 'active',
    ai_priority: Math.max(0, normalizeInteger(skill.ai_priority)),
  };
};

export const buildPartnerBattleSkillData = (
  skills: PartnerEffectiveSkillEntry[],
): SkillData[] => {
  return skills.map((skill) => toPartnerBattleSkillData(skill));
};

export const toPartnerComputedAttrsDto = (
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
    jianfantan: Number(finalAttrs.jianfantan) || 0,
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

export const toPartnerBaseAttrsDto = (
  rawAttrs: Record<string, unknown> | null | undefined,
): PartnerBaseAttrsDto => {
  return {
    max_qixue: Number(rawAttrs?.max_qixue) || 0,
    max_lingqi: Number(rawAttrs?.max_lingqi) || 0,
    wugong: Number(rawAttrs?.wugong) || 0,
    fagong: Number(rawAttrs?.fagong) || 0,
    wufang: Number(rawAttrs?.wufang) || 0,
    fafang: Number(rawAttrs?.fafang) || 0,
    mingzhong: Number(rawAttrs?.mingzhong) || 0,
    shanbi: Number(rawAttrs?.shanbi) || 0,
    zhaojia: Number(rawAttrs?.zhaojia) || 0,
    baoji: Number(rawAttrs?.baoji) || 0,
    baoshang: Number(rawAttrs?.baoshang) || 0,
    jianbaoshang: Number(rawAttrs?.jianbaoshang) || 0,
    jianfantan: Number(rawAttrs?.jianfantan) || 0,
    kangbao: Number(rawAttrs?.kangbao) || 0,
    zengshang: Number(rawAttrs?.zengshang) || 0,
    zhiliao: Number(rawAttrs?.zhiliao) || 0,
    jianliao: Number(rawAttrs?.jianliao) || 0,
    xixue: Number(rawAttrs?.xixue) || 0,
    lengque: Number(rawAttrs?.lengque) || 0,
    sudu: Number(rawAttrs?.sudu) || 0,
    kongzhi_kangxing: Number(rawAttrs?.kongzhi_kangxing) || 0,
    jin_kangxing: Number(rawAttrs?.jin_kangxing) || 0,
    mu_kangxing: Number(rawAttrs?.mu_kangxing) || 0,
    shui_kangxing: Number(rawAttrs?.shui_kangxing) || 0,
    huo_kangxing: Number(rawAttrs?.huo_kangxing) || 0,
    tu_kangxing: Number(rawAttrs?.tu_kangxing) || 0,
    qixue_huifu: Number(rawAttrs?.qixue_huifu) || 0,
    lingqi_huifu: Number(rawAttrs?.lingqi_huifu) || 0,
  };
};

export const buildPartnerTechniqueDto = (
  entry: EffectivePartnerTechniqueEntry,
  meta: PartnerTechniqueStaticMeta,
): PartnerTechniqueDto => {
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
    skills: buildPartnerTechniqueSkills(meta),
    passiveAttrs: toPartnerPassiveAttrsDto(meta.passiveAttrs),
  };
};

export const getPartnerInnateTechniqueIds = (definition: PartnerDefConfig): string[] => {
  const ids = Array.isArray(definition.innate_technique_ids)
    ? definition.innate_technique_ids
        .map((entry) => normalizeText(entry))
        .filter((entry) => entry.length > 0)
    : [];
  return [...new Set(ids)];
};

export const buildEffectivePartnerTechniqueEntries = (
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

export const findEffectivePartnerTechniqueEntry = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
  techniqueIdRaw: string,
): EffectivePartnerTechniqueEntry | null => {
  const techniqueId = normalizeText(techniqueIdRaw);
  if (!techniqueId) return null;
  return buildEffectivePartnerTechniqueEntries(definition, techniqueRows)
    .find((entry) => entry.techniqueId === techniqueId) ?? null;
};

export const buildPartnerEffectiveSkillEntries = (
  definition: PartnerDefConfig,
  techniqueRows: PartnerTechniqueRow[],
): PartnerEffectiveSkillEntry[] => {
  const effectiveTechniqueEntries = buildEffectivePartnerTechniqueEntries(
    definition,
    techniqueRows,
  );
  const skills: PartnerEffectiveSkillEntry[] = [];
  const seenSkillIds = new Set<string>();

  for (const entry of effectiveTechniqueEntries) {
    const meta = getPartnerTechniqueStaticMeta(
      entry.techniqueId,
      entry.currentLayer,
    );
    if (!meta) {
      throw new Error(`伙伴功法不存在: ${entry.techniqueId}`);
    }
    const sourceTechniqueId = entry.techniqueId;
    const sourceTechniqueName = normalizeText(meta.definition.name) || meta.definition.id;
    const sourceTechniqueQuality = normalizeText(meta.definition.quality) || '黄';

    for (const skill of buildPartnerTechniqueSkills(meta)) {
      if (seenSkillIds.has(skill.id)) continue;
      seenSkillIds.add(skill.id);
      skills.push({
        skillId: skill.id,
        skillName: skill.name,
        skillIcon: skill.icon,
        skillDescription: skill.description,
        cost_lingqi: skill.cost_lingqi,
        cost_lingqi_rate: skill.cost_lingqi_rate,
        cost_qixue: skill.cost_qixue,
        cost_qixue_rate: skill.cost_qixue_rate,
        cooldown: skill.cooldown,
        target_type: skill.target_type,
        target_count: skill.target_count,
        damage_type: skill.damage_type,
        element: skill.element,
        effects: skill.effects,
        trigger_type: skill.trigger_type,
        ai_priority: skill.ai_priority,
        sourceTechniqueId,
        sourceTechniqueName,
        sourceTechniqueQuality,
      });
    }
  }

  return skills;
};

export const buildPartnerDisplay = (params: {
  row: PartnerRow;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
  ownerRealm: PartnerOwnerRealmContext;
}): PartnerDisplayDto => {
  const { row, definition, techniqueRows, ownerRealm } = params;
  const config = getPartnerGrowthConfig();
  const growth = toPartnerGrowth(row);
  const levelLimit = resolvePartnerLevelLimit({
    ownerRealm,
    partnerLevel: row.level,
  });
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
    level: levelLimit.effectiveLevel,
    levelAttrGains: definition.level_attr_gains,
    passiveAttrs,
    element,
  });

  return {
    id: row.id,
    partnerDefId: definition.id,
    nickname: normalizeText(row.nickname) || normalizeText(definition.name),
    name: normalizeText(definition.name) || definition.id,
    description: normalizeText(row.description) || normalizeText(definition.description),
    avatar: normalizeText(row.avatar) || normalizeText(definition.avatar) || null,
    element,
    role: normalizeText(definition.role) || '伙伴',
    quality: normalizeText(definition.quality) || '黄',
    level: normalizeInteger(row.level, 1),
    currentEffectiveLevel: levelLimit.effectiveLevel,
    progressExp: normalizeInteger(row.progress_exp),
    nextLevelCostExp: calcPartnerUpgradeExpByTargetLevel(
      normalizeInteger(row.level, 1) + 1,
      config,
    ),
    slotCount: Math.max(0, normalizeInteger(definition.max_technique_slots)),
    isActive: Boolean(row.is_active),
    obtainedFrom: normalizeText(row.obtained_from) || null,
    growth: toPartnerGrowthDto(growth),
    levelAttrGains: toPartnerBaseAttrsDto(definition.level_attr_gains),
    computedAttrs: toPartnerComputedAttrsDto(finalAttrs),
    techniques,
  };
};

export const attachPartnerTradeState = (
  partner: PartnerDisplayDto,
  runtimeState?: {
    tradeState?: { tradeStatus: PartnerTradeStatus; marketListingId: number | null };
    fusionState?: PartnerFusionLockState;
  },
): PartnerDetailDto => {
  return {
    ...partner,
    tradeStatus: runtimeState?.tradeState?.tradeStatus ?? 'none',
    marketListingId: runtimeState?.tradeState?.marketListingId ?? null,
    fusionStatus: runtimeState?.fusionState?.fusionStatus ?? 'none',
    fusionJobId: runtimeState?.fusionState?.fusionJobId ?? null,
  };
};

export const buildPartnerDetails = async (params: {
  rows: PartnerRow[];
  techniqueMap: Map<number, PartnerTechniqueRow[]>;
  ownerRealmMap: Map<number, PartnerOwnerRealmContext>;
  tradeStateMap?: Map<number, { tradeStatus: PartnerTradeStatus; marketListingId: number | null }>;
  fusionStateMap?: Map<number, PartnerFusionLockState>;
}): Promise<PartnerDetailDto[]> => {
  const definitionMap = await getPartnerDefinitionsByIds(
    params.rows.map((row) => row.partner_def_id),
  );
  return Promise.all(params.rows.map(async (row) => {
    const definition = definitionMap.get(row.partner_def_id) ?? null;
    if (!definition) {
      throw new Error(`伙伴模板不存在: ${row.partner_def_id}`);
    }
    const ownerRealm = params.ownerRealmMap.get(row.character_id);
    if (!ownerRealm) {
      throw new Error(`伙伴所属角色境界缺失: ${row.character_id}`);
    }
    const techniqueRows = params.techniqueMap.get(row.id) ?? [];
    const partner = buildPartnerDisplay({
      row,
      definition,
      techniqueRows,
      ownerRealm,
    });
    return attachPartnerTradeState(
      partner,
      {
        tradeState: params.tradeStateMap?.get(row.id),
        fusionState: params.fusionStateMap?.get(row.id),
      },
    );
  }));
};
