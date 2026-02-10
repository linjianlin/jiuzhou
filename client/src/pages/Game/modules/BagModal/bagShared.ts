/**
 * BagModal 共享类型、常量与工具函数
 * 桌面端和移动端 BagModal 均引用此文件
 */
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import { SERVER_BASE } from '../../../../services/api';
import type { InventoryItemDto, InventoryLocation, ItemDefLite } from '../../../../services/api';

/* ───────── 类型 ───────── */

export type BagCategory = 'all' | 'consumable' | 'material' | 'equipment' | 'skill' | 'quest';
export type BagQuality = '黄' | '玄' | '地' | '天';
export type BagSort = 'default' | 'nameAsc' | 'nameDesc' | 'qtyDesc' | 'qualityDesc';
export type BagAction = 'use' | 'compose' | 'equip' | 'disassemble' | 'enhance' | 'show';
export type BatchMode = 'disassemble' | 'remove';

export type EquipmentAffix = {
  key?: string;
  name?: string;
  attr_key?: string;
  apply_type?: string;
  tier?: number;
  value?: number;
  is_legendary?: boolean;
  description?: string;
};

export type SocketedGemEffect = {
  attrKey: string;
  value: number;
  applyType: 'flat' | 'percent' | 'special';
};

export type SocketedGemEntry = {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketedGemEffect[];
  name?: string;
  icon?: string;
};

export type BagItem = {
  id: number;
  itemDefId: string;
  name: string;
  category: Exclude<BagCategory, 'all'>;
  subCategory: string | null;
  quality: BagQuality;
  tags: string[];
  icon: string;
  qty: number;
  stackMax: number;
  location: InventoryLocation;
  equippedSlot: string | null;
  locked: boolean;
  desc: string;
  effects: string[];
  actions: BagAction[];
  equip: {
    equipSlot: string | null;
    strengthenLevel: number;
    refineLevel: number;
    identified: boolean;
    baseAttrs: Record<string, number>;
    baseAttrsRaw: Record<string, number>;
    defQualityRank: number;
    resolvedQualityRank: number;
    affixes: EquipmentAffix[];
    socketMax: number;
    gemSlotTypes: unknown;
    socketedGems: SocketedGemEntry[];
    itemLevel: number;
  } | null;
};

/* ───────── 常量 ───────── */

export const categoryLabels: Record<BagCategory, string> = {
  all: '全部',
  consumable: '丹药',
  material: '材料',
  equipment: '装备',
  skill: '功法',
  quest: '任务',
};

export const qualityLabels: BagQuality[] = ['黄', '玄', '地', '天'];

export const qualityRank: Record<BagQuality, number> = { 黄: 1, 玄: 2, 地: 3, 天: 4 };

export const qualityColor: Record<BagQuality, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

export const qualityLabelText: Record<BagQuality, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

export const equipSlotLabelText: Record<string, string> = {
  weapon: '武器',
  head: '头部',
  clothes: '衣服',
  gloves: '护手',
  pants: '裤子',
  necklace: '项链',
  accessory: '饰品',
  artifact: '法宝',
};

export const getEquipSlotLabel = (slot: string) => equipSlotLabelText[slot] ?? slot;

export const qualityClass: Record<BagQuality, string> = {
  天: 'q-tian',
  地: 'q-di',
  玄: 'q-xuan',
  黄: 'q-huang',
};

export const attrLabel: Record<string, string> = {
  max_qixue: '气血上限',
  max_lingqi: '灵气上限',
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  mingzhong: '命中',
  shanbi: '闪避',
  zhaojia: '招架',
  baoji: '暴击',
  baoshang: '暴伤',
  kangbao: '抗暴',
  zengshang: '增伤',
  zhiliao: '治疗',
  jianliao: '减疗',
  xixue: '吸血',
  lengque: '冷却',
  sudu: '速度',
  qixue_huifu: '气血恢复',
  lingqi_huifu: '灵气恢复',
  kongzhi_kangxing: '控制抗性',
  jin_kangxing: '金抗性',
  mu_kangxing: '木抗性',
  shui_kangxing: '水抗性',
  huo_kangxing: '火抗性',
  tu_kangxing: '土抗性',
  fuyuan: '福源',
  shuxing_shuzhi: '属性数值',
};

export const attrOrder: Record<string, number> = Object.fromEntries(
  [
    'max_qixue', 'max_lingqi', 'wugong', 'fagong', 'wufang', 'fafang',
    'mingzhong', 'shanbi', 'zhaojia', 'baoji', 'baoshang', 'kangbao',
    'zengshang', 'zhiliao', 'jianliao', 'xixue', 'lengque', 'sudu',
    'qixue_huifu', 'lingqi_huifu', 'kongzhi_kangxing',
    'jin_kangxing', 'mu_kangxing', 'shui_kangxing', 'huo_kangxing', 'tu_kangxing',
    'fuyuan', 'shuxing_shuzhi',
  ].map((k, idx) => [k, idx]),
);

export const permyriadPercentKeys = new Set<string>([
  'shuxing_shuzhi', 'mingzhong', 'shanbi', 'zhaojia', 'baoji', 'baoshang',
  'kangbao', 'zengshang', 'zhiliao', 'jianliao', 'xixue', 'lengque',
  'kongzhi_kangxing', 'jin_kangxing', 'mu_kangxing', 'shui_kangxing',
  'huo_kangxing', 'tu_kangxing',
]);

/* ───────── 图标解析 ───────── */

const ITEM_ICON_GLOB = import.meta.glob('../../../../assets/images/**/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const ITEM_ICON_BY_FILENAME: Record<string, string> = Object.fromEntries(
  Object.entries(ITEM_ICON_GLOB).map(([p, url]) => {
    const parts = p.split(/[/\\]/);
    return [parts[parts.length - 1] ?? p, url];
  }),
);

export const resolveIcon = (def?: ItemDefLite): string => {
  const raw = (def?.icon ?? '').trim();
  if (!raw) return coin01;
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/uploads/')) return `${SERVER_BASE}${raw}`;
  if (raw.startsWith('/assets/')) {
    const filename = raw.split('/').filter(Boolean).pop() ?? raw;
    return ITEM_ICON_BY_FILENAME[filename] ?? raw;
  }
  if (raw.startsWith('/')) return `${SERVER_BASE}${raw}`;
  const filename = raw.split('/').filter(Boolean).pop() ?? raw;
  return ITEM_ICON_BY_FILENAME[filename] ?? coin01;
};

/* ───────── 通用工具 ───────── */

export const coerceStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
};

export const coerceAttrRecord = (value: unknown): Record<string, number> => {
  if (!value) return {};
  let obj: unknown = value;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) as unknown; } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) out[k] = parsed;
    }
  }
  return out;
};

export const coerceAffixes = (value: unknown): EquipmentAffix[] => {
  if (!value) return [];
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) as unknown; } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map<EquipmentAffix | null>((x) => {
      if (!x || typeof x !== 'object') return null;
      const a = x as Record<string, unknown>;
      const tierNum = typeof a.tier === 'number' ? a.tier : typeof a.tier === 'string' ? Number(a.tier) : undefined;
      const valueNum = typeof a.value === 'number' ? a.value : typeof a.value === 'string' ? Number(a.value) : undefined;
      return {
        key: typeof a.key === 'string' ? a.key : undefined,
        name: typeof a.name === 'string' ? a.name : undefined,
        attr_key: typeof a.attr_key === 'string' ? a.attr_key : undefined,
        apply_type: typeof a.apply_type === 'string' ? a.apply_type : undefined,
        tier: Number.isFinite(tierNum ?? NaN) ? tierNum : undefined,
        value: Number.isFinite(valueNum ?? NaN) ? valueNum : undefined,
        is_legendary: typeof a.is_legendary === 'boolean' ? a.is_legendary : undefined,
        description: typeof a.description === 'string' ? a.description : undefined,
      };
    })
    .filter((v): v is EquipmentAffix => !!v);
};

/* ───────── 格式化 ───────── */

export const formatSignedNumber = (value: number): string => {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}`;
};

export const formatSignedPermyriadPercent = (value: number): string => {
  const percent = value / 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  const sign = value > 0 ? '+' : '';
  return `${sign}${trimmed}%`;
};

export const formatPermyriadPercent = (value: number): string => {
  return (value / 100).toFixed(2).replace(/\.00$/, '');
};

/* ───────── 装备成长计算 ───────── */

export const getStrengthenMultiplier = (strengthenLevel: number): number => {
  const lv = Math.max(0, Math.min(15, Math.floor(Number(strengthenLevel) || 0)));
  return 1 + lv * 0.03;
};

export const getRefineMultiplier = (refineLevel: number): number => {
  const lv = Math.max(0, Math.min(10, Math.floor(Number(refineLevel) || 0)));
  return 1 + lv * 0.02;
};

export const getQualityMultiplier = (rank: number): number => {
  const r = Math.max(1, Math.min(4, Math.floor(Number(rank) || 1)));
  if (r >= 4) return 1.75;
  if (r === 3) return 1.45;
  if (r === 2) return 1.2;
  return 1;
};

export const buildGrowthPreviewAttrs = (
  params: {
    baseAttrsRaw: Record<string, number>;
    defQualityRankRaw: unknown;
    resolvedQualityRankRaw: unknown;
    strengthenLevelRaw: unknown;
    refineLevelRaw: unknown;
  },
  mode: 'enhance' | 'refine',
): Record<string, number> => {
  const baseAttrs = params.baseAttrsRaw;
  const defQualityRank = Math.max(1, Math.floor(Number(params.defQualityRankRaw) || 1));
  const resolvedQualityRank = Math.max(1, Math.floor(Number(params.resolvedQualityRankRaw) || 1));
  const strengthenLevel = Math.max(0, Math.min(15, Math.floor(Number(params.strengthenLevelRaw) || 0)));
  const refineLevel = Math.max(0, Math.min(10, Math.floor(Number(params.refineLevelRaw) || 0)));

  const targetStrengthenLevel = mode === 'enhance' ? Math.min(15, strengthenLevel + 1) : strengthenLevel;
  const targetRefineLevel = mode === 'refine' ? Math.min(10, refineLevel + 1) : refineLevel;

  const qualityFactor = getQualityMultiplier(resolvedQualityRank) / getQualityMultiplier(defQualityRank);
  const growthFactor = getStrengthenMultiplier(targetStrengthenLevel) * getRefineMultiplier(targetRefineLevel);
  const factor = qualityFactor * growthFactor;

  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseAttrs)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.round(n * factor);
  }
  return out;
};

export const getEnhanceSuccessRatePermyriad = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 10000, 2: 10000, 3: 10000, 4: 10000, 5: 10000,
    6: 8000, 7: 7000, 8: 6000, 9: 5000, 10: 4000,
    11: 3500, 12: 3000, 13: 2500, 14: 2000, 15: 1500,
  };
  return table[Math.max(1, Math.min(15, Math.floor(Number(targetLevel) || 1)))] ?? 0;
};

export const getRefineSuccessRatePermyriad = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 10000, 2: 10000, 3: 10000, 4: 9000, 5: 8000,
    6: 7000, 7: 6000, 8: 5000, 9: 4000, 10: 3000,
  };
  return table[Math.max(1, Math.min(10, Math.floor(Number(targetLevel) || 1)))] ?? 0;
};

export interface GrowthCostPlan {
  materialItemDefId: string;
  materialQty: number;
  silverCost: number;
  spiritStoneCost: number;
}

export const buildEnhanceCostPlan = (itemLevel: number, targetLevel: number): GrowthCostPlan => {
  const level = Math.max(0, Math.floor(Number(itemLevel) || 0));
  const target = Math.max(1, Math.min(15, Math.floor(Number(targetLevel) || 1)));
  return {
    materialItemDefId: target <= 10 ? 'enhance-001' : 'enhance-002',
    materialQty: 1,
    silverCost: Math.max(50, Math.floor((level + 5) * 20 * target)),
    spiritStoneCost: Math.max(0, Math.floor(target / 5)),
  };
};

export const buildRefineCostPlan = (itemLevel: number, targetLevel: number): GrowthCostPlan => {
  const level = Math.max(0, Math.floor(Number(itemLevel) || 0));
  const target = Math.max(1, Math.min(10, Math.floor(Number(targetLevel) || 1)));
  return {
    materialItemDefId: 'enhance-002',
    materialQty: target >= 8 ? 2 : 1,
    silverCost: Math.max(100, Math.floor((level + 8) * 35 * target)),
    spiritStoneCost: Math.max(0, Math.floor((target + 1) / 3)),
  };
};

/* ───────── 宝石 ───────── */

export const parseSocketedGems = (raw: unknown): SocketedGemEntry[] => {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) as unknown; } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];

  const out: SocketedGemEntry[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const row = it as Record<string, unknown>;
    const slot = Number(row.slot);
    const itemDefId = String(row.itemDefId ?? row.item_def_id ?? '').trim();
    const gemType = String(row.gemType ?? row.gem_type ?? 'all').trim() || 'all';
    const effectsRaw = Array.isArray(row.effects) ? row.effects : [];
    const effects: SocketedGemEffect[] = [];
    for (const fx of effectsRaw) {
      if (!fx || typeof fx !== 'object') continue;
      const f = fx as Record<string, unknown>;
      const attrKey = String(f.attrKey ?? f.attr_key ?? f.attr ?? '').trim();
      const value = Number(f.value);
      const applyTypeRaw = String(f.applyType ?? f.apply_type ?? 'flat').trim().toLowerCase();
      const applyType: SocketedGemEffect['applyType'] =
        applyTypeRaw === 'percent' ? 'percent' : applyTypeRaw === 'special' ? 'special' : 'flat';
      if (!attrKey || !Number.isFinite(value)) continue;
      effects.push({ attrKey, value, applyType });
    }
    if (!Number.isInteger(slot) || slot < 0) continue;
    if (!itemDefId || effects.length === 0) continue;
    out.push({
      slot, itemDefId, gemType, effects,
      name: typeof row.name === 'string' ? row.name : undefined,
      icon: typeof row.icon === 'string' ? row.icon : undefined,
    });
  }
  return out.sort((a, b) => a.slot - b.slot);
};

export const resolveSocketMax = (socketMaxRaw: unknown, qualityRaw: unknown): number => {
  const configured = Number(socketMaxRaw);
  if (Number.isInteger(configured) && configured > 0) return Math.max(0, Math.min(12, configured));
  const qualityRankVal = Math.max(1, Math.min(4, Number(qualityRaw) || 1));
  if (qualityRankVal >= 4) return 4;
  if (qualityRankVal === 3) return 3;
  if (qualityRankVal === 2) return 2;
  return 1;
};

export const normalizeGemType = (value: unknown): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'all';
  if (['all', 'any', '*', 'universal'].includes(raw)) return 'all';
  if (['atk', 'attack', 'gongji', 'offense'].includes(raw)) return 'attack';
  if (['def', 'defense', 'fangyu'].includes(raw)) return 'defense';
  if (['hp', 'life', 'survival', 'shengming'].includes(raw)) return 'survival';
  if (['util', 'utility', 'support'].includes(raw)) return 'utility';
  return raw;
};

export const getAllowedGemTypesBySlot = (gemSlotTypesRaw: unknown, slot: number): string[] | null => {
  let raw: unknown = gemSlotTypesRaw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown; } catch { return null; }
  }
  if (Array.isArray(raw)) {
    const slotBased = raw[slot];
    if (Array.isArray(slotBased)) {
      const normalized = slotBased.map((v) => normalizeGemType(v)).filter(Boolean);
      return normalized.length > 0 ? normalized : null;
    }
    if (raw.every((v) => typeof v === 'string')) {
      const normalized = raw.map((v) => normalizeGemType(v)).filter(Boolean);
      return normalized.length > 0 ? normalized : null;
    }
    return null;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const exact = obj[String(slot)];
    if (Array.isArray(exact)) {
      const normalized = exact.map((v) => normalizeGemType(v)).filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
    const fallback = obj.default;
    if (Array.isArray(fallback)) {
      const normalized = fallback.map((v) => normalizeGemType(v)).filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
  }
  return null;
};

export const isGemTypeAllowedInSlot = (gemSlotTypesRaw: unknown, slot: number, gemTypeRaw: unknown): boolean => {
  const allowed = getAllowedGemTypesBySlot(gemSlotTypesRaw, slot);
  if (!allowed || allowed.length === 0) return true;
  const gemType = normalizeGemType(gemTypeRaw);
  if (!gemType) return false;
  return allowed.includes('all') || gemType === 'all' || allowed.includes(gemType);
};

export const collectGemCandidates = (items: BagItem[]): BagItem[] => {
  const gemDefIdSet = new Set(['gem-001', 'gem-002', 'gem-003', 'gem-004']);
  const out: BagItem[] = [];
  for (const it of items) {
    if (it.location !== 'bag') continue;
    if (it.locked) continue;
    if (it.category !== 'material') continue;
    if (gemDefIdSet.has(it.itemDefId)) { out.push(it); continue; }
    const effects = it.effects;
    if (!effects.some((line) => line.includes('socket') || line.includes('镶嵌') || line.includes('宝石'))) continue;
    out.push(it);
  }
  return out;
};

/* ───────── 构建装备详情行 ───────── */

export const buildEquipmentLines = (item: BagItem | null): string[] => {
  if (!item?.equip) return [];
  const { strengthenLevel, refineLevel, identified, baseAttrs, affixes, socketMax, socketedGems } = item.equip;

  const lines: string[] = [];
  lines.push(`强化：${strengthenLevel > 0 ? `+${strengthenLevel}` : strengthenLevel}`);
  lines.push(`精炼：${refineLevel > 0 ? `+${refineLevel}` : refineLevel}`);

  const toSortedEntries = (rec: Record<string, number>) =>
    Object.entries(rec).sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b));

  for (const [k, v] of toSortedEntries(baseAttrs)) {
    const label = attrLabel[k] ?? k;
    const valText = permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v);
    lines.push(`基础：${label} ${valText}`);
  }

  lines.push(`孔位：${socketedGems.length}/${socketMax}`);
  for (const gem of socketedGems) {
    const gemName = gem.name || gem.itemDefId;
    lines.push(`宝石[${gem.slot}]：${gemName}`);
    for (const effect of gem.effects) {
      const label = attrLabel[effect.attrKey] ?? effect.attrKey;
      const valText =
        effect.applyType === 'percent'
          ? formatSignedPermyriadPercent(effect.value)
          : formatSignedNumber(effect.value);
      lines.push(`  - ${label} ${valText}`);
    }
  }

  if (!identified) { lines.push('词条：未鉴定'); return lines; }

  const sortedAffixes = [...affixes].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
  for (const a of sortedAffixes) {
    const tierText = a.tier ? `T${a.tier}` : 'T-';
    const prefix = a.is_legendary ? '传奇词条' : '词条';
    const key = a.attr_key;
    const label = (key ? attrLabel[key] : undefined) ?? a.name ?? key ?? '未知';
    if (typeof a.value === 'number') {
      const isPercent = a.apply_type === 'percent' || (key ? permyriadPercentKeys.has(key) : false);
      const valText = isPercent ? formatSignedPermyriadPercent(a.value) : formatSignedNumber(a.value);
      lines.push(`${prefix} ${tierText}：${label} ${valText}`);
      continue;
    }
    if (a.description) lines.push(`${prefix} ${tierText}：${label}（${a.description}）`);
    else lines.push(`${prefix} ${tierText}：${label}`);
  }
  return lines;
};

/* ───────── 效果 / 分类映射 ───────── */

const mapCategory = (value: unknown): Exclude<BagCategory, 'all'> => {
  if (value === 'consumable') return 'consumable';
  if (value === 'material') return 'material';
  if (value === 'equipment') return 'equipment';
  if (value === 'skillbook') return 'skill';
  if (value === 'quest') return 'quest';
  return 'material';
};

const mapActions = (category: unknown): BagAction[] => {
  if (category === 'consumable') return ['use', 'show'];
  if (category === 'equipment') return ['equip', 'enhance', 'disassemble', 'show'];
  if (category === 'material') return ['compose', 'show'];
  if (category === 'skillbook') return ['use', 'show'];
  if (category === 'quest') return ['show'];
  return ['show'];
};

const buildEffects = (def?: ItemDefLite): string[] => {
  const effects: string[] = [];
  const raw = def?.effect_defs;
  if (!Array.isArray(raw)) return effects;

  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const effectType = (e as { effect_type?: unknown }).effect_type;
    const value = (e as { value?: unknown }).value;
    const durationRound = (e as { duration_round?: unknown }).duration_round;

    if (effectType === 'heal' && typeof value === 'number') effects.push(`恢复气血 ${value}`);
    else if ((effectType === 'restore_mana' || effectType === 'mana') && typeof value === 'number') effects.push(`恢复灵气 ${value}`);
    else if (typeof effectType === 'string') effects.push(`效果：${effectType}`);

    if (typeof durationRound === 'number' && durationRound > 0) effects.push(`持续 ${durationRound} 回合`);
  }
  return effects;
};

/* ───────── 构建 BagItem ───────── */

export const buildBagItem = (it: InventoryItemDto): BagItem | null => {
  const def = it.def;
  if (!def) return null;

  const rawQuality = def.quality;
  const quality = qualityLabels.includes(rawQuality as BagQuality) ? (rawQuality as BagQuality) : '黄';
  const tags = coerceStringArray(def.tags);
  const category = mapCategory(def.category);
  const isEquip = category === 'equipment';

  return {
    id: Number(it.id),
    itemDefId: it.item_def_id,
    name: def.name,
    category,
    subCategory: def.sub_category ?? null,
    quality,
    tags,
    icon: resolveIcon(def),
    qty: it.qty,
    stackMax: def.stack_max,
    location: it.location,
    equippedSlot: it.equipped_slot ?? null,
    locked: !!it.locked,
    desc: def.long_desc || def.description || '',
    effects: buildEffects(def),
    actions: mapActions(def.category),
    equip: isEquip
      ? {
          equipSlot: def.equip_slot ?? null,
          strengthenLevel: Number(it.strengthen_level) || 0,
          refineLevel: Number(it.refine_level) || 0,
          identified: !!it.identified,
          baseAttrs: coerceAttrRecord(def.base_attrs),
          baseAttrsRaw: coerceAttrRecord(def.base_attrs_raw ?? def.base_attrs),
          defQualityRank: Number(def.quality_rank) || qualityRank[quality],
          resolvedQualityRank: Number(it.quality_rank) || qualityRank[quality],
          affixes: coerceAffixes(it.affixes),
          socketMax: resolveSocketMax(def.socket_max, qualityRank[quality]),
          gemSlotTypes: def.gem_slot_types,
          socketedGems: parseSocketedGems(it.socketed_gems),
          itemLevel: Math.max(0, Math.floor(Number(def.level) || 0)),
        }
      : null,
  };
};

/* ───────── 使用效果计算 ───────── */

export const pickNumber = (obj: unknown, keys: string[]): number | null => {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

export const calcUseEffectDelta = (effects: unknown, qty: number): { qixue: number; lingqi: number } => {
  if (!Array.isArray(effects)) return { qixue: 0, lingqi: 0 };
  let deltaQixue = 0;
  let deltaLingqi = 0;
  const safeQty = Math.max(1, Math.floor(Number(qty) || 1));

  for (const rawEffect of effects) {
    if (!rawEffect || typeof rawEffect !== 'object') continue;
    const e = rawEffect as Record<string, unknown>;
    if (String(e.trigger || '') !== 'use') continue;
    if (String(e.target || 'self') !== 'self') continue;

    const effectType = typeof e.effect_type === 'string' ? e.effect_type : undefined;
    const value = typeof e.value === 'number' ? e.value : Number(e.value);
    if (!Number.isFinite(value)) continue;

    if (!effectType || effectType === 'heal') { deltaQixue += value * safeQty; continue; }
    if (effectType === 'resource') {
      const params = e.params && typeof e.params === 'object' ? (e.params as Record<string, unknown>) : null;
      const resource = params ? String(params.resource || '') : '';
      if (resource === 'qixue') deltaQixue += value * safeQty;
      if (resource === 'lingqi') deltaLingqi += value * safeQty;
    }
  }
  return { qixue: Math.floor(deltaQixue), lingqi: Math.floor(deltaLingqi) };
};
