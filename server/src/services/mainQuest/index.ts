/**
 * 主线任务模块导出聚合
 *
 * 作用：作为 mainQuest 模块的唯一公共入口，re-export service 实例与类型。
 * 所有外部模块（routes、其他 service）统一从此文件导入。
 *
 * 边界条件：
 * 1) 不包含任何业务逻辑，仅做导出转发。
 * 2) 类型和实例分别来自 types.ts 和 service.ts。
 */
import { mainQuestService } from './service.js';

export { mainQuestService } from './service.js';
export type { MainQuestProgressDto, MainQuestProgressEvent, SectionStatus, RewardResult } from './types.js';

// 兼容性导出：保持原有函数签名不变，供外部调用方无需改动 import
export const ensureMainQuestProgressForNewChapters = (characterId: number) =>
  mainQuestService.ensureProgressForNewChapters(characterId);

export const getMainQuestProgress = (characterId: number) =>
  mainQuestService.getProgress(characterId);

export const startDialogue = (characterId: number, dialogueId?: string) =>
  mainQuestService.startDialogue(characterId, dialogueId);

export const advanceDialogue = (userId: number, characterId: number) =>
  mainQuestService.advanceDialogue(userId, characterId);

export const selectDialogueChoice = (userId: number, characterId: number, choiceId: string) =>
  mainQuestService.selectDialogueChoice(userId, characterId, choiceId);

export const updateSectionProgress = (characterId: number, event: import('./types.js').MainQuestProgressEvent) =>
  mainQuestService.updateProgress(characterId, event);

export const completeCurrentSection = (userId: number, characterId: number) =>
  mainQuestService.completeCurrentSection(userId, characterId);

export const getChapterList = (characterId: number) =>
  mainQuestService.getChapterList(characterId);

export const getSectionList = (characterId: number, chapterId: string) =>
  mainQuestService.getSectionList(characterId, chapterId);

export const setMainQuestTracked = (characterId: number, tracked: boolean) =>
  mainQuestService.setTracked(characterId, tracked);
