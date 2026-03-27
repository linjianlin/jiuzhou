/**
 * 伙伴排行榜快照服务。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把伙伴等级/战力榜所需字段收敛为 `partner_rank_snapshot`，避免排行查询时重建全量伙伴属性。
 * 2. 做什么：提供按角色同步、缺失回填与提交后去抖刷新入口，供伙伴培养、获得、转移与角色突破复用。
 * 3. 不做什么：不负责排行榜分页 UI，不决定榜单排序文案，也不替代伙伴总览 DTO。
 *
 * 输入/输出：
 * - 输入：角色 ID，或由伙伴展示 DTO 派生出的单条快照源。
 * - 输出：标准化后的伙伴快照行；副作用是 upsert / delete `partner_rank_snapshot`。
 *
 * 数据流/状态流：
 * 伙伴写库成功 / 角色境界突破 -> 本模块登记 after-commit 去抖刷新 -> 加载当前角色全部伙伴展示 DTO ->
 * 计算真实等级与排行战力 -> 写入 `partner_rank_snapshot` -> `rankService` 只读快照分页。
 *
 * 复用设计说明：
 * 1. 快照字段完全复用 `partnerView` 的展示构建与 `rankPower` 的统一战力口径，避免榜单再维护第二套伙伴属性算法。
 * 2. 刷新入口按“角色”而不是“单伙伴”同步，能同时覆盖伙伴新增、删除、转移和境界导致的战力变化，减少多处散落删除逻辑。
 * 3. 提交后调度集中放在这里，伙伴服务、坊市服务、境界服务只负责声明“谁需要刷新”，不再各自维护计时器与并发控制。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴战力依赖角色当前境界衍生出的伙伴属性，所以角色突破后必须同步刷新该角色全部伙伴快照。
 * 2. 伙伴可能在归契或交易中被删除/转移；同步时必须清掉当前角色已经不存在的快照，避免旧榜单残留。
 */
import { afterTransactionCommit, query } from '../config/database.js';
import type { PartnerOwnerRealmContext } from './shared/partnerLevelLimit.js';
import {
  buildPartnerDetails,
  loadPartnerRows,
  loadPartnerTechniqueRows,
  normalizeInteger,
  normalizeText,
  type PartnerDisplayDto,
} from './shared/partnerView.js';
import { computeRankPower } from './shared/rankPower.js';

export interface PartnerRankSnapshotRow {
  partnerId: number;
  characterId: number;
  partnerName: string;
  avatar: string | null;
  quality: string;
  element: string;
  role: string;
  level: number;
  power: number;
}

const PARTNER_RANK_REFRESH_DEBOUNCE_MS = 80;
const PARTNER_RANK_BACKFILL_BATCH_SIZE = 100;

const partnerRankRefreshTimers = new Map<number, ReturnType<typeof setTimeout>>();
const partnerRankRefreshInFlight = new Set<number>();
const partnerRankRefreshQueued = new Set<number>();

const normalizeCharacterId = (characterId: number): number => {
  const normalized = Math.floor(Number(characterId));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const normalizePartnerId = (partnerId: number): number => {
  const normalized = Math.floor(Number(partnerId));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const loadPartnerOwnerRealmContextByCharacterId = async (
  characterId: number,
): Promise<PartnerOwnerRealmContext | null> => {
  const result = await query(
    `
      SELECT realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;

  const row = result.rows[0] as {
    realm: string | null;
    sub_realm: string | null;
  };

  return {
    realm: normalizeText(row.realm) || '凡人',
    subRealm: normalizeText(row.sub_realm) || null,
  };
};

export const buildPartnerRankSnapshotRow = (
  characterId: number,
  partner: Pick<
    PartnerDisplayDto,
    'id' | 'nickname' | 'avatar' | 'quality' | 'element' | 'role' | 'level' | 'computedAttrs'
  >,
): PartnerRankSnapshotRow => {
  const power = computeRankPower(partner.computedAttrs);

  return {
    partnerId: normalizePartnerId(partner.id),
    characterId: normalizeCharacterId(characterId),
    partnerName: normalizeText(partner.nickname),
    avatar: normalizeText(partner.avatar) || null,
    quality: normalizeText(partner.quality) || '黄',
    element: normalizeText(partner.element) || 'none',
    role: normalizeText(partner.role) || '伙伴',
    level: normalizeInteger(partner.level, 1),
    power,
  };
};

export const upsertPartnerRankSnapshot = async (
  characterId: number,
  partner: Pick<
    PartnerDisplayDto,
    'id' | 'nickname' | 'avatar' | 'quality' | 'element' | 'role' | 'level' | 'computedAttrs'
  >,
): Promise<PartnerRankSnapshotRow> => {
  const snapshot = buildPartnerRankSnapshotRow(characterId, partner);
  if (snapshot.partnerId <= 0 || snapshot.characterId <= 0) {
    throw new Error('伙伴排行榜快照主键非法');
  }

  await query(
    `
      INSERT INTO partner_rank_snapshot (
        partner_id,
        character_id,
        partner_name,
        avatar,
        quality,
        element,
        role,
        level,
        power,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
      )
      ON CONFLICT (partner_id) DO UPDATE SET
        character_id = EXCLUDED.character_id,
        partner_name = EXCLUDED.partner_name,
        avatar = EXCLUDED.avatar,
        quality = EXCLUDED.quality,
        element = EXCLUDED.element,
        role = EXCLUDED.role,
        level = EXCLUDED.level,
        power = EXCLUDED.power,
        updated_at = NOW()
    `,
    [
      snapshot.partnerId,
      snapshot.characterId,
      snapshot.partnerName,
      snapshot.avatar,
      snapshot.quality,
      snapshot.element,
      snapshot.role,
      snapshot.level,
      snapshot.power,
    ],
  );

  return snapshot;
};

const deleteStalePartnerRankSnapshotsByCharacterId = async (
  characterId: number,
  partnerIds: number[],
): Promise<void> => {
  if (partnerIds.length <= 0) {
    await query('DELETE FROM partner_rank_snapshot WHERE character_id = $1', [characterId]);
    return;
  }

  await query(
    `
      DELETE FROM partner_rank_snapshot
      WHERE character_id = $1
        AND NOT (partner_id = ANY($2))
    `,
    [characterId, partnerIds],
  );
};

export const syncPartnerRankSnapshotsByCharacterId = async (
  characterId: number,
): Promise<void> => {
  const normalizedCharacterId = normalizeCharacterId(characterId);
  if (normalizedCharacterId <= 0) return;

  const rows = await loadPartnerRows(normalizedCharacterId, false);
  if (rows.length <= 0) {
    await deleteStalePartnerRankSnapshotsByCharacterId(normalizedCharacterId, []);
    return;
  }

  const ownerRealm = await loadPartnerOwnerRealmContextByCharacterId(normalizedCharacterId);
  if (!ownerRealm) {
    await deleteStalePartnerRankSnapshotsByCharacterId(normalizedCharacterId, []);
    return;
  }

  const techniqueMap = await loadPartnerTechniqueRows(
    rows.map((row) => row.id),
    false,
  );
  const partners = await buildPartnerDetails({
    rows,
    techniqueMap,
    ownerRealmMap: new Map<number, PartnerOwnerRealmContext>([
      [normalizedCharacterId, ownerRealm],
    ]),
  });

  const partnerIds = partners
    .map((partner) => normalizePartnerId(partner.id))
    .filter((partnerId) => partnerId > 0);

  for (const partner of partners) {
    await upsertPartnerRankSnapshot(normalizedCharacterId, partner);
  }

  await deleteStalePartnerRankSnapshotsByCharacterId(normalizedCharacterId, partnerIds);
};

const clearPartnerRankRefreshTimer = (characterId: number): void => {
  const timer = partnerRankRefreshTimers.get(characterId);
  if (!timer) return;
  clearTimeout(timer);
  partnerRankRefreshTimers.delete(characterId);
};

const flushPartnerRankSnapshotRefresh = async (characterId: number): Promise<void> => {
  if (partnerRankRefreshInFlight.has(characterId)) {
    partnerRankRefreshQueued.add(characterId);
    return;
  }

  partnerRankRefreshInFlight.add(characterId);
  try {
    await syncPartnerRankSnapshotsByCharacterId(characterId);
  } finally {
    partnerRankRefreshInFlight.delete(characterId);
    if (partnerRankRefreshQueued.delete(characterId)) {
      schedulePartnerRankSnapshotRefreshByCharacterId(characterId);
    }
  }
};

const enqueuePartnerRankSnapshotRefreshByCharacterId = (
  characterId: number,
): void => {
  const normalizedCharacterId = normalizeCharacterId(characterId);
  if (normalizedCharacterId <= 0) return;

  clearPartnerRankRefreshTimer(normalizedCharacterId);
  const timer = setTimeout(() => {
    partnerRankRefreshTimers.delete(normalizedCharacterId);
    void flushPartnerRankSnapshotRefresh(normalizedCharacterId).catch((error) => {
      console.error(`[partner:rank] 后台刷新失败: characterId=${normalizedCharacterId}`, error);
    });
  }, PARTNER_RANK_REFRESH_DEBOUNCE_MS);
  partnerRankRefreshTimers.set(normalizedCharacterId, timer);
};

export const schedulePartnerRankSnapshotRefreshByCharacterId = async (
  characterId: number,
): Promise<void> => {
  const normalizedCharacterId = normalizeCharacterId(characterId);
  if (normalizedCharacterId <= 0) return;

  await afterTransactionCommit(async () => {
    enqueuePartnerRankSnapshotRefreshByCharacterId(normalizedCharacterId);
  });
};

export const backfillPartnerRankSnapshots = async (): Promise<void> => {
  const result = await query(
    `
      SELECT DISTINCT cp.character_id
      FROM character_partner cp
      LEFT JOIN partner_rank_snapshot prs ON prs.partner_id = cp.id
      WHERE prs.partner_id IS NULL
      ORDER BY cp.character_id ASC
    `,
    [],
  );

  const characterIds = (result.rows as Array<{ character_id: number | string | bigint | null }>)
    .map((row) => normalizeCharacterId(normalizeInteger(row.character_id)))
    .filter((characterId) => characterId > 0);

  if (characterIds.length <= 0) return;

  for (let index = 0; index < characterIds.length; index += PARTNER_RANK_BACKFILL_BATCH_SIZE) {
    const chunk = characterIds.slice(index, index + PARTNER_RANK_BACKFILL_BATCH_SIZE);
    for (const characterId of chunk) {
      await syncPartnerRankSnapshotsByCharacterId(characterId);
    }
  }
};
