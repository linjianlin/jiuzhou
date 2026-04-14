import { afterTransactionCommit, hasUsableTransactionContext, query, withTransaction } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import type { InventoryItem } from '../inventory/shared/types.js';
import { lockCharacterInventoryMutex, lockCharacterInventoryMutexes } from '../inventoryMutex.js';
import { createScopedLogger } from '../../utils/logger.js';
import { tryInsertItemInstanceWithSlot } from './itemInstanceSlotInsert.js';

type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type ItemInstanceLocation = string;

export type CharacterItemInstanceMetadata = { [key: string]: JsonValue } | null;

export interface CharacterItemInstanceSnapshot extends Omit<InventoryItem, 'location' | 'metadata' | 'socketed_gems' | 'affixes'> {
  owner_user_id: number;
  owner_character_id: number;
  bind_owner_user_id: number | null;
  bind_owner_character_id: number | null;
  random_seed: string | null;
  affix_gen_version: number;
  affix_roll_meta: JsonValue;
  custom_name: string | null;
  expire_at: Date | null;
  obtained_from: string | null;
  obtained_ref_id: string | null;
  location: ItemInstanceLocation;
  metadata: CharacterItemInstanceMetadata;
  socketed_gems: JsonValue;
  affixes: JsonValue;
}

export type BufferedCharacterItemInstanceMutation = {
  opId: string;
  characterId: number;
  itemId: number;
  createdAt: number;
  kind: 'upsert' | 'delete';
  snapshot: CharacterItemInstanceSnapshot | null;
};

type LoadProjectedCharacterItemInstanceOptions = {
  pendingMutations?: readonly BufferedCharacterItemInstanceMutation[];
};

type ExistingItemInstanceLocationRow = {
  id: number | string;
  owner_character_id: number | string;
  location: string;
  location_slot: number | string | null;
};

type ExistingItemInstanceRow = ExistingItemInstanceLocationRow & {
  owner_user_id: number | string;
};

type ItemInstanceMutationFlushPlan = {
  slotReleaseItemIds: number[];
  duplicateTargetKeys: string[];
};

type ResolvedItemInstanceFlushInput = {
  effectiveMutations: BufferedCharacterItemInstanceMutation[];
  flushPlan: ItemInstanceMutationFlushPlan;
  droppedSortInventoryMutations: boolean;
};

type NormalizedItemInstanceMutations = {
  mutations: BufferedCharacterItemInstanceMutation[];
  droppedSortInventoryMutations: boolean;
};

export const buildItemInstanceIdArrayParam = (itemIds: readonly number[]): string[] => {
  return [...new Set(
    itemIds
      .map((itemId) => Math.floor(Number(itemId)))
      .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
      .map((itemId) => String(itemId)),
  )];
};

export const buildItemInstanceMutationHashField = (itemId: number): string => {
  return String(Math.floor(Number(itemId)));
};

export const collapseBufferedCharacterItemInstanceMutations = (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): BufferedCharacterItemInstanceMutation[] => {
  const latestMutationByItemId = new Map<number, BufferedCharacterItemInstanceMutation>();
  for (const mutation of mutations) {
    latestMutationByItemId.set(mutation.itemId, mutation);
  }
  return [...latestMutationByItemId.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.opId.localeCompare(right.opId));
};

const getItemInstanceMutationPrefix = (opId: string): string => {
  const normalized = String(opId || '').trim();
  const separatorIndex = normalized.indexOf(':');
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
};

export const pruneStaleSortInventoryMutations = (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): BufferedCharacterItemInstanceMutation[] => {
  const latestNonSortMutationCreatedAt = mutations
    .filter((mutation) => getItemInstanceMutationPrefix(mutation.opId) !== 'sort-inventory')
    .reduce((latest, mutation) => Math.max(latest, mutation.createdAt), 0);

  if (latestNonSortMutationCreatedAt <= 0) {
    return [...mutations];
  }

  return mutations.filter((mutation) => (
    getItemInstanceMutationPrefix(mutation.opId) !== 'sort-inventory'
    || mutation.createdAt > latestNonSortMutationCreatedAt
  ));
};

const buildSlotTargetKey = (
  mutation: BufferedCharacterItemInstanceMutation,
): string | null => {
  if (mutation.kind !== 'upsert' || !mutation.snapshot) {
    return null;
  }
  const locationSlot = mutation.snapshot.location_slot;
  if (!isSlotConstrainedLocation(mutation.snapshot.location, locationSlot)) {
    return null;
  }
  return `${mutation.snapshot.owner_character_id}:${mutation.snapshot.location}:${locationSlot}`;
};

export const pruneSlotConflictingSortInventoryMutations = (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): NormalizedItemInstanceMutations => {
  const mutationsByTargetKey = new Map<string, BufferedCharacterItemInstanceMutation[]>();
  for (const mutation of mutations) {
    const targetKey = buildSlotTargetKey(mutation);
    if (!targetKey) {
      continue;
    }
    const group = mutationsByTargetKey.get(targetKey) ?? [];
    group.push(mutation);
    mutationsByTargetKey.set(targetKey, group);
  }

  const keptSortMutationIds = new Set<string>();
  const droppedSortMutationIds = new Set<string>();
  for (const group of mutationsByTargetKey.values()) {
    const sortUpserts = group.filter((mutation) => getItemInstanceMutationPrefix(mutation.opId) === 'sort-inventory');
    if (sortUpserts.length <= 0) {
      continue;
    }
    const nonSortUpserts = group.filter((mutation) => getItemInstanceMutationPrefix(mutation.opId) !== 'sort-inventory');
    if (nonSortUpserts.length >= 1) {
      for (const mutation of sortUpserts) {
        droppedSortMutationIds.add(`${mutation.itemId}:${mutation.opId}:${mutation.createdAt}`);
      }
      continue;
    }
    if (sortUpserts.length <= 1) {
      continue;
    }
    const latestSortMutation = [...sortUpserts].sort(
      (left, right) => left.createdAt - right.createdAt || left.opId.localeCompare(right.opId),
    )[sortUpserts.length - 1];
    if (!latestSortMutation) {
      continue;
    }
    keptSortMutationIds.add(`${latestSortMutation.itemId}:${latestSortMutation.opId}:${latestSortMutation.createdAt}`);
    for (const mutation of sortUpserts) {
      const mutationKey = `${mutation.itemId}:${mutation.opId}:${mutation.createdAt}`;
      if (mutationKey === `${latestSortMutation.itemId}:${latestSortMutation.opId}:${latestSortMutation.createdAt}`) {
        continue;
      }
      droppedSortMutationIds.add(mutationKey);
    }
  }

  if (droppedSortMutationIds.size <= 0) {
    return {
      mutations: [...mutations],
      droppedSortInventoryMutations: false,
    };
  }

  return {
    mutations: mutations.filter((mutation) => {
      const mutationKey = `${mutation.itemId}:${mutation.opId}:${mutation.createdAt}`;
      if (keptSortMutationIds.has(mutationKey)) {
        return true;
      }
      return !droppedSortMutationIds.has(mutationKey);
    }),
    droppedSortInventoryMutations: true,
  };
};

const normalizeBufferedCharacterItemInstanceMutations = (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): NormalizedItemInstanceMutations => {
  const prunedSortMutations = pruneStaleSortInventoryMutations(mutations);
  const collapsedMutations = collapseBufferedCharacterItemInstanceMutations(prunedSortMutations);
  return pruneSlotConflictingSortInventoryMutations(collapsedMutations);
};

export const buildCanonicalItemInstanceMutationHash = (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Record<string, string> => {
  const canonicalHash: Record<string, string> = {};
  for (const mutation of normalizeBufferedCharacterItemInstanceMutations(mutations).mutations) {
    canonicalHash[buildItemInstanceMutationHashField(mutation.itemId)] = encodeMutation(mutation);
  }
  return canonicalHash;
};

const compactItemInstanceMutationHash = async (key: string): Promise<BufferedCharacterItemInstanceMutation[]> => {
  const hash = await redis.hgetall(key);
  const mutations = Object.values(hash)
    .map((raw) => decodeMutation(raw))
    .filter((mutation): mutation is BufferedCharacterItemInstanceMutation => mutation !== null)
    .sort((left, right) => left.createdAt - right.createdAt || left.opId.localeCompare(right.opId));
  const canonicalHash = buildCanonicalItemInstanceMutationHash(mutations);
  const rawEntries = Object.entries(hash).sort(([left], [right]) => left.localeCompare(right));
  const canonicalEntries = Object.entries(canonicalHash).sort(([left], [right]) => left.localeCompare(right));
  const needsRewrite = rawEntries.length !== canonicalEntries.length
    || rawEntries.some(([field, value], index) => {
      const canonicalEntry = canonicalEntries[index];
      return !canonicalEntry || canonicalEntry[0] !== field || canonicalEntry[1] !== value;
    });

  if (needsRewrite) {
    const multi = redis.multi();
    multi.del(key);
    if (canonicalEntries.length > 0) {
      multi.hset(key, canonicalHash);
    }
    await multi.exec();
  }

  return normalizeBufferedCharacterItemInstanceMutations(mutations).mutations;
};

const ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY = 'character:item-instance-mutation:index';
const ITEM_INSTANCE_MUTATION_KEY_PREFIX = 'character:item-instance-mutation:';
const ITEM_INSTANCE_MUTATION_INFLIGHT_KEY_PREFIX = 'character:item-instance-mutation:inflight:';
const ITEM_INSTANCE_MUTATION_FLUSH_INTERVAL_MS = 1_000;
const ITEM_INSTANCE_MUTATION_FLUSH_BATCH_LIMIT = 100;
const itemInstanceMutationLogger = createScopedLogger('characterItemInstanceMutation.delta');

let itemInstanceMutationFlushTimer: ReturnType<typeof setInterval> | null = null;
let itemInstanceMutationFlushInFlight: Promise<void> | null = null;

const claimItemInstanceMutationLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

if redis.call('EXISTS', inflightKey) == 1 then
  return 0
end

if redis.call('EXISTS', mainKey) == 0 then
  redis.call('SREM', dirtyIndexKey, characterId)
  return 0
end

redis.call('RENAME', mainKey, inflightKey)
return 1
`;

const finalizeItemInstanceMutationLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

redis.call('DEL', inflightKey)
if redis.call('EXISTS', mainKey) == 1 then
  redis.call('SADD', dirtyIndexKey, characterId)
else
  redis.call('SREM', dirtyIndexKey, characterId)
end
return 1
`;

const restoreItemInstanceMutationLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

local inflightValues = redis.call('HGETALL', inflightKey)
if next(inflightValues) == nil then
  if redis.call('EXISTS', mainKey) == 1 then
    redis.call('SADD', dirtyIndexKey, characterId)
  else
    redis.call('SREM', dirtyIndexKey, characterId)
  end
  return 0
end

for i = 1, #inflightValues, 2 do
  redis.call('HSET', mainKey, inflightValues[i], inflightValues[i + 1])
end
redis.call('DEL', inflightKey)
redis.call('SADD', dirtyIndexKey, characterId)
return 1
`;

const buildItemInstanceMutationKey = (characterId: number): string =>
  `${ITEM_INSTANCE_MUTATION_KEY_PREFIX}${characterId}`;

const buildInflightItemInstanceMutationKey = (characterId: number): string =>
  `${ITEM_INSTANCE_MUTATION_INFLIGHT_KEY_PREFIX}${characterId}`;

const normalizePositiveInt = (value: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const normalizeOptionalInt = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) ? normalized : null;
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeOptionalDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeOptionalNumericString = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeLocation = (location: string): ItemInstanceLocation | null => {
  const normalized = String(location || '').trim();
  return normalized.length > 0 ? normalized : null;
};

const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const next: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = cloneJsonValue(entry);
    }
    return next;
  }
  return value;
};

const normalizeJsonValue = (value: JsonValue): JsonValue => cloneJsonValue(value);

const normalizeMetadata = (value: CharacterItemInstanceMetadata | JsonValue): CharacterItemInstanceMetadata => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return null;
  }
  const normalized: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    normalized[key] = normalizeJsonValue(entry);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
};

const normalizeSnapshot = (
  snapshot: CharacterItemInstanceSnapshot | null,
): CharacterItemInstanceSnapshot | null => {
  if (!snapshot) return null;
  const location = normalizeLocation(snapshot.location);
  const id = normalizePositiveInt(snapshot.id);
  const ownerCharacterId = normalizePositiveInt(snapshot.owner_character_id);
  const ownerUserId = normalizePositiveInt(snapshot.owner_user_id);
  const qty = Math.max(0, Math.floor(Number(snapshot.qty) || 0));
  const strengthenLevel = Math.max(0, Math.floor(Number(snapshot.strengthen_level) || 0));
  const refineLevel = Math.max(0, Math.floor(Number(snapshot.refine_level) || 0));
  if (!location || id <= 0 || ownerCharacterId <= 0 || ownerUserId <= 0 || qty <= 0) {
    return null;
  }
  return {
    id,
    owner_user_id: ownerUserId,
    owner_character_id: ownerCharacterId,
    item_def_id: String(snapshot.item_def_id || '').trim(),
    qty,
    quality: typeof snapshot.quality === 'string' && snapshot.quality.trim().length > 0
      ? snapshot.quality.trim()
      : null,
    quality_rank: normalizeOptionalInt(snapshot.quality_rank),
    metadata: normalizeMetadata(snapshot.metadata),
    location,
    location_slot: normalizeOptionalInt(snapshot.location_slot),
    equipped_slot: typeof snapshot.equipped_slot === 'string' && snapshot.equipped_slot.trim().length > 0
      ? snapshot.equipped_slot.trim()
      : null,
    strengthen_level: strengthenLevel,
    refine_level: refineLevel,
    socketed_gems: normalizeJsonValue(snapshot.socketed_gems),
    affixes: normalizeJsonValue(snapshot.affixes),
    identified: Boolean(snapshot.identified),
    locked: Boolean(snapshot.locked),
    bind_type: String(snapshot.bind_type || '').trim() || 'none',
    bind_owner_user_id: normalizeOptionalInt(snapshot.bind_owner_user_id),
    bind_owner_character_id: normalizeOptionalInt(snapshot.bind_owner_character_id),
    random_seed: normalizeOptionalNumericString(snapshot.random_seed),
    affix_gen_version: Math.max(0, Math.floor(Number(snapshot.affix_gen_version) || 0)),
    affix_roll_meta: normalizeJsonValue(snapshot.affix_roll_meta),
    custom_name: normalizeOptionalString(snapshot.custom_name),
    expire_at: normalizeOptionalDate(snapshot.expire_at),
    obtained_from: normalizeOptionalString(snapshot.obtained_from),
    obtained_ref_id: normalizeOptionalString(snapshot.obtained_ref_id),
    created_at: snapshot.created_at instanceof Date
      ? snapshot.created_at
      : new Date(String(snapshot.created_at)),
  };
};

const normalizeMutation = (
  mutation: BufferedCharacterItemInstanceMutation,
): BufferedCharacterItemInstanceMutation | null => {
  const characterId = normalizePositiveInt(mutation.characterId);
  const itemId = normalizePositiveInt(mutation.itemId);
  const opId = String(mutation.opId || '').trim();
  const createdAt = Math.max(0, Math.floor(Number(mutation.createdAt) || Date.now()));
  if (!opId || characterId <= 0 || itemId <= 0) {
    return null;
  }
  if (mutation.kind === 'delete') {
    return {
      opId,
      characterId,
      itemId,
      createdAt,
      kind: 'delete',
      snapshot: null,
    };
  }
  const snapshot = normalizeSnapshot(mutation.snapshot);
  if (!snapshot || snapshot.id !== itemId || snapshot.owner_character_id !== characterId) {
    return null;
  }
  return {
    opId,
    characterId,
    itemId,
    createdAt,
    kind: 'upsert',
    snapshot,
  };
};

const encodeMutation = (mutation: BufferedCharacterItemInstanceMutation): string => {
  return JSON.stringify({
    opId: mutation.opId,
    characterId: mutation.characterId,
    itemId: mutation.itemId,
    createdAt: mutation.createdAt,
    kind: mutation.kind,
    snapshot: mutation.snapshot
      ? {
          ...mutation.snapshot,
          created_at: mutation.snapshot.created_at.toISOString(),
        }
      : null,
  });
};

const decodeMutation = (raw: string): BufferedCharacterItemInstanceMutation | null => {
  try {
    const parsed = JSON.parse(raw) as {
      opId?: string;
      characterId?: number;
      itemId?: number;
      createdAt?: number;
      kind?: 'upsert' | 'delete';
      snapshot?: CharacterItemInstanceSnapshot | null;
    };
    return normalizeMutation({
      opId: String(parsed.opId || ''),
      characterId: Number(parsed.characterId),
      itemId: Number(parsed.itemId),
      createdAt: Number(parsed.createdAt),
      kind: parsed.kind === 'delete' ? 'delete' : 'upsert',
      snapshot: parsed.snapshot ?? null,
    });
  } catch {
    return null;
  }
};

const cloneSnapshot = (snapshot: CharacterItemInstanceSnapshot): CharacterItemInstanceSnapshot => ({
  ...snapshot,
  metadata: normalizeMetadata(snapshot.metadata),
  socketed_gems: normalizeJsonValue(snapshot.socketed_gems),
  affixes: normalizeJsonValue(snapshot.affixes),
  created_at: new Date(snapshot.created_at),
});

const mapRowToSnapshot = (row: Record<string, JsonValue | Date | number | string | boolean | null>): CharacterItemInstanceSnapshot | null => {
  return normalizeSnapshot({
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    owner_character_id: Number(row.owner_character_id),
    item_def_id: String(row.item_def_id || ''),
    qty: Number(row.qty),
    quality: typeof row.quality === 'string' ? row.quality : null,
    quality_rank: row.quality_rank === null ? null : Number(row.quality_rank),
    metadata: normalizeMetadata((row.metadata ?? null) as JsonValue),
    location: String(row.location || '') as ItemInstanceLocation,
    location_slot: row.location_slot === null ? null : Number(row.location_slot),
    equipped_slot: typeof row.equipped_slot === 'string' ? row.equipped_slot : null,
    strengthen_level: Number(row.strengthen_level) || 0,
    refine_level: Number(row.refine_level) || 0,
    socketed_gems: (row.socketed_gems ?? []) as JsonValue,
    affixes: (row.affixes ?? []) as JsonValue,
    identified: Boolean(row.identified),
    locked: Boolean(row.locked),
    bind_type: String(row.bind_type || 'none'),
    bind_owner_user_id: row.bind_owner_user_id === null ? null : Number(row.bind_owner_user_id),
    bind_owner_character_id: row.bind_owner_character_id === null ? null : Number(row.bind_owner_character_id),
    random_seed: row.random_seed === null ? null : String(row.random_seed),
    affix_gen_version: Number(row.affix_gen_version) || 0,
    affix_roll_meta: (row.affix_roll_meta ?? null) as JsonValue,
    custom_name: typeof row.custom_name === 'string' ? row.custom_name : null,
    expire_at: row.expire_at instanceof Date ? row.expire_at : row.expire_at === null ? null : new Date(String(row.expire_at)),
    obtained_from: typeof row.obtained_from === 'string' ? row.obtained_from : null,
    obtained_ref_id: typeof row.obtained_ref_id === 'string' ? row.obtained_ref_id : null,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  });
};

const listDirtyCharacterIds = async (limit: number): Promise<number[]> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return (await redis.srandmember(ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY, normalizedLimit))
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
    .sort((left, right) => left - right);
};

const claimCharacterItemInstanceMutations = async (characterId: number): Promise<boolean> => {
  const result = await redis.eval(
    claimItemInstanceMutationLua,
    3,
    ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
    buildItemInstanceMutationKey(characterId),
    buildInflightItemInstanceMutationKey(characterId),
    String(characterId),
  );
  return Number(result) === 1;
};

const finalizeCharacterItemInstanceMutations = async (characterId: number): Promise<void> => {
  await redis.eval(
    finalizeItemInstanceMutationLua,
    3,
    ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
    buildItemInstanceMutationKey(characterId),
    buildInflightItemInstanceMutationKey(characterId),
    String(characterId),
  );
};

const restoreCharacterItemInstanceMutations = async (characterId: number): Promise<void> => {
  await redis.eval(
    restoreItemInstanceMutationLua,
    3,
    ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY,
    buildItemInstanceMutationKey(characterId),
    buildInflightItemInstanceMutationKey(characterId),
    String(characterId),
  );
};

const loadMutationHash = async (key: string): Promise<BufferedCharacterItemInstanceMutation[]> => {
  return compactItemInstanceMutationHash(key);
};

const loadClaimedMutations = async (characterId: number): Promise<BufferedCharacterItemInstanceMutation[]> => {
  return loadMutationHash(buildInflightItemInstanceMutationKey(characterId));
};

const isSlotConstrainedLocation = (location: string, locationSlot: number | null): boolean => {
  return (location === 'bag' || location === 'warehouse') && locationSlot !== null;
};

const isItemInstanceSlotConflictError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const databaseError = error as Error & { code?: string; constraint?: string };
  return databaseError.code === '23505'
    && typeof databaseError.constraint === 'string'
    && databaseError.constraint.includes('uq_item_instance_slot');
};

const loadExistingItemInstanceRow = async (
  itemId: number,
): Promise<ExistingItemInstanceRow | null> => {
  const result = await query<ExistingItemInstanceRow>(
    `
      SELECT id, owner_user_id, owner_character_id, location, location_slot
      FROM item_instance
      WHERE id = $1
    `,
    [itemId],
  );
  return result.rows[0] ?? null;
};

const tryInsertCharacterItemInstanceSnapshotWithSlot = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<boolean> => {
  const insertedId = await tryInsertItemInstanceWithSlot(
    `
      INSERT INTO item_instance (
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13,
        $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22,
        $23::jsonb, $24, $25, $26, $27, $28, NOW()
      )
    `,
    buildSnapshotPersistenceParams(snapshot),
  );
  return insertedId !== null;
};

const updateCharacterItemInstanceSnapshot = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<void> => {
  await query(
    `
      UPDATE item_instance
      SET owner_user_id = $2,
          owner_character_id = $3,
          item_def_id = $4,
          qty = $5,
          quality = $6,
          quality_rank = $7,
          metadata = $8::jsonb,
          location = $9,
          location_slot = $10,
          equipped_slot = $11,
          strengthen_level = $12,
          refine_level = $13,
          socketed_gems = $14::jsonb,
          affixes = $15::jsonb,
          identified = $16,
          locked = $17,
          bind_type = $18,
          bind_owner_user_id = $19,
          bind_owner_character_id = $20,
          random_seed = $21,
          affix_gen_version = $22,
          affix_roll_meta = $23::jsonb,
          custom_name = $24,
          expire_at = $25,
          obtained_from = $26,
          obtained_ref_id = $27,
          created_at = $28,
          updated_at = NOW()
      WHERE id = $1
    `,
    buildSnapshotPersistenceParams(snapshot),
  );
};

const tryUpdateCharacterItemInstanceSnapshotWithSlot = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<boolean> => {
  const result = await query<{ id: number | string }>(
    `
      UPDATE item_instance AS target
      SET owner_user_id = $2,
          owner_character_id = $3,
          item_def_id = $4,
          qty = $5,
          quality = $6,
          quality_rank = $7,
          metadata = $8::jsonb,
          location = $9,
          location_slot = $10,
          equipped_slot = $11,
          strengthen_level = $12,
          refine_level = $13,
          socketed_gems = $14::jsonb,
          affixes = $15::jsonb,
          identified = $16,
          locked = $17,
          bind_type = $18,
          bind_owner_user_id = $19,
          bind_owner_character_id = $20,
          random_seed = $21,
          affix_gen_version = $22,
          affix_roll_meta = $23::jsonb,
          custom_name = $24,
          expire_at = $25,
          obtained_from = $26,
          obtained_ref_id = $27,
          created_at = $28,
          updated_at = NOW()
      WHERE target.id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM item_instance AS occupied
          WHERE occupied.owner_character_id = $3
            AND occupied.location = $9
            AND occupied.location_slot = $10
            AND occupied.id <> target.id
        )
      RETURNING target.id
    `,
    [
      snapshot.id,
      snapshot.owner_user_id,
      snapshot.owner_character_id,
      snapshot.item_def_id,
      snapshot.qty,
      snapshot.quality,
      snapshot.quality_rank,
      toDbJson(snapshot.metadata),
      snapshot.location,
      snapshot.location_slot,
      snapshot.equipped_slot,
      snapshot.strengthen_level,
      snapshot.refine_level,
      toDbJson(snapshot.socketed_gems),
      toDbJson(snapshot.affixes),
      snapshot.identified,
      snapshot.locked,
      snapshot.bind_type,
      snapshot.bind_owner_user_id,
      snapshot.bind_owner_character_id,
      snapshot.random_seed,
      snapshot.affix_gen_version,
      toDbJson(snapshot.affix_roll_meta),
      snapshot.custom_name,
      snapshot.expire_at,
      snapshot.obtained_from,
      snapshot.obtained_ref_id,
      snapshot.created_at,
    ],
  );
  return result.rows.length > 0;
};

export const tryUpsertCharacterItemInstanceSnapshotImmediately = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<boolean> => {
  if (!isSlotConstrainedLocation(snapshot.location, snapshot.location_slot)) {
    await upsertCharacterItemInstanceSnapshot(snapshot);
    return true;
  }

  const existingRow = await loadExistingItemInstanceRow(snapshot.id);
  if (!existingRow) {
    return tryInsertCharacterItemInstanceSnapshotWithSlot(snapshot);
  }

  return tryUpdateCharacterItemInstanceSnapshotWithSlot(snapshot);
};

export const buildItemInstanceMutationFlushPlan = (
  existingRows: readonly ExistingItemInstanceLocationRow[],
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): ItemInstanceMutationFlushPlan => {
  const latestMutations = collapseBufferedCharacterItemInstanceMutations(mutations);
  const latestMutationByItemId = new Map<number, BufferedCharacterItemInstanceMutation>();
  for (const mutation of latestMutations) {
    latestMutationByItemId.set(mutation.itemId, mutation);
  }

  const existingRowByItemId = new Map<number, ExistingItemInstanceLocationRow>();
  for (const row of existingRows) {
    const normalizedItemId = normalizePositiveInt(Number(row.id));
    if (normalizedItemId <= 0) {
      continue;
    }
    existingRowByItemId.set(normalizedItemId, row);
  }

  const slotReleaseItemIds = new Set<number>();
  const remainingOccupantByTargetKey = new Map<string, number>();
  const targetOwnerByKey = new Map<string, number>();
  const duplicateTargetKeys = new Set<string>();

  for (const [itemId, mutation] of latestMutationByItemId.entries()) {
    const existingRow = existingRowByItemId.get(itemId);
    const normalizedExistingOwnerCharacterId = existingRow
      ? normalizePositiveInt(Number(existingRow.owner_character_id))
      : 0;
    const normalizedExistingLocationSlot = existingRow
      ? normalizeOptionalInt(
        existingRow.location_slot === null ? null : Number(existingRow.location_slot),
      )
      : null;
    if (
      existingRow
      && normalizedExistingOwnerCharacterId > 0
      && isSlotConstrainedLocation(existingRow.location, normalizedExistingLocationSlot)
    ) {
      const keepsCurrentSlot = mutation.kind === 'upsert'
        && mutation.snapshot !== null
        && mutation.snapshot.owner_character_id === normalizedExistingOwnerCharacterId
        && mutation.snapshot.location === existingRow.location
        && mutation.snapshot.location_slot === normalizedExistingLocationSlot;
      if (!keepsCurrentSlot) {
        slotReleaseItemIds.add(itemId);
      }
    }
  }

  for (const row of existingRows) {
    const normalizedItemId = normalizePositiveInt(Number(row.id));
    const normalizedOwnerCharacterId = normalizePositiveInt(Number(row.owner_character_id));
    const normalizedLocationSlot = normalizeOptionalInt(
      row.location_slot === null ? null : Number(row.location_slot),
    );
    if (normalizedItemId <= 0 || normalizedOwnerCharacterId <= 0) {
      continue;
    }
    if (!isSlotConstrainedLocation(row.location, normalizedLocationSlot)) {
      continue;
    }
    if (slotReleaseItemIds.has(normalizedItemId)) {
      continue;
    }
    remainingOccupantByTargetKey.set(
      `${normalizedOwnerCharacterId}:${row.location}:${normalizedLocationSlot}`,
      normalizedItemId,
    );
  }

  for (const [itemId, mutation] of latestMutationByItemId.entries()) {
    if (mutation.kind !== 'upsert' || !mutation.snapshot) {
      continue;
    }
    const locationSlot = mutation.snapshot.location_slot;
    if (!isSlotConstrainedLocation(mutation.snapshot.location, locationSlot)) {
      continue;
    }
    const targetKey = `${mutation.snapshot.owner_character_id}:${mutation.snapshot.location}:${locationSlot}`;
    const existingOccupantId = remainingOccupantByTargetKey.get(targetKey) ?? null;
    if (
      existingOccupantId !== null
      && existingOccupantId !== itemId
    ) {
      duplicateTargetKeys.add(targetKey);
      continue;
    }
    const existingTargetOwner = targetOwnerByKey.get(targetKey) ?? null;
    if (existingTargetOwner !== null && existingTargetOwner !== itemId) {
      duplicateTargetKeys.add(targetKey);
      continue;
    }
    targetOwnerByKey.set(targetKey, itemId);
  }

  return {
    slotReleaseItemIds: [...slotReleaseItemIds].sort((left, right) => left - right),
    duplicateTargetKeys: [...duplicateTargetKeys].sort(),
  };
};

export const resolveItemInstanceFlushInput = (
  existingRows: readonly ExistingItemInstanceLocationRow[],
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): ResolvedItemInstanceFlushInput => {
  const normalizedMutations = normalizeBufferedCharacterItemInstanceMutations(mutations);
  const effectiveMutations = normalizedMutations.mutations;
  const flushPlan = buildItemInstanceMutationFlushPlan(existingRows, effectiveMutations);
  if (flushPlan.duplicateTargetKeys.length <= 0) {
    return {
      effectiveMutations,
      flushPlan,
      droppedSortInventoryMutations: normalizedMutations.droppedSortInventoryMutations,
    };
  }

  const nonSortMutations = effectiveMutations.filter((mutation) => (
    getItemInstanceMutationPrefix(mutation.opId) !== 'sort-inventory'
  ));
  if (nonSortMutations.length === effectiveMutations.length) {
    return {
      effectiveMutations,
      flushPlan,
      droppedSortInventoryMutations: normalizedMutations.droppedSortInventoryMutations,
    };
  }

  const nonSortFlushPlan = buildItemInstanceMutationFlushPlan(existingRows, nonSortMutations);
  if (nonSortFlushPlan.duplicateTargetKeys.length > 0) {
    return {
      effectiveMutations,
      flushPlan,
      droppedSortInventoryMutations: normalizedMutations.droppedSortInventoryMutations,
    };
  }

  return {
    effectiveMutations: nonSortMutations,
    flushPlan: nonSortFlushPlan,
    droppedSortInventoryMutations: true,
  };
};

export const loadCharacterPendingItemInstanceMutations = async (
  characterId: number,
): Promise<BufferedCharacterItemInstanceMutation[]> => {
  const normalizedCharacterId = normalizePositiveInt(characterId);
  if (normalizedCharacterId <= 0) return [];
  const [mainMutations, inflightMutations] = await Promise.all([
    loadMutationHash(buildItemInstanceMutationKey(normalizedCharacterId)),
    loadMutationHash(buildInflightItemInstanceMutationKey(normalizedCharacterId)),
  ]);
  return [...mainMutations, ...inflightMutations]
    .sort((left, right) => left.createdAt - right.createdAt || left.opId.localeCompare(right.opId));
};

export const loadBaseCharacterItemInstanceSnapshots = async (
  characterId: number,
): Promise<CharacterItemInstanceSnapshot[]> => {
  const normalizedCharacterId = normalizePositiveInt(characterId);
  if (normalizedCharacterId <= 0) return [];
  const result = await query(
    `
      SELECT
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at
      FROM item_instance
      WHERE owner_character_id = $1
      ORDER BY id ASC
    `,
    [normalizedCharacterId],
  );
  return result.rows
    .map((row) => mapRowToSnapshot(row as Record<string, JsonValue | Date | number | string | boolean | null>))
    .filter((snapshot): snapshot is CharacterItemInstanceSnapshot => snapshot !== null);
};

/**
 * 按指定条件加载库存实例快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：复用统一的 item_instance -> CharacterItemInstanceSnapshot 映射逻辑，避免按位置 / 按 ID 查询各自复制整段 SQL 映射代码。
 * 2. 不做什么：不叠加 Redis 中的 pending mutation，也不做位置过滤后的业务判定；这里只负责底表快照读取。
 *
 * 输入 / 输出：
 * - 输入：完整 SQL 与参数数组。
 * - 输出：标准化后的 `CharacterItemInstanceSnapshot[]`。
 *
 * 数据流 / 状态流：
 * SQL 查询 -> `mapRowToSnapshot` 标准化 -> 过滤脏行 -> 返回只读快照数组。
 *
 * 复用设计说明：
 * - 把快照行映射收敛到单一入口后，按位置 / 按 ID / 带 mutation 关联 ID 的查询都能复用，减少重复维护。
 * - 后续如果 item_instance 字段扩展，只需在一处同步映射规则，不会遗漏局部查询分支。
 *
 * 关键边界条件与坑点：
 * 1. SQL 必须显式带上 `owner_character_id` 约束，否则会把其他角色实例混入当前投影视图。
 * 2. 返回结果仍是底表快照，不代表最终 projected 结果；调用方若需要 pending overlay，必须继续叠加 mutation。
 */
const loadCharacterItemInstanceSnapshotsByQuery = async (
  sql: string,
  params: ReadonlyArray<number | string | string[]>,
): Promise<CharacterItemInstanceSnapshot[]> => {
  const result = await query(sql, [...params]);
  return result.rows
    .map((row) => mapRowToSnapshot(row as Record<string, JsonValue | Date | number | string | boolean | null>))
    .filter((snapshot): snapshot is CharacterItemInstanceSnapshot => snapshot !== null);
};

const loadBaseCharacterItemInstanceSnapshotsByLocation = async (
  characterId: number,
  location: ItemInstanceLocation,
): Promise<CharacterItemInstanceSnapshot[]> => {
  const normalizedCharacterId = normalizePositiveInt(characterId);
  if (normalizedCharacterId <= 0) return [];
  return loadCharacterItemInstanceSnapshotsByQuery(
    `
      SELECT
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = $2
      ORDER BY id ASC
    `,
    [normalizedCharacterId, location],
  );
};

const loadBaseCharacterItemInstanceSnapshotsForProjectedLocation = async (
  characterId: number,
  location: ItemInstanceLocation,
  relatedItemIds: readonly number[],
): Promise<CharacterItemInstanceSnapshot[]> => {
  const normalizedCharacterId = normalizePositiveInt(characterId);
  if (normalizedCharacterId <= 0) return [];
  if (relatedItemIds.length <= 0) {
    return loadBaseCharacterItemInstanceSnapshotsByLocation(normalizedCharacterId, location);
  }
  return loadCharacterItemInstanceSnapshotsByQuery(
    `
      SELECT
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at
      FROM item_instance
      WHERE owner_character_id = $1
        AND (
          location = $2
          OR id = ANY($3::bigint[])
        )
      ORDER BY id ASC
    `,
    [normalizedCharacterId, location, buildItemInstanceIdArrayParam(relatedItemIds)],
  );
};

const loadBaseCharacterItemInstanceSnapshotById = async (
  characterId: number,
  itemId: number,
): Promise<CharacterItemInstanceSnapshot | null> => {
  const normalizedCharacterId = normalizePositiveInt(characterId);
  const normalizedItemId = normalizePositiveInt(itemId);
  if (normalizedCharacterId <= 0 || normalizedItemId <= 0) return null;
  const rows = await loadCharacterItemInstanceSnapshotsByQuery(
    `
      SELECT
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at
      FROM item_instance
      WHERE owner_character_id = $1
        AND id = $2
      LIMIT 1
    `,
    [normalizedCharacterId, normalizedItemId],
  );
  return rows[0] ? cloneSnapshot(rows[0]) : null;
};

export const applyCharacterItemInstanceMutations = (
  baseSnapshots: readonly CharacterItemInstanceSnapshot[],
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): CharacterItemInstanceSnapshot[] => {
  const snapshotById = new Map<number, CharacterItemInstanceSnapshot>();
  for (const snapshot of baseSnapshots) {
    snapshotById.set(snapshot.id, cloneSnapshot(snapshot));
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'delete') {
      snapshotById.delete(mutation.itemId);
      continue;
    }
    if (!mutation.snapshot) continue;
    snapshotById.set(mutation.itemId, cloneSnapshot(mutation.snapshot));
  }
  return [...snapshotById.values()].sort((left, right) => left.id - right.id);
};

export const loadProjectedCharacterItemInstances = async (
  characterId: number,
  options: LoadProjectedCharacterItemInstanceOptions = {},
): Promise<CharacterItemInstanceSnapshot[]> => {
  const mutations = options.pendingMutations
    ? [...options.pendingMutations]
    : await loadCharacterPendingItemInstanceMutations(characterId);
  const baseSnapshots = await loadBaseCharacterItemInstanceSnapshots(characterId);
  return applyCharacterItemInstanceMutations(baseSnapshots, mutations);
};

export const loadProjectedCharacterItemInstancesByLocation = async (
  characterId: number,
  location: ItemInstanceLocation,
  options: LoadProjectedCharacterItemInstanceOptions = {},
): Promise<CharacterItemInstanceSnapshot[]> => {
  const mutations = options.pendingMutations
    ? [...options.pendingMutations]
    : await loadCharacterPendingItemInstanceMutations(characterId);
  const baseSnapshots = await loadBaseCharacterItemInstanceSnapshotsForProjectedLocation(
    characterId,
    location,
    mutations.map((mutation) => mutation.itemId),
  );
  const projectedItems = applyCharacterItemInstanceMutations(baseSnapshots, mutations);
  return projectedItems.filter((item) => item.location === location);
};

export const loadProjectedCharacterItemInstanceById = async (
  characterId: number,
  itemId: number,
  options: LoadProjectedCharacterItemInstanceOptions = {},
): Promise<CharacterItemInstanceSnapshot | null> => {
  const normalizedItemId = normalizePositiveInt(itemId);
  if (normalizedItemId <= 0) {
    return null;
  }
  const mutations = options.pendingMutations
    ? [...options.pendingMutations]
    : await loadCharacterPendingItemInstanceMutations(characterId);
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index];
    if (!mutation || mutation.itemId !== normalizedItemId) {
      continue;
    }
    if (mutation.kind === 'delete' || !mutation.snapshot) {
      return null;
    }
    return cloneSnapshot(mutation.snapshot);
  }
  return loadBaseCharacterItemInstanceSnapshotById(characterId, normalizedItemId);
};

export const bufferCharacterItemInstanceMutations = async (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<void> => {
  const normalizedMutations = mutations
    .map((mutation) => normalizeMutation(mutation))
    .filter((mutation): mutation is BufferedCharacterItemInstanceMutation => mutation !== null);
  if (normalizedMutations.length <= 0) return;

  await afterTransactionCommit(async () => {
    const multi = redis.multi();
    for (const mutation of normalizedMutations) {
      multi.hset(
        buildItemInstanceMutationKey(mutation.characterId),
        buildItemInstanceMutationHashField(mutation.itemId),
        encodeMutation(mutation),
      );
      multi.sadd(ITEM_INSTANCE_MUTATION_DIRTY_INDEX_KEY, String(mutation.characterId));
    }
    await multi.exec();
  });
};

const toDbJson = (value: JsonValue | CharacterItemInstanceMetadata): string | null => {
  if (value === null) return null;
  return JSON.stringify(value);
};

const buildSnapshotPersistenceParams = (
  snapshot: CharacterItemInstanceSnapshot,
): [
  number,
  number,
  number,
  string,
  number,
  string | null,
  number | null,
  string | null,
  string,
  number | null,
  string | null,
  number,
  number,
  string | null,
  string | null,
  boolean,
  boolean,
  string,
  number | null,
  number | null,
  string | null,
  number,
  string | null,
  string | null,
  Date | null,
  string | null,
  string | null,
  Date,
] => [
  snapshot.id,
  snapshot.owner_user_id,
  snapshot.owner_character_id,
  snapshot.item_def_id,
  snapshot.qty,
  snapshot.quality,
  snapshot.quality_rank,
  toDbJson(snapshot.metadata),
  snapshot.location,
  snapshot.location_slot,
  snapshot.equipped_slot,
  snapshot.strengthen_level,
  snapshot.refine_level,
  toDbJson(snapshot.socketed_gems),
  toDbJson(snapshot.affixes),
  snapshot.identified,
  snapshot.locked,
  snapshot.bind_type,
  snapshot.bind_owner_user_id,
  snapshot.bind_owner_character_id,
  snapshot.random_seed,
  snapshot.affix_gen_version,
  toDbJson(snapshot.affix_roll_meta),
  snapshot.custom_name,
  snapshot.expire_at,
  snapshot.obtained_from,
  snapshot.obtained_ref_id,
  snapshot.created_at,
];

const insertCharacterItemInstanceSnapshot = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<void> => {
  await query(
    `
      INSERT INTO item_instance (
        id,
        owner_user_id,
        owner_character_id,
        item_def_id,
        qty,
        quality,
        quality_rank,
        metadata,
        location,
        location_slot,
        equipped_slot,
        strengthen_level,
        refine_level,
        socketed_gems,
        affixes,
        identified,
        locked,
        bind_type,
        bind_owner_user_id,
        bind_owner_character_id,
        random_seed,
        affix_gen_version,
        affix_roll_meta,
        custom_name,
        expire_at,
        obtained_from,
        obtained_ref_id,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13,
        $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22,
        $23::jsonb, $24, $25, $26, $27, $28, NOW()
      )
    `,
    buildSnapshotPersistenceParams(snapshot),
  );
};

/**
 * 在当前事务内立即落库单个实例快照，供需要真实外键约束的链路复用。
 * 这里只负责真实表 insert/update 分流落库，不负责 Redis mutation 同步；调用方若仍依赖投影覆盖，
 * 需要自行继续写入 bufferCharacterItemInstanceMutations。
 */
export const upsertCharacterItemInstanceSnapshot = async (
  snapshot: CharacterItemInstanceSnapshot,
): Promise<void> => {
  const existingRow = await loadExistingItemInstanceRow(snapshot.id);
  if (!existingRow) {
    if (isSlotConstrainedLocation(snapshot.location, snapshot.location_slot)) {
      const inserted = await tryInsertCharacterItemInstanceSnapshotWithSlot(snapshot);
      if (!inserted) {
        throw new Error(`slot-conflict:${snapshot.id}`);
      }
      return;
    }
    await insertCharacterItemInstanceSnapshot(snapshot);
    return;
  }

  if (isSlotConstrainedLocation(snapshot.location, snapshot.location_slot)) {
    const updated = await tryUpdateCharacterItemInstanceSnapshotWithSlot(snapshot);
    if (!updated) {
      throw new Error(`slot-conflict:${snapshot.id}`);
    }
    return;
  }

  await updateCharacterItemInstanceSnapshot(snapshot);
};

/**
 * 在当前事务内立即应用实例 mutation，供必须受 savepoint 控制的链路复用。
 *
 * 作用：
 * 1. 直接把 upsert/delete 写入 `item_instance`，保证调用方可以依赖数据库事务回滚，而不是依赖 after-commit Redis 投影。
 * 2. 仅处理当前入参 mutation，不接管原有异步 flush 体系，避免影响常规高频奖励链路。
 *
 * 输入 / 输出：
 * - 输入：已经按顺序计算好的实例 mutation 列表。
 * - 输出：无；全部 mutation 会立刻落到数据库当前事务。
 *
 * 数据流 / 状态流：
 * - 调用方先完成容量/堆叠/槽位计算；
 * - 本方法按顺序执行 delete/insert/update；
 * - 若外层事务或 savepoint 回滚，所有已写实例会一起回退。
 *
 * 复用设计说明：
 * - 邮件主动领取需要“失败即无副作用”语义，因此复用共享 snapshot 持久化能力而不是再写一套 SQL。
 * - 常规战斗/挂机链路仍继续走 `bufferCharacterItemInstanceMutations`，保持高频奖励性能方案不变。
 *
 * 关键边界条件与坑点：
 * 1. 调用方必须保证 mutation 顺序已经收敛正确，本方法不会重新排序或做冲突消解。
 * 2. 这里不会同步写 Redis 投影视图；只有真正需要 savepoint 语义的调用方才应使用它。
 */
export const applyCharacterItemInstanceMutationsImmediately = async (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<void> => {
  const applied = await tryApplyCharacterItemInstanceMutationsImmediately(mutations);
  if (!applied) {
    throw new Error('实例 mutation 目标槽位冲突');
  }
};

const buildImmediateMutationSavepointName = (): string => {
  return `item_instance_immediate_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
};

const executeImmediateCharacterItemInstanceMutations = async (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<void> => {
  const mutationsByCharacter = new Map<number, BufferedCharacterItemInstanceMutation[]>();
  for (const mutation of mutations) {
    const group = mutationsByCharacter.get(mutation.characterId) ?? [];
    group.push(mutation);
    mutationsByCharacter.set(mutation.characterId, group);
  }

  await lockCharacterInventoryMutexes([...mutationsByCharacter.keys()]);

  for (const [characterId, characterMutations] of mutationsByCharacter.entries()) {
    const existingRowsResult = await query<ExistingItemInstanceLocationRow>(
      `
        SELECT id, owner_character_id, location, location_slot
        FROM item_instance
        WHERE owner_character_id = $1
          AND location IN ('bag', 'warehouse')
          AND location_slot IS NOT NULL
      `,
      [characterId],
    );

    const { effectiveMutations, flushPlan } = resolveItemInstanceFlushInput(
      existingRowsResult.rows,
      characterMutations,
    );

    if (flushPlan.duplicateTargetKeys.length > 0) {
      throw new Error(`slot-conflict:${flushPlan.duplicateTargetKeys.join(',')}`);
    }

    if (flushPlan.slotReleaseItemIds.length > 0) {
      await query(
        `
          UPDATE item_instance
          SET location_slot = NULL,
              updated_at = NOW()
          WHERE owner_character_id = $1
            AND id = ANY($2::bigint[])
            AND location IN ('bag', 'warehouse')
            AND location_slot IS NOT NULL
        `,
        [characterId, buildItemInstanceIdArrayParam(flushPlan.slotReleaseItemIds)],
      );
    }

    for (const mutation of effectiveMutations) {
      if (mutation.kind === 'delete') {
        await query(
          `
            DELETE FROM item_instance
            WHERE id = $1 AND owner_character_id = $2
          `,
          [mutation.itemId, mutation.characterId],
        );
        continue;
      }

      if (!mutation.snapshot) {
        continue;
      }

      const persisted = await tryUpsertCharacterItemInstanceSnapshotImmediately(mutation.snapshot);
      if (!persisted) {
        throw new Error(`slot-conflict:${mutation.itemId}`);
      }
    }
  }
};

export const tryApplyCharacterItemInstanceMutationsImmediately = async (
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<boolean> => {
  if (mutations.length <= 0) {
    return true;
  }

  try {
    if (!hasUsableTransactionContext()) {
      await withTransaction(async () => {
        await executeImmediateCharacterItemInstanceMutations(mutations);
      });
      return true;
    }

    const savepointName = buildImmediateMutationSavepointName();
    await query(`SAVEPOINT ${savepointName}`);
    try {
      await executeImmediateCharacterItemInstanceMutations(mutations);
      await query(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (error) {
      await query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await query(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
    return true;
  } catch (error) {
    if (isItemInstanceSlotConflictError(error)) {
      return false;
    }
    if (error instanceof Error && error.message.startsWith('slot-conflict:')) {
      return false;
    }
    throw error;
  }
};

export const reserveItemInstanceIds = async (count: number): Promise<number[]> => {
  const normalizedCount = Math.max(0, Math.floor(count));
  if (normalizedCount <= 0) return [];
  const result = await query<{ id: number | string }>(
    `
      SELECT nextval(pg_get_serial_sequence('item_instance', 'id')) AS id
      FROM generate_series(1, $1)
    `,
    [normalizedCount],
  );
  return result.rows
    .map((row) => Math.floor(Number(row.id)))
    .filter((id) => Number.isFinite(id) && id > 0);
};

const flushSingleCharacterItemInstanceMutations = async (
  characterId: number,
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<void> => {
  if (mutations.length <= 0) return;
  await withTransaction(async () => {
    await lockCharacterInventoryMutex(characterId);
    const existingRowsResult = await query<ExistingItemInstanceLocationRow>(
      `
        SELECT id, owner_character_id, location, location_slot
        FROM item_instance
        WHERE owner_character_id = $1
          AND location IN ('bag', 'warehouse')
          AND location_slot IS NOT NULL
      `,
      [characterId],
    );
    const {
      effectiveMutations,
      flushPlan,
      droppedSortInventoryMutations,
    } = resolveItemInstanceFlushInput(existingRowsResult.rows, mutations);
    if (droppedSortInventoryMutations) {
      itemInstanceMutationLogger.warn(
        { characterId, droppedMutationCount: mutations.length - effectiveMutations.length },
        '实例 mutation flush 检测到过期整理快照冲突，已丢弃 sort-inventory mutation',
      );
    }
    if (flushPlan.duplicateTargetKeys.length > 0) {
      throw new Error(`实例 mutation 目标槽位冲突: ${flushPlan.duplicateTargetKeys.join(', ')}`);
    }
    if (flushPlan.slotReleaseItemIds.length > 0) {
      await query(
        `
          UPDATE item_instance
          SET location_slot = NULL,
              updated_at = NOW()
          WHERE owner_character_id = $1
            AND id = ANY($2::bigint[])
            AND location IN ('bag', 'warehouse')
            AND location_slot IS NOT NULL
        `,
        [characterId, buildItemInstanceIdArrayParam(flushPlan.slotReleaseItemIds)],
      );
    }
    for (const mutation of effectiveMutations) {
      if (mutation.kind === 'delete') {
        await query(
          `
            DELETE FROM item_instance
            WHERE id = $1 AND owner_character_id = $2
          `,
          [mutation.itemId, characterId],
        );
        continue;
      }
      if (!mutation.snapshot) continue;
      await upsertCharacterItemInstanceSnapshot(mutation.snapshot);
    }
  });
};

const flushCharacterItemInstanceMutations = async (
  options: { drainAll?: boolean; limit?: number } = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const limit = Math.max(1, Math.floor(options.limit ?? ITEM_INSTANCE_MUTATION_FLUSH_BATCH_LIMIT));
  do {
    const dirtyCharacterIds = await listDirtyCharacterIds(limit);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }
    for (const characterId of dirtyCharacterIds) {
      const claimed = await claimCharacterItemInstanceMutations(characterId);
      if (!claimed) continue;
      try {
        const mutations = await loadClaimedMutations(characterId);
        await flushSingleCharacterItemInstanceMutations(characterId, mutations);
        await finalizeCharacterItemInstanceMutations(characterId);
      } catch (error) {
        await restoreCharacterItemInstanceMutations(characterId);
        throw error;
      }
    }
  } while (drainAll);
};

const runItemInstanceMutationFlushLoopOnce = async (): Promise<void> => {
  if (itemInstanceMutationFlushInFlight) {
    await itemInstanceMutationFlushInFlight;
    return;
  }
  const currentFlush = flushCharacterItemInstanceMutations().catch((error: Error) => {
    itemInstanceMutationLogger.error(error, '角色实例 mutation flush 失败');
  });
  itemInstanceMutationFlushInFlight = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (itemInstanceMutationFlushInFlight === currentFlush) {
      itemInstanceMutationFlushInFlight = null;
    }
  }
};

export const initializeCharacterItemInstanceMutationService = async (): Promise<void> => {
  if (itemInstanceMutationFlushTimer) return;
  itemInstanceMutationFlushTimer = setInterval(() => {
    void runItemInstanceMutationFlushLoopOnce();
  }, ITEM_INSTANCE_MUTATION_FLUSH_INTERVAL_MS);
};

export const shutdownCharacterItemInstanceMutationService = async (): Promise<void> => {
  if (itemInstanceMutationFlushTimer) {
    clearInterval(itemInstanceMutationFlushTimer);
    itemInstanceMutationFlushTimer = null;
  }
  if (itemInstanceMutationFlushInFlight) {
    await itemInstanceMutationFlushInFlight;
  }
  await flushCharacterItemInstanceMutations({ drainAll: true });
};
