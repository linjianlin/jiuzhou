import { query, getTransactionClient } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  normalizeTitleEffects,
} from './shared.js';
import type { ServiceResult, TitleInfo, TitleListResult } from './types.js';
import { invalidateCharacterComputedCache } from '../characterComputedService.js';
import { getTitleDefinitions } from '../staticConfigLoader.js';

/**
 * 称号管理服务
 *
 * 作用：处理称号列表查询与称号装备切换
 * 不做：不处理称号发放（由 titleOwnership.ts 负责）
 *
 * 数据流：
 * - getTitleList：查询角色拥有的称号列表（包含装备状态）
 * - equipTitle：锁定称号记录 → 卸下当前装备 → 装备新称号 → 更新角色属性 → 失效缓存
 *
 * 边界条件：
 * 1) getTitleList 为纯读方法，不需要事务
 * 2) equipTitle 使用 @Transactional 保证装备状态与角色属性更新的原子性
 */
class TitleService {
  private computeEffectDelta(
    current: Record<string, number>,
    next: Record<string, number>,
  ): Record<string, number> {
    const keys = new Set<string>([...Object.keys(current), ...Object.keys(next)]);
    const out: Record<string, number> = {};
    for (const key of keys) {
      const diff = (next[key] ?? 0) - (current[key] ?? 0);
      if (diff !== 0) out[key] = diff;
    }
    return out;
  }

  private async updateCharacterAttrsWithDeltaTx(
    characterId: number,
    titleName: string,
    _delta: Record<string, number>,
  ): Promise<void> {
    const params: unknown[] = [characterId, titleName];
    await query(`UPDATE characters SET title = $2, updated_at = NOW() WHERE id = $1`, params);
  }

  async getTitleList(characterId: number): Promise<TitleListResult> {
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
  }

  @Transactional
  async equipTitle(characterId: number, titleId: string): Promise<ServiceResult> {
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const tid = asNonEmptyString(titleId);
    if (!cid) return { success: false, message: '角色不存在' };
    if (!tid) return { success: false, message: '称号ID不能为空' };

    const targetDef = getTitleDefinitions().find((row) => row.id === tid && row.enabled !== false);
    if (!targetDef) {
      return { success: false, message: '未拥有该称号' };
    }

    const targetRes = await query(
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
      return { success: false, message: '未拥有该称号' };
    }

    const targetName = asNonEmptyString(targetDef.name) ?? tid;
    const nextEffects = normalizeTitleEffects(targetDef.effects);

    const currentRes = await query(
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

    const delta = this.computeEffectDelta(currentEffects, nextEffects);

    await query(
      `
        UPDATE character_title
        SET is_equipped = false,
            updated_at = NOW()
        WHERE character_id = $1
          AND is_equipped = true
      `,
      [cid],
    );

    await query(
      `
        UPDATE character_title
        SET is_equipped = true,
            updated_at = NOW()
        WHERE character_id = $1
          AND title_id = $2
      `,
      [cid, tid],
    );

    await this.updateCharacterAttrsWithDeltaTx(cid, targetName, delta);
    await invalidateCharacterComputedCache(cid);
    return { success: true, message: 'ok' };
  }
}

export const titleService = new TitleService();

// 向后兼容的命名导出
export const getTitleList = titleService.getTitleList.bind(titleService);
export const equipTitle = titleService.equipTitle.bind(titleService);
