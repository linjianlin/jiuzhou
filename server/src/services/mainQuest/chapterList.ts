/**
 * 主线章节与任务节列表查询
 *
 * 作用：返回所有启用章节列表和指定章节下的任务节列表。
 * 输入：characterId（角色 ID）、chapterId（章节 ID，仅任务节列表需要）。
 * 输出：ChapterDto[] 或 SectionDto[] 列表。
 *
 * 数据流：
 * 1. 查询角色进度获取已完成章节/任务节列表
 * 2. 关联静态配置构建 DTO
 * 3. getSectionListLegacy 额外执行 syncCurrentSectionStaticProgress 同步境界/技能目标
 *
 * 边界条件：
 * 1) 章节按 chapter_num 排序并去重（同 chapter_num 仅保留一个）。
 * 2) characterId 无效时返回空列表，不抛异常。
 */
import { query } from '../../config/database.js';
import { asString, asNumber, asArray, asObject } from '../shared/typeCoercion.js';
import {
  isMainQuestSectionEnabled,
  getEnabledMainQuestSectionById,
} from './shared/questConfig.js';
import { syncCurrentSectionStaticProgress } from './objectiveProgress.js';
import {
  getMainQuestChapterDefinitions,
  getMainQuestSectionDefinitions,
} from '../staticConfigLoader.js';
import type {
  ChapterDto,
  SectionDto,
  SectionObjectiveDto,
  SectionStatus,
} from './types.js';

/** 返回所有启用章节 */
export const getChapterListLegacy = async (characterId: number): Promise<{ chapters: ChapterDto[] }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { chapters: [] };

  const progressRes = await query(`SELECT completed_chapters FROM character_main_quest_progress WHERE character_id = $1`, [cid]);
  const completedChapters = asArray<string>((progressRes.rows?.[0] as { completed_chapters?: unknown } | undefined)?.completed_chapters);

  const enabledSections = getMainQuestSectionDefinitions().filter((section) => isMainQuestSectionEnabled(section));
  const sectionCountByChapterId = new Map<string, number>();
  for (const section of enabledSections) {
    sectionCountByChapterId.set(section.chapter_id, (sectionCountByChapterId.get(section.chapter_id) ?? 0) + 1);
  }

  const chaptersSorted = getMainQuestChapterDefinitions()
    .filter((chapter) => chapter.enabled !== false)
    .map((chapter) => ({
      chapter,
      sectionCount: sectionCountByChapterId.get(chapter.id) ?? 0,
    }))
    .sort((left, right) => {
      const chapterNumDiff = asNumber(left.chapter.chapter_num, 0) - asNumber(right.chapter.chapter_num, 0);
      if (chapterNumDiff !== 0) return chapterNumDiff;
      const sectionCountDiff = right.sectionCount - left.sectionCount;
      if (sectionCountDiff !== 0) return sectionCountDiff;
      const sortWeightDiff = asNumber(right.chapter.sort_weight, 0) - asNumber(left.chapter.sort_weight, 0);
      if (sortWeightDiff !== 0) return sortWeightDiff;
      return asString(left.chapter.id).localeCompare(asString(right.chapter.id));
    });

  const seenChapterNums = new Set<number>();
  const chapters: ChapterDto[] = [];
  for (const { chapter } of chaptersSorted) {
    const id = asString(chapter.id);
    const chapterNum = asNumber(chapter.chapter_num, 0);
    if (!id || chapterNum <= 0) continue;
    if (seenChapterNums.has(chapterNum)) continue;
    seenChapterNums.add(chapterNum);
    chapters.push({
      id,
      chapterNum,
      name: asString(chapter.name),
      description: asString(chapter.description),
      background: asString(chapter.background),
      minRealm: asString(chapter.min_realm) || '凡人',
      isCompleted: completedChapters.includes(id),
    });
  }
  return { chapters };
};

/** 返回指定章节下任务节 */
export const getSectionListLegacy = async (characterId: number, chapterId: string): Promise<{ sections: SectionDto[] }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { sections: [] };

  const chapId = typeof chapterId === 'string' ? chapterId.trim() : '';
  if (!chapId) return { sections: [] };

  await syncCurrentSectionStaticProgress(cid);

  const progressRes = await query(
    `SELECT current_section_id, section_status, objectives_progress, completed_sections
     FROM character_main_quest_progress
     WHERE character_id = $1`,
    [cid],
  );
  const progress = progressRes.rows?.[0] as
    | { current_section_id?: unknown; section_status?: unknown; objectives_progress?: unknown; completed_sections?: unknown }
    | undefined;
  const completedSections = asArray<string>(progress?.completed_sections);
  const currentSectionId = asString(progress?.current_section_id);
  const currentStatus = (asString(progress?.section_status) as SectionStatus) || 'not_started';
  const currentProgress = asObject(progress?.objectives_progress);

  const sectionDefs = getMainQuestSectionDefinitions()
    .filter((section) => section.chapter_id === chapId)
    .filter((section) => isMainQuestSectionEnabled(section))
    .sort((left, right) => asNumber(left.section_num, 0) - asNumber(right.section_num, 0));
  const sections: SectionDto[] = sectionDefs.map((row) => {
    const id = asString(row.id);
    const isCurrentSection = id === currentSectionId;
    const isCompleted = completedSections.includes(id);

    let status: SectionStatus = 'not_started';
    if (isCompleted) status = 'completed';
    else if (isCurrentSection) status = currentStatus;

    const objectivesRaw = asArray<{ id?: unknown; type?: unknown; text?: unknown; target?: unknown; params?: unknown }>(
      row.objectives,
    );
    const objectives: SectionObjectiveDto[] = objectivesRaw.map((o) => {
      const oid = asString(o.id);
      const target = asNumber(o.target, 1);
      return {
        id: oid,
        type: asString(o.type),
        text: asString(o.text),
        target,
        done: isCurrentSection ? asNumber(currentProgress[oid], 0) : isCompleted ? target : 0,
        params: (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) ? (o.params as Record<string, unknown>) : undefined,
      };
    });

    return {
      id,
      chapterId: asString(row.chapter_id),
      sectionNum: asNumber(row.section_num, 0),
      name: asString(row.name),
      description: asString(row.description),
      brief: asString(row.brief),
      npcId: asString(row.npc_id) || null,
      mapId: asString(row.map_id) || null,
      roomId: asString(row.room_id) || null,
      status,
      objectives,
      rewards: asObject(row.rewards),
      isChapterFinal: row.is_chapter_final === true,
    };
  });
  return { sections };
};
