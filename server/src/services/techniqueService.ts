import { query } from '../config/database.js';

export type TechniqueDefRow = {
  id: string;
  code: string | null;
  name: string;
  type: string;
  quality: string;
  quality_rank: number;
  max_layer: number;
  required_realm: string;
  attribute_type: string;
  attribute_element: string;
  tags: string[];
  description: string | null;
  long_desc: string | null;
  icon: string | null;
  obtain_type: string | null;
  obtain_hint: string[];
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export type TechniqueLayerRow = {
  technique_id: string;
  layer: number;
  cost_spirit_stones: number;
  cost_exp: number;
  cost_materials: unknown;
  passives: unknown;
  unlock_skill_ids: string[];
  upgrade_skill_ids: string[];
  required_realm: string | null;
  required_quest_id: string | null;
  layer_desc: string | null;
};

export type SkillDefRow = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  source_type: string;
  source_id: string | null;
  cost_lingqi: number;
  cost_qixue: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string | null;
  element: string;
  effects: unknown[];
  trigger_type: string;
  conditions: unknown;
  ai_priority: number;
  ai_conditions: unknown;
  upgrades: unknown;
  sort_weight: number;
  version: number;
  enabled: boolean;
};

const coerceCostMaterials = (raw: unknown): Array<{ itemId: string; qty: number }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const itemId = (x as { itemId?: unknown }).itemId;
      const qty = (x as { qty?: unknown }).qty;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      return { itemId, qty };
    })
    .filter((v): v is { itemId: string; qty: number } => !!v);
};

const getItemMetaMap = async (itemIds: string[]): Promise<Map<string, { name: string; icon: string | null }>> => {
  const uniq = Array.from(new Set(itemIds.filter((x) => typeof x === 'string' && x.trim().length > 0)));
  if (uniq.length === 0) return new Map();
  const result = await query(`SELECT id, name, icon FROM item_def WHERE id = ANY($1::text[]) AND enabled = true`, [uniq]);
  return new Map(result.rows.map((r) => [r.id, { name: r.name, icon: r.icon ?? null }]));
};

export const getEnabledTechniqueDefs = async (): Promise<TechniqueDefRow[]> => {
  const result = await query(
    `
      SELECT
        id, code, name, type, quality, quality_rank, max_layer, required_realm,
        attribute_type, attribute_element,
        tags, description, long_desc, icon, obtain_type, obtain_hint,
        sort_weight, version, enabled
      FROM technique_def
      WHERE enabled = true
      ORDER BY sort_weight DESC, quality_rank DESC, id ASC
    `
  );
  return result.rows;
};

export const getTechniqueDefById = async (techniqueId: string): Promise<TechniqueDefRow | null> => {
  const result = await query(
    `
      SELECT
        id, code, name, type, quality, quality_rank, max_layer, required_realm,
        attribute_type, attribute_element,
        tags, description, long_desc, icon, obtain_type, obtain_hint,
        sort_weight, version, enabled
      FROM technique_def
      WHERE id = $1
      LIMIT 1
    `,
    [techniqueId]
  );
  return result.rows[0] ?? null;
};

export const getTechniqueLayersByTechniqueId = async (techniqueId: string): Promise<TechniqueLayerRow[]> => {
  const result = await query(
    `
      SELECT
        technique_id, layer, cost_spirit_stones, cost_exp, cost_materials,
        passives, unlock_skill_ids, upgrade_skill_ids, required_realm, required_quest_id, layer_desc
      FROM technique_layer
      WHERE technique_id = $1
      ORDER BY layer ASC
    `,
    [techniqueId]
  );
  const rows = result.rows as TechniqueLayerRow[];
  const itemIds: string[] = [];
  for (const r of rows) {
    for (const m of coerceCostMaterials(r.cost_materials)) {
      itemIds.push(m.itemId);
    }
  }
  const metaMap = await getItemMetaMap(itemIds);
  return rows.map((r) => {
    const materials = coerceCostMaterials(r.cost_materials).map((m) => {
      const meta = metaMap.get(m.itemId) ?? null;
      return { itemId: m.itemId, qty: m.qty, itemName: meta?.name, itemIcon: meta?.icon };
    });
    return { ...r, cost_materials: materials };
  });
};

export const getSkillsByTechniqueId = async (techniqueId: string): Promise<SkillDefRow[]> => {
  const result = await query(
    `
      SELECT
        id, code, name, description, icon, source_type, source_id,
        cost_lingqi, cost_qixue, cooldown, target_type, target_count,
        damage_type, element,
        effects, trigger_type, conditions, ai_priority, ai_conditions, upgrades,
        sort_weight, version, enabled
      FROM skill_def
      WHERE source_type = 'technique' AND source_id = $1 AND enabled = true
      ORDER BY sort_weight DESC, id ASC
    `,
    [techniqueId]
  );
  return result.rows;
};

export const getTechniqueDetailById = async (
  techniqueId: string
): Promise<{ technique: TechniqueDefRow; layers: TechniqueLayerRow[]; skills: SkillDefRow[] } | null> => {
  const technique = await getTechniqueDefById(techniqueId);
  if (!technique) return null;
  const [layers, skills] = await Promise.all([
    getTechniqueLayersByTechniqueId(techniqueId),
    getSkillsByTechniqueId(techniqueId),
  ]);
  return { technique, layers, skills };
};
