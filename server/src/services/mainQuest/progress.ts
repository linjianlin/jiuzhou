/**
 * 主线任务进度查询
 *
 * 作用：获取角色当前主线任务进度，包含章节、任务节、对话状态等完整信息。
 * 输入：characterId（角色 ID）。
 * 输出：MainQuestProgressDto，包含当前章节/任务节/已完成列表/对话状态/追踪状态。
 *
 * 数据流：
 * 1. 查询 character_main_quest_progress 表获取进度记录
 * 2. 若无记录则初始化为第一章第一节
 * 3. 关联静态配置补全章节/任务节详情
 * 4. 动态解析当前任务节目标房间
 *
 * 边界条件：
 * 1) 首次查询自动初始化，但不执行写事务（推进章节/同步目标应在写路径触发）。
 * 2) characterId 无效时返回空结构，不抛异常。
 */
import { query } from '../../config/database.js';
import {
  type DialogueEffect,
  type DialogueNode,
  type DialogueState,
} from '../dialogueService.js';
import { asString, asNumber, asArray, asObject } from '../shared/typeCoercion.js';
import {
  getEnabledMainQuestChapterById,
  getEnabledMainQuestSectionById,
  getEnabledMainQuestSectionsSorted,
} from './shared/questConfig.js';
import { resolveCurrentSectionRoomId } from './shared/roomResolver.js';
import { decorateSectionRewards } from './shared/rewardDecorator.js';
import type {
  MainQuestProgressDto,
  ChapterDto,
  SectionDto,
  SectionObjectiveDto,
  SectionStatus,
} from './types.js';

/** 返回启用的第一个任务节（用于初始化进度） */
export const getFirstSection = async (): Promise<{ id: string; chapter_id: string } | null> => {
  const first = getEnabledMainQuestSectionsSorted()[0];
  if (!first) return null;
  return { id: first.id, chapter_id: first.chapter_id };
};

/** 获取角色主线进度（含初始化逻辑） */
export const getMainQuestProgressLegacy = async (characterId: number): Promise<MainQuestProgressDto> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) {
    return {
      currentChapter: null,
      currentSection: null,
      completedChapters: [],
      completedSections: [],
      dialogueState: null,
      tracked: true,
    };
  }

  let progressRes = await query(`SELECT * FROM character_main_quest_progress WHERE character_id = $1`, [cid]);
  if (!progressRes.rows?.[0]) {
    const firstSection = await getFirstSection();
    if (firstSection) {
      await query(
        `INSERT INTO character_main_quest_progress
         (character_id, current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections)
         VALUES ($1, $2, $3, 'not_started', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [cid, firstSection.chapter_id, firstSection.id],
      );
      progressRes = await query(`SELECT * FROM character_main_quest_progress WHERE character_id = $1`, [cid]);
    }
  }

  // 读接口保持纯读取，不在此处执行写事务（推进章节/同步目标应在写路径触发）。

  const progress = progressRes.rows?.[0] as
    | {
        current_chapter_id?: unknown;
        current_section_id?: unknown;
        section_status?: unknown;
        objectives_progress?: unknown;
        dialogue_state?: unknown;
        completed_chapters?: unknown;
        completed_sections?: unknown;
        tracked?: unknown;
      }
    | undefined;

  if (!progress) {
    return {
      currentChapter: null,
      currentSection: null,
      completedChapters: [],
      completedSections: [],
      dialogueState: null,
      tracked: true,
    };
  }

  const completedChapters = asArray<string>(progress.completed_chapters);
  const completedSections = asArray<string>(progress.completed_sections);
  const dialogueStateRaw = asObject(progress.dialogue_state);
  const tracked = progress.tracked !== false;

  let currentChapter: ChapterDto | null = null;
  const currentChapterId = asString(progress.current_chapter_id);
  if (currentChapterId) {
    const chapter = getEnabledMainQuestChapterById(currentChapterId);
    if (chapter) {
      currentChapter = {
        id: chapter.id,
        chapterNum: asNumber(chapter.chapter_num, 0),
        name: asString(chapter.name),
        description: asString(chapter.description),
        background: asString(chapter.background),
        minRealm: asString(chapter.min_realm) || '凡人',
        isCompleted: completedChapters.includes(chapter.id),
      };
    }
  }

  let currentSection: SectionDto | null = null;
  const currentSectionId = asString(progress.current_section_id);
  if (currentSectionId) {
    const section = getEnabledMainQuestSectionById(currentSectionId);
    if (section) {
      const objectivesRaw = asArray<{ id?: unknown; type?: unknown; text?: unknown; target?: unknown; params?: unknown }>(
        section.objectives,
      );
      const progressData = asObject(progress.objectives_progress);
      const objectives: SectionObjectiveDto[] = objectivesRaw.map((o) => {
        const id = asString(o.id);
        return {
          id,
          type: asString(o.type),
          text: asString(o.text),
          target: asNumber(o.target, 1),
          done: asNumber(progressData[id], 0),
          params: (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) ? (o.params as Record<string, unknown>) : undefined,
        };
      });

      const status = (asString(progress.section_status) as SectionStatus) || 'not_started';
      const mapId = asString(section.map_id) || null;
      const npcId = asString(section.npc_id) || null;
      const baseRoomId = asString(section.room_id) || null;
      const effectiveRoomId = await resolveCurrentSectionRoomId({
        status,
        mapId,
        npcId,
        roomId: baseRoomId,
        objectives,
      });

      currentSection = {
        id: section.id,
        chapterId: asString(section.chapter_id),
        sectionNum: asNumber(section.section_num, 0),
        name: asString(section.name),
        description: asString(section.description),
        brief: asString(section.brief),
        npcId,
        mapId,
        roomId: effectiveRoomId,
        status,
        objectives,
        rewards: await decorateSectionRewards(asObject(section.rewards)),
        isChapterFinal: section.is_chapter_final === true,
      };
    }
  }

  let dialogueState: DialogueState | null = null;
  if (dialogueStateRaw.dialogueId) {
    dialogueState = {
      dialogueId: asString(dialogueStateRaw.dialogueId),
      currentNodeId: asString(dialogueStateRaw.currentNodeId),
      currentNode: (dialogueStateRaw.currentNode as DialogueNode | null) ?? null,
      selectedChoices: asArray<string>(dialogueStateRaw.selectedChoices),
      isComplete: dialogueStateRaw.isComplete === true,
      pendingEffects: asArray<DialogueEffect>(dialogueStateRaw.pendingEffects),
    };
  }

  return { currentChapter, currentSection, completedChapters, completedSections, dialogueState, tracked };
};
