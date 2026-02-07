import { pool, query } from '../../config/database.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  normalizeTitleEffects,
} from './shared.js';
import type { ServiceResult, TitleInfo, TitleListResult } from './types.js';

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
  delta: Record<string, number>,
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> => {
  const keys = Object.keys(delta);
  const setClauses: string[] = [];
  const params: unknown[] = [characterId, titleName];

  for (const key of keys) {
    params.push(delta[key]);
    setClauses.push(`${key} = GREATEST(0, ${key} + $${params.length})`);
  }

  if (setClauses.length === 0) {
    await client.query(`UPDATE characters SET title = $2, updated_at = NOW() WHERE id = $1`, params);
  } else {
    await client.query(
      `
        UPDATE characters
        SET title = $2,
            ${setClauses.join(', ')},
            updated_at = NOW()
        WHERE id = $1
      `,
      params,
    );
  }

  await client.query(
    `
      UPDATE characters
      SET qixue = LEAST(qixue, max_qixue),
          lingqi = LEAST(lingqi, max_lingqi),
          updated_at = NOW()
      WHERE id = $1
    `,
    [characterId],
  );
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
        td.name,
        td.description,
        td.rarity,
        td.color,
        td.icon,
        td.effects
      FROM character_title ct
      JOIN title_def td ON td.id = ct.title_id
      WHERE ct.character_id = $1
        AND td.enabled = true
      ORDER BY ct.is_equipped DESC, ct.obtained_at ASC, ct.id ASC
    `,
    [cid],
  );

  const titles: TitleInfo[] = [];
  let equipped = '';

  for (const row of res.rows as Array<Record<string, unknown>>) {
    const id = asNonEmptyString(row.title_id);
    if (!id) continue;
    const isEquipped = row.is_equipped === true;
    if (isEquipped) equipped = id;

    titles.push({
      id,
      name: asNonEmptyString(row.name) ?? id,
      description: String(row.description ?? ''),
      rarity: asNonEmptyString(row.rarity) ?? 'common',
      color: asNonEmptyString(row.color),
      icon: asNonEmptyString(row.icon),
      effects: normalizeTitleEffects(row.effects),
      isEquipped,
      obtainedAt: row.obtained_at ? new Date(String(row.obtained_at)).toISOString() : new Date(0).toISOString(),
    });
  }

  return { titles, equipped };
};

export const equipTitle = async (characterId: number, titleId: string): Promise<ServiceResult> => {
  const cid = asFiniteNonNegativeInt(characterId, 0);
  const tid = asNonEmptyString(titleId);
  if (!cid) return { success: false, message: '角色不存在' };
  if (!tid) return { success: false, message: '称号ID不能为空' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const targetRes = await client.query(
      `
        SELECT ct.title_id, td.name, td.effects
        FROM character_title ct
        JOIN title_def td ON td.id = ct.title_id
        WHERE ct.character_id = $1
          AND ct.title_id = $2
          AND td.enabled = true
        LIMIT 1
        FOR UPDATE
      `,
      [cid, tid],
    );

    if ((targetRes.rows ?? []).length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '未拥有该称号' };
    }

    const targetRow = targetRes.rows[0] as Record<string, unknown>;
    const targetName = asNonEmptyString(targetRow.name) ?? tid;
    const nextEffects = normalizeTitleEffects(targetRow.effects);

    const currentRes = await client.query(
      `
        SELECT ct.title_id, td.effects
        FROM character_title ct
        JOIN title_def td ON td.id = ct.title_id
        WHERE ct.character_id = $1
          AND ct.is_equipped = true
        LIMIT 1
        FOR UPDATE
      `,
      [cid],
    );

    const currentRow = (currentRes.rows?.[0] ?? null) as Record<string, unknown> | null;
    const currentTitleId = currentRow ? asNonEmptyString(currentRow.title_id) : null;
    const currentEffects = currentRow ? normalizeTitleEffects(currentRow.effects) : {};

    if (currentTitleId === tid) {
      await client.query('COMMIT');
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

    await client.query('COMMIT');
    return { success: true, message: 'ok' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('装备称号失败:', error);
    return { success: false, message: '装备称号失败' };
  } finally {
    client.release();
  }
};
