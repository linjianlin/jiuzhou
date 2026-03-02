/**
 * 主线任务领域公共类型定义
 *
 * 作用：集中定义主线任务模块的所有 DTO 和事件类型。
 * 复用点：progress、chapterList、dialogue、objectiveProgress、sectionComplete、service、roomResolver 等模块共享。
 *
 * 边界条件：
 * 1) SectionStatus 是有限枚举，新增状态需同步更新此处。
 * 2) MainQuestProgressEvent 的 type 字段需与目标匹配逻辑保持同步。
 */
import type { DialogueState } from '../dialogueService.js';

export type SectionStatus = 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';

export type SectionObjectiveDto = {
  id: string;
  type: string;
  text: string;
  target: number;
  done: number;
  params?: Record<string, unknown>;
};

export type ChapterDto = {
  id: string;
  chapterNum: number;
  name: string;
  description: string;
  background: string;
  minRealm: string;
  isCompleted: boolean;
};

export type SectionDto = {
  id: string;
  chapterId: string;
  sectionNum: number;
  name: string;
  description: string;
  brief: string;
  npcId: string | null;
  mapId: string | null;
  roomId: string | null;
  status: SectionStatus;
  objectives: SectionObjectiveDto[];
  rewards: Record<string, unknown>;
  isChapterFinal: boolean;
};

export type MainQuestProgressDto = {
  currentChapter: ChapterDto | null;
  currentSection: SectionDto | null;
  completedChapters: string[];
  completedSections: string[];
  dialogueState: DialogueState | null;
  tracked: boolean;
};

export type MainQuestProgressEvent =
  | { type: 'talk_npc'; npcId: string }
  | { type: 'kill_monster'; monsterId: string; count: number }
  | { type: 'gather_resource'; resourceId: string; count: number }
  | { type: 'collect'; itemId: string; count: number }
  | { type: 'dungeon_clear'; dungeonId: string; difficultyId?: string; count: number }
  | { type: 'craft_item'; recipeId?: string; recipeType?: string; craftKind?: string; itemId?: string; count: number }
  | { type: 'reach'; roomId: string }
  | { type: 'upgrade_technique'; techniqueId: string; layer: number }
  | { type: 'upgrade_realm'; realm: string };

export type RewardResult =
  | { type: 'exp'; amount: number }
  | { type: 'silver'; amount: number }
  | { type: 'spirit_stones'; amount: number }
  | { type: 'item'; itemDefId: string; quantity: number; itemName?: string; itemIcon?: string }
  | { type: 'technique'; techniqueId: string; techniqueName?: string; techniqueIcon?: string }
  | { type: 'title'; title: string }
  | { type: 'chapter_exp'; amount: number }
  | { type: 'chapter_silver'; amount: number }
  | { type: 'chapter_spirit_stones'; amount: number };
