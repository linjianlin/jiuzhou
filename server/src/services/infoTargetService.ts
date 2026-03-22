/**
 * 信息目标详情服务
 *
 * 作用：
 * - 聚合 NPC / 怪物 / 物品 / 玩家 的信息面板数据
 *
 * 输入：
 * - type: 目标类型（npc | monster | item | player）
 * - id: 目标唯一标识（玩家为角色ID字符串）
 *
 * 输出：
 * - MapObjectDto | null（找不到目标时返回 null）
 */
import { query } from '../config/database.js';
import {
  getCharacterComputedByCharacterId,
  type CharacterComputedRow,
} from './characterComputedService.js';
import { loadPlayerInventoryStatesByCharacterId } from './playerStateRepository.js';
import type { MapObjectDto } from './roomObjectService.js';
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getMonsterDefinitions,
  getNpcDefinitions,
  getTechniqueDefinitions,
} from './staticConfigLoader.js';
import { resolveDropPoolById } from './dropPoolResolver.js';
import {
  getAdjustedChance,
  getAdjustedWeight,
  normalizeMonsterKind,
  type DropEntrySourceType,
  type MonsterKind,
} from './shared/dropRateMultiplier.js';
import { getAdjustedDropQuantityRange } from './shared/dropQuantityMultiplier.js';
import { getGemLevel, isGemItemDefinition } from './shared/gemItemSemantics.js';
import { getMonthCardActiveMapByCharacterIds } from './shared/monthCardBenefits.js';
import {
  CHARACTER_ATTR_DEFINITION_LIST,
  CHARACTER_ATTR_LABEL_MAP,
  CHARACTER_RATIO_ATTR_KEY_SET,
} from './shared/characterAttrRegistry.js';

type InfoTargetType = 'npc' | 'monster' | 'item' | 'player';

type DropEntryRow = {
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
  sort_order: number;
  bind_type: string | null;
  sourceType: DropEntrySourceType;
  sourcePoolId: string;
};

type NpcRow = {
  id: string;
  name: string;
  title: string | null;
  gender: string | null;
  realm: string | null;
  avatar: string | null;
  description: string | null;
  drop_pool_id: string | null;
};

type MonsterRow = {
  id: string;
  name: string;
  title: string | null;
  realm: string | null;
  avatar: string | null;
  kind: string | null;
  base_attrs: unknown;
  attr_variance: unknown;
  attr_multiplier_min: unknown;
  attr_multiplier_max: unknown;
  drop_pool_id: string | null;
};

type ItemRow = {
  id: string;
  name: string;
  category: string | null;
  sub_category: string | null;
  quality: string | null;
  gem_level: number | null;
  icon: string | null;
  description: string | null;
  long_desc: string | null;
  equip_req_realm: string | null;
  use_req_realm: string | null;
  base_attrs: unknown;
};

type EquippedRow = {
  equipped_slot: string | null;
  item_def_id: string | null;
  item_quality: string | null;
};

type EquippedTechniqueRow = {
  technique_id: string | null;
  current_layer: number | null;
};

const attrLabelMap: Record<string, string> = {
  jing: '精',
  qi: '气',
  shen: '神',
  ...CHARACTER_ATTR_LABEL_MAP,
};

const playerInfoAttrKeys = CHARACTER_ATTR_DEFINITION_LIST.reduce<Array<keyof CharacterComputedRow>>((keys, entry) => {
  if (entry.key !== 'qixue' && entry.key !== 'lingqi') {
    keys.push(entry.key);
  }
  return keys;
}, []);

const formatPercent = (value: number): string => {
  const percent = value * 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') || '0' : fixed;
  return `${trimmed}%`;
};

const toStatsFromAttrs = (attrs: unknown, prefix: string): Array<{ label: string; value: string | number }> => {
  if (!attrs) return [];
  let obj: unknown = attrs;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const entries = Object.entries(obj as Record<string, unknown>);
  const rows: Array<{ label: string; value: string | number }> = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const label = attrLabelMap[key] ?? key;
    if (CHARACTER_RATIO_ATTR_KEY_SET.has(key)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) {
        rows.push({ label: `${prefix}${label}`, value: formatPercent(n) });
        continue;
      }
    }
    rows.push({ label: `${prefix}${label}`, value });
  }
  return rows;
};

const asNumberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!value) return undefined;
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const buildMonsterStats = (
  baseAttrs: Record<string, number> | undefined,
) => {
  const attrs = baseAttrs ?? {};
  if (Object.keys(attrs).length === 0) return [];

  const knownKeys = Object.keys(attrLabelMap);
  const used = new Set<string>();
  const rows: Array<{ label: string; value: string | number }> = [];

  for (const k of knownKeys) {
    if (!(k in attrs)) continue;
    used.add(k);
    rows.push({ label: attrLabelMap[k] ?? k, value: attrs[k] });
  }

  const extraKeys = Object.keys(attrs).filter((k) => !used.has(k));
  extraKeys.sort((a, b) => a.localeCompare(b));
  for (const k of extraKeys) {
    rows.push({ label: attrLabelMap[k] ?? k, value: attrs[k] });
  }

  return rows;
};

const formatRatioPercent = (ratio: number): string => {
  return formatPercent(ratio);
};

const formatChance = (mode: string, chance: number, weight: number, totalWeight: number): string => {
  if (mode === 'weight') {
    if (totalWeight <= 0) return '-';
    return formatRatioPercent(weight / totalWeight);
  }
  return formatRatioPercent(chance);
};

const buildPlayerStats = (
  computed: CharacterComputedRow,
): Array<{ label: string; value: string | number }> => {
  const rows: Array<{ label: string; value: string | number }> = [];

  for (const key of playerInfoAttrKeys) {
    const value = computed[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const label = attrLabelMap[key] ?? key;
    rows.push({
      label,
      value: CHARACTER_RATIO_ATTR_KEY_SET.has(key) ? formatPercent(value) : value,
    });
  }

  return rows;
};

const buildFullRealm = (realmRaw: string | null, subRealmRaw: string | null): string => {
  const realm = typeof realmRaw === 'string' ? realmRaw.trim() : '';
  const sub = typeof subRealmRaw === 'string' ? subRealmRaw.trim() : '';
  if (!realm) return '凡人';
  if (realm === '凡人' || !sub) return realm;
  return `${realm}·${sub}`;
};

const normalizeGender = (value: string | null): string | undefined => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  if (raw === 'male') return '男';
  if (raw === 'female') return '女';
  return raw;
};

const EQUIPPED_SLOT_TO_UI_LABEL: Record<string, string> = {
  weapon: '武器',
  head: '头部',
  clothes: '衣服',
  gloves: '护手',
  pants: '下装',
  necklace: '项链',
  accessory: '饰品',
  artifact: '法宝',
};

const getDropsByPoolId = async (
  dropPoolId: string,
  options: {
    isDungeonBattle?: boolean;
    monsterKind?: MonsterKind;
    monsterRealm?: string | null;
  } = {},
): Promise<Array<{ name: string; quality: string; chance: string }>> => {
  const pool = resolveDropPoolById(dropPoolId);
  if (!pool) return [];
  const multiplierOptions = {
    isDungeonBattle: options.isDungeonBattle === true,
    monsterKind: normalizeMonsterKind(options.monsterKind),
    monsterRealm: options.monsterRealm ?? null,
  };

  const mode: 'prob' | 'weight' = pool.mode;
  const entries = pool.entries
    .filter((entry) => entry.show_in_ui)
    .map((entry) => {
      const itemDefId = entry.item_def_id.trim();
      return {
        mode,
        item_def_id: itemDefId,
        chance: Number(entry.chance) || 0,
        weight: Number(entry.weight) || 0,
        chance_add_by_monster_realm: Number(entry.chance_add_by_monster_realm) || 0,
        qty_min: entry.qty_min,
        qty_max: entry.qty_max,
        qty_min_add_by_monster_realm: entry.qty_min_add_by_monster_realm,
        qty_max_add_by_monster_realm: entry.qty_max_add_by_monster_realm,
        qty_multiply_by_monster_realm: Number(entry.qty_multiply_by_monster_realm) || 1,
        sort_order: Math.max(0, Math.floor(Number(entry.sort_order) || 0)),
        bind_type: entry.bind_type,
        sourceType: entry.sourceType,
        sourcePoolId: entry.sourcePoolId,
      } satisfies DropEntryRow;
    })
    .filter((entry) => entry.item_def_id.length > 0)
    .sort((left, right) => left.sort_order - right.sort_order || left.item_def_id.localeCompare(right.item_def_id));

  const rows = entries;
  if (rows.length === 0) return [];

  const itemDefIds = Array.from(new Set(rows.map((entry) => entry.item_def_id)));
  const itemDefs = getItemDefinitionsByIds(itemDefIds);
  const itemDefMap = new Map<string, { id: string; name: string; quality: string | null }>();
  for (const itemId of itemDefIds) {
    const def = itemDefs.get(itemId);
    if (!def) continue;
    itemDefMap.set(itemId, {
      id: itemId,
      name: String(def.name || itemId),
      quality: typeof def.quality === 'string' ? def.quality : null,
    });
  }

  const totalWeight = mode === 'weight'
    ? rows.reduce(
      (sum, r) =>
        sum + getAdjustedWeight(r.weight, r.sourceType, r.sourcePoolId, multiplierOptions),
      0,
    )
    : 0;

  return rows.map((r) => {
    const itemDef = itemDefMap.get(r.item_def_id);
    const baseName = (itemDef?.name ?? r.item_def_id ?? '未知').trim() || '未知';
    const quantityRange = getAdjustedDropQuantityRange({
      itemDefId: r.item_def_id,
      qtyMin: r.qty_min,
      qtyMax: r.qty_max,
      qtyMinAddByMonsterRealm: r.qty_min_add_by_monster_realm,
      qtyMaxAddByMonsterRealm: r.qty_max_add_by_monster_realm,
      sourceType: r.sourceType,
      sourcePoolId: r.sourcePoolId,
      dropMultiplierOptions: multiplierOptions,
      qtyMultiplyByMonsterRealm: r.qty_multiply_by_monster_realm,
      monsterRealm: options.monsterRealm ?? null,
    });
    const qtyMin = quantityRange.qtyMin;
    const qtyMax = quantityRange.qtyMax;
    const qtyText =
      qtyMin === qtyMax ? (qtyMin > 1 ? `×${qtyMin}` : '') : `×${Math.max(1, qtyMin)}-${Math.max(qtyMin, qtyMax)}`;
    const name = `${baseName}${qtyText}`;

    const quality = (itemDef?.quality ?? '-').trim() || '-';
    const chanceVal = Number(r.chance ?? 0);
    const weightVal = Number(r.weight ?? 0);
    const chance = formatChance(
      mode,
      getAdjustedChance(chanceVal, r.sourceType, r.sourcePoolId, {
        ...multiplierOptions,
        chanceAddByMonsterRealm: r.chance_add_by_monster_realm,
      }),
      getAdjustedWeight(weightVal, r.sourceType, r.sourcePoolId, multiplierOptions),
      totalWeight,
    );

    return { name, quality, chance };
  });
};

export const getInfoTargetDetail = async (type: InfoTargetType, id: string): Promise<MapObjectDto | null> => {
  if (type === 'npc') {
    const npc = (getNpcDefinitions().find((entry) => entry.enabled !== false && entry.id === id) ?? null) as NpcRow | null;
    if (!npc) return null;
    const drops = npc.drop_pool_id ? await getDropsByPoolId(npc.drop_pool_id) : [];
    return {
      type: 'npc',
      id: npc.id,
      name: npc.name,
      title: npc.title ?? undefined,
      gender: npc.gender ?? undefined,
      realm: npc.realm ?? undefined,
      avatar: npc.avatar ?? null,
      desc: npc.description ?? undefined,
      drops,
    };
  }

  if (type === 'monster') {
    const monster = (getMonsterDefinitions().find((entry) => entry.enabled !== false && entry.id === id) ?? null) as MonsterRow | null;
    if (!monster) return null;
    const monsterKind = normalizeMonsterKind(monster.kind);
    const drops = monster.drop_pool_id
      ? await getDropsByPoolId(monster.drop_pool_id, { isDungeonBattle: false, monsterKind, monsterRealm: monster.realm })
      : [];
    const baseAttrs = asNumberRecord(monster.base_attrs);
    const stats = buildMonsterStats(baseAttrs);
    const variance = asNumber(monster.attr_variance);
    const multMin = asNumber(monster.attr_multiplier_min);
    const multMax = asNumber(monster.attr_multiplier_max);

    if (typeof variance === 'number') stats.push({ label: '属性波动', value: `±${formatRatioPercent(variance)}` });
    if (typeof multMin === 'number' && typeof multMax === 'number') {
      stats.push({ label: '整体倍率', value: `${multMin.toFixed(2)} - ${multMax.toFixed(2)}` });
    }

    return {
      type: 'monster',
      id: monster.id,
      name: monster.name,
      title: monster.title ?? undefined,
      gender: '-',
      realm: monster.realm ?? undefined,
      avatar: monster.avatar ?? null,
      base_attrs: baseAttrs,
      attr_variance: variance,
      attr_multiplier_min: multMin,
      attr_multiplier_max: multMax,
      stats: stats.length > 0 ? stats : undefined,
      drops,
    };
  }

  if (type === 'item') {
    const def = getItemDefinitionById(id);
    const gemLevel = isGemItemDefinition(def) ? getGemLevel(def) : null;
    const item = def && def.enabled !== false
      ? ({
          id: def.id,
          name: def.name,
          category: def.category ?? null,
          sub_category: def.sub_category ?? null,
          quality: def.quality ?? null,
          gem_level: gemLevel,
          icon: def.icon ?? null,
          description: def.description ?? null,
          long_desc: def.long_desc ?? null,
          equip_req_realm: def.equip_req_realm ?? null,
          use_req_realm: def.use_req_realm ?? null,
          base_attrs: def.base_attrs ?? null,
        } satisfies ItemRow)
      : null;
    if (!item) return null;

    const desc = item.long_desc || item.description || null;
    const realm =
      item.equip_req_realm || item.use_req_realm || (item.gem_level !== null ? `等级${item.gem_level}` : null);
    const baseStats = toStatsFromAttrs(item.base_attrs, '');
    const stats = baseStats;

    return {
      type: 'item',
      id: item.id,
      name: item.name,
      title: item.quality ?? undefined,
      gender: '-',
      realm: realm ?? undefined,
      avatar: item.icon ?? null,
      desc: desc ?? undefined,
      stats: stats.length > 0 ? stats : undefined,
    };
  }

  if (type === 'player') {
    const characterId = Math.floor(Number(id));
    if (!Number.isFinite(characterId) || characterId <= 0) return null;

    const [computed, equippedStates, techRes] = await Promise.all([
      getCharacterComputedByCharacterId(characterId),
      loadPlayerInventoryStatesByCharacterId(characterId),
      query(
        `
          SELECT
            ct.technique_id,
            ct.current_layer
          FROM character_technique ct
          WHERE ct.character_id = $1 AND ct.slot_type IS NOT NULL
          ORDER BY ct.slot_type ASC, ct.slot_index ASC
        `,
        [characterId]
      ),
    ]);

    if (!computed) return null;

    const equipRows = equippedStates
      .filter((row) => String(row.location) === 'equipped')
      .sort((left, right) => {
        const slotCompare = String(left.equipped_slot || '').localeCompare(String(right.equipped_slot || ''));
        if (slotCompare !== 0) return slotCompare;
        return Number(left.id) - Number(right.id);
      })
      .map((row) => ({
        equipped_slot: row.equipped_slot,
        item_def_id: row.item_def_id,
        item_quality: typeof row.quality === 'string' ? row.quality : null,
      })) as EquippedRow[];
    const equipItemDefIds = Array.from(
      new Set(
        equipRows
          .map((row) => (typeof row.item_def_id === 'string' ? row.item_def_id.trim() : ''))
          .filter((itemDefId) => itemDefId.length > 0),
      ),
    );
    const equipDefs = getItemDefinitionsByIds(equipItemDefIds);
    const equipment = equipRows
      .map((r, idx) => {
        const slotCode = typeof r.equipped_slot === 'string' ? r.equipped_slot.trim() : '';
        const slot = slotCode ? (EQUIPPED_SLOT_TO_UI_LABEL[slotCode] ?? slotCode) : `槽位${idx + 1}`;
        const itemDefId = typeof r.item_def_id === 'string' ? r.item_def_id.trim() : '';
        const def = itemDefId ? equipDefs.get(itemDefId) : null;
        const name = typeof def?.name === 'string' ? def.name.trim() : '';
        const qualityFromInstance = typeof r.item_quality === 'string' ? r.item_quality.trim() : '';
        const qualityFromDef = typeof def?.quality === 'string' ? def.quality.trim() : '';
        const quality = qualityFromInstance || qualityFromDef;
        if (!slot || !name) return null;
        return { slot, name, quality: quality || '-' };
      })
      .filter((x): x is { slot: string; name: string; quality: string } => Boolean(x));

    const techRows = techRes.rows as EquippedTechniqueRow[];
    const techniqueMap = new Map(
      getTechniqueDefinitions()
        .filter((entry) => entry.enabled !== false)
        .map((entry) => [entry.id, entry] as const),
    );
    const techniques = techRows
      .map((r) => {
        const techniqueId = typeof (r as Record<string, unknown>).technique_id === 'string' ? String((r as Record<string, unknown>).technique_id) : '';
        const def = techniqueMap.get(techniqueId) ?? null;
        const name = typeof def?.name === 'string' ? def.name.trim() : '';
        if (!name) return null;
        const typeText = typeof def?.type === 'string' ? def.type.trim() : '';
        const layer = Number(r.current_layer ?? 0) || 0;
        const level = layer > 0 ? `${layer}重` : '-';
        return { name, level, type: typeText || '功法' };
      })
      .filter((x): x is { name: string; level: string; type: string } => Boolean(x));

    const name = computed.nickname.trim() || `修士${computed.id}`;
    const title = computed.title.trim() || '散修';
    const monthCardActive = (await getMonthCardActiveMapByCharacterIds([computed.id])).get(computed.id) ?? false;

    return {
      type: 'player',
      id: String(computed.id),
      name,
      monthCardActive,
      title,
      gender: normalizeGender(computed.gender) ?? '-',
      realm: buildFullRealm(computed.realm, computed.sub_realm),
      avatar: computed.avatar ?? null,
      stats: buildPlayerStats(computed),
      equipment,
      techniques,
    };
  }

  return null;
};
