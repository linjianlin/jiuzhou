import { query } from '../config/database.js';
import crypto from 'crypto';
import { getBountyDefinitions, getItemDefinitions, getItemDefinitionsByIds } from './staticConfigLoader.js';
import { getTaskDefinitionById } from './taskDefinitionService.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { Transactional } from '../decorators/transactional.js';
import { consumeMaterialByDefId } from './inventory/shared/consume.js';
import {
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';

export type BountySourceType = 'daily' | 'player';
export type BountyClaimPolicy = 'unique' | 'limited' | 'unlimited';

export type BountyRequiredItemDto = { itemDefId: string; name: string; qty: number };

export type BountyBoardRowDto = {
  id: number;
  sourceType: BountySourceType;
  taskId: string;
  title: string;
  description: string;
  claimPolicy: BountyClaimPolicy;
  maxClaims: number;
  claimedCount: number;
  refreshDate: string | null;
  expiresAt: string | null;
  publishedByCharacterId: number | null;
  spiritStonesReward: number;
  silverReward: number;
  spiritStonesFee: number;
  silverFee: number;
  requiredItems: BountyRequiredItemDto[];
  claimedByMe: boolean;
  myClaimStatus: string | null;
  myTaskStatus: string | null;
};

type BountyDefRow = {
  id: string;
  pool: string;
  task_id: string;
  title: string;
  description: string | null;
  claim_policy: string;
  max_claims: number;
  weight: number;
};

type CountRow = { cnt: number | string | null };

type BountyBoardQueryRow = {
  id: number | string | null;
  source_type: string | null;
  task_id: string | null;
  title: string | null;
  description: string | null;
  claim_policy: string | null;
  max_claims: number | string | null;
  claimed_count: number | string | null;
  refresh_date: string | Date | null;
  expires_at: string | Date | null;
  published_by_character_id: number | string | null;
  spirit_stones_reward: number | string | null;
  silver_reward: number | string | null;
  spirit_stones_fee: number | string | null;
  silver_fee: number | string | null;
  required_items: unknown;
  claimed_by_me: boolean | null;
  my_claim_status: string | null;
  my_task_status: string | null;
};

type BountyInstanceRow = {
  id: number | string | null;
  task_id: string | null;
  claim_policy: string | null;
  max_claims: number | string | null;
  claimed_count: number | string | null;
  expires_at: string | Date | null;
};

type TaskStatusRow = { status: string | null };
type InsertIdRow = { id: number | string | null };
type ClaimLookupRow = {
  claim_id: number | string | null;
  claim_status: string | null;
  bounty_instance_id: number | string | null;
  required_items: unknown;
};
type ProgressLookupRow = { progress: unknown; status: string | null };
type BountyCharacterCurrencySnapshot = {
  spiritStones: number;
  silver: number;
};
type TaskObjectiveRecord = Record<string, unknown>;
type BountyRequiredItemRecord = {
  item_def_id?: unknown;
  itemDefId?: unknown;
  name?: unknown;
  qty?: unknown;
};

const asNonEmptyString = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

const asFiniteInt = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
};

const asFiniteNonNegativeInt = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
};

const asRequiredItems = (v: unknown): BountyRequiredItemDto[] => {
  const list = Array.isArray(v) ? v : [];
  const out: BountyRequiredItemDto[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as BountyRequiredItemRecord;
    const itemDefId = asNonEmptyString(r.item_def_id ?? r.itemDefId) ?? '';
    if (!itemDefId) continue;
    const name = asNonEmptyString(r.name) ?? itemDefId;
    const qty = Math.max(1, asFiniteNonNegativeInt(r.qty, 1));
    out.push({ itemDefId, name, qty });
  }
  return out;
};

const isTaskObjectiveRecord = (value: unknown): value is TaskObjectiveRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toTaskObjectiveRecords = (value: unknown): TaskObjectiveRecord[] =>
  Array.isArray(value) ? value.filter(isTaskObjectiveRecord) : [];

const getObjectiveType = (objective: TaskObjectiveRecord): string =>
  String(objective.type ?? '').trim();

const getObjectiveId = (objective: TaskObjectiveRecord): string | null =>
  asNonEmptyString(objective.id);

const getObjectiveTarget = (objective: TaskObjectiveRecord): number =>
  Math.max(1, asFiniteNonNegativeInt(objective.target, 1));

const getLocalDateKey = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const getLocalNextMidnight = (d: Date = new Date()): Date => {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
};

const loadBountyCharacterCurrencySnapshot = async (
  characterId: number,
): Promise<BountyCharacterCurrencySnapshot | null> => {
  const character = await loadCharacterWritebackRowByCharacterId(characterId, { forUpdate: true });
  if (!character) return null;
  return {
    spiritStones: asFiniteNonNegativeInt(character.spirit_stones, 0),
    silver: asFiniteNonNegativeInt(character.silver, 0),
  };
};

const spendBountyCharacterCurrencies = async (
  characterId: number,
  current: BountyCharacterCurrencySnapshot,
  spiritCost: number,
  silverCost: number,
): Promise<BountyCharacterCurrencySnapshot> => {
  const nextCurrency = {
    spiritStones: current.spiritStones - spiritCost,
    silver: current.silver - silverCost,
  };
  await queueCharacterWritebackSnapshot(characterId, {
    spirit_stones: nextCurrency.spiritStones,
    silver: nextCurrency.silver,
  });
  return nextCurrency;
};

const pickWeightedUnique = (defs: BountyDefRow[], take: number): BountyDefRow[] => {
  const list = defs.filter((x) => x.weight > 0);
  const result: BountyDefRow[] = [];
  const n = Math.max(0, Math.trunc(take));
  if (n <= 0 || list.length === 0) return result;

  const pool = [...list];
  while (result.length < n && pool.length > 0) {
    let total = 0;
    for (const x of pool) total += Math.max(0, x.weight);
    if (total <= 0) break;
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx += 1) {
      r -= Math.max(0, pool[idx].weight);
      if (r <= 0) break;
    }
    const chosen = pool[Math.min(idx, pool.length - 1)];
    result.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return result;
};

class BountyService {
  @Transactional
  async ensureDailyBountyInstances(desiredCount: number = 6): Promise<void> {
    const today = getLocalDateKey();
    const take = Math.max(1, Math.min(30, Math.trunc(desiredCount)));
    const expiresAt = getLocalNextMidnight();

    await query(
      `
        DELETE FROM bounty_instance
        WHERE source_type = 'daily'
          AND (
            (expires_at IS NOT NULL AND expires_at <= NOW())
            OR (refresh_date IS NOT NULL AND refresh_date < CURRENT_DATE)
          )
      `,
    );

    const existingRes = await query<CountRow>(
      `SELECT COUNT(*)::int AS cnt FROM bounty_instance WHERE source_type = 'daily' AND refresh_date = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [today],
    );
    const existing = asFiniteInt(existingRes.rows[0]?.cnt, 0);
    if (existing >= take) {
      return;
    }

    const defs = getBountyDefinitions()
      .filter((entry) => entry.enabled !== false)
      .filter((entry) => (entry.pool ?? 'daily') === 'daily')
      .map((entry) => ({
        id: entry.id,
        pool: entry.pool ?? 'daily',
        task_id: entry.task_id,
        title: entry.title,
        description: typeof entry.description === 'string' ? entry.description : null,
        claim_policy: entry.claim_policy ?? 'limited',
        max_claims: Number.isFinite(Number(entry.max_claims)) ? Number(entry.max_claims) : 0,
        weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
      }))
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
    const picked = pickWeightedUnique(defs, take);

    for (const d of picked) {
      await query(
        `
          INSERT INTO bounty_instance (
            source_type, bounty_def_id, task_id, title, description,
            claim_policy, max_claims, claimed_count, refresh_date, expires_at,
            published_by_character_id, created_at, updated_at
          ) VALUES (
            'daily', $1, $2, $3, $4,
            $5, $6, 0, $7, $8,
            NULL, NOW(), NOW()
          )
          ON CONFLICT (source_type, refresh_date, bounty_def_id) DO NOTHING
        `,
        [
          d.id,
          d.task_id,
          d.title,
          d.description || null,
          d.claim_policy,
          asFiniteInt(d.max_claims, 0),
          today,
          expiresAt,
        ],
      );
    }
  }

  async getBountyBoard(
    characterId: number,
    poolName: 'daily' | 'all' | 'player' = 'daily',
  ): Promise<{ success: true; data: { bounties: BountyBoardRowDto[]; today: string } } | { success: false; message: string }> {
    const cid = Number(characterId);
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
    const today = getLocalDateKey();

    if (poolName === 'daily' || poolName === 'all') {
      await this.ensureDailyBountyInstances(6);
    }

    const params: unknown[] = [cid];
    if (poolName === 'daily' || poolName === 'all') params.push(today);
    const whereParts: string[] = [];
    if (poolName === 'daily') whereParts.push(`i.source_type = 'daily' AND i.refresh_date = $2 AND (i.expires_at IS NULL OR i.expires_at > NOW())`);
    if (poolName === 'player') whereParts.push(`i.source_type = 'player' AND (i.expires_at IS NULL OR i.expires_at > NOW())`);
    if (poolName === 'all')
      whereParts.push(
        `(i.source_type = 'daily' AND i.refresh_date = $2 AND (i.expires_at IS NULL OR i.expires_at > NOW())) OR (i.source_type = 'player' AND (i.expires_at IS NULL OR i.expires_at > NOW()))`,
      );
    const where = whereParts.length > 0 ? `WHERE ${whereParts.map((p) => `(${p})`).join(' OR ')}` : '';

    const res = await query<BountyBoardQueryRow>(
      `
        SELECT
          i.id,
          i.source_type,
          i.task_id,
          i.title,
          COALESCE(i.description, '') AS description,
          i.claim_policy,
          i.max_claims,
          i.claimed_count,
          i.refresh_date,
          i.expires_at,
          i.published_by_character_id,
          i.spirit_stones_reward,
          i.silver_reward,
          i.spirit_stones_fee,
          i.silver_fee,
          i.required_items,
          CASE WHEN c.id IS NULL THEN false ELSE true END AS claimed_by_me,
          c.status AS my_claim_status,
          p.status AS my_task_status
        FROM bounty_instance i
        LEFT JOIN bounty_claim c
          ON c.bounty_instance_id = i.id
         AND c.character_id = $1
        LEFT JOIN character_task_progress p
          ON p.character_id = $1
         AND p.task_id = i.task_id
        ${where}
        ORDER BY
          CASE WHEN i.source_type = 'daily' THEN 0 ELSE 1 END ASC,
          i.id DESC
      `,
      params,
    );

    const bounties: BountyBoardRowDto[] = res.rows.map((row) => ({
      id: asFiniteInt(row.id, 0),
      sourceType: (asNonEmptyString(row.source_type) ?? 'daily') as BountySourceType,
      taskId: asNonEmptyString(row.task_id) ?? '',
      title: String(row.title ?? ''),
      description: String(row.description ?? ''),
      claimPolicy: (asNonEmptyString(row.claim_policy) ?? 'limited') as BountyClaimPolicy,
      maxClaims: asFiniteInt(row.max_claims, 0),
      claimedCount: asFiniteInt(row.claimed_count, 0),
      refreshDate: row.refresh_date ? String(row.refresh_date) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      publishedByCharacterId:
        row.published_by_character_id === null || row.published_by_character_id === undefined
          ? null
          : asFiniteInt(row.published_by_character_id, 0),
      spiritStonesReward: asFiniteNonNegativeInt(row.spirit_stones_reward, 0),
      silverReward: asFiniteNonNegativeInt(row.silver_reward, 0),
      spiritStonesFee: asFiniteNonNegativeInt(row.spirit_stones_fee, 0),
      silverFee: asFiniteNonNegativeInt(row.silver_fee, 0),
      requiredItems: asRequiredItems(row.required_items),
      claimedByMe: row.claimed_by_me === true,
      myClaimStatus: asNonEmptyString(row.my_claim_status),
      myTaskStatus: asNonEmptyString(row.my_task_status),
    }));

    return { success: true, data: { bounties, today } };
  }

  @Transactional
  async claimBounty(
    characterId: number,
    bountyInstanceId: number,
  ): Promise<
    | { success: true; message: string; data: { bountyInstanceId: number; taskId: string } }
    | { success: false; message: string }
  > {
    const cid = Number(characterId);
    const bid = Number(bountyInstanceId);
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
    if (!Number.isFinite(bid) || bid <= 0) return { success: false, message: '悬赏不存在' };

    const instRes = await query<BountyInstanceRow>(
      `
        SELECT id, task_id, claim_policy, max_claims, claimed_count, expires_at
        FROM bounty_instance
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [bid],
    );
    if (instRes.rows.length === 0) {
      return { success: false, message: '悬赏不存在' };
    }
    const inst = instRes.rows[0];
    const taskId = asNonEmptyString(inst.task_id) ?? '';
    if (!taskId) {
      return { success: false, message: '悬赏数据异常' };
    }
    const expiresAtMs = inst.expires_at ? new Date(inst.expires_at).getTime() : 0;
    if (expiresAtMs && Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
      return { success: false, message: '悬赏已过期' };
    }

    const claimPolicy = (asNonEmptyString(inst.claim_policy) ?? 'limited') as BountyClaimPolicy;
    const maxClaims = asFiniteInt(inst.max_claims, 0);
    const claimedCount = asFiniteInt(inst.claimed_count, 0);

    if (claimPolicy === 'unique' && claimedCount >= 1) {
      return { success: false, message: '该悬赏已被接取' };
    }
    if (claimPolicy === 'limited' && maxClaims > 0 && claimedCount >= maxClaims) {
      return { success: false, message: '该悬赏接取次数已满' };
    }

    const taskProgRes = await query<TaskStatusRow>(
      `SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE`,
      [cid, taskId],
    );
    if (taskProgRes.rows.length > 0) {
      const st = asNonEmptyString(taskProgRes.rows[0]?.status);
      if (st && st !== 'claimed') {
        return { success: false, message: '该任务已接取' };
      }
    }

    const insertClaimRes = await query<InsertIdRow>(
      `
        INSERT INTO bounty_claim (bounty_instance_id, character_id, status, claimed_at, updated_at)
        VALUES ($1, $2, 'claimed', NOW(), NOW())
        ON CONFLICT (bounty_instance_id, character_id) DO NOTHING
        RETURNING id
      `,
      [bid, cid],
    );
    if (insertClaimRes.rows.length === 0) {
      return { success: false, message: '已接取该悬赏' };
    }

    await query(
      `UPDATE bounty_instance SET claimed_count = claimed_count + 1, updated_at = NOW() WHERE id = $1`,
      [bid],
    );

    const taskDef = await getTaskDefinitionById(taskId);
    if (!taskDef) {
      return { success: false, message: '任务不存在' };
    }
    const objectives = toTaskObjectiveRecords(taskDef.objectives);
    const hasSubmitObjective = objectives.some((objective) => getObjectiveType(objective) === 'submit_items');
    const initialStatus = hasSubmitObjective ? 'turnin' : 'ongoing';

    await query(
      `
        INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
        VALUES ($1, $2, $3, '{}'::jsonb, true, NOW(), NULL, NULL, NOW())
        ON CONFLICT (character_id, task_id) DO UPDATE SET
          status = EXCLUDED.status,
          progress = EXCLUDED.progress,
          tracked = EXCLUDED.tracked,
          accepted_at = NOW(),
          completed_at = NULL,
          claimed_at = NULL,
          updated_at = NOW()
      `,
      [cid, taskId, initialStatus],
    );
    return { success: true, message: '接取成功', data: { bountyInstanceId: bid, taskId } };
  }

  async publishBounty(
    characterId: number,
    payload: {
      title: string;
      description?: string;
      claimPolicy?: BountyClaimPolicy;
      maxClaims?: number;
      expiresAt?: string;
      spiritStonesReward?: number;
      silverReward?: number;
      requiredItems?: Array<{ itemDefId?: unknown; qty?: unknown }>;
      taskId?: string;
    },
  ): Promise<
    | { success: true; message: string; data: { bountyInstanceId: number } }
    | { success: false; message: string }
  > {
    const cid = Number(characterId);
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

    const title = asNonEmptyString(payload.title) ?? '';
    if (!title) return { success: false, message: '标题不能为空' };

    const claimPolicy = ((asNonEmptyString(payload.claimPolicy) ?? 'limited') as BountyClaimPolicy) ?? 'limited';
    const maxClaimsRaw = asFiniteNonNegativeInt(payload.maxClaims, 0);
    const maxClaims = claimPolicy === 'limited' ? maxClaimsRaw : 0;
    if (claimPolicy === 'limited' && maxClaims <= 0) return { success: false, message: '限次接取必须设置最大次数' };
    if (claimPolicy === 'unlimited') return { success: false, message: '玩家悬赏暂不支持不限接取' };
    const desc = typeof payload.description === 'string' ? payload.description : '';
    const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : NaN;
    const expiresAt = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() ? new Date(expiresAtMs).toISOString() : null;

    const spiritStonesReward = asFiniteNonNegativeInt(payload.spiritStonesReward, 0);
    const silverReward = asFiniteNonNegativeInt(payload.silverReward, 0);
    if (spiritStonesReward <= 0 && silverReward <= 0) return { success: false, message: '奖励不能都为0' };

    const rawRequiredItems = Array.isArray(payload.requiredItems) ? payload.requiredItems : [];
    const requiredItems: Array<{ itemDefId: string; qty: number }> = [];
    for (const it of rawRequiredItems) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const input = it as { itemDefId?: unknown; qty?: unknown };
      const itemDefId = asNonEmptyString(input.itemDefId) ?? '';
      const qty = Math.max(1, asFiniteNonNegativeInt(input.qty, 1));
      if (!itemDefId) continue;
      requiredItems.push({ itemDefId, qty });
    }
    if (requiredItems.length === 0) return { success: false, message: '必须设置需要提交的材料' };
    if (requiredItems.length > 8) return { success: false, message: '一次最多设置8种材料' };

    const multiplier = claimPolicy === 'limited' ? Math.max(1, maxClaims) : 1;
    const spiritBudget = spiritStonesReward * multiplier;
    const silverBudget = silverReward * multiplier;

    const spiritStonesFee = spiritBudget > 0 ? Math.ceil(spiritBudget * 0.1) : 0;
    const silverFee = silverBudget > 0 ? Math.ceil(silverBudget * 0.1) : 0;
    const spiritCost = spiritBudget + spiritStonesFee;
    const silverCost = silverBudget + silverFee;

    try {
      return await this._publishBountyInner(cid, payload, title, desc, claimPolicy, maxClaims, expiresAt, spiritStonesReward, silverReward, requiredItems, spiritStonesFee, silverFee, spiritCost, silverCost);
    } catch (error) {
      console.error('发布悬赏失败:', error);
      return { success: false, message: '服务器错误' };
    }
  }

  @Transactional
  private async _publishBountyInner(
    cid: number,
    payload: { taskId?: string },
    title: string,
    desc: string,
    claimPolicy: BountyClaimPolicy,
    maxClaims: number,
    expiresAt: string | null,
    spiritStonesReward: number,
    silverReward: number,
    requiredItems: Array<{ itemDefId: string; qty: number }>,
    spiritStonesFee: number,
    silverFee: number,
    spiritCost: number,
    silverCost: number,
  ): Promise<
    | { success: true; message: string; data: { bountyInstanceId: number } }
    | { success: false; message: string }
  > {
    const itemIds = Array.from(new Set(requiredItems.map((x) => x.itemDefId)));
    const nameById = new Map<string, string>();
    const defs = getItemDefinitionsByIds(itemIds);
    for (const id of itemIds) {
      const def = defs.get(id);
      if (!def || def.enabled === false) continue;
      const name = asNonEmptyString(def.name) ?? id;
      nameById.set(id, name);
    }
    if (nameById.size !== itemIds.length) {
      return { success: false, message: '包含不存在的材料' };
    }

    const providedTaskId = asNonEmptyString(payload.taskId);
    const taskId = providedTaskId ? providedTaskId : `task-bounty-${crypto.randomUUID()}`;
    if (taskId.length > 64) {
      return { success: false, message: '任务ID过长' };
    }

    const objectiveText = requiredItems
      .map((x) => `${nameById.get(x.itemDefId) ?? x.itemDefId}×${x.qty}`)
      .join('、');
    const taskObjectives = [
      {
        id: 'obj-submit',
        type: 'submit_items',
        text: `提交材料：${objectiveText}`,
        target: 1,
        params: { items: requiredItems.map((x) => ({ item_def_id: x.itemDefId, qty: x.qty })) },
      },
    ];

    const normalizedRequiredItems = requiredItems.map((x) => ({
      item_def_id: x.itemDefId,
      name: nameById.get(x.itemDefId) ?? x.itemDefId,
      qty: x.qty,
    }));

    if (!providedTaskId) {
      await query(
        `
          INSERT INTO task_def (
            id, category, title, realm, description,
            giver_npc_id, map_id, room_id,
            objectives, rewards, prereq_task_ids,
            enabled, sort_weight, version, updated_at
          ) VALUES (
            $1, 'event', $2, '凡人', $3,
            NULL, NULL, NULL,
            $4::jsonb, '[]'::jsonb, '[]'::jsonb,
            true, 0, 1, NOW()
          )
        `,
        [taskId, title, desc || null, JSON.stringify(taskObjectives)],
      );
    } else {
      const existsTaskDef = await getTaskDefinitionById(taskId);
      if (!existsTaskDef) {
        return { success: false, message: '任务不存在' };
      }
    }

    const character = await loadBountyCharacterCurrencySnapshot(cid);
    if (!character) {
      return { success: false, message: '角色不存在' };
    }
    if (character.spiritStones < spiritCost) {
      return { success: false, message: '灵石不足' };
    }
    if (character.silver < silverCost) {
      return { success: false, message: '银两不足' };
    }

    const res = await query<InsertIdRow>(
      `
        INSERT INTO bounty_instance (
          source_type, bounty_def_id, task_id, title, description,
          claim_policy, max_claims, claimed_count, refresh_date, expires_at,
          published_by_character_id,
          spirit_stones_reward, silver_reward, spirit_stones_fee, silver_fee,
          required_items,
          created_at, updated_at
        ) VALUES (
          'player', NULL, $1, $2, $3,
          $4, $5, 0, NULL, $6,
          $7,
          $8, $9, $10, $11,
          $12::jsonb,
          NOW(), NOW()
        )
        RETURNING id
      `,
      [
        taskId,
        title,
        desc || null,
        claimPolicy,
        maxClaims,
        expiresAt,
        cid,
        spiritStonesReward,
        silverReward,
        spiritStonesFee,
        silverFee,
        JSON.stringify(normalizedRequiredItems),
      ],
    );
    const id = asFiniteInt(res.rows[0]?.id, 0);
    if (!id) {
      return { success: false, message: '发布失败' };
    }
    await spendBountyCharacterCurrencies(cid, character, spiritCost, silverCost);
    return { success: true, message: '发布成功', data: { bountyInstanceId: id } };
  }

  async searchItemDefsForBounty(
    keyword: string,
    limit: number = 20,
  ): Promise<{ success: true; data: { items: Array<{ id: string; name: string; icon: string | null; category: string | null }> } } | { success: false; message: string }> {
    const q = asNonEmptyString(keyword) ?? '';
    const take = Math.max(1, Math.min(50, Math.trunc(limit)));
    if (!q) return { success: true, data: { items: [] } };
    const keywordLower = q.toLowerCase();
    const items = getItemDefinitions()
      .filter((entry) => entry.enabled !== false)
      .filter((entry) => String(entry.name || '').toLowerCase().includes(keywordLower))
      .sort((left, right) => {
        const categoryDiff = String(left.category || '').localeCompare(String(right.category || ''));
        if (categoryDiff !== 0) return categoryDiff;
        const qualityRankDiff =
          resolveQualityRankFromName(right.quality, 0) - resolveQualityRankFromName(left.quality, 0);
        if (qualityRankDiff !== 0) return qualityRankDiff;
        return String(left.id || '').localeCompare(String(right.id || ''));
      })
      .slice(0, take)
      .map((entry) => ({
        id: String(entry.id || ''),
        name: String(entry.name || ''),
        icon: typeof entry.icon === 'string' ? entry.icon : null,
        category: typeof entry.category === 'string' ? entry.category : null,
      }))
      .filter((entry) => entry.id);

    return { success: true, data: { items } };
  }

  async submitBountyMaterials(
    characterId: number,
    taskId: string,
  ): Promise<{ success: true; message: string; data: { taskId: string } } | { success: false; message: string }> {
    const cid = Number(characterId);
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
    const tid = asNonEmptyString(taskId) ?? '';
    if (!tid) return { success: false, message: '任务ID不能为空' };

    try {
      return await this._submitBountyMaterialsInner(cid, tid);
    } catch (error) {
      console.error('提交悬赏材料失败:', error);
      return { success: false, message: '服务器错误' };
    }
  }

  @Transactional
  private async _submitBountyMaterialsInner(
    cid: number,
    tid: string,
  ): Promise<{ success: true; message: string; data: { taskId: string } } | { success: false; message: string }> {
    const claimRes = await query<ClaimLookupRow>(
      `
        SELECT
          c.id AS claim_id,
          c.status AS claim_status,
          i.id AS bounty_instance_id,
          i.required_items
        FROM bounty_claim c
        JOIN bounty_instance i ON i.id = c.bounty_instance_id
        WHERE c.character_id = $1
          AND i.task_id = $2
          AND c.status IN ('claimed','completed')
        LIMIT 1
        FOR UPDATE
      `,
      [cid, tid],
    );
    if (claimRes.rows.length === 0) {
      return { success: false, message: '未接取该悬赏' };
    }

    const claimRow = claimRes.rows[0];
    const claimId = Number(claimRow.claim_id);
    const claimStatus = asNonEmptyString(claimRow.claim_status) ?? 'claimed';
    if (claimStatus === 'completed') {
      return { success: false, message: '已提交材料' };
    }

    const requiredItems = asRequiredItems(claimRow.required_items);
    if (requiredItems.length === 0) {
      return { success: false, message: '该悬赏无需提交材料' };
    }

    const progRes = await query<ProgressLookupRow>(
      `SELECT progress, status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 FOR UPDATE`,
      [cid, tid],
    );
    if (progRes.rows.length === 0) {
      return { success: false, message: '任务未接取' };
    }
    const currentStatus = asNonEmptyString(progRes.rows[0]?.status) ?? 'ongoing';
    if (currentStatus === 'claimable') {
      return { success: false, message: '任务已可领取' };
    }
    if (currentStatus === 'claimed') {
      return { success: false, message: '任务已完成' };
    }

    const taskDef = await getTaskDefinitionById(tid);
    const objectives = toTaskObjectiveRecords(taskDef?.objectives);
    const submitObj = objectives.find((objective) => getObjectiveType(objective) === 'submit_items');
    const submitObjId = submitObj ? getObjectiveId(submitObj) : null;
    const submitTarget = submitObj ? getObjectiveTarget(submitObj) : 1;

    for (const reqItem of requiredItems) {
      const consumeResult = await consumeMaterialByDefId(cid, reqItem.itemDefId, reqItem.qty);
      if (!consumeResult.success) {
        return { success: false, message: consumeResult.message };
      }
    }

    const progressValue = progRes.rows[0]?.progress;
    const progressRecord =
      progressValue && typeof progressValue === 'object' && !Array.isArray(progressValue)
        ? (progressValue as Record<string, unknown>)
        : {};
    const nextProgress: Record<string, number> = {};
    for (const [k, v] of Object.entries(progressRecord)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (Number.isFinite(n)) nextProgress[k] = Math.max(0, Math.floor(n));
    }
    if (submitObjId) nextProgress[submitObjId] = submitTarget;

    await query(
      `
        UPDATE character_task_progress
        SET progress = $3::jsonb,
            status = 'claimable',
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE character_id = $1 AND task_id = $2
      `,
      [cid, tid, JSON.stringify(nextProgress)],
    );

    if (Number.isFinite(claimId) && claimId > 0) {
      await query(`UPDATE bounty_claim SET status = 'completed', updated_at = NOW() WHERE id = $1`, [claimId]);
    }
    return { success: true, message: '提交成功', data: { taskId: tid } };
  }
}

export const bountyService = new BountyService();
