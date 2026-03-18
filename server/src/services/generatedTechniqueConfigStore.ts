/**
 * AI 生成功法配置缓存
 *
 * 作用：
 * 1) 从数据库加载“已发布”的生成功法/技能/层级；
 * 2) 在内存中提供同步只读快照，供静态配置读取链路合并；
 * 3) 允许服务在发布后主动刷新缓存，避免重启可见性延迟。
 */
import { query } from '../config/database.js';
import { resolveSkillTriggerType } from '../shared/skillTriggerType.js';
import { normalizeTechniqueUsageScope, type TechniqueUsageScope } from './shared/techniqueUsageScope.js';

export type GeneratedTechniqueDefLite = {
  id: string;
  code?: string;
  name: string;
  type: string;
  quality: string;
  max_layer?: number;
  required_realm?: string;
  attribute_type?: string;
  attribute_element?: string;
  tags?: string[];
  description?: string | null;
  long_desc?: string | null;
  icon?: string | null;
  obtain_type?: string | null;
  obtain_hint?: string[];
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
  usage_scope?: TechniqueUsageScope;
};

export type GeneratedSkillDefLite = {
  id: string;
  code?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  source_type: string;
  source_id?: string | null;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
  trigger_type?: string;
  conditions?: unknown;
  ai_priority?: number;
  ai_conditions?: unknown;
  upgrades?: unknown;
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
};

export type GeneratedTechniqueLayerLite = {
  technique_id: string;
  layer: number;
  cost_spirit_stones?: number;
  cost_exp?: number;
  cost_materials?: Array<{ itemId: string; qty: number }>;
  passives?: Array<{ key: string; value: number }>;
  unlock_skill_ids?: string[];
  upgrade_skill_ids?: string[];
  required_realm?: string | null;
  required_quest_id?: string | null;
  layer_desc?: string | null;
  enabled?: boolean;
};

let generatedTechniqueDefsCache: GeneratedTechniqueDefLite[] = [];
let generatedSkillDefsCache: GeneratedSkillDefLite[] = [];
let generatedTechniqueLayerCache: GeneratedTechniqueLayerLite[] = [];
let generatedTechniqueByIdCache = new Map<string, GeneratedTechniqueDefLite>();

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

const asNumber = (raw: unknown, fallback = 0): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const asJsonArray = <T>(raw: unknown): T[] => {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const isUndefinedTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '42P01';
};

/**
 * 刷新 AI 生成功法缓存。
 *
 * 边界：
 * 1) 若表尚未初始化（42P01），返回空缓存，不抛错。
 * 2) 仅读取已发布且 enabled 的内容，草稿不会进入全局读取链路。
 */
export const reloadGeneratedTechniqueConfigStore = async (): Promise<void> => {
  try {
    const [defRes, skillRes, layerRes] = await Promise.all([
      query(
        `
          SELECT
            id,
            name,
            display_name,
            type,
            quality,
            max_layer,
            required_realm,
            attribute_type,
            attribute_element,
            usage_scope,
            tags,
            description,
            long_desc,
            icon,
            enabled,
            version,
            created_at
          FROM generated_technique_def
          WHERE is_published = true AND enabled = true
          ORDER BY created_at DESC
        `,
      ),
      query(
        `
          SELECT
            s.id,
            s.code,
            s.name,
            s.description,
            s.icon,
            s.source_type,
            s.source_id,
            s.cost_lingqi,
            s.cost_lingqi_rate,
            s.cost_qixue,
            s.cost_qixue_rate,
            s.cooldown,
            s.target_type,
            s.target_count,
            s.damage_type,
            s.element,
            s.effects,
            s.trigger_type,
            s.conditions,
            s.ai_priority,
            s.ai_conditions,
            s.upgrades,
            s.sort_weight,
            s.version,
            s.enabled
          FROM generated_skill_def s
          JOIN generated_technique_def d ON d.id = s.source_id
          WHERE d.is_published = true AND d.enabled = true AND s.enabled = true
          ORDER BY s.sort_weight DESC, s.id ASC
        `,
      ),
      query(
        `
          SELECT
            l.technique_id,
            l.layer,
            l.cost_spirit_stones,
            l.cost_exp,
            l.cost_materials,
            l.passives,
            l.unlock_skill_ids,
            l.upgrade_skill_ids,
            l.required_realm,
            l.required_quest_id,
            l.layer_desc,
            l.enabled
          FROM generated_technique_layer l
          JOIN generated_technique_def d ON d.id = l.technique_id
          WHERE d.is_published = true AND d.enabled = true AND l.enabled = true
          ORDER BY l.technique_id ASC, l.layer ASC
        `,
      ),
    ]);

    generatedTechniqueDefsCache = (defRes.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const id = asString(row.id);
      if (!id) return [];
      const displayName = asString(row.display_name);
      const baseName = asString(row.name);
      const def: GeneratedTechniqueDefLite = {
        id,
        name: displayName || baseName || id,
        type: asString(row.type) || '武技',
        quality: asString(row.quality) || '黄',
        max_layer: Math.max(1, Math.floor(asNumber(row.max_layer, 1))),
        required_realm: asString(row.required_realm) || '凡人',
        attribute_type: asString(row.attribute_type) || 'physical',
        attribute_element: asString(row.attribute_element) || 'none',
        usage_scope: normalizeTechniqueUsageScope(row.usage_scope),
        tags: asJsonArray<string>(row.tags).map((x) => asString(x)).filter(Boolean),
        description: typeof row.description === 'string' ? row.description : null,
        long_desc: typeof row.long_desc === 'string' ? row.long_desc : null,
        icon: typeof row.icon === 'string' ? row.icon : null,
        obtain_type: 'ai_generate',
        obtain_hint: ['AI研修生成'],
        sort_weight: 100,
        version: Math.max(1, Math.floor(asNumber(row.version, 1))),
        enabled: row.enabled !== false,
      };
      return [def];
    });

    generatedSkillDefsCache = (skillRes.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const id = asString(row.id);
      if (!id) return [];
      const effects = asJsonArray<{ type?: string; buffKind?: string }>(row.effects);
      const skill: GeneratedSkillDefLite = {
        id,
        code: asString(row.code) || undefined,
        name: asString(row.name) || id,
        description: typeof row.description === 'string' ? row.description : null,
        icon: typeof row.icon === 'string' ? row.icon : null,
        source_type: asString(row.source_type) || 'technique',
        source_id: asString(row.source_id) || null,
        cost_lingqi: Math.max(0, Math.floor(asNumber(row.cost_lingqi, 0))),
        cost_lingqi_rate: Math.max(0, asNumber(row.cost_lingqi_rate, 0)),
        cost_qixue: Math.max(0, Math.floor(asNumber(row.cost_qixue, 0))),
        cost_qixue_rate: Math.max(0, asNumber(row.cost_qixue_rate, 0)),
        cooldown: Math.max(0, Math.floor(asNumber(row.cooldown, 0))),
        target_type: asString(row.target_type) || 'single_enemy',
        target_count: Math.max(1, Math.floor(asNumber(row.target_count, 1))),
        damage_type: asString(row.damage_type) || null,
        element: asString(row.element) || 'none',
        effects,
        trigger_type: resolveSkillTriggerType({
          triggerType: asString(row.trigger_type) || undefined,
          effects,
        }),
        conditions: row.conditions ?? null,
        ai_priority: Math.max(0, Math.floor(asNumber(row.ai_priority, 50))),
        ai_conditions: row.ai_conditions ?? null,
        upgrades: row.upgrades ?? [],
        sort_weight: Math.floor(asNumber(row.sort_weight, 0)),
        version: Math.max(1, Math.floor(asNumber(row.version, 1))),
        enabled: row.enabled !== false,
      };
      return [skill];
    });

    generatedTechniqueLayerCache = (layerRes.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const techniqueId = asString(row.technique_id);
      const layer = Math.max(1, Math.floor(asNumber(row.layer, 1)));
      if (!techniqueId) return [];
      const unlockSkillIds = Array.isArray(row.unlock_skill_ids)
        ? asStringArray(row.unlock_skill_ids)
        : asStringArray(asJsonArray<string>(row.unlock_skill_ids));
      const upgradeSkillIds = Array.isArray(row.upgrade_skill_ids)
        ? asStringArray(row.upgrade_skill_ids)
        : asStringArray(asJsonArray<string>(row.upgrade_skill_ids));

      const layerDef: GeneratedTechniqueLayerLite = {
        technique_id: techniqueId,
        layer,
        cost_spirit_stones: Math.max(0, Math.floor(asNumber(row.cost_spirit_stones, 0))),
        cost_exp: Math.max(0, Math.floor(asNumber(row.cost_exp, 0))),
        cost_materials: asJsonArray<{ itemId: string; qty: number }>(row.cost_materials)
          .map((entry) => ({
            itemId: asString((entry as { itemId?: unknown }).itemId),
            qty: Math.max(0, Math.floor(asNumber((entry as { qty?: unknown }).qty, 0))),
          }))
          .filter((entry) => entry.itemId.length > 0 && entry.qty > 0),
        passives: asJsonArray<{ key: string; value: number }>(row.passives)
          .map((entry) => ({
            key: asString((entry as { key?: unknown }).key),
            value: asNumber((entry as { value?: unknown }).value, 0),
          }))
          .filter((entry) => entry.key.length > 0 && Number.isFinite(entry.value)),
        unlock_skill_ids: unlockSkillIds,
        upgrade_skill_ids: upgradeSkillIds,
        required_realm: asString(row.required_realm) || null,
        required_quest_id: asString(row.required_quest_id) || null,
        layer_desc: typeof row.layer_desc === 'string' ? row.layer_desc : null,
        enabled: row.enabled !== false,
      };
      return [layerDef];
    });

    generatedTechniqueByIdCache = new Map(generatedTechniqueDefsCache.map((row) => [row.id, row] as const));
  } catch (error) {
    if (isUndefinedTableError(error)) {
      generatedTechniqueDefsCache = [];
      generatedSkillDefsCache = [];
      generatedTechniqueLayerCache = [];
      generatedTechniqueByIdCache = new Map();
      return;
    }
    throw error;
  }
};

export const getGeneratedTechniqueDefinitions = (): GeneratedTechniqueDefLite[] => {
  return generatedTechniqueDefsCache;
};

export const getGeneratedSkillDefinitions = (): GeneratedSkillDefLite[] => {
  return generatedSkillDefsCache;
};

export const getGeneratedTechniqueLayerDefinitions = (): GeneratedTechniqueLayerLite[] => {
  return generatedTechniqueLayerCache;
};

export const getGeneratedTechniqueDefinitionById = (techniqueId: string): GeneratedTechniqueDefLite | null => {
  const id = asString(techniqueId);
  if (!id) return null;
  return generatedTechniqueByIdCache.get(id) ?? null;
};
