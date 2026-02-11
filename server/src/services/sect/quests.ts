import { pool } from '../../config/database.js';
import { assertMember, toNumber } from './db.js';
import type { Result, SectQuest } from './types.js';

const QUESTS: Array<Omit<SectQuest, 'status' | 'progress'>> = [
  {
    id: 'sect-quest-daily-001',
    name: '宗门日常：打扫大殿',
    type: 'daily',
    target: '完成一次打扫',
    required: 1,
    reward: { contribution: 50, buildPoints: 5, funds: 100 },
  },
  {
    id: 'sect-quest-daily-002',
    name: '宗门日常：炼体修行',
    type: 'daily',
    target: '完成一次修行',
    required: 1,
    reward: { contribution: 80, buildPoints: 5, funds: 150 },
  },
  {
    id: 'sect-quest-weekly-001',
    name: '宗门周常：宗门委托',
    type: 'weekly',
    target: '完成一次委托',
    required: 1,
    reward: { contribution: 300, buildPoints: 30, funds: 800 },
  },
];

export const getSectQuests = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: SectQuest[] }> => {
  try {
    await assertMember(characterId);
    const progressRes = await pool.query(
      `SELECT quest_id, progress, status FROM sect_quest_progress WHERE character_id = $1`,
      [characterId]
    );
    const map = new Map<string, { progress: number; status: string }>();
    for (const row of progressRes.rows) {
      map.set(String(row.quest_id), { progress: toNumber(row.progress), status: String(row.status) });
    }

    const quests: SectQuest[] = QUESTS.map((q) => {
      const p = map.get(q.id);
      if (!p) return { ...q, status: 'not_accepted', progress: 0 };
      const status = p.status === 'completed' || p.status === 'claimed' || p.status === 'in_progress' ? p.status : 'in_progress';
      return { ...q, status: status as any, progress: p.progress };
    });

    return { success: true, message: 'ok', data: quests };
  } catch (error) {
    console.error('获取宗门任务失败:', error);
    return { success: false, message: '获取宗门任务失败' };
  }
};

export const acceptSectQuest = async (characterId: number, questId: string): Promise<Result> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertMember(characterId, client);

    const quest = QUESTS.find((q) => q.id === questId);
    if (!quest) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务不存在' };
    }

    const existing = await client.query(
      `SELECT id FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2`,
      [characterId, questId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务已接取' };
    }

    await client.query(
      `INSERT INTO sect_quest_progress (character_id, quest_id, progress, status) VALUES ($1, $2, 0, 'in_progress')`,
      [characterId, questId]
    );
    await client.query('COMMIT');
    return { success: true, message: '接取成功' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('接取宗门任务失败:', error);
    return { success: false, message: '接取宗门任务失败' };
  } finally {
    client.release();
  }
};
