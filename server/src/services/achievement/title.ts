import { pool, query, withTransaction } from '../../config/database.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  normalizeTitleEffects,
} from './shared.js';
import type { ServiceResult, TitleInfo, TitleListResult } from './types.js';
import { invalidateCharacterComputedCache } from '../characterComputedService.js';
import { getTitleDefinitions } from '../staticConfigLoader.js';

const computeEffectDelta = (
  current: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> => {
  const keys = new Set<string>([...Object.keys(current), ...Object.keys(next)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const diff = (next[key] ?? 0) - (current[key] ?? 0);
    if (diff !== 0) out[key] = diff;
  }
  return out;
};

const updateCharacterAttrsWithDeltaTx = async (
  characterId: number,
  titleName: string,
  _delta: Record<string, number>,
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> => {
  const params: unknown[] = [characterId, titleName];
  await client.query(`UPDATE characters SET title = $2, updated_at = NOW() WHERE id = $1`, params);
};

export const getTitleList = async (characterId: number): Promise<TitleListResult> => {
  const cid = asFiniteNonNegativeInt(characterId, 0);
  if (!cid) return { titles: [], equipped: '' };

  const res = await query(
    `
      SELECT
        ct.title_id,
        ct.is_equipped,
        ct.obtained_at,
        ct.expires_at
      FROM character_title ct
      WHERE ct.character_id = $1
        AND (ct.expires_at IS NULL OR ct.expires_at > NOW())
      ORDER BY ct.is_equipped DESC, ct.obtained_at ASC, ct.id ASC
    `,
    [cid],
  );

  const titleDefMap = new Map(
    getTitleDefinitions()
      .filter((row) => row.enabled !== false)
      .map((row) => [row.id, row]),
  );

  const titles: TitleInfo[] = [];
  let equipped = '';

  for (const row of res.rows as Array<Record<string, unknown>>) {
    const id = asNonEmptyString(row.title_id);
    if (!id) continue;
    const def = titleDefMap.get(id);
    if (!def) continue;
    const isEquipped = row.is_equipped === true;
    if (isEquipped) equipped = id;

    titles.push({
      id,
      name: asNonEmptyString(def.name) ?? id,
      description: String(def.description ?? ''),
      color: asNonEmptyString(def.color),
      icon: asNonEmptyString(def.icon),
      effects: normalizeTitleEffects(def.effects),
      isEquipped,
      obtainedAt: row.obtained_at ? new Date(String(row.obtained_at)).toISOString() : new Date(0).toISOString(),
      expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
    });
  }

  return { titles, equipped };
};

export const equipTitle = async (characterId: number, titleId: string): Promise<ServiceResult> => {
  const cid = asFiniteNonNegativeInt(characterId, 0);
  const tid = asNonEmptyString(titleId);
  if (!cid) return { success: false, message: '角色不存在' };
  if (!tid) return { success: false, message: '称号ID不能为空' };

  try {
    return await withTransaction(async (client) => {
  const targetDef = getTitleDefinitions().find((row) => row.id === tid && row.enabled !== false);
      if (!targetDef) {
        await client.query('ROLLBACK');
        return { success: false, message: '未拥有该称号' };
      }
  
      const targetRes = await client.query(
        `
          SELECT title_id
          FROM character_title
          WHERE character_id = $1
            AND title_id = $2
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1
          FOR UPDATE
        `,
        [cid, tid],
      );
  
      if ((targetRes.rows ?? []).length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '未拥有该称号' };
      }
  
      const targetName = asNonEmptyString(targetDef.name) ?? tid;
      const nextEffects = normalizeTitleEffects(targetDef.effects);
  
      const currentRes = await client.query(
        `
          SELECT title_id
          FROM character_title
          WHERE character_id = $1
            AND is_equipped = true
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1
          FOR UPDATE
        `,
        [cid],
      );
  
      const currentRow = (currentRes.rows?.[0] ?? null) as Record<string, unknown> | null;
      const currentTitleId = currentRow ? asNonEmptyString(currentRow.title_id) : null;
      const currentDef = currentTitleId
        ? getTitleDefinitions().find((row) => row.id === currentTitleId && row.enabled !== false)
        : null;
      const currentEffects = currentDef ? normalizeTitleEffects(currentDef.effects) : {};
  
      if (currentTitleId === tid) {
  return { success: true, message: 'ok' };
      }
  
      const delta = computeEffectDelta(currentEffects, nextEffects);
  
      await client.query(
        `
          UPDATE character_title
          SET is_equipped = false,
              updated_at = NOW()
          WHERE character_id = $1
            AND is_equipped = true
        `,
        [cid],
      );
  
      await client.query(
        `
          UPDATE character_title
          SET is_equipped = true,
              updated_at = NOW()
          WHERE character_id = $1
            AND title_id = $2
        `,
        [cid, tid],
      );
  
      await updateCharacterAttrsWithDeltaTx(cid, targetName, delta, client);
  await invalidateCharacterComputedCache(cid);
      return { success: true, message: 'ok' };
    });
  } catch (error) {
console.error('装备称号失败:', error);
    return { success: false, message: '装备称号失败' };
  }
};
