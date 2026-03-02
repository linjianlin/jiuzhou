/**
 * 任务节奖励发放
 *
 * 作用：根据奖励配置发放经验、银两、灵石、物品、功法、称号等。
 * 输入：userId、characterId、rewards 配置对象。
 * 输出：RewardResult[] 发放结果列表。
 *
 * 数据流：遍历 rewards 各字段 → 执行对应 DB 更新/物品创建 → 收集结果。
 *
 * 边界条件：
 * 1) 调用方需保证事务上下文（getTransactionClient），物品创建需要传 dbClient。
 * 2) 任一物品创建失败会抛异常，由事务回滚保证一致性。
 */
import { query, getTransactionClient } from '../../config/database.js';
import { itemService } from '../itemService.js';
import {
  getItemDefinitionById,
  getTechniqueDefinitions,
} from '../staticConfigLoader.js';
import { asString, asNumber, asArray } from '../shared/typeCoercion.js';
import type { RewardResult } from './types.js';

/** 发放任务节奖励（需事务上下文） */
export const grantSectionRewards = async (
  userId: number,
  characterId: number,
  rewards: Record<string, unknown>,
): Promise<RewardResult[]> => {
  const results: RewardResult[] = [];
  const client = getTransactionClient();
  if (!client) throw new Error('事务上下文不存在');

  const exp = asNumber((rewards as { exp?: unknown }).exp, 0);
  if (exp > 0) {
    await query(`UPDATE characters SET exp = exp + $1, updated_at = NOW() WHERE id = $2`, [exp, characterId]);
    results.push({ type: 'exp', amount: exp });
  }

  const silver = asNumber((rewards as { silver?: unknown }).silver, 0);
  if (silver > 0) {
    await query(`UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`, [silver, characterId]);
    results.push({ type: 'silver', amount: silver });
  }

  const spiritStones = asNumber((rewards as { spirit_stones?: unknown }).spirit_stones, 0);
  if (spiritStones > 0) {
    await query(`UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`, [
      spiritStones,
      characterId,
    ]);
    results.push({ type: 'spirit_stones', amount: spiritStones });
  }

  const items = asArray<{ item_def_id?: unknown; quantity?: unknown }>((rewards as { items?: unknown }).items);
  for (const item of items) {
    const itemDefId = asString(item.item_def_id);
    const quantity = Math.max(1, Math.floor(asNumber(item.quantity, 1)));
    if (!itemDefId || quantity <= 0) continue;
    const itemDef = getItemDefinitionById(itemDefId);
    const itemName = asString(itemDef?.name);
    const itemIcon = asString(itemDef?.icon);
    const result = await itemService.createItem(userId, characterId, itemDefId, quantity, {
      dbClient: client,
      location: 'bag',
      obtainedFrom: 'main_quest',
    });
    if (!result.success) throw new Error(result.message);
    results.push({ type: 'item', itemDefId, quantity, itemName: itemName || undefined, itemIcon: itemIcon || undefined });
  }

  const techniques = asArray<string>((rewards as { techniques?: unknown }).techniques);
  for (const techId of techniques) {
    const t = asString(techId);
    if (!t) continue;
    const techniqueDef = getTechniqueDefinitions().find((entry) => entry.id === t && entry.enabled !== false) ?? null;
    const techniqueName = asString(techniqueDef?.name);
    const techniqueIcon = asString(techniqueDef?.icon);
    const existsRes = await query(
      `SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1`,
      [characterId, t],
    );
    if (existsRes.rows.length === 0) {
      await query(
        `INSERT INTO character_technique (character_id, technique_id, current_layer, acquired_at)
         VALUES ($1, $2, 1, NOW())`,
        [characterId, t],
      );
      results.push({
        type: 'technique',
        techniqueId: t,
        techniqueName: techniqueName || undefined,
        techniqueIcon: techniqueIcon || undefined,
      });
    }
  }

  const titles = asArray<string>((rewards as { titles?: unknown }).titles);
  const title = asString((rewards as { title?: unknown }).title).trim();
  const normalizedTitles = [...titles, title].map((x) => asString(x)).map((x) => x.trim()).filter(Boolean);
  if (normalizedTitles.length > 0) {
    const finalTitle = normalizedTitles[normalizedTitles.length - 1];
    await query(`UPDATE characters SET title = $1, updated_at = NOW() WHERE id = $2`, [finalTitle, characterId]);
    for (const t of normalizedTitles) {
      results.push({ type: 'title', title: t });
    }
  }

  return results;
};
