import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { assertMember, toNumber } from './db.js';
import type { ClaimSectQuestResult, Result, SectQuest, SubmitSectQuestResult } from './types.js';
import { getItemDefinitions } from '../staticConfigLoader.js';
import { hashTextU32 } from '../shared/deterministicHash.js';

type QuestProgressEvent = 'donate_spirit_stones' | 'shop_buy_count';
type SubmitQuestPool = 'item' | 'material' | 'consumable';

type QuestTemplateBase = Pick<SectQuest, 'id' | 'name' | 'type' | 'required' | 'reward'>;

type EventQuestTemplate = QuestTemplateBase & {
  objectiveType: 'event';
  progressEvent: QuestProgressEvent;
  target: string;
};

type SubmitQuestTemplate = QuestTemplateBase & {
  objectiveType: 'submit_item';
  submitPool: SubmitQuestPool;
};

type SectQuestTemplate = EventQuestTemplate | SubmitQuestTemplate;

type SubmitItemCandidate = {
  id: string;
  name: string;
  category: 'material' | 'consumable';
  subCategory: string | null;
};

type QuestPeriodKeys = {
  dailyKey: string;
  weeklyKey: string;
};

type ResolvedQuestDef = Omit<SectQuest, 'status' | 'progress'> & {
  objectiveType: 'event' | 'submit_item';
  progressEvent?: QuestProgressEvent;
};

const isEventQuestTemplate = (quest: SectQuestTemplate): quest is EventQuestTemplate => quest.objectiveType === 'event';
const isSubmitQuestTemplate = (quest: SectQuestTemplate): quest is SubmitQuestTemplate => quest.objectiveType === 'submit_item';

const QUESTS: SectQuestTemplate[] = [
  {
    id: 'sect-quest-daily-001',
    name: '宗门日常：灵石捐献',
    type: 'daily',
    required: 100,
    reward: { contribution: 25, buildPoints: 1, funds: 10 },
    objectiveType: 'event',
    progressEvent: 'donate_spirit_stones',
    target: '累计捐献灵石 100',
  },
  {
    id: 'sect-quest-daily-submit-item',
    name: '宗门日常：随机物资上缴',
    type: 'daily',
    required: 2,
    reward: { contribution: 35, buildPoints: 1, funds: 12 },
    objectiveType: 'submit_item',
    submitPool: 'item',
  },
  {
    id: 'sect-quest-daily-submit-material',
    name: '宗门日常：材料上缴',
    type: 'daily',
    required: 8,
    reward: { contribution: 45, buildPoints: 2, funds: 16 },
    objectiveType: 'submit_item',
    submitPool: 'material',
  },
  {
    id: 'sect-quest-daily-submit-consumable',
    name: '宗门日常：消耗品上缴',
    type: 'daily',
    required: 3,
    reward: { contribution: 40, buildPoints: 1, funds: 14 },
    objectiveType: 'submit_item',
    submitPool: 'consumable',
  },
  {
    id: 'sect-quest-weekly-001',
    name: '宗门周常：大额捐献',
    type: 'weekly',
    required: 1000,
    reward: { contribution: 150, buildPoints: 2, funds: 19 },
    objectiveType: 'event',
    progressEvent: 'donate_spirit_stones',
    target: '累计捐献灵石 1000',
  },
];

const DAILY_QUEST_IDS = QUESTS.filter((quest) => quest.type === 'daily').map((quest) => quest.id);
const WEEKLY_QUEST_IDS = QUESTS.filter((quest) => quest.type === 'weekly').map((quest) => quest.id);
const QUEST_TEMPLATE_BY_ID = new Map<string, SectQuestTemplate>(QUESTS.map((quest) => [quest.id, quest]));
const QUEST_IDS_BY_EVENT: Record<QuestProgressEvent, string[]> = {
  donate_spirit_stones: QUESTS.filter(
    (quest): quest is EventQuestTemplate => isEventQuestTemplate(quest) && quest.progressEvent === 'donate_spirit_stones'
  ).map((quest) => quest.id),
  shop_buy_count: QUESTS.filter(
    (quest): quest is EventQuestTemplate => isEventQuestTemplate(quest) && quest.progressEvent === 'shop_buy_count'
  ).map((quest) => quest.id),
};
const EMPTY_SUBMIT_POOLS: Record<SubmitQuestPool, SubmitItemCandidate[]> = {
  item: [],
  material: [],
  consumable: [],
};
const EXCLUDED_CONSUMABLE_SUB_CATEGORIES = new Set<string>(['month_card', 'battle_pass', 'token', 'function']);

const normalizeQuestStatus = (raw: unknown): SectQuest['status'] => {
  if (raw === 'completed') return 'completed';
  if (raw === 'claimed') return 'claimed';
  if (raw === 'in_progress') return 'in_progress';
  return 'in_progress';
};

const getQuestPeriodKeysTx = async (): Promise<QuestPeriodKeys> => {
  const periodRes = await query<{ daily_key: string; weekly_key: string }>(
    `
      SELECT
        to_char(date_trunc('day', NOW()), 'YYYY-MM-DD') AS daily_key,
        to_char(date_trunc('week', NOW()), 'IYYY-IW') AS weekly_key
    `
  );
  const row = periodRes.rows[0];
  return {
    dailyKey: row?.daily_key ?? '',
    weeklyKey: row?.weekly_key ?? '',
  };
};

const loadSubmitItemCandidatesTx = async (): Promise<Record<SubmitQuestPool, SubmitItemCandidate[]>> => {
  const rows = getItemDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => entry.quest_only !== true)
    .filter((entry) => entry.category === 'material' || entry.category === 'consumable')
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')))
    .map((entry) => ({
      id: String(entry.id || ''),
      name: String(entry.name || entry.id || ''),
      category: String(entry.category || ''),
      sub_category: typeof entry.sub_category === 'string' ? entry.sub_category : null,
    }));

  const pools: Record<SubmitQuestPool, SubmitItemCandidate[]> = {
    item: [],
    material: [],
    consumable: [],
  };

  for (const row of rows) {
    const categoryRaw = String(row.category);
    const subCategory = typeof row.sub_category === 'string' && row.sub_category.trim() ? row.sub_category.trim() : null;
    const candidate: SubmitItemCandidate = {
      id: String(row.id),
      name: String(row.name),
      category: categoryRaw === 'material' ? 'material' : 'consumable',
      subCategory,
    };

    if (candidate.category === 'material') {
      pools.material.push(candidate);
      pools.item.push(candidate);
      continue;
    }

    if (!EXCLUDED_CONSUMABLE_SUB_CATEGORIES.has(subCategory ?? '')) {
      pools.consumable.push(candidate);
      pools.item.push(candidate);
    }
  }

  return pools;
};

const pickDeterministicCandidate = (candidates: SubmitItemCandidate[], seed: string): SubmitItemCandidate => {
  const index = hashTextU32(seed) % candidates.length;
  return candidates[index];
};

const resolveSubmitRequirement = (
  template: SubmitQuestTemplate,
  characterId: number,
  periodKeys: QuestPeriodKeys,
  pools: Record<SubmitQuestPool, SubmitItemCandidate[]>
): NonNullable<SectQuest['submitRequirement']> => {
  const pool = pools[template.submitPool];
  if (!pool || pool.length === 0) {
    throw new Error(`宗门任务缺少可用提交物品池: ${template.submitPool}`);
  }

  const periodKey = template.type === 'weekly' ? periodKeys.weeklyKey : periodKeys.dailyKey;
  const seed = `${characterId}:${template.id}:${periodKey}`;
  const picked = pickDeterministicCandidate(pool, seed);
  return {
    itemDefId: picked.id,
    itemName: picked.name,
    itemCategory: template.submitPool,
  };
};

const buildQuestNamePrefix = (questType: SectQuest['type']): string => {
  if (questType === 'daily') return '宗门日常';
  if (questType === 'weekly') return '宗门周常';
  return '宗门任务';
};

const resolveQuestTemplate = (
  template: SectQuestTemplate,
  characterId: number,
  periodKeys: QuestPeriodKeys,
  submitPools: Record<SubmitQuestPool, SubmitItemCandidate[]>
): ResolvedQuestDef => {
  if (isEventQuestTemplate(template)) {
    return {
      id: template.id,
      name: template.name,
      type: template.type,
      target: template.target,
      required: template.required,
      reward: template.reward,
      actionType: 'event',
      objectiveType: 'event',
      progressEvent: template.progressEvent,
    };
  }

  const submitRequirement = resolveSubmitRequirement(template, characterId, periodKeys, submitPools);
  const questName = `${buildQuestNamePrefix(template.type)}：上缴${submitRequirement.itemName}`;
  return {
    id: template.id,
    name: questName,
    type: template.type,
    target: `提交${submitRequirement.itemName} ${template.required}个`,
    required: template.required,
    reward: template.reward,
    actionType: 'submit_item',
    submitRequirement,
    objectiveType: 'submit_item',
  };
};

const resolveQuestDefsTx = async (characterId: number): Promise<ResolvedQuestDef[]> => {
  const periodKeys = await getQuestPeriodKeysTx();
  const hasSubmitQuest = QUESTS.some((quest) => quest.objectiveType === 'submit_item');
  const submitPools = hasSubmitQuest ? await loadSubmitItemCandidatesTx() : EMPTY_SUBMIT_POOLS;
  return QUESTS.map((template) => resolveQuestTemplate(template, characterId, periodKeys, submitPools));
};

const resolveQuestDefByIdTx = async (
  characterId: number,
  questId: string
): Promise<ResolvedQuestDef | null> => {
  const template = QUEST_TEMPLATE_BY_ID.get(questId);
  if (!template) return null;
  const periodKeys = await getQuestPeriodKeysTx();
  const submitPools = isSubmitQuestTemplate(template) ? await loadSubmitItemCandidatesTx() : EMPTY_SUBMIT_POOLS;
  return resolveQuestTemplate(template, characterId, periodKeys, submitPools);
};

const resetSectQuestProgressIfNeededTx = async (characterId: number): Promise<void> => {
  await query(
    `
      DELETE FROM sect_quest_progress
      WHERE character_id = $1
        AND (
          (quest_id = ANY($2::varchar[]) AND accepted_at < date_trunc('day', NOW()))
          OR
          (quest_id = ANY($3::varchar[]) AND accepted_at < date_trunc('week', NOW()))
        )
    `,
    [characterId, DAILY_QUEST_IDS, WEEKLY_QUEST_IDS]
  );
};

const applyQuestProgressDeltaTx = async (
  characterId: number,
  questId: string,
  delta: number
): Promise<void> => {
  const questTemplate = QUEST_TEMPLATE_BY_ID.get(questId);
  if (!questTemplate) return;
  if (!Number.isFinite(delta) || delta <= 0) return;

  const safeDelta = Math.max(1, Math.floor(delta));
  await query(
    `
      UPDATE sect_quest_progress
      SET progress = LEAST($3, progress + $4),
          status = CASE
                     WHEN progress + $4 >= $3 THEN 'completed'
                     ELSE status
                   END,
          completed_at = CASE
                           WHEN progress + $4 >= $3 THEN COALESCE(completed_at, NOW())
                           ELSE completed_at
                         END
      WHERE character_id = $1
        AND quest_id = $2
        AND status = 'in_progress'
    `,
    [characterId, questId, questTemplate.required, safeDelta]
  );
};

const recordSectQuestEventTx = async (
  characterId: number,
  event: QuestProgressEvent,
  delta: number
): Promise<void> => {
  if (!Number.isFinite(delta) || delta <= 0) return;
  await resetSectQuestProgressIfNeededTx(characterId);
  const questIds = QUEST_IDS_BY_EVENT[event] ?? [];
  if (questIds.length === 0) return;
  for (const questId of questIds) {
    await applyQuestProgressDeltaTx(characterId, questId, delta);
  }
};

const consumeItemDefQtyTx = async (
  characterId: number,
  itemDefId: string,
  qty: number
): Promise<{ success: boolean; message: string; consumed: number }> => {
  const requested = Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;
  const rowsRes = await query<{ id: number; qty: number }>(
    `
      SELECT id, qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND locked = false
        AND location IN ('bag', 'warehouse')
      ORDER BY CASE WHEN location = 'bag' THEN 0 ELSE 1 END ASC, qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, itemDefId]
  );

  const rows = rowsRes.rows;
  const available = rows.reduce((sum, row) => sum + Math.max(0, toNumber(row.qty)), 0);
  if (available <= 0) {
    return { success: false, message: '可提交物品不足', consumed: 0 };
  }

  const consumeTarget = Math.min(requested, available);
  let remaining = consumeTarget;
  for (const row of rows) {
    if (remaining <= 0) break;
    const rowQty = Math.max(0, toNumber(row.qty));
    if (rowQty <= 0) continue;

    if (rowQty <= remaining) {
      await query(`DELETE FROM item_instance WHERE id = $1`, [row.id]);
      remaining -= rowQty;
      continue;
    }

    await query(`UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2`, [remaining, row.id]);
    remaining = 0;
  }

  return { success: true, message: '提交成功', consumed: consumeTarget };
};

export const recordSectDonateEventTx = async (
  characterId: number,
  donatedSpiritStones: number
): Promise<void> => {
  const delta = Number.isFinite(donatedSpiritStones) ? Math.max(0, Math.floor(donatedSpiritStones)) : 0;
  if (delta <= 0) return;
  await recordSectQuestEventTx(characterId, 'donate_spirit_stones', delta);
};

export const recordSectShopBuyEventTx = async (characterId: number, quantity: number): Promise<void> => {
  const delta = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  if (delta <= 0) return;
  await recordSectQuestEventTx(characterId, 'shop_buy_count', delta);
};

/**
 * 宗门任务服务
 *
 * 作用：处理宗门任务查询、接取、提交、领取逻辑
 * 不做：不处理路由层参数校验、不做权限判断
 *
 * 数据流：
 * - getSectQuests：读取任务进度，计算任务状态
 * - acceptSectQuest：接取任务，插入进度记录
 * - submitSectQuest：提交物品，更新任务进度
 * - claimSectQuest：领取奖励，更新宗门资金、建设点、个人贡献
 *
 * 边界条件：
 * 1) 所有写操作使用 @Transactional 保证原子性
 * 2) getSectQuests 使用事务保证读一致性（需要重置过期任务）
 * 3) recordSectDonateEventTx 和 recordSectShopBuyEventTx 被外部事务调用，不加装饰器
 */
class SectQuestService {
  private async addLog(
    sectId: string,
    logType: string,
    operatorId: number | null,
    targetId: number | null,
    content: string
  ): Promise<void> {
    await query(
      `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
      [sectId, logType, operatorId, targetId, content]
    );
  }

  @Transactional
  async getSectQuests(
    characterId: number
  ): Promise<{ success: boolean; message: string; data?: SectQuest[] }> {
    try {
      await assertMember(characterId);
      await resetSectQuestProgressIfNeededTx(characterId);

      const resolvedQuestDefs = await resolveQuestDefsTx(characterId);
      const progressRes = await query(`SELECT quest_id, progress, status FROM sect_quest_progress WHERE character_id = $1`, [
        characterId,
      ]);
      const progressMap = new Map<string, { progress: number; status: SectQuest['status'] }>();
      for (const row of progressRes.rows) {
        progressMap.set(String(row.quest_id), {
          progress: toNumber(row.progress),
          status: normalizeQuestStatus(row.status),
        });
      }

      const quests: SectQuest[] = resolvedQuestDefs.map((quest) => {
        const progress = progressMap.get(quest.id);
        if (!progress) {
          return {
            ...quest,
            status: 'not_accepted',
            progress: 0,
          };
        }
        return {
          ...quest,
          status: progress.status,
          progress: Math.max(0, Math.min(quest.required, progress.progress)),
        };
      });
      return { success: true, message: 'ok', data: quests };
    } catch (error) {
      console.error('获取宗门任务失败:', error);
      return { success: false, message: '获取宗门任务失败' };
    }
  }

  @Transactional
  async acceptSectQuest(characterId: number, questIdRaw: string): Promise<Result> {
    const questId = questIdRaw.trim();
    if (!questId) return { success: false, message: '任务不存在' };

    await assertMember(characterId);
    await resetSectQuestProgressIfNeededTx(characterId);

    const quest = await resolveQuestDefByIdTx(characterId, questId);
    if (!quest) {
      return { success: false, message: '任务不存在' };
    }

    const existing = await query(
      `SELECT status FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2 FOR UPDATE`,
      [characterId, questId]
    );
    if (existing.rows.length > 0) {
      return { success: false, message: '任务已接取' };
    }

    await query(
      `INSERT INTO sect_quest_progress (character_id, quest_id, progress, status) VALUES ($1, $2, 0, 'in_progress')`,
      [characterId, questId]
    );
    return { success: true, message: `接取成功：${quest.name}` };
  }

  @Transactional
  async submitSectQuest(
    characterId: number,
    questIdRaw: string,
    quantity?: number
  ): Promise<SubmitSectQuestResult> {
    const questId = questIdRaw.trim();
    if (!questId) return { success: false, message: '任务不存在' };

    const member = await assertMember(characterId);
    await resetSectQuestProgressIfNeededTx(characterId);

    const quest = await resolveQuestDefByIdTx(characterId, questId);
    if (!quest) {
      return { success: false, message: '任务不存在' };
    }
    if (quest.actionType !== 'submit_item' || !quest.submitRequirement) {
      return { success: false, message: '该任务无需提交物品' };
    }

    const progressRes = await query(
      `SELECT progress, status FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2 FOR UPDATE`,
      [characterId, questId]
    );
    if (progressRes.rows.length === 0) {
      return { success: false, message: '任务未接取' };
    }

    const status = normalizeQuestStatus(progressRes.rows[0].status);
    if (status === 'claimed') {
      return { success: false, message: '奖励已领取' };
    }
    if (status === 'completed') {
      return { success: false, message: '任务已完成，请先领取奖励' };
    }
    if (status !== 'in_progress') {
      return { success: false, message: '任务状态异常' };
    }

    const currentProgress = Math.max(0, Math.min(quest.required, toNumber(progressRes.rows[0].progress)));
    const remaining = Math.max(0, quest.required - currentProgress);
    if (remaining <= 0) {
      return { success: false, message: '任务已达成，请先领取奖励' };
    }

    const requested = typeof quantity === 'number' && Number.isFinite(quantity) ? Math.max(1, Math.floor(quantity)) : remaining;
    const submitQty = Math.min(remaining, requested);
    const consumeRes = await consumeItemDefQtyTx(characterId, quest.submitRequirement.itemDefId, submitQty);
    if (!consumeRes.success || consumeRes.consumed <= 0) {
      return { success: false, message: `${quest.submitRequirement.itemName}数量不足` };
    }

    await applyQuestProgressDeltaTx(characterId, questId, consumeRes.consumed);
    const updatedRes = await query<{ progress: number; status: string }>(
      `SELECT progress, status FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2`,
      [characterId, questId]
    );
    const updatedProgress = Math.max(0, Math.min(quest.required, toNumber(updatedRes.rows[0]?.progress)));
    const updatedStatus = normalizeQuestStatus(updatedRes.rows[0]?.status);

    // 任务在本次提交后已完成时，只保留"领取奖励"日志，避免同一完成动作出现提交+领奖双记录。
    if (updatedStatus !== 'completed') {
      await this.addLog(
        member.sectId,
        'quest_submit',
        characterId,
        null,
        `提交宗门任务物资：${quest.submitRequirement.itemName}×${consumeRes.consumed}（${updatedProgress}/${quest.required}）`
      );
    }
    return {
      success: true,
      message: updatedStatus === 'completed' ? '提交成功，任务已完成' : '提交成功',
      consumed: consumeRes.consumed,
      progress: updatedProgress,
      status: updatedStatus,
    };
  }

  @Transactional
  async claimSectQuest(characterId: number, questIdRaw: string): Promise<ClaimSectQuestResult> {
    const questId = questIdRaw.trim();
    if (!questId) return { success: false, message: '任务不存在' };

    const member = await assertMember(characterId);
    await resetSectQuestProgressIfNeededTx(characterId);

    const quest = await resolveQuestDefByIdTx(characterId, questId);
    if (!quest) {
      return { success: false, message: '任务不存在' };
    }

    const progressRes = await query(
      `SELECT status FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2 FOR UPDATE`,
      [characterId, questId]
    );
    if (progressRes.rows.length === 0) {
      return { success: false, message: '任务未接取' };
    }

    const status = normalizeQuestStatus(progressRes.rows[0].status);
    if (status === 'claimed') {
      return { success: false, message: '奖励已领取' };
    }
    if (status !== 'completed') {
      return { success: false, message: '任务未完成' };
    }

    await query(
      `UPDATE sect_def SET funds = funds + $2, build_points = build_points + $3, updated_at = NOW() WHERE id = $1`,
      [member.sectId, quest.reward.funds, quest.reward.buildPoints]
    );
    await query(
      `
        UPDATE sect_member
        SET contribution = contribution + $2,
            weekly_contribution = weekly_contribution + $2
        WHERE character_id = $1
      `,
      [characterId, quest.reward.contribution]
    );
    await query(
      `
        UPDATE sect_quest_progress
        SET status = 'claimed',
            progress = $3,
            completed_at = COALESCE(completed_at, NOW())
        WHERE character_id = $1
          AND quest_id = $2
      `,
      [characterId, questId, quest.required]
    );
    await this.addLog(
      member.sectId,
      'quest_claim',
      characterId,
      null,
      `领取宗门任务：${quest.name}（贡献+${quest.reward.contribution}，建设点+${quest.reward.buildPoints}，资金+${quest.reward.funds}）`
    );
    return { success: true, message: '领取成功', reward: quest.reward };
  }
}

export const sectQuestService = new SectQuestService();

// 向后兼容的命名导出
export const getSectQuests = (characterId: number) => sectQuestService.getSectQuests(characterId);
export const acceptSectQuest = (characterId: number, questIdRaw: string) =>
  sectQuestService.acceptSectQuest(characterId, questIdRaw);
export const submitSectQuest = (characterId: number, questIdRaw: string, quantity?: number) =>
  sectQuestService.submitSectQuest(characterId, questIdRaw, quantity);
export const claimSectQuest = (characterId: number, questIdRaw: string) =>
  sectQuestService.claimSectQuest(characterId, questIdRaw);
