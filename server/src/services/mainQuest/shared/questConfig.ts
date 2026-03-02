/**
 * 主线任务配置查询工具
 *
 * 作用：提供主线章节和任务节的启用状态检查与排序查询。
 * 输入：章节/任务节 ID 或无参数。
 * 输出：启用的配置对象或 null。
 *
 * 复用点：progress、chapterList、dialogue、objectiveProgress、sectionComplete、service 均依赖此模块判断启用状态。
 *
 * 边界条件：
 * 1) enabled 字段缺失时视为启用（enabled !== false）。
 * 2) 任务节启用需同时要求所属章节也启用，避免孤立任务节泄露。
 */
import {
  getMainQuestChapterById,
  getMainQuestSectionById,
  getMainQuestSectionDefinitions,
  type MainQuestChapterConfig,
  type MainQuestSectionConfig,
} from '../../staticConfigLoader.js';

/** 检查章节是否启用 */
export const isMainQuestChapterEnabled = (chapter: MainQuestChapterConfig | null): boolean => {
  return !!chapter && chapter.enabled !== false;
};

/** 检查任务节是否启用（需所属章节也启用） */
export const isMainQuestSectionEnabled = (section: MainQuestSectionConfig | null): boolean => {
  if (!section || section.enabled === false) return false;
  const chapter = getMainQuestChapterById(section.chapter_id);
  return isMainQuestChapterEnabled(chapter);
};

/** 按 ID 获取启用的任务节，不启用则返回 null */
export const getEnabledMainQuestSectionById = (sectionId: string): MainQuestSectionConfig | null => {
  const section = getMainQuestSectionById(sectionId);
  return isMainQuestSectionEnabled(section) ? section : null;
};

/** 按 ID 获取启用的章节，不启用则返回 null */
export const getEnabledMainQuestChapterById = (chapterId: string): MainQuestChapterConfig | null => {
  const chapter = getMainQuestChapterById(chapterId);
  return isMainQuestChapterEnabled(chapter) ? chapter : null;
};

/** 获取所有启用的任务节并按章节号 + 任务节号排序 */
export const getEnabledMainQuestSectionsSorted = (): MainQuestSectionConfig[] => {
  return getMainQuestSectionDefinitions()
    .filter((section) => isMainQuestSectionEnabled(section))
    .sort((left, right) => {
      const leftChapterNum = Number(getMainQuestChapterById(left.chapter_id)?.chapter_num ?? 0);
      const rightChapterNum = Number(getMainQuestChapterById(right.chapter_id)?.chapter_num ?? 0);
      if (leftChapterNum !== rightChapterNum) return leftChapterNum - rightChapterNum;
      return Number(left.section_num || 0) - Number(right.section_num || 0);
    });
};
