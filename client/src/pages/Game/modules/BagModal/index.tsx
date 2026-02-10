import { App, Button, Input, Modal, Select, Tabs, Tag } from 'antd';
import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import MobileBagModal from './MobileBagModal';
import coin01 from '../../../../assets/images/ui/sh_icon_0006_jinbi_02.png';
import { gameSocket } from '../../../../services/gameSocket';
import {
  SERVER_BASE,
  disassembleInventoryEquipmentBatch,
  enhanceInventoryItem,
  equipInventoryItem,
  getInventoryInfo,
  getInventoryItems,
  refineInventoryItem,
  removeInventoryItemsBatch,
  removeInventorySocketGem,
  socketInventoryGem,
  sortInventory,
  unequipInventoryItem,
  inventoryUseItem,
} from '../../../../services/api';
import type { InventoryInfoData, InventoryItemDto, InventoryLocation, ItemDefLite } from '../../../../services/api';
import DisassembleModal from './DisassembleModal';
import './index.scss';

type BagCategory = 'all' | 'consumable' | 'material' | 'equipment' | 'skill' | 'quest';
type BagQuality = '黄' | '玄' | '地' | '天';
type BagSort = 'default' | 'nameAsc' | 'nameDesc' | 'qtyDesc' | 'qualityDesc';

type BagAction = 'use' | 'compose' | 'equip' | 'disassemble' | 'enhance' | 'show';

type BatchMode = 'disassemble' | 'remove';

type EquipmentAffix = {
  key?: string;
  name?: string;
  attr_key?: string;
  apply_type?: string;
  tier?: number;
  value?: number;
  is_legendary?: boolean;
  description?: string;
};

type SocketedGemEffect = {
  attrKey: string;
  value: number;
  applyType: 'flat' | 'percent' | 'special';
};

type SocketedGemEntry = {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketedGemEffect[];
  name?: string;
  icon?: string;
};

type BagItem = {
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
  equip:
    | {
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
      }
    | null;
};

const categoryLabels: Record<BagCategory, string> = {
  all: '全部',
  consumable: '丹药',
  material: '材料',
  equipment: '装备',
  skill: '功法',
  quest: '任务',
};

const qualityLabels: BagQuality[] = ['黄', '玄', '地', '天'];

const qualityRank: Record<BagQuality, number> = {
  黄: 1,
  玄: 2,
  地: 3,
  天: 4,
};

const qualityColor: Record<BagQuality, string> = {
  天: 'var(--rarity-tian)',
  地: 'var(--rarity-di)',
  玄: 'var(--rarity-xuan)',
  黄: 'var(--rarity-huang)',
};

const qualityLabelText: Record<BagQuality, string> = {
  天: '天品',
  地: '地品',
  玄: '玄品',
  黄: '黄品',
};

const equipSlotLabelText: Record<string, string> = {
  weapon: '武器',
  head: '头部',
  clothes: '衣服',
  gloves: '护手',
  pants: '裤子',
  necklace: '项链',
  accessory: '饰品',
  artifact: '法宝',
};

const getEquipSlotLabel = (slot: string) => equipSlotLabelText[slot] ?? slot;

const qualityClass: Record<BagQuality, string> = {
  天: 'q-tian',
  地: 'q-di',
  玄: 'q-xuan',
  黄: 'q-huang',
};

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

const resolveIcon = (def?: ItemDefLite): string => {
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

const coerceStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
};

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

const attrLabel: Record<string, string> = {
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

const attrOrder: Record<string, number> = Object.fromEntries(
  [
    'max_qixue',
    'max_lingqi',
    'wugong',
    'fagong',
    'wufang',
    'fafang',
    'mingzhong',
    'shanbi',
    'zhaojia',
    'baoji',
    'baoshang',
    'kangbao',
    'zengshang',
    'zhiliao',
    'jianliao',
    'xixue',
    'lengque',
    'sudu',
    'qixue_huifu',
    'lingqi_huifu',
    'kongzhi_kangxing',
    'jin_kangxing',
    'mu_kangxing',
    'shui_kangxing',
    'huo_kangxing',
    'tu_kangxing',
    'fuyuan',
    'shuxing_shuzhi',
  ].map((k, idx) => [k, idx])
);

const permyriadPercentKeys = new Set<string>([
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const coerceAttrRecord = (value: unknown): Record<string, number> => {
  if (!value) return {};
  let obj: unknown = value;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return {};
    }
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

const coerceAffixes = (value: unknown): EquipmentAffix[] => {
  if (!value) return [];
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map<EquipmentAffix | null>((x) => {
      if (!x || typeof x !== 'object') return null;
      const a = x as Record<string, unknown>;
      const tierNum = typeof a.tier === 'number' ? a.tier : typeof a.tier === 'string' ? Number(a.tier) : undefined;
      const valueNum = typeof a.value === 'number' ? a.value : typeof a.value === 'string' ? Number(a.value) : undefined;

      const out: EquipmentAffix = {
        key: typeof a.key === 'string' ? a.key : undefined,
        name: typeof a.name === 'string' ? a.name : undefined,
        attr_key: typeof a.attr_key === 'string' ? a.attr_key : undefined,
        apply_type: typeof a.apply_type === 'string' ? a.apply_type : undefined,
        tier: Number.isFinite(tierNum ?? NaN) ? tierNum : undefined,
        value: Number.isFinite(valueNum ?? NaN) ? valueNum : undefined,
        is_legendary: typeof a.is_legendary === 'boolean' ? a.is_legendary : undefined,
        description: typeof a.description === 'string' ? a.description : undefined,
      };
      return out;
    })
    .filter((v): v is EquipmentAffix => !!v);
};

const formatSignedNumber = (value: number): string => {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}`;
};

const formatSignedPermyriadPercent = (value: number): string => {
  const percent = value / 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  const sign = value > 0 ? '+' : '';
  return `${sign}${trimmed}%`;
};

const formatPermyriadPercent = (value: number): string => {
  return (value / 100).toFixed(2).replace(/\.00$/, '');
};

const getStrengthenMultiplier = (strengthenLevel: number): number => {
  const lv = Math.max(0, Math.min(15, Math.floor(Number(strengthenLevel) || 0)));
  return 1 + lv * 0.03;
};

const getRefineMultiplier = (refineLevel: number): number => {
  const lv = Math.max(0, Math.min(10, Math.floor(Number(refineLevel) || 0)));
  return 1 + lv * 0.02;
};

const getQualityMultiplier = (rank: number): number => {
  const r = Math.max(1, Math.min(4, Math.floor(Number(rank) || 1)));
  if (r >= 4) return 1.75;
  if (r === 3) return 1.45;
  if (r === 2) return 1.2;
  return 1;
};

const buildGrowthPreviewAttrs = (
  params: {
    baseAttrsRaw: Record<string, number>;
    defQualityRankRaw: unknown;
    resolvedQualityRankRaw: unknown;
    strengthenLevelRaw: unknown;
    refineLevelRaw: unknown;
  },
  mode: 'enhance' | 'refine'
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

const parseSocketedGems = (raw: unknown): SocketedGemEntry[] => {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr) as unknown;
    } catch {
      return [];
    }
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
      slot,
      itemDefId,
      gemType,
      effects,
      name: typeof row.name === 'string' ? row.name : undefined,
      icon: typeof row.icon === 'string' ? row.icon : undefined,
    });
  }
  return out.sort((a, b) => a.slot - b.slot);
};

const resolveSocketMax = (socketMaxRaw: unknown, qualityRaw: unknown): number => {
  const configured = Number(socketMaxRaw);
  if (Number.isInteger(configured) && configured > 0) return Math.max(0, Math.min(12, configured));
  const qualityRank = Math.max(1, Math.min(4, Number(qualityRaw) || 1));
  if (qualityRank >= 4) return 4;
  if (qualityRank === 3) return 3;
  if (qualityRank === 2) return 2;
  return 1;
};

const normalizeGemType = (value: unknown): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'all';
  if (['all', 'any', '*', 'universal'].includes(raw)) return 'all';
  if (['atk', 'attack', 'gongji', 'offense'].includes(raw)) return 'attack';
  if (['def', 'defense', 'fangyu'].includes(raw)) return 'defense';
  if (['hp', 'life', 'survival', 'shengming'].includes(raw)) return 'survival';
  if (['util', 'utility', 'support'].includes(raw)) return 'utility';
  return raw;
};

const getAllowedGemTypesBySlot = (gemSlotTypesRaw: unknown, slot: number): string[] | null => {
  let raw: unknown = gemSlotTypesRaw;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
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

const isGemTypeAllowedInSlot = (gemSlotTypesRaw: unknown, slot: number, gemTypeRaw: unknown): boolean => {
  const allowed = getAllowedGemTypesBySlot(gemSlotTypesRaw, slot);
  if (!allowed || allowed.length === 0) return true;
  const gemType = normalizeGemType(gemTypeRaw);
  if (!gemType) return false;
  return allowed.includes('all') || gemType === 'all' || allowed.includes(gemType);
};

const getEnhanceSuccessRatePermyriad = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 10000,
    2: 10000,
    3: 10000,
    4: 10000,
    5: 10000,
    6: 8000,
    7: 7000,
    8: 6000,
    9: 5000,
    10: 4000,
    11: 3500,
    12: 3000,
    13: 2500,
    14: 2000,
    15: 1500,
  };
  const lv = Math.max(1, Math.min(15, Math.floor(Number(targetLevel) || 1)));
  return table[lv] ?? 0;
};

const getRefineSuccessRatePermyriad = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 10000,
    2: 10000,
    3: 10000,
    4: 9000,
    5: 8000,
    6: 7000,
    7: 6000,
    8: 5000,
    9: 4000,
    10: 3000,
  };
  const lv = Math.max(1, Math.min(10, Math.floor(Number(targetLevel) || 1)));
  return table[lv] ?? 0;
};

interface GrowthCostPlan {
  materialItemDefId: string;
  materialQty: number;
  silverCost: number;
  spiritStoneCost: number;
}

const buildEnhanceCostPlan = (itemLevel: number, targetLevel: number): GrowthCostPlan => {
  const level = Math.max(0, Math.floor(Number(itemLevel) || 0));
  const target = Math.max(1, Math.min(15, Math.floor(Number(targetLevel) || 1)));
  return {
    materialItemDefId: target <= 10 ? 'enhance-001' : 'enhance-002',
    materialQty: 1,
    silverCost: Math.max(50, Math.floor((level + 5) * 20 * target)),
    spiritStoneCost: Math.max(0, Math.floor(target / 5)),
  };
};

const buildRefineCostPlan = (itemLevel: number, targetLevel: number): GrowthCostPlan => {
  const level = Math.max(0, Math.floor(Number(itemLevel) || 0));
  const target = Math.max(1, Math.min(10, Math.floor(Number(targetLevel) || 1)));
  return {
    materialItemDefId: 'enhance-002',
    materialQty: target >= 8 ? 2 : 1,
    silverCost: Math.max(100, Math.floor((level + 8) * 35 * target)),
    spiritStoneCost: Math.max(0, Math.floor((target + 1) / 3)),
  };
};

const collectGemCandidates = (items: BagItem[]): BagItem[] => {
  const gemDefIdSet = new Set(['gem-001', 'gem-002', 'gem-003', 'gem-004']);
  const out: BagItem[] = [];
  for (const it of items) {
    if (it.location !== 'bag') continue;
    if (it.locked) continue;
    if (it.category !== 'material') continue;
    if (gemDefIdSet.has(it.itemDefId)) {
      out.push(it);
      continue;
    }
    const effects = it.effects;
    if (!effects.some((line) => line.includes('socket') || line.includes('镶嵌') || line.includes('宝石'))) continue;
    out.push(it);
  }
  return out;
};

const buildEquipmentLines = (item: BagItem | null): string[] => {
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

  if (!identified) {
    lines.push('词条：未鉴定');
    return lines;
  }

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

    if (a.description) {
      lines.push(`${prefix} ${tierText}：${label}（${a.description}）`);
    } else {
      lines.push(`${prefix} ${tierText}：${label}`);
    }
  }

  return lines;
};

const buildBagItem = (it: InventoryItemDto): BagItem | null => {
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

const pickNumber = (obj: unknown, keys: string[]): number | null => {
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

const calcUseEffectDelta = (effects: unknown, qty: number): { qixue: number; lingqi: number } => {
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

    if (!effectType || effectType === 'heal') {
      deltaQixue += value * safeQty;
      continue;
    }

    if (effectType === 'resource') {
      const params = e.params && typeof e.params === 'object' ? (e.params as Record<string, unknown>) : null;
      const resource = params ? String(params.resource || '') : '';
      if (resource === 'qixue') deltaQixue += value * safeQty;
      if (resource === 'lingqi') deltaLingqi += value * safeQty;
    }
  }

  return { qixue: Math.floor(deltaQixue), lingqi: Math.floor(deltaLingqi) };
};

interface BagModalProps {
  open: boolean;
  onClose: () => void;
}

const BagModal: React.FC<BagModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [category, setCategory] = useState<BagCategory>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BagSort>('default');
  const [quality, setQuality] = useState<BagQuality | 'all'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategories, setFilterCategories] = useState<Array<Exclude<BagCategory, 'all'>>>([]);
  const [filterQualities, setFilterQualities] = useState<BagQuality[]>([]);
  const [filterAttrKeys, setFilterAttrKeys] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [disassembleOpen, setDisassembleOpen] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceSubmitting, setEnhanceSubmitting] = useState(false);
  const [growthMode, setGrowthMode] = useState<'enhance' | 'refine' | 'socket'>('enhance');
  const [refineSubmitting, setRefineSubmitting] = useState(false);
  const [socketSubmitting, setSocketSubmitting] = useState(false);
  const [socketSlot, setSocketSlot] = useState<number | undefined>(undefined);
  const [selectedGemItemId, setSelectedGemItemId] = useState<number | undefined>(undefined);
  const [removeSlot, setRemoveSlot] = useState<number | undefined>(undefined);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<BatchMode>('disassemble');
  const [batchQualities, setBatchQualities] = useState<BagQuality[]>(qualityLabels);
  const [batchCategory, setBatchCategory] = useState<BagCategory>('all');
  const [batchSubCategory, setBatchSubCategory] = useState<string>('all');
  const [batchEquipSlot, setBatchEquipSlot] = useState<string>('all');
  const [batchKeyword, setBatchKeyword] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<InventoryInfoData | null>(null);
  const [items, setItems] = useState<BagItem[]>([]);
  const [playerSilver, setPlayerSilver] = useState(0);
  const [playerSpiritStones, setPlayerSpiritStones] = useState(0);

  useEffect(() => {
    return gameSocket.onCharacterUpdate((char) => {
      setPlayerSilver(Number(char?.silver) || 0);
      setPlayerSpiritStones(Number(char?.spiritStones) || 0);
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [infoRes, bagRes, equippedRes] = await Promise.all([
        getInventoryInfo(),
        getInventoryItems('bag', 1, 200),
        getInventoryItems('equipped', 1, 200),
      ]);
      if (!infoRes.success || !infoRes.data) throw new Error(infoRes.message || '获取背包信息失败');
      if (!bagRes.success || !bagRes.data) throw new Error(bagRes.message || '获取背包物品失败');
      if (!equippedRes.success || !equippedRes.data) throw new Error(equippedRes.message || '获取已穿戴物品失败');

      const nextBagItems = bagRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      const nextEquippedItems = equippedRes.data.items.map(buildBagItem).filter((v): v is BagItem => !!v);
      const nextItems = [...nextBagItems, ...nextEquippedItems];
      setInfo(infoRes.data);
      setItems(nextItems);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '获取背包数据失败');
      setInfo(null);
      setItems([]);
      setActiveId(null);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  const totalSlots = info?.bag_capacity ?? 100;

  const filterAttrKeyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it.category !== 'equipment' || !it.equip) continue;
      for (const k of Object.keys(it.equip.baseAttrs || {})) {
        if (k) set.add(k);
      }
      for (const a of it.equip.affixes || []) {
        const k = a.attr_key;
        if (k) set.add(k);
      }
    }
    const list = [...set];
    list.sort((a, b) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b));
    return list.map((k) => ({ value: k, label: attrLabel[k] ?? k }));
  }, [items]);

  const activeFilterCount = useMemo(() => {
    return filterCategories.length + filterQualities.length + filterAttrKeys.length;
  }, [filterAttrKeys.length, filterCategories.length, filterQualities.length]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items;
    if (filterCategories.length > 0) {
      const set = new Set(filterCategories);
      list = list.filter((i) => set.has(i.category));
    } else if (category !== 'all') {
      list = list.filter((i) => i.category === category);
    }

    if (filterQualities.length > 0) {
      const set = new Set(filterQualities);
      list = list.filter((i) => set.has(i.quality));
    } else if (quality !== 'all') {
      list = list.filter((i) => i.quality === quality);
    }

    if (filterAttrKeys.length > 0) {
      const set = new Set(filterAttrKeys);
      list = list.filter((i) => {
        if (i.category !== 'equipment' || !i.equip) return false;
        for (const k of Object.keys(i.equip.baseAttrs || {})) {
          if (set.has(k)) return true;
        }
        for (const a of i.equip.affixes || []) {
          const k = a.attr_key;
          if (k && set.has(k)) return true;
        }
        return false;
      });
    }

    if (q) {
      list = list.filter((i) => `${i.name}${i.tags.join('')}`.toLowerCase().includes(q));
    }

    const out = [...list];
    if (sort === 'nameAsc') out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    if (sort === 'nameDesc') out.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
    if (sort === 'qtyDesc') out.sort((a, b) => b.qty - a.qty);
    if (sort === 'qualityDesc') out.sort((a, b) => qualityRank[b.quality] - qualityRank[a.quality]);
    return out;
  }, [category, query, quality, sort, items, filterCategories, filterQualities, filterAttrKeys]);

  const safeActiveId = useMemo(() => {
    if (activeId !== null && filtered.some((i) => i.id === activeId)) return activeId;
    return filtered[0]?.id ?? null;
  }, [activeId, filtered]);

  const activeItem = useMemo(
    () => (safeActiveId === null ? null : filtered.find((i) => i.id === safeActiveId) ?? null),
    [filtered, safeActiveId]
  );

  const equipLines = useMemo(() => buildEquipmentLines(activeItem), [activeItem]);
  const hasDesc = useMemo(() => Boolean(activeItem?.desc?.trim()), [activeItem?.desc]);
  const hasEquipAttrs = useMemo(() => activeItem?.category === 'equipment' && equipLines.length > 0, [activeItem, equipLines]);
  const hasEffects = useMemo(() => (activeItem?.effects?.length ?? 0) > 0, [activeItem?.effects]);

  const usedSlots = info?.bag_used ?? items.filter((i) => i.location === 'bag').length;

  const materialCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const it of items) {
      if (it.category !== 'material') continue;
      out[it.itemDefId] = (out[it.itemDefId] ?? 0) + Math.max(0, Math.floor(it.qty));
    }
    return out;
  }, [items]);

  const openBatch = useCallback(
    (mode: BatchMode) => {
      setBatchMode(mode);
      setBatchOpen(true);
      setBatchSubmitting(false);
      setBatchKeyword('');
      setBatchSubCategory('all');
      setBatchEquipSlot('all');
      setBatchQualities(quality === 'all' ? qualityLabels : [quality]);
      if (mode === 'remove') {
        setBatchCategory(category === 'all' ? 'all' : category);
      } else {
        setBatchCategory('equipment');
      }
    },
    [category, quality]
  );

  const actionDisabled = (a: BagAction) => {
    if (!activeItem) return true;
    if (!activeItem.actions.includes(a)) return true;
    if (a === 'use') {
      if (activeItem.locked) return true;
      if (activeItem.qty <= 0) return true;
      if (activeItem.location !== 'bag') return true;
    }
    if (a === 'disassemble') {
      if (activeItem.category !== 'equipment') return true;
      if (activeItem.locked) return true;
      if (activeItem.location === 'equipped') return true;
    }
    if (a === 'enhance') {
      if (activeItem.category !== 'equipment') return true;
      if (!activeItem.equip) return true;
    }
    return false;
  };

  const hasAction = (a: BagAction) => {
    if (!activeItem) return false;
    return activeItem.actions.includes(a);
  };

  const equipButtonText = useMemo(() => {
    if (!activeItem) return '装备';
    if (activeItem.category !== 'equipment') return '装备';
    return activeItem.location === 'equipped' ? '卸下' : '装备';
  }, [activeItem]);

  const handleEquipToggle = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;

    setLoading(true);
    try {
      if (activeItem.location === 'equipped') {
        const res = await unequipInventoryItem(activeItem.id, 'bag');
        if (!res.success) throw new Error(res.message || '卸下失败');
        message.success(res.message || '卸下成功');
      } else {
        const res = await equipInventoryItem(activeItem.id);
        if (!res.success) throw new Error(res.message || '装备失败');
        message.success(res.message || '装备成功');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '操作失败');
      setLoading(false);
    }
  }, [activeItem, message, refresh]);

  const handleUseItem = useCallback(async () => {
    if (!activeItem) return;

    setLoading(true);
    try {
      const beforeChar = gameSocket.getCharacter();
      const res = await inventoryUseItem({ itemInstanceId: activeItem.id, qty: 1 });
      if (!res.success) throw new Error(res.message || '使用失败');

      const lootResults = res.data?.lootResults;
      const remaining = Math.max(0, Math.floor(activeItem.qty) - 1);

      let content: string;
      if (lootResults && lootResults.length > 0) {
        const rewardParts = lootResults.map((r) => `${r.name || r.type}×${r.amount}`);
        content = `打开【${activeItem.name}】，获得${rewardParts.join('、')}。`;
      } else {
        const afterChar = res.data?.character;
        const beforeQixue = beforeChar?.qixue ?? null;
        const afterQixue = pickNumber(afterChar, ['qixue']);
        const effectDelta = calcUseEffectDelta(res.effects, 1);

        const restoredByStat =
          beforeQixue !== null && afterQixue !== null ? Math.max(0, Math.floor(afterQixue - beforeQixue)) : null;
        const restored = restoredByStat !== null ? restoredByStat : Math.max(0, Math.floor(effectDelta.qixue));

        content =
          activeItem.category === 'consumable'
            ? `使用【${activeItem.name}】成功，恢复了${restored}点气血，背包剩余${remaining}。`
            : `使用【${activeItem.name}】成功，背包剩余${remaining}。`;
      }
      window.dispatchEvent(new CustomEvent('chat:append', { detail: { channel: 'system', content } }));

      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      window.dispatchEvent(
        new CustomEvent('chat:append', {
          detail: { channel: 'system', content: `使用【${activeItem.name}】失败：${err.message || '操作失败'}` },
        }),
      );
      setLoading(false);
    }
  }, [activeItem, refresh]);

  const enhanceState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const curLv = Math.max(0, Math.min(15, Math.floor(Number(activeItem.equip.strengthenLevel) || 0)));
    const targetLv = Math.min(15, curLv + 1);
    const costPlan = buildEnhanceCostPlan(activeItem.equip.itemLevel, targetLv);
    const materialName = costPlan.materialItemDefId === 'enhance-001' ? '淬灵石' : '蕴灵石';
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const previewBaseAttrs = buildGrowthPreviewAttrs(
      {
        baseAttrsRaw: activeItem.equip.baseAttrsRaw,
        defQualityRankRaw: activeItem.equip.defQualityRank,
        resolvedQualityRankRaw: activeItem.equip.resolvedQualityRank,
        strengthenLevelRaw: curLv,
        refineLevelRaw: activeItem.equip.refineLevel,
      },
      'enhance',
    );
    return {
      curLv,
      targetLv,
      materialItemDefId: costPlan.materialItemDefId,
      materialName,
      owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRatePermyriad: getEnhanceSuccessRatePermyriad(targetLv),
      downgradeOnFail: targetLv >= 8,
      previewBaseAttrs,
    };
  }, [activeItem, materialCounts]);

  const refineState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const curLv = Math.max(0, Math.min(10, Math.floor(Number(activeItem.equip.refineLevel) || 0)));
    const targetLv = Math.min(10, curLv + 1);
    const costPlan = buildRefineCostPlan(activeItem.equip.itemLevel, targetLv);
    const owned = materialCounts[costPlan.materialItemDefId] ?? 0;
    const previewBaseAttrs = buildGrowthPreviewAttrs(
      {
        baseAttrsRaw: activeItem.equip.baseAttrsRaw,
        defQualityRankRaw: activeItem.equip.defQualityRank,
        resolvedQualityRankRaw: activeItem.equip.resolvedQualityRank,
        strengthenLevelRaw: activeItem.equip.strengthenLevel,
        refineLevelRaw: curLv,
      },
      'refine',
    );

    const materialName = costPlan.materialItemDefId === 'enhance-002' ? '蕴灵石' : costPlan.materialItemDefId;
    return {
      curLv,
      targetLv,
      materialItemDefId: costPlan.materialItemDefId,
      materialName,
      materialQty: costPlan.materialQty,
      owned,
      silverCost: costPlan.silverCost,
      spiritStoneCost: costPlan.spiritStoneCost,
      successRatePermyriad: getRefineSuccessRatePermyriad(targetLv),
      previewBaseAttrs,
    };
  }, [activeItem, materialCounts]);

  const socketState = useMemo(() => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return null;
    const equip = activeItem.equip;
    const candidates = collectGemCandidates(items);
    const availableSlots = Array.from({ length: Math.max(0, equip.socketMax) }, (_, idx) => idx);
    const selectedSlot =
      socketSlot === undefined || socketSlot === null ? availableSlots.find((s) => !equip.socketedGems.some((g) => g.slot === s)) : socketSlot;
    const selectedGem = candidates.find((x) => x.id === selectedGemItemId) ?? null;
    const selectedGemType = selectedGem ? normalizeGemType(selectedGem.subCategory || selectedGem.name) : 'all';
    const slotValid = selectedSlot !== undefined && selectedSlot >= 0 && selectedSlot < equip.socketMax;
    const typeValid =
      selectedGem && selectedSlot !== undefined
        ? isGemTypeAllowedInSlot(equip.gemSlotTypes, selectedSlot, selectedGemType)
        : false;
    return {
      socketed: equip.socketedGems,
      socketMax: equip.socketMax,
      availableSlots,
      selectedSlot,
      candidates,
      selectedGem,
      selectedGemType,
      slotValid,
      typeValid,
    };
  }, [activeItem, items, selectedGemItemId, socketSlot]);

  const handleEnhance = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;
    if (!activeItem.equip) return;

    setEnhanceSubmitting(true);
    try {
      const res = await enhanceInventoryItem({ itemId: activeItem.id });
      if (res.success) {
        message.success(res.message || '强化成功');
      } else {
        if ((res.message || '') === '强化失败') message.warning(res.message || '强化失败');
        else message.error(res.message || '强化失败');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '强化失败');
    } finally {
      setEnhanceSubmitting(false);
    }
  }, [activeItem, message, refresh]);

  const handleRefine = useCallback(async () => {
    if (!activeItem) return;
    if (activeItem.category !== 'equipment') return;
    if (!activeItem.equip) return;

    setRefineSubmitting(true);
    try {
      const res = await refineInventoryItem({ itemId: activeItem.id });
      if (res.success) {
        message.success(res.message || '精炼成功');
      } else {
        if ((res.message || '') === '精炼失败') message.warning(res.message || '精炼失败');
        else message.error(res.message || '精炼失败');
      }
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '精炼失败');
    } finally {
      setRefineSubmitting(false);
    }
  }, [activeItem, message, refresh]);

  const handleSocket = useCallback(async () => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return;
    if (!socketState) return;
    if (!socketState.selectedGem) return;
    if (socketState.selectedSlot === undefined) return;
    if (!socketState.slotValid || !socketState.typeValid) return;

    setSocketSubmitting(true);
    try {
      const res = await socketInventoryGem({
        itemId: activeItem.id,
        gemItemId: socketState.selectedGem.id,
        slot: socketState.selectedSlot,
      });
      if (!res.success) throw new Error(res.message || '镶嵌失败');
      message.success(res.message || '镶嵌成功');
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setSelectedGemItemId(undefined);
      setSocketSlot(undefined);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '镶嵌失败');
    } finally {
      setSocketSubmitting(false);
    }
  }, [activeItem, message, refresh, socketState]);

  const handleRemoveSocket = useCallback(async () => {
    if (!activeItem?.equip || activeItem.category !== 'equipment') return;
    if (removeSlot === undefined || removeSlot === null) return;

    setSocketSubmitting(true);
    try {
      const res = await removeInventorySocketGem({ itemId: activeItem.id, slot: removeSlot });
      if (!res.success) throw new Error(res.message || '卸下宝石失败');
      message.success(res.message || '卸下宝石成功');
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setRemoveSlot(undefined);
    } catch (error: unknown) {
      const err = error as { message?: string };
      message.error(err.message || '卸下宝石失败');
    } finally {
      setSocketSubmitting(false);
    }
  }, [activeItem, message, refresh, removeSlot]);

  const bagOnlyItems = useMemo(() => items.filter((i) => i.location === 'bag'), [items]);

  const batchSubCategoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of bagOnlyItems) {
      if (it.subCategory) set.add(it.subCategory);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bagOnlyItems]);

  const batchEquipSlotOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of bagOnlyItems) {
      if (it.category !== 'equipment') continue;
      const slot = it.equip?.equipSlot;
      if (slot) set.add(slot);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [bagOnlyItems]);

  const batchCandidates = useMemo(() => {
    const kw = batchKeyword.trim().toLowerCase();

    let list = bagOnlyItems.filter((i) => !i.locked);
    if (batchMode === 'disassemble') {
      list = list.filter((i) => i.category === 'equipment');
      if (batchEquipSlot !== 'all') {
        list = list.filter((i) => (i.equip?.equipSlot ?? '') === batchEquipSlot);
      }
    } else {
      if (batchCategory !== 'all') {
        list = list.filter((i) => i.category === batchCategory);
      }
      if (batchSubCategory !== 'all') {
        list = list.filter((i) => (i.subCategory ?? '') === batchSubCategory);
      }
    }

    if (batchQualities.length > 0) {
      const allowed = new Set(batchQualities);
      list = list.filter((i) => allowed.has(i.quality));
    }

    if (kw) {
      list = list.filter((i) => `${i.name}${i.tags.join('')}`.toLowerCase().includes(kw));
    }

    return list;
  }, [bagOnlyItems, batchCategory, batchEquipSlot, batchKeyword, batchMode, batchQualities, batchSubCategory]);

  const batchSummary = useMemo(() => {
    if (batchMode === 'disassemble') {
      let cui = 0;
      let yun = 0;
      for (const it of batchCandidates) {
        if (it.quality === '黄' || it.quality === '玄') cui += 1;
        else yun += 1;
      }
      const parts: string[] = [];
      if (cui > 0) parts.push(`淬灵石×${cui}`);
      if (yun > 0) parts.push(`蕴灵石×${yun}`);
      return parts.join('，');
    }

    const qty = batchCandidates.reduce((sum, it) => sum + Math.max(0, it.qty || 0), 0);
    return `共${qty}件`;
  }, [batchCandidates, batchMode]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1040}
      className="bag-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setActiveId(null);
      }}
    >
      <div className="bag-modal-shell">
        <div className="bag-modal-left">
          <div className="bag-modal-left-top">
            <Tabs
              size="small"
              activeKey={category}
              onChange={(k) => {
                setCategory(k as BagCategory);
                setActiveId(null);
              }}
              items={(Object.keys(categoryLabels) as BagCategory[]).map((key) => ({
                key,
                label: categoryLabels[key],
              }))}
            />

            <div className="bag-modal-filters">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索物品..."
                allowClear
                prefix={<SearchOutlined />}
                size="middle"
              />
              <Select
                value={sort}
                onChange={(v) => setSort(v)}
                size="middle"
                options={[
                  { value: 'default', label: '默认排序' },
                  { value: 'qualityDesc', label: '按品质' },
                  { value: 'qtyDesc', label: '按数量' },
                  { value: 'nameAsc', label: '按名称 A-Z' },
                  { value: 'nameDesc', label: '按名称 Z-A' },
                ]}
              />
              <Select
                value={quality}
                onChange={(v) => setQuality(v)}
                size="middle"
                options={[
                  { value: 'all', label: '全部品质' },
                  ...qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] })),
                ]}
              />
              <Button
                size="middle"
                onClick={() => setFilterOpen(true)}
                className={activeFilterCount > 0 ? 'bag-filter-btn is-active' : 'bag-filter-btn'}
                icon={<FilterOutlined />}
              >
                筛选{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
              </Button>
            </div>
          </div>

          <div className="bag-modal-grid">
            {filtered.map((it) => (
              <div
                key={it.id}
                className={`bag-cell ${qualityClass[it.quality]} ${it.id === safeActiveId ? 'is-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(it.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveId(it.id);
                }}
              >
                {it.stackMax > 1 ? <div className="bag-cell-count">{it.qty}</div> : null}
                {it.location === 'equipped' ? <div className="bag-cell-equipped-badge">已穿戴</div> : null}
                <img className="bag-cell-icon" src={it.icon} alt={it.name} />
                <div className="bag-cell-name">{it.name}</div>
              </div>
            ))}
            {filtered.length === 0 ? (
              <div className="bag-modal-empty">{loading ? '加载中...' : '暂无物品'}</div>
            ) : null}
            {loading && filtered.length > 0 ? <div className="bag-modal-grid-overlay">加载中...</div> : null}
          </div>

          <div className="bag-modal-left-footer">
            <div className="bag-modal-slot-text">
              已用 {usedSlots} / {totalSlots} 格
            </div>
            <div className="bag-modal-left-footer-actions">
              <Button
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  openBatch('disassemble');
                }}
              >
                一键分解
              </Button>
              <Button
                danger
                disabled={loading}
                onClick={() => {
                  if (loading) return;
                  openBatch('remove');
                }}
              >
                一键丢弃
              </Button>
              <Button
                type="primary"
                loading={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    const res = await sortInventory('bag');
                    if (!res.success) throw new Error(res.message || '整理失败');
                    await refresh();
                  } catch (error: unknown) {
                    const err = error as { message?: string };
                    message.error(err.message || '整理失败');
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                一键整理
              </Button>
            </div>
          </div>
        </div>

        <div className="bag-modal-right">
          {activeItem ? (
            <>
              <div className="bag-detail">
                <div className="bag-detail-head">
                  <div className="bag-detail-img">
                    <img src={activeItem.icon} alt={activeItem.name} />
                  </div>
                  <div className="bag-detail-meta">
                    <div className="bag-detail-name">{activeItem.name}</div>
                    <div className="bag-detail-tags">
                      <Tag color="blue">{categoryLabels[activeItem.category]}</Tag>
                      <Tag color={qualityColor[activeItem.quality]}>{qualityLabelText[activeItem.quality]}</Tag>
                      {activeItem.tags.map((t) => (
                        <Tag key={t} color="default">
                          {t}
                        </Tag>
                      ))}
                    </div>
                    {activeItem.stackMax > 1 ? (
                      <div className="bag-detail-sub">
                        数量：{activeItem.qty} / {activeItem.stackMax}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="bag-detail-scroll">
                  <div className="bag-detail-body">
                    {hasDesc ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">物品描述</div>
                        <div className="bag-detail-text">{activeItem.desc}</div>
                      </div>
                    ) : null}

                    {hasEquipAttrs ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">装备属性</div>
                        <div className="bag-detail-attr-grid">
                          {equipLines.map((line, idx) => (
                            <div key={`${idx}-${line}`} className="bag-detail-attr-item">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {hasEffects ? (
                      <div className="bag-detail-section">
                        <div className="bag-detail-title">效果 / 说明</div>
                        <div className="bag-detail-lines">
                          {activeItem.effects.map((line) => (
                            <div key={line} className="bag-detail-line">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="bag-actions">
                {hasAction('use') ||
                hasAction('compose') ||
                hasAction('equip') ||
                hasAction('disassemble') ||
                hasAction('enhance') ||
                hasAction('show') ? (
                  <div className="bag-actions-row">
                    <div className="bag-actions-row-inner">
                      {hasAction('use') ? (
                        <Button
                          size="small"
                          type="primary"
                          disabled={loading || actionDisabled('use')}
                          onClick={() => void handleUseItem()}
                        >
                          使用
                        </Button>
                      ) : null}
                      {hasAction('compose') ? (
                        <Button size="small" disabled={actionDisabled('compose')}>
                          合成
                        </Button>
                      ) : null}
                      {hasAction('equip') ? (
                        <Button
                          size="small"
                          disabled={loading || actionDisabled('equip')}
                          onClick={() => void handleEquipToggle()}
                        >
                          {equipButtonText}
                        </Button>
                      ) : null}
                      {hasAction('disassemble') ? (
                        <Button
                          size="small"
                          danger
                          disabled={loading || actionDisabled('disassemble')}
                          onClick={() => setDisassembleOpen(true)}
                        >
                          分解
                        </Button>
                      ) : null}
                      {hasAction('enhance') ? (
                        <Button
                          size="small"
                          disabled={loading || actionDisabled('enhance')}
                          onClick={() => setEnhanceOpen(true)}
                        >
                          强化
                        </Button>
                      ) : null}
                      {hasAction('show') ? (
                        <Button size="small" disabled={actionDisabled('show')}>
                          展示
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="bag-modal-empty">请选择物品</div>
          )}
        </div>
      </div>

      <Modal
        open={filterOpen}
        onCancel={() => setFilterOpen(false)}
        footer={null}
        centered
        destroyOnHidden
        title="筛选"
        maskClosable
        className="bag-filter-modal"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="bag-filter-label">分类类型（多选）</div>
            <Select
              mode="multiple"
              value={filterCategories}
              onChange={(v) => {
                const next = (v as Array<Exclude<BagCategory, 'all'>>).filter(Boolean);
                setFilterCategories(next);
                if (next.length > 0) setCategory('all');
              }}
              placeholder="选择分类"
              options={(Object.keys(categoryLabels) as BagCategory[])
                .filter((k) => k !== 'all')
                .map((k) => ({ value: k, label: categoryLabels[k] }))}
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div className="bag-filter-label">品质（多选）</div>
            <Select
              mode="multiple"
              value={filterQualities}
              onChange={(v) => {
                const next = (v as BagQuality[]).filter(Boolean);
                setFilterQualities(next);
                if (next.length > 0) setQuality('all');
              }}
              placeholder="选择品质"
              options={qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] }))}
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div className="bag-filter-label">属性 / 词条（多选）</div>
            <Select
              mode="multiple"
              value={filterAttrKeys}
              onChange={(v) => setFilterAttrKeys((v as string[]).filter(Boolean))}
              placeholder="选择属性或词条"
              options={filterAttrKeyOptions}
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
            />
            <div className="bag-filter-hint">选择后仅展示包含对应属性/词条的装备</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              onClick={() => {
                setFilterCategories([]);
                setFilterQualities([]);
                setFilterAttrKeys([]);
              }}
            >
              重置
            </Button>
            <Button type="primary" onClick={() => setFilterOpen(false)}>
              确定
            </Button>
          </div>
        </div>
      </Modal>

      <DisassembleModal
        open={disassembleOpen}
        item={
          activeItem
            ? {
                id: activeItem.id,
                name: activeItem.name,
                quality: activeItem.quality,
                location: activeItem.location,
                locked: activeItem.locked,
              }
            : null
        }
        onClose={() => setDisassembleOpen(false)}
        onSuccess={refresh}
      />

      <Modal
        open={enhanceOpen}
        onCancel={() => {
          if (enhanceSubmitting || refineSubmitting || socketSubmitting) return;
          setEnhanceOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        title="装备成长"
        className="bag-enhance-modal"
        maskClosable={!(enhanceSubmitting || refineSubmitting || socketSubmitting)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Tabs
            size="small"
            activeKey={growthMode}
            onChange={(k) => setGrowthMode(k as 'enhance' | 'refine' | 'socket')}
            items={[
              { key: 'enhance', label: '强化' },
              { key: 'refine', label: '精炼' },
              { key: 'socket', label: '镶嵌' },
            ]}
          />

          <div className="bag-growth-header">
            <div className="bag-growth-header-name" style={{ color: activeItem?.quality ? qualityColor[activeItem.quality] : undefined }}>
              {activeItem?.name ?? '未选择'}
            </div>
            <div className="bag-growth-header-meta">
              {activeItem?.equip?.equipSlot ? <span>{getEquipSlotLabel(activeItem.equip.equipSlot)}</span> : null}
              {activeItem?.quality ? <span className={'bag-growth-quality-badge ' + qualityClass[activeItem.quality]}>{qualityLabelText[activeItem.quality]}</span> : null}
            </div>
          </div>

          {growthMode === 'enhance' && (enhanceState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{enhanceState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{enhanceState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPermyriadPercent(enhanceState.successRatePermyriad)}%</span>
                </div>
                {enhanceState.downgradeOnFail && <div className="bag-growth-tip-warn">失败掉级</div>}
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  <div className={'bag-growth-cost-chip' + (enhanceState.owned < 1 ? ' is-insufficient' : '')}>
                    <span className="bag-growth-cost-name">{enhanceState.materialName}</span>
                    <span className="bag-growth-cost-val">×1</span>
                    <span className="bag-growth-cost-own">/{enhanceState.owned}</span>
                  </div>
                  {enhanceState.silverCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSilver < enhanceState.silverCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">银两</span>
                      <span className="bag-growth-cost-val">{enhanceState.silverCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSilver.toLocaleString()}</span>
                    </div>
                  )}
                  {enhanceState.spiritStoneCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSpiritStones < enhanceState.spiritStoneCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">灵石</span>
                      <span className="bag-growth-cost-val">{enhanceState.spiritStoneCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSpiritStones.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="bag-growth-attr-grid">
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">当前属性</div>
                  {Object.entries(activeItem?.equip?.baseAttrs ?? {})
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`cur-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">强化后</div>
                  {Object.entries(enhanceState.previewBaseAttrs)
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`next-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  enhanceSubmitting ||
                  enhanceState.curLv >= 15 ||
                  enhanceState.owned < 1 ||
                  playerSilver < enhanceState.silverCost ||
                  playerSpiritStones < enhanceState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleEnhance()}
                loading={enhanceSubmitting}
              >
                {activeItem?.locked ? '物品已锁定' : enhanceState.curLv >= 15 ? '已达上限' : '强化'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可强化的装备</div>
          ))}

          {growthMode === 'refine' && (refineState ? (
            <>
              <div className="bag-growth-summary-card">
                <div className="bag-growth-summary-main">
                  <span className="bag-growth-level">+{refineState.curLv}</span>
                  <span className="bag-growth-arrow">→</span>
                  <span className="bag-growth-level bag-growth-level--target">+{refineState.targetLv}</span>
                  <span className="bag-growth-rate">{formatPermyriadPercent(refineState.successRatePermyriad)}%</span>
                </div>
              </div>

              <div className="bag-growth-cost-card">
                <div className="bag-growth-cost-title">消耗</div>
                <div className="bag-growth-cost-list">
                  <div className={'bag-growth-cost-chip' + (refineState.owned < refineState.materialQty ? ' is-insufficient' : '')}>
                    <span className="bag-growth-cost-name">{refineState.materialName}</span>
                    <span className="bag-growth-cost-val">×{refineState.materialQty}</span>
                    <span className="bag-growth-cost-own">/{refineState.owned}</span>
                  </div>
                  {refineState.silverCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSilver < refineState.silverCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">银两</span>
                      <span className="bag-growth-cost-val">{refineState.silverCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSilver.toLocaleString()}</span>
                    </div>
                  )}
                  {refineState.spiritStoneCost > 0 && (
                    <div className={'bag-growth-cost-chip' + (playerSpiritStones < refineState.spiritStoneCost ? ' is-insufficient' : '')}>
                      <span className="bag-growth-cost-name">灵石</span>
                      <span className="bag-growth-cost-val">{refineState.spiritStoneCost.toLocaleString()}</span>
                      <span className="bag-growth-cost-own">/{playerSpiritStones.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="bag-growth-attr-grid">
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">当前属性</div>
                  {Object.entries(activeItem?.equip?.baseAttrs ?? {})
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`ref-cur-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
                <div className="bag-growth-attr-col">
                  <div className="bag-growth-attr-title">精炼后</div>
                  {Object.entries(refineState.previewBaseAttrs)
                    .sort(([a], [b]) => (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b))
                    .map(([k, v]) => (
                      <div className="bag-growth-attr-row" key={`ref-next-${k}`}>
                        <span>{attrLabel[k] ?? k}</span>
                        <span>{permyriadPercentKeys.has(k) ? formatSignedPermyriadPercent(v) : formatSignedNumber(v)}</span>
                      </div>
                    ))}
                </div>
              </div>

              <Button
                block
                disabled={
                  refineSubmitting ||
                  refineState.curLv >= 10 ||
                  refineState.owned < refineState.materialQty ||
                  playerSilver < refineState.silverCost ||
                  playerSpiritStones < refineState.spiritStoneCost ||
                  !!activeItem?.locked
                }
                type="primary"
                onClick={() => void handleRefine()}
                loading={refineSubmitting}
              >
                {activeItem?.locked ? '物品已锁定' : refineState.curLv >= 10 ? '已达上限' : '精炼'}
              </Button>
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可精炼的装备</div>
          ))}

          {growthMode === 'socket' && (socketState ? (
            <>
              <div>孔位：{socketState.socketed.length}/{socketState.socketMax}</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Select
                  value={socketState.selectedSlot}
                  onChange={(v) => setSocketSlot(typeof v === 'number' ? v : undefined)}
                  placeholder="选择孔位"
                  options={socketState.availableSlots.map((slot) => {
                    const existed = socketState.socketed.find((g) => g.slot === slot);
                    return {
                      value: slot,
                      label: existed ? `孔位${slot}（已镶嵌：${existed.name ?? existed.itemDefId}）` : `孔位${slot}（空）`,
                    };
                  })}
                />
                <Select
                  value={selectedGemItemId}
                  onChange={(v) => setSelectedGemItemId(typeof v === 'number' ? v : undefined)}
                  placeholder="选择宝石"
                  options={socketState.candidates.map((g) => ({ value: g.id, label: `${g.name} x${g.qty}` }))}
                />
              </div>

              <div style={{ color: 'var(--text-secondary)' }}>
                {socketState.selectedGem
                  ? `已选宝石：${socketState.selectedGem.name}（类型：${socketState.selectedGemType}）`
                  : '请选择可镶嵌宝石'}
              </div>
              {socketState.selectedGem && socketState.selectedSlot !== undefined && !socketState.typeValid ? (
                <div className="bag-enhance-warning">宝石类型与孔位不匹配</div>
              ) : null}

              <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
                <Select
                  value={removeSlot}
                  onChange={(v) => setRemoveSlot(typeof v === 'number' ? v : undefined)}
                  placeholder="选择卸下孔位"
                  style={{ minWidth: 220 }}
                  options={socketState.socketed.map((g) => ({ value: g.slot, label: `孔位${g.slot}：${g.name ?? g.itemDefId}` }))}
                />
                <div style={{ display: 'flex', gap: 10 }}>
                  <Button
                    disabled={socketSubmitting || removeSlot === undefined || !!activeItem?.locked}
                    onClick={() => void handleRemoveSocket()}
                    loading={socketSubmitting}
                  >
                    卸下宝石
                  </Button>
                  <Button
                    type="primary"
                    disabled={
                      socketSubmitting ||
                      !socketState.selectedGem ||
                      socketState.selectedSlot === undefined ||
                      !socketState.slotValid ||
                      !socketState.typeValid ||
                      !!activeItem?.locked
                    }
                    onClick={() => void handleSocket()}
                    loading={socketSubmitting}
                  >
                    镶嵌宝石
                  </Button>
                </div>
              </div>

              {activeItem?.locked ? <div className="bag-enhance-hint">物品已锁定</div> : null}
            </>
          ) : (
            <div className="bag-enhance-hint">请选择可镶嵌的装备</div>
          ))}
        </div>
      </Modal>

      <Modal
        open={batchOpen}
        onCancel={() => {
          if (batchSubmitting) return;
          setBatchOpen(false);
        }}
        footer={null}
        centered
        destroyOnHidden
        title={batchMode === 'disassemble' ? '一键分解' : '一键丢弃'}
        maskClosable={!batchSubmitting}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Select
              mode="multiple"
              value={batchQualities}
              onChange={(v) => setBatchQualities(v as BagQuality[])}
              placeholder="品质"
              options={qualityLabels.map((q) => ({ value: q, label: qualityLabelText[q] }))}
            />
            <Input value={batchKeyword} onChange={(e) => setBatchKeyword(e.target.value)} placeholder="搜索名称/标签" allowClear />
            {batchMode === 'remove' ? (
              <>
                <Select
                  value={batchCategory}
                  onChange={(v) => setBatchCategory(v as BagCategory)}
                  placeholder="类型"
                  options={[
                    { value: 'all', label: '全部类型' },
                    { value: 'consumable', label: categoryLabels.consumable },
                    { value: 'material', label: categoryLabels.material },
                    { value: 'equipment', label: categoryLabels.equipment },
                    { value: 'skill', label: categoryLabels.skill },
                    { value: 'quest', label: categoryLabels.quest },
                  ]}
                />
                <Select
                  value={batchSubCategory}
                  onChange={(v) => setBatchSubCategory(String(v))}
                  placeholder="子类型"
                  options={[{ value: 'all', label: '全部子类型' }, ...batchSubCategoryOptions.map((s) => ({ value: s, label: s }))]}
                />
              </>
            ) : (
              <>
                <Select
                  value={batchEquipSlot}
                  onChange={(v) => setBatchEquipSlot(String(v))}
                  placeholder="装备部位"
                  options={[
                    { value: 'all', label: '全部部位' },
                    ...batchEquipSlotOptions.map((s) => ({ value: s, label: getEquipSlotLabel(s) })),
                  ]}
                />
                <Select value="bag" disabled options={[{ value: 'bag', label: '仅背包' }]} />
              </>
            )}
          </div>

          <div style={{ color: 'rgba(255,255,255,0.7)' }}>
            将处理 {batchCandidates.length} 个物品{batchSummary ? `（${batchSummary}）` : ''}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.55)' }}>已自动排除：已穿戴、已锁定</div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              disabled={batchSubmitting}
              onClick={() => {
                if (batchSubmitting) return;
                setBatchOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              type="primary"
              danger={batchMode === 'remove'}
              loading={batchSubmitting}
              disabled={batchCandidates.length === 0}
              onClick={async () => {
                if (batchCandidates.length === 0) return;
                setBatchSubmitting(true);
                try {
                  const ids = batchCandidates.map((x) => x.id);
                  if (batchMode === 'disassemble') {
                    const res = await disassembleInventoryEquipmentBatch(ids);
                    if (!res.success) throw new Error(res.message || '分解失败');
                    message.success(res.message || '分解成功');
                  } else {
                    const res = await removeInventoryItemsBatch(ids);
                    if (!res.success) throw new Error(res.message || '丢弃失败');
                    message.success(res.message || '丢弃成功');
                  }
                  await refresh();
                  setBatchOpen(false);
                } catch (error: unknown) {
                  const err = error as { message?: string };
                  message.error(err.message || '操作失败');
                } finally {
                  setBatchSubmitting(false);
                }
              }}
            >
              {batchMode === 'disassemble' ? '确认分解' : '确认丢弃'}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
};

const MOBILE_BREAKPOINT = 768;

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= MOBILE_BREAKPOINT);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
};

const BagModalSwitch: React.FC<{ open: boolean; onClose: () => void }> = (props) => {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileBagModal {...props} />;
  return <BagModal {...props} />;
};

export default BagModalSwitch;
