/**
 * AI 生成伙伴配置缓存
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：从数据库加载已启用的动态伙伴定义，并在内存中提供同步只读快照。
 * 2) 做什么：让 `staticConfigLoader` 能把静态伙伴与 AI 伙伴合并成统一读取入口，避免伙伴系统分叉。
 * 3) 不做什么：不生成伙伴内容、不处理招募任务状态，也不决定伙伴实例是否被角色持有。
 *
 * 输入/输出：
 * - 输入：`generated_partner_def` 表数据。
 * - 输出：动态伙伴定义列表、按 ID 查询函数、缓存刷新函数。
 *
 * 数据流/状态流：
 * partnerRecruitService 落库 -> reloadGeneratedPartnerConfigStore -> staticConfigLoader.getPartnerDefinitions 合并读取。
 *
 * 关键边界条件与坑点：
 * 1) 若表尚未初始化（42P01），必须返回空缓存，避免启动期因读库时序导致服务不可用。
 * 2) 这里返回的结构必须对齐 `PartnerDefConfig` 运行时必需字段，否则现有伙伴服务会在详情/战斗构建时直接报错。
 */
import { query } from '../config/database.js';
import type { PartnerBaseAttrConfig, PartnerDefConfig } from './staticConfigLoader.js';

type GeneratedPartnerDefLite = PartnerDefConfig;

let generatedPartnerDefsCache: GeneratedPartnerDefLite[] = [];
let generatedPartnerByIdCache = new Map<string, GeneratedPartnerDefLite>();

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asNumber = (raw: unknown, fallback = 0): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const asNonNegativeNumber = (raw: unknown, fallback = 0): number => {
  return Math.max(0, asNumber(raw, fallback));
};

const asStringArray = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry): entry is string => entry.length > 0);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry): entry is string => entry.length > 0)
        : [];
    } catch {
      return [];
    }
  }
  return [];
};

const asPartnerBaseAttrs = (raw: unknown): PartnerBaseAttrConfig | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const maxQixue = asNonNegativeNumber(row.max_qixue, 0);
  if (maxQixue <= 0) return null;
  return {
    max_qixue: maxQixue,
    max_lingqi: asNonNegativeNumber(row.max_lingqi, 0),
    wugong: asNonNegativeNumber(row.wugong, 0),
    fagong: asNonNegativeNumber(row.fagong, 0),
    wufang: asNonNegativeNumber(row.wufang, 0),
    fafang: asNonNegativeNumber(row.fafang, 0),
    sudu: asNonNegativeNumber(row.sudu, 0),
    mingzhong: asNonNegativeNumber(row.mingzhong, 0),
    shanbi: asNonNegativeNumber(row.shanbi, 0),
    zhaojia: asNonNegativeNumber(row.zhaojia, 0),
    baoji: asNonNegativeNumber(row.baoji, 0),
    baoshang: asNonNegativeNumber(row.baoshang, 0),
    jianbaoshang: asNonNegativeNumber(row.jianbaoshang, 0),
    kangbao: asNonNegativeNumber(row.kangbao, 0),
    zengshang: asNonNegativeNumber(row.zengshang, 0),
    zhiliao: asNonNegativeNumber(row.zhiliao, 0),
    jianliao: asNonNegativeNumber(row.jianliao, 0),
    xixue: asNonNegativeNumber(row.xixue, 0),
    lengque: asNonNegativeNumber(row.lengque, 0),
    kongzhi_kangxing: asNonNegativeNumber(row.kongzhi_kangxing, 0),
    jin_kangxing: asNonNegativeNumber(row.jin_kangxing, 0),
    mu_kangxing: asNonNegativeNumber(row.mu_kangxing, 0),
    shui_kangxing: asNonNegativeNumber(row.shui_kangxing, 0),
    huo_kangxing: asNonNegativeNumber(row.huo_kangxing, 0),
    tu_kangxing: asNonNegativeNumber(row.tu_kangxing, 0),
    qixue_huifu: asNonNegativeNumber(row.qixue_huifu, 0),
    lingqi_huifu: asNonNegativeNumber(row.lingqi_huifu, 0),
  };
};

const isUndefinedTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '42P01';
};

export const reloadGeneratedPartnerConfigStore = async (): Promise<void> => {
  try {
    const res = await query(
      `
        SELECT
          id,
          name,
          description,
          avatar,
          quality,
          attribute_element,
          role,
          max_technique_slots,
          base_attrs,
          level_attr_gains,
          innate_technique_ids,
          enabled,
          created_by_character_id,
          source_job_id,
          created_at,
          updated_at
        FROM generated_partner_def
        WHERE enabled = true
        ORDER BY created_at DESC
      `,
    );

    generatedPartnerDefsCache = (res.rows as Array<Record<string, unknown>>).flatMap((row) => {
      const id = asString(row.id);
      const name = asString(row.name);
      const baseAttrs = asPartnerBaseAttrs(row.base_attrs);
      if (!id || !name || !baseAttrs) return [];
      const levelAttrGains = asPartnerBaseAttrs(row.level_attr_gains) ?? {};
      return [{
        id,
        name,
        description: asString(row.description),
        avatar: asString(row.avatar) || null,
        quality: asString(row.quality) || '黄',
        attribute_element: asString(row.attribute_element) || 'none',
        role: asString(row.role) || '伙伴',
        max_technique_slots: Math.max(1, Math.floor(asNumber(row.max_technique_slots, 1))),
        innate_technique_ids: asStringArray(row.innate_technique_ids),
        base_attrs: baseAttrs,
        level_attr_gains: levelAttrGains,
        enabled: row.enabled !== false,
        sort_weight: 1000,
        created_by_character_id: Math.max(0, Math.floor(asNumber(row.created_by_character_id, 0))),
        source_job_id: asString(row.source_job_id) || undefined,
        created_at: asString(row.created_at) || undefined,
        updated_at: asString(row.updated_at) || undefined,
      } satisfies GeneratedPartnerDefLite];
    });

    generatedPartnerByIdCache = new Map(generatedPartnerDefsCache.map((entry) => [entry.id, entry] as const));
  } catch (error) {
    if (isUndefinedTableError(error)) {
      generatedPartnerDefsCache = [];
      generatedPartnerByIdCache = new Map();
      return;
    }
    throw error;
  }
};

export const getGeneratedPartnerDefinitions = (): GeneratedPartnerDefLite[] => {
  return generatedPartnerDefsCache;
};

export const getGeneratedPartnerDefinitionById = (partnerDefId: string): GeneratedPartnerDefLite | null => {
  const id = asString(partnerDefId);
  if (!id) return null;
  return generatedPartnerByIdCache.get(id) ?? null;
};
