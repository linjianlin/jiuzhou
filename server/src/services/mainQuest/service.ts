/**
 * MainQuestService - 主线任务服务
 *
 * 作用：主线任务模块的统一入口类，负责协调各子模块完成读写操作。
 * 写方法使用 @Transactional 保证事务，读方法直接委托对应查询函数。
 *
 * 数据流：
 * 1. 角色首次查询 → 初始化进度记录（第一章第一节）
 * 2. 任务节流程：not_started → dialogue → objectives → turnin → completed
 * 3. 完成任务节 → 发放奖励 → 检查是否推进下一节/章
 *
 * 边界条件：
 * 1) 使用 @Transactional 确保进度更新与奖励发放的原子性。
 * 2) getProgress 仅做读取，章节补推进仅在写路径触发，避免读写锁冲突。
 */
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { getRealmOrderIndex } from '../shared/realmRules.js';
import {
  getMainQuestChapterById,
  getMainQuestSectionById,
} from '../staticConfigLoader.js';
import { asString, asNumber, asArray, asObject, asStringArray } from '../shared/typeCoercion.js';
import {
  getEnabledMainQuestSectionsSorted,
} from './shared/questConfig.js';
import { getMainQuestProgressLegacy } from './progress.js';
import { getChapterListLegacy, getSectionListLegacy } from './chapterList.js';
import { startDialogueLegacy, advanceDialogueLegacy, selectDialogueChoiceLegacy } from './dialogue.js';
import { completeCurrentSectionLegacy } from './sectionComplete.js';
import type { DialogueState } from '../dialogueService.js';
import type {
  MainQuestProgressDto,
  MainQuestProgressEvent,
  SectionDto,
  SectionStatus,
  ChapterDto,
  RewardResult,
} from './types.js';

class MainQuestService {
  /**
   * 确保角色主线进度推进到新章节
   * 当角色完成当前章节后，自动推进到下一章第一节
   */
  @Transactional
  async ensureProgressForNewChapters(characterId: number): Promise<void> {
    const cid = Number(characterId);
    if (!Number.isFinite(cid) || cid <= 0) return;

    const progressRes = await query(
      `SELECT current_chapter_id, current_section_id, section_status, completed_chapters, completed_sections
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );

    if (!progressRes.rows?.[0]) {
      return;
    }

    const progress = progressRes.rows[0] as {
      current_chapter_id?: unknown;
      current_section_id?: unknown;
      section_status?: unknown;
      completed_chapters?: unknown;
      completed_sections?: unknown;
    };

    if (asString(progress.section_status) !== 'completed') {
      return;
    }

    const completedChapters = asStringArray(progress.completed_chapters);
    const completedSections = asStringArray(progress.completed_sections);

    const chapterIdSet = new Set<string>();
    for (const chapterId of completedChapters) {
      chapterIdSet.add(chapterId);
    }

    const currentChapterId = asString(progress.current_chapter_id).trim();
    if (currentChapterId) {
      chapterIdSet.add(currentChapterId);
    }

    const currentSectionId = asString(progress.current_section_id).trim();
    if (currentSectionId) {
      const currentSection = getMainQuestSectionById(currentSectionId);
      const chapterIdFromCurrentSection = asString(currentSection?.chapter_id).trim();
      if (chapterIdFromCurrentSection) {
        chapterIdSet.add(chapterIdFromCurrentSection);
      }
    }

    for (const sectionId of completedSections) {
      const section = getMainQuestSectionById(sectionId);
      const chapterIdFromSection = asString(section?.chapter_id).trim();
      if (!chapterIdFromSection) continue;
      chapterIdSet.add(chapterIdFromSection);
    }

    let latestCompletedChapterNum = 0;
    for (const chapterId of chapterIdSet) {
      const chapterNum = asNumber(getMainQuestChapterById(chapterId)?.chapter_num, 0);
      if (chapterNum > latestCompletedChapterNum) latestCompletedChapterNum = chapterNum;
    }

    if (latestCompletedChapterNum <= 0) {
      return;
    }

    const nextSection = getEnabledMainQuestSectionsSorted().find((entry) => {
      const chapterNum = asNumber(getMainQuestChapterById(entry.chapter_id)?.chapter_num, 0);
      return chapterNum > latestCompletedChapterNum;
    });

    if (!nextSection) {
      return;
    }

    const nextChapterId = asString(nextSection.chapter_id).trim();
    const nextSectionId = asString(nextSection.id).trim();
    if (!nextChapterId || !nextSectionId) {
      return;
    }

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
      [cid, nextChapterId, nextSectionId, JSON.stringify(completedChapters), JSON.stringify(completedSections)],
    );
  }

  async getProgress(characterId: number): Promise<MainQuestProgressDto> {
    return getMainQuestProgressLegacy(characterId);
  }

  async startDialogue(characterId: number, dialogueId?: string): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState } }> {
    return startDialogueLegacy(characterId, dialogueId);
  }

  @Transactional
  async advanceDialogue(userId: number, characterId: number): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState; effectResults?: unknown[] } }> {
    return advanceDialogueLegacy(userId, characterId);
  }

  @Transactional
  async selectDialogueChoice(userId: number, characterId: number, choiceId: string): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState; effectResults?: unknown[] } }> {
    return selectDialogueChoiceLegacy(userId, characterId, choiceId);
  }

  @Transactional
  async updateProgress(characterId: number, event: MainQuestProgressEvent): Promise<{ success: boolean; message: string; updated: boolean; completed: boolean }> {
    const cid = Number(characterId);
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在', updated: false, completed: false };

    const progressRes = await query(
      `SELECT current_section_id, section_status, objectives_progress
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      return { success: false, message: '主线进度不存在', updated: false, completed: false };
    }

    const progress = progressRes.rows[0] as {
      current_section_id?: unknown;
      section_status?: unknown;
      objectives_progress?: unknown;
    };
    if (asString(progress.section_status) !== 'objectives') {
      return { success: true, message: '当前不在目标阶段', updated: false, completed: false };
    }

    const sectionId = asString(progress.current_section_id).trim();
    if (!sectionId) {
      return { success: false, message: '当前任务节不存在', updated: false, completed: false };
    }

    const sectionDef = getMainQuestSectionById(sectionId);
    if (!sectionDef) {
      return { success: false, message: '任务节配置不存在', updated: false, completed: false };
    }

    const objectives = asArray<{ id?: unknown; type?: unknown; target?: unknown; params?: unknown }>(sectionDef.objectives);
    if (objectives.length === 0) {
      return { success: true, message: '无目标', updated: false, completed: false };
    }

    const currentProgress = asObject(progress.objectives_progress) as Record<string, number>;
    let updated = false;

    for (const obj of objectives) {
      const oid = asString(obj.id).trim();
      const otype = asString(obj.type).trim();
      const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
      if (!oid || !otype) continue;

      const current = asNumber(currentProgress[oid], 0);
      if (current >= target) continue;

      const params = asObject(obj.params);
      let matched = false;

      if (otype === 'talk_npc' && event.type === 'talk_npc') {
        const requiredNpcId = asString(params.npc_id).trim();
        matched = !requiredNpcId || requiredNpcId === event.npcId;
      } else if (otype === 'kill_monster' && event.type === 'kill_monster') {
        const requiredMonsterId = asString(params.monster_id).trim();
        matched = !requiredMonsterId || requiredMonsterId === event.monsterId;
      } else if (otype === 'gather_resource' && event.type === 'gather_resource') {
        const requiredResourceId = asString(params.resource_id).trim();
        matched = !requiredResourceId || requiredResourceId === event.resourceId;
      } else if (otype === 'collect' && event.type === 'collect') {
        const requiredItemId = asString(params.item_id).trim();
        matched = !requiredItemId || requiredItemId === event.itemId;
      } else if (otype === 'dungeon_clear' && event.type === 'dungeon_clear') {
        const requiredDungeonId = asString(params.dungeon_id).trim();
        const requiredDifficultyId = asString(params.difficulty_id).trim();
        const dungeonMatch = !requiredDungeonId || requiredDungeonId === event.dungeonId;
        const difficultyMatch = !requiredDifficultyId || requiredDifficultyId === (event.difficultyId ?? '');
        matched = dungeonMatch && difficultyMatch;
      } else if (otype === 'craft_item' && event.type === 'craft_item') {
        const requiredRecipeId = asString(params.recipe_id).trim();
        const requiredRecipeType = asString(params.recipe_type).trim();
        const requiredCraftKind = asString(params.craft_kind).trim();
        const requiredItemId = asString(params.item_id).trim();

        const recipeIdMatch = !requiredRecipeId || requiredRecipeId === (event.recipeId ?? '');
        const recipeTypeMatch = !requiredRecipeType || requiredRecipeType === (event.recipeType ?? '');
        const craftKindMatch = !requiredCraftKind || requiredCraftKind === (event.craftKind ?? '');
        const itemIdMatch = !requiredItemId || requiredItemId === (event.itemId ?? '');

        matched = recipeIdMatch && recipeTypeMatch && craftKindMatch && itemIdMatch;
      } else if (otype === 'reach' && event.type === 'reach') {
        const requiredRoomId = asString(params.room_id).trim();
        matched = !requiredRoomId || requiredRoomId === event.roomId;
      } else if (otype === 'upgrade_technique' && event.type === 'upgrade_technique') {
        const requiredTechniqueId = asString(params.technique_id).trim();
        const requiredLayer = asNumber(params.layer, 0);
        const techniqueMatch = !requiredTechniqueId || requiredTechniqueId === event.techniqueId;
        const layerMatch = requiredLayer <= 0 || event.layer >= requiredLayer;
        matched = techniqueMatch && layerMatch;
      } else if (otype === 'upgrade_realm' && event.type === 'upgrade_realm') {
        const requiredRealm = asString(params.realm).trim();
        if (!requiredRealm) {
          matched = true;
        } else {
          const requiredIndex = getRealmOrderIndex(requiredRealm);
          const eventIndex = getRealmOrderIndex(event.realm);
          matched = requiredIndex > 0 && eventIndex >= requiredIndex;
        }
      }

      if (matched) {
        const increment = event.type === 'talk_npc' || event.type === 'reach' || event.type === 'upgrade_technique' || event.type === 'upgrade_realm' ? 1 : ('count' in event ? event.count : 1);
        currentProgress[oid] = Math.min(target, current + increment);
        updated = true;
      }
    }

    if (!updated) {
      return { success: true, message: '无匹配目标', updated: false, completed: false };
    }

    const allCompleted = objectives.every((obj) => {
      const oid = asString(obj.id).trim();
      const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
      return currentProgress[oid] >= target;
    });

    if (allCompleted) {
      await query(
        `UPDATE character_main_quest_progress
         SET section_status = 'turnin',
             objectives_progress = $2::jsonb,
             updated_at = NOW()
         WHERE character_id = $1`,
        [cid, JSON.stringify(currentProgress)],
      );
      return { success: true, message: '目标已全部完成', updated: true, completed: true };
    }

    await query(
      `UPDATE character_main_quest_progress
       SET objectives_progress = $2::jsonb,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(currentProgress)],
    );
    return { success: true, message: '进度已更新', updated: true, completed: false };
  }

  @Transactional
  async completeCurrentSection(userId: number, characterId: number): Promise<{ success: boolean; message: string; data?: { rewards: RewardResult[]; nextSection?: SectionDto; chapterCompleted?: boolean } }> {
    return completeCurrentSectionLegacy(userId, characterId);
  }

  async getChapterList(characterId: number): Promise<{ chapters: ChapterDto[] }> {
    return getChapterListLegacy(characterId);
  }

  async getSectionList(characterId: number, chapterId: string): Promise<{ sections: SectionDto[] }> {
    return getSectionListLegacy(characterId, chapterId);
  }

  async setTracked(characterId: number, tracked: boolean): Promise<{ success: boolean; message: string; data?: { tracked: boolean } }> {
    return setMainQuestTrackedLegacy(characterId, tracked);
  }
}

/** 设置主线追踪状态 */
const setMainQuestTrackedLegacy = async (
  characterId: number,
  tracked: boolean,
): Promise<{ success: boolean; message: string; data?: { tracked: boolean } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const existsRes = await query(`SELECT 1 FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`, [cid]);
  if ((existsRes.rows ?? []).length === 0) {
    await getMainQuestProgressLegacy(cid);
  }

  const res = await query(
    `UPDATE character_main_quest_progress
     SET tracked = $2, updated_at = NOW()
     WHERE character_id = $1
     RETURNING tracked`,
    [cid, tracked === true],
  );
  const saved = res.rows?.[0]?.tracked !== false;
  return { success: true, message: 'ok', data: { tracked: saved } };
};

export const mainQuestService = new MainQuestService();

// 兼容性导出（供 dialogue.ts 等内部模块调用）
export const ensureMainQuestProgressForNewChapters = (characterId: number) =>
  mainQuestService.ensureProgressForNewChapters(characterId);
