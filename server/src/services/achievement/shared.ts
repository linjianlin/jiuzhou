import type { PoolClient } from 'pg';
import { query } from '../../config/database.js';
import type {
  AchievementDefRow,
  AchievementRewardConfig,
  AchievementStatus,
  AchievementTargetItem,
  AchievementTrackType,
  CharacterAchievementRow,
} from './types.js';

const CATEGORY_TO_POINTS_COLUMN: Record<string, 'combat' | 'cultivation' | 'exploration' | 'social' | 'collection' | null> = {
  combat: 'combat',
  cultivation: 'cultivation',
  skill: 'cultivation',
  technique: 'cultivation',
  exploration: 'exploration',
  dungeon: 'exploration',
  social: 'social',
  collection: 'collection',
  equipment: 'collection',
  life: 'collection',
};

export const TITLE_EFFECT_KEYS = [
  'qixue',
  'max_qixue',
  'lingqi',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
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
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
] as const;

const titleEffectKeySet = new Set<string>(TITLE_EFFECT_KEYS);

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
};

export const asFiniteInt = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
};

export const asFiniteNonNegativeInt = (value: unknown, fallback = 0): number => {
  return Math.max(0, asFiniteInt(value, fallback));
};

export const parseJsonObject = <T extends Record<string, unknown>>(value: unknown): T => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  return {} as T;
};

export const parseJsonArray = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  return value as T[];
};

export const normalizeAchievementStatus = (value: unknown): AchievementStatus => {
  const raw = asNonEmptyString(value) ?? 'in_progress';
  if (raw === 'completed') return 'completed';
  if (raw === 'claimed') return 'claimed';
  return 'in_progress';
};

export const normalizeTrackType = (value: unknown): AchievementTrackType => {
  const raw = asNonEmptyString(value) ?? 'counter';
  if (raw === 'flag') return 'flag';
  if (raw === 'multi') return 'multi';
  return 'counter';
};

export const normalizeTargetList = (value: unknown): AchievementTargetItem[] => {
  return parseJsonArray<AchievementTargetItem>(value);
};

export const normalizeRewards = (value: unknown): AchievementRewardConfig[] => {
  return parseJsonArray<AchievementRewardConfig>(value);
};

export const parseAchievementDefRow = (row: Record<string, unknown>): AchievementDefRow | null => {
  const id = asNonEmptyString(row.id);
  const name = asNonEmptyString(row.name);
  const trackKey = asNonEmptyString(row.track_key);
  if (!id || !name || !trackKey) return null;
  return {
    id,
    name,
    description: String(row.description ?? ''),
    category: asNonEmptyString(row.category) ?? 'combat',
    points: asFiniteNonNegativeInt(row.points, 0),
    icon: asNonEmptyString(row.icon),
    hidden: row.hidden === true,
    prerequisite_id: asNonEmptyString(row.prerequisite_id),
    track_type: normalizeTrackType(row.track_type),
    track_key: trackKey,
    target_value: Math.max(1, asFiniteNonNegativeInt(row.target_value, 1)),
    target_list: normalizeTargetList(row.target_list),
    rewards: normalizeRewards(row.rewards),
    title_id: asNonEmptyString(row.title_id),
    sort_weight: asFiniteInt(row.sort_weight, 0),
    enabled: row.enabled !== false,
    version: Math.max(1, asFiniteNonNegativeInt(row.version, 1)),
  };
};

export const parseCharacterAchievementRow = (row: Record<string, unknown>): CharacterAchievementRow | null => {
  const id = asFiniteNonNegativeInt(row.id, 0);
  const characterId = asFiniteNonNegativeInt(row.character_id, 0);
  const achievementId = asNonEmptyString(row.achievement_id);
  if (!id || !characterId || !achievementId) return null;
  return {
    id,
    character_id: characterId,
    achievement_id: achievementId,
    status: normalizeAchievementStatus(row.status),
    progress: asFiniteNonNegativeInt(row.progress, 0),
    progress_data: parseJsonObject<Record<string, number | boolean | string>>(row.progress_data),
    completed_at: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    claimed_at: row.claimed_at ? new Date(String(row.claimed_at)).toISOString() : null,
    updated_at: row.updated_at ? new Date(String(row.updated_at)).toISOString() : new Date(0).toISOString(),
  };
};

export const getPointColumnForCategory = (
  category: string,
): 'combat' | 'cultivation' | 'exploration' | 'social' | 'collection' | null => {
  const key = category.trim().toLowerCase();
  return CATEGORY_TO_POINTS_COLUMN[key] ?? null;
};

export const buildTrackKeyCandidates = (trackKey: string): string[] => {
  const key = trackKey.trim();
  if (!key) return [];
  const parts = key.split(':').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];

  const out = new Set<string>();
  out.add(parts.join(':'));

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const next = parts.slice(0, i).concat(Array(parts.length - i).fill('*')).join(':');
    out.add(next);
  }

  out.add('*');
  return Array.from(out);
};

export const normalizeTitleEffects = (effects: unknown): Record<string, number> => {
  const source = parseJsonObject<Record<string, unknown>>(effects);
  const flat = parseJsonObject<Record<string, unknown>>(source.flat);
  const candidates = Object.keys(flat).length > 0 ? flat : source;
  const out: Record<string, number> = {};

  for (const [key, raw] of Object.entries(candidates)) {
    if (!titleEffectKeySet.has(key)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const delta = Math.floor(value);
    if (delta === 0) continue;
    out[key] = delta;
  }

  return out;
};

export const ensureCharacterAchievementPoints = async (characterId: number): Promise<void> => {
  await query(
    `
      INSERT INTO character_achievement_points (character_id)
      VALUES ($1)
      ON CONFLICT (character_id) DO NOTHING
    `,
    [characterId],
  );
};

export const parseClaimedThresholds = (value: unknown): number[] => {
  const list = parseJsonArray<unknown>(value);
  const out = new Set<number>();
  for (const item of list) {
    const n = asFiniteNonNegativeInt(item, -1);
    if (n >= 0) out.add(n);
  }
  return Array.from(out).sort((a, b) => a - b);
};
