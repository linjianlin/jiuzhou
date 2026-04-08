import { afterTransactionCommit, query, withTransaction } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import type { InventoryItem, InventoryLocation } from '../inventory/shared/types.js';
import { createScopedLogger } from '../../utils/logger.js';

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

type ExistingItemInstanceLocationRow = {
  id: number | string;
  owner_character_id: number | string;
  location: string;
  location_slot: number | string | null;
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
): Promise<CharacterItemInstanceSnapshot[]> => {
  const [baseSnapshots, mutations] = await Promise.all([
    loadBaseCharacterItemInstanceSnapshots(characterId),
    loadCharacterPendingItemInstanceMutations(characterId),
  ]);
  return applyCharacterItemInstanceMutations(baseSnapshots, mutations);
};

export const loadProjectedCharacterItemInstancesByLocation = async (
  characterId: number,
  location: ItemInstanceLocation,
): Promise<CharacterItemInstanceSnapshot[]> => {
  const projectedItems = await loadProjectedCharacterItemInstances(characterId);
  return projectedItems.filter((item) => item.location === location);
};

export const loadProjectedCharacterItemInstanceById = async (
  characterId: number,
  itemId: number,
): Promise<CharacterItemInstanceSnapshot | null> => {
  const projectedItems = await loadProjectedCharacterItemInstances(characterId);
  const target = projectedItems.find((item) => item.id === itemId);
  return target ? cloneSnapshot(target) : null;
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
          ON CONFLICT (id) DO UPDATE
          SET owner_user_id = EXCLUDED.owner_user_id,
              owner_character_id = EXCLUDED.owner_character_id,
              item_def_id = EXCLUDED.item_def_id,
              qty = EXCLUDED.qty,
              quality = EXCLUDED.quality,
              quality_rank = EXCLUDED.quality_rank,
              metadata = EXCLUDED.metadata,
              location = EXCLUDED.location,
              location_slot = EXCLUDED.location_slot,
              equipped_slot = EXCLUDED.equipped_slot,
              strengthen_level = EXCLUDED.strengthen_level,
              refine_level = EXCLUDED.refine_level,
              socketed_gems = EXCLUDED.socketed_gems,
              affixes = EXCLUDED.affixes,
              identified = EXCLUDED.identified,
              locked = EXCLUDED.locked,
              bind_type = EXCLUDED.bind_type,
              bind_owner_user_id = EXCLUDED.bind_owner_user_id,
              bind_owner_character_id = EXCLUDED.bind_owner_character_id,
              random_seed = EXCLUDED.random_seed,
              affix_gen_version = EXCLUDED.affix_gen_version,
              affix_roll_meta = EXCLUDED.affix_roll_meta,
              custom_name = EXCLUDED.custom_name,
              expire_at = EXCLUDED.expire_at,
              obtained_from = EXCLUDED.obtained_from,
              obtained_ref_id = EXCLUDED.obtained_ref_id,
              created_at = EXCLUDED.created_at,
              updated_at = NOW()
        `,
        [
          mutation.snapshot.id,
          mutation.snapshot.owner_user_id,
          mutation.snapshot.owner_character_id,
          mutation.snapshot.item_def_id,
          mutation.snapshot.qty,
          mutation.snapshot.quality,
          mutation.snapshot.quality_rank,
          toDbJson(mutation.snapshot.metadata),
          mutation.snapshot.location,
          mutation.snapshot.location_slot,
          mutation.snapshot.equipped_slot,
          mutation.snapshot.strengthen_level,
          mutation.snapshot.refine_level,
          toDbJson(mutation.snapshot.socketed_gems),
          toDbJson(mutation.snapshot.affixes),
          mutation.snapshot.identified,
          mutation.snapshot.locked,
          mutation.snapshot.bind_type,
          mutation.snapshot.bind_owner_user_id,
          mutation.snapshot.bind_owner_character_id,
          mutation.snapshot.random_seed,
          mutation.snapshot.affix_gen_version,
          toDbJson(mutation.snapshot.affix_roll_meta),
          mutation.snapshot.custom_name,
          mutation.snapshot.expire_at,
          mutation.snapshot.obtained_from,
          mutation.snapshot.obtained_ref_id,
          mutation.snapshot.created_at,
        ],
      );
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
