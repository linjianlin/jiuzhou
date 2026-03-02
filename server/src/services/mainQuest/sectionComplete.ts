/**
 * 任务节完成与追踪命令
 *
 * 作用：处理当前任务节完成流程——校验状态、发放奖励、推进到下一节/章。
 * 输入：userId + characterId。
 * 输出：奖励结果 + 下一任务节信息 + 是否章节完成。
 *
 * 数据流：
 * 1. 读进度（FOR UPDATE）→ 校验 turnin 状态
 * 2. 发放任务节奖励（grantSectionRewards）
 * 3. 若 is_chapter_final → 发放章节奖励 → 推进到下一章
 * 4. 否则推进到同章下一节
 *
 * 边界条件：
 * 1) 调用方需通过 @Transactional 保证事务上下文。
 * 2) 所有章节都完成后标记 section_status = 'completed'，不再推进。
 */
import { query } from '../../config/database.js';
import { asString, asNumber, asArray, asObject } from '../shared/typeCoercion.js';
import {
  getEnabledMainQuestSectionById,
  getEnabledMainQuestSectionsSorted,
} from './shared/questConfig.js';
import { decorateSectionRewards } from './shared/rewardDecorator.js';
import { grantSectionRewards } from './grantRewards.js';
import { getMainQuestChapterById } from '../staticConfigLoader.js';
import type { SectionDto, RewardResult } from './types.js';

/** 完成当前任务节（需 @Transactional） */
export const completeCurrentSectionLegacy = async (
  userId: number,
  characterId: number,
): Promise<{ success: boolean; message: string; data?: { rewards: RewardResult[]; nextSection?: SectionDto; chapterCompleted?: boolean } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const progressRes = await query(
    `SELECT current_chapter_id, current_section_id, section_status, completed_chapters, completed_sections
     FROM character_main_quest_progress
     WHERE character_id = $1 FOR UPDATE`,
    [cid],
  );
  if (!progressRes.rows?.[0]) {
    return { success: false, message: '主线进度不存在' };
  }

  const progress = progressRes.rows[0] as {
    current_chapter_id?: unknown;
    current_section_id?: unknown;
    section_status?: unknown;
    completed_chapters?: unknown;
    completed_sections?: unknown;
  };

  if (asString(progress.section_status) !== 'turnin') {
    return { success: false, message: '任务未完成，无法领取奖励' };
  }

  const currentSectionId = asString(progress.current_section_id);
  if (!currentSectionId) {
    return { success: false, message: '任务节不存在' };
  }

  const section = getEnabledMainQuestSectionById(currentSectionId);
  if (!section) {
    return { success: false, message: '任务节不存在' };
  }

  const sectionId = asString(section.id);
  const chapterId = asString(section.chapter_id);
  if (!sectionId || !chapterId) {
    return { success: false, message: '任务节不存在' };
  }

  const rewardResults = await grantSectionRewards(uid, cid, asObject(section.rewards));

  const completedSections = asArray<string>(progress.completed_sections);
  if (!completedSections.includes(sectionId)) completedSections.push(sectionId);

  const completedChapters = asArray<string>(progress.completed_chapters);
  let chapterCompleted = false;
  let nextSectionDto: SectionDto | undefined;

  if (section.is_chapter_final === true) {
    chapterCompleted = true;
    if (!completedChapters.includes(chapterId)) completedChapters.push(chapterId);

    const chapterRewards = asObject(getMainQuestChapterById(chapterId)?.chapter_rewards);
    const chapterRewardResults = await grantSectionRewards(uid, cid, chapterRewards);
    rewardResults.push(
      ...chapterRewardResults.map((r) => {
        if (r.type === 'exp') return { type: 'chapter_exp', amount: r.amount } as RewardResult;
        if (r.type === 'silver') return { type: 'chapter_silver', amount: r.amount } as RewardResult;
        if (r.type === 'spirit_stones') return { type: 'chapter_spirit_stones', amount: r.amount } as RewardResult;
        return r;
      }),
    );

    const currentChapterNum = asNumber(getMainQuestChapterById(chapterId)?.chapter_num, 0);
    const nextSection = getEnabledMainQuestSectionsSorted().find(
      (entry) => asNumber(getMainQuestChapterById(entry.chapter_id)?.chapter_num, 0) > currentChapterNum,
    );

    if (nextSection) {
      const nextId = asString(nextSection.id);
      const nextChapterId = asString(nextSection.chapter_id);
      if (nextId && nextChapterId) {
        await query(
          `UPDATE character_main_quest_progress
           SET current_chapter_id = $2,
               current_section_id = $3,
               section_status = 'not_started',
               objectives_progress = '{}'::jsonb,
               dialogue_state = '{}'::jsonb,
               completed_chapters = $4::jsonb,
               completed_sections = $5::jsonb,
               updated_at = NOW()
           WHERE character_id = $1`,
          [cid, nextChapterId, nextId, JSON.stringify(completedChapters), JSON.stringify(completedSections)],
        );
      }
    } else {
      await query(
        `UPDATE character_main_quest_progress
         SET section_status = 'completed',
             completed_chapters = $2::jsonb,
             completed_sections = $3::jsonb,
             updated_at = NOW()
         WHERE character_id = $1`,
        [cid, JSON.stringify(completedChapters), JSON.stringify(completedSections)],
      );
    }

  } else {
    const currentSectionNum = asNumber(section.section_num, 0);
    const nextSection = getEnabledMainQuestSectionsSorted().find(
      (entry) => entry.chapter_id === chapterId && asNumber(entry.section_num, 0) > currentSectionNum,
    );

    if (nextSection) {
      const nextId = asString(nextSection.id);
      if (nextId) {
        await query(
          `UPDATE character_main_quest_progress
           SET current_section_id = $2,
               section_status = 'not_started',
               objectives_progress = '{}'::jsonb,
               dialogue_state = '{}'::jsonb,
               completed_sections = $3::jsonb,
               updated_at = NOW()
           WHERE character_id = $1`,
          [cid, nextId, JSON.stringify(completedSections)],
        );

        nextSectionDto = {
          id: nextId,
          chapterId: asString(nextSection.chapter_id),
          sectionNum: asNumber(nextSection.section_num, 0),
          name: asString(nextSection.name),
          description: asString(nextSection.description),
          brief: asString(nextSection.brief),
          npcId: asString(nextSection.npc_id) || null,
          mapId: asString(nextSection.map_id) || null,
          roomId: asString(nextSection.room_id) || null,
          status: 'not_started',
          objectives: [],
          rewards: await decorateSectionRewards(asObject(nextSection.rewards)),
          isChapterFinal: nextSection.is_chapter_final === true,
        };
      }
    }
  }

  return { success: true, message: 'ok', data: { rewards: rewardResults, nextSection: nextSectionDto, chapterCompleted } };
};
