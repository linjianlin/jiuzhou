import { pool, query } from '../config/database.js';
import type { PoolClient } from 'pg';
import {
  loadDialogue,
  getDialogueNode,
  processChoice,
  createDialogueState,
  applyDialogueEffectsTx,
  type DialogueEffect,
  type DialogueNode,
  type DialogueState,
} from './dialogueService.js';
import { createItem } from './itemService.js';
import { getRoomsInMap } from './mapService.js';
import { getRealmOrderIndex } from './shared/realmOrder.js';
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getMainQuestChapterById,
  getMainQuestChapterDefinitions,
  getMainQuestSectionById,
  getMainQuestSectionDefinitions,
  getTechniqueDefinitions,
  type MainQuestChapterConfig,
  type MainQuestSectionConfig,
} from './staticConfigLoader.js';

type ChapterDto = {
  id: string;
  chapterNum: number;
  name: string;
  description: string;
  background: string;
  minRealm: string;
  isCompleted: boolean;
};

export type SectionStatus = 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';

type SectionObjectiveDto = {
  id: string;
  type: string;
  text: string;
  target: number;
  done: number;
  params?: Record<string, unknown>;
};

type SectionDto = {
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

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

const asNumber = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringArray = (v: unknown): string[] => {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const raw of asArray<unknown>(v)) {
    const value = asString(raw).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
};

const isMainQuestChapterEnabled = (chapter: MainQuestChapterConfig | null): boolean => {
  return !!chapter && chapter.enabled !== false;
};

const isMainQuestSectionEnabled = (section: MainQuestSectionConfig | null): boolean => {
  if (!section || section.enabled === false) return false;
  const chapter = getMainQuestChapterById(section.chapter_id);
  return isMainQuestChapterEnabled(chapter);
};

const getEnabledMainQuestSectionById = (sectionId: string): MainQuestSectionConfig | null => {
  const section = getMainQuestSectionById(sectionId);
  return isMainQuestSectionEnabled(section) ? section : null;
};

const getEnabledMainQuestChapterById = (chapterId: string): MainQuestChapterConfig | null => {
  const chapter = getMainQuestChapterById(chapterId);
  return isMainQuestChapterEnabled(chapter) ? chapter : null;
};

const getEnabledMainQuestSectionsSorted = (): MainQuestSectionConfig[] => {
  return getMainQuestSectionDefinitions()
    .filter((section) => isMainQuestSectionEnabled(section))
    .sort((left, right) => {
      const leftChapterNum = Number(getMainQuestChapterById(left.chapter_id)?.chapter_num ?? 0);
      const rightChapterNum = Number(getMainQuestChapterById(right.chapter_id)?.chapter_num ?? 0);
      if (leftChapterNum !== rightChapterNum) return leftChapterNum - rightChapterNum;
      return Number(left.section_num || 0) - Number(right.section_num || 0);
    });
};

const resolveNpcRoomId = async (mapId: string | null, npcId: string | null): Promise<string | null> => {
  const mid = asString(mapId).trim();
  const nid = asString(npcId).trim();
  if (!mid || !nid) return null;

  const rooms = await getRoomsInMap(mid);
  for (const room of rooms) {
    if (!Array.isArray(room.npcs) || room.npcs.length === 0) continue;
    if (room.npcs.includes(nid)) return room.id;
  }

  return null;
};

const resolveCurrentSectionRoomId = async (params: {
  status: SectionStatus;
  mapId: string | null;
  npcId: string | null;
  roomId: string | null;
  objectives: SectionObjectiveDto[];
}): Promise<string | null> => {
  const { status, mapId, npcId, roomId, objectives } = params;
  let effectiveRoomId = roomId;

  if (status === 'objectives') {
    const reachObj = objectives.find((objective) => {
      if (objective.type !== 'reach') return false;
      if (objective.done >= objective.target) return false;
      const rid = typeof objective.params?.room_id === 'string' ? objective.params.room_id.trim() : '';
      return rid.length > 0;
    });
    if (reachObj) {
      const rid = typeof reachObj.params?.room_id === 'string' ? reachObj.params.room_id.trim() : '';
      if (rid) effectiveRoomId = rid;
    }
    return effectiveRoomId;
  }

  if (status === 'not_started' || status === 'dialogue' || status === 'turnin') {
    const npcRoomId = await resolveNpcRoomId(mapId, npcId);
    if (npcRoomId) return npcRoomId;
  }

  return effectiveRoomId;
};

const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmOrderIndex(realmRaw, subRealmRaw);
};

const syncCurrentSectionStaticProgress = async (characterId: number): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT current_section_id, section_status, objectives_progress
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
      return;
    }

    const progress = progressRes.rows[0] as {
      current_section_id?: unknown;
      section_status?: unknown;
      objectives_progress?: unknown;
    };
    if (asString(progress.section_status) !== 'objectives') {
      await client.query('ROLLBACK');
      return;
    }

    const sectionId = asString(progress.current_section_id);
    if (!sectionId) {
      await client.query('ROLLBACK');
      return;
    }

    const section = getEnabledMainQuestSectionById(sectionId);
    if (!section) {
      await client.query('ROLLBACK');
      return;
    }

    const objectives = asArray<{ id?: unknown; type?: unknown; target?: unknown; params?: unknown }>(section.objectives);
    const progressData = asObject(progress.objectives_progress);

    const characterRes = await client.query(`SELECT realm, sub_realm FROM characters WHERE id = $1 LIMIT 1`, [cid]);
    const characterRow = characterRes.rows?.[0] as { realm?: unknown; sub_realm?: unknown } | undefined;
    const currentRealmRank = getRealmRank(characterRow?.realm, characterRow?.sub_realm);

    const techniqueRes = await client.query(
      `SELECT technique_id, current_layer FROM character_technique WHERE character_id = $1`,
      [cid],
    );
    const currentTechniqueLayerMap = new Map<string, number>();
    for (const row of techniqueRes.rows ?? []) {
      const record = row as { technique_id?: unknown; current_layer?: unknown };
      const techniqueId = asString(record.technique_id).trim();
      if (!techniqueId) continue;
      const currentLayer = Math.max(0, Math.floor(asNumber(record.current_layer, 0)));
      const prevLayer = currentTechniqueLayerMap.get(techniqueId) ?? 0;
      if (currentLayer > prevLayer) currentTechniqueLayerMap.set(techniqueId, currentLayer);
    }

    let updated = false;
    for (const obj of objectives) {
      const objId = asString(obj.id);
      if (!objId) continue;
      const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
      const done = asNumber(progressData[objId], 0);
      if (done >= target) continue;

      const objType = asString(obj.type);
      const params = asObject(obj.params);

      if (objType === 'upgrade_realm') {
        const requiredRealm = asString(params.realm).trim();
        const requiredRealmRank = getRealmRank(requiredRealm);
        if (!requiredRealm) continue;
        if (requiredRealmRank >= 0 && currentRealmRank >= requiredRealmRank) {
          progressData[objId] = target;
          updated = true;
        }
      }

      if (objType === 'upgrade_technique') {
        const techniqueId = asString(params.technique_id).trim();
        const requiredQuality = asString(params.quality).trim();
        const requiredLayer = Math.max(1, Math.floor(asNumber(params.layer, 1)));

        if (techniqueId) {
          // 按具体功法 ID 匹配
          const currentLayer = currentTechniqueLayerMap.get(techniqueId) ?? 0;
          if (currentLayer >= requiredLayer) {
            progressData[objId] = target;
            updated = true;
          }
        } else if (requiredQuality) {
          // 按品质匹配：玩家拥有任意一门该品质功法且 layer >= 要求即可
          const qualityTechIds = new Set(
            getTechniqueDefinitions()
              .filter((t) => t.enabled !== false && asString(t.quality).trim() === requiredQuality)
              .map((t) => t.id),
          );
          for (const [tid, layer] of currentTechniqueLayerMap) {
            if (qualityTechIds.has(tid) && layer >= requiredLayer) {
              progressData[objId] = target;
              updated = true;
              break;
            }
          }
        }
      }
    }

    if (!updated) {
      await client.query('ROLLBACK');
      return;
    }

    const allDone = objectives.every((obj) => {
      const objId = asString(obj.id);
      if (!objId) return true;
      const target = Math.max(1, Math.floor(asNumber(obj.target, 1)));
      return asNumber(progressData[objId], 0) >= target;
    });
    const nextStatus: SectionStatus = allDone ? 'turnin' : 'objectives';
    await client.query(
      `UPDATE character_main_quest_progress
       SET objectives_progress = $2::jsonb,
           section_status = $3,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(progressData), nextStatus],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('同步主线静态目标失败:', error);
  } finally {
    client.release();
  }
};

const getFirstSection = async (): Promise<{ id: string; chapter_id: string } | null> => {
  const first = getEnabledMainQuestSectionsSorted()[0];
  if (!first) return null;
  return { id: first.id, chapter_id: first.chapter_id };
};

/**
 * 修复“历史角色在新章节上线后仍停留在 completed 状态”的问题。
 * 输入：characterId（角色ID）
 * 输出：无返回值；若满足条件则原子地把进度推进到下一章首节。
 * 约束：
 * 1. 仅在 section_status = completed 时触发，避免干扰正常进行中的主线流程。
 * 2. 以“当前章节 + 已完成章节 + 已完成任务节反推章节”中的最大章节号为基线。
 * 3. 找到基线之后的第一条可用任务节并切换为 not_started，函数可重复调用且幂等。
 */
export const ensureMainQuestProgressForNewChapters = async (characterId: number): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT current_chapter_id, current_section_id, section_status, completed_chapters, completed_sections
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );

    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
      return;
    }

    const nextSection = getEnabledMainQuestSectionsSorted().find((entry) => {
      const chapterNum = asNumber(getMainQuestChapterById(entry.chapter_id)?.chapter_num, 0);
      return chapterNum > latestCompletedChapterNum;
    });

    if (!nextSection) {
      await client.query('ROLLBACK');
      return;
    }

    const nextChapterId = asString(nextSection.chapter_id).trim();
    const nextSectionId = asString(nextSection.id).trim();
    if (!nextChapterId || !nextSectionId) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
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

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('修复主线新增章节进度失败:', error);
  } finally {
    client.release();
  }
};

type DbQueryLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const decorateSectionRewards = async (db: DbQueryLike, rewards: Record<string, unknown>): Promise<Record<string, unknown>> => {
  void db;
  const items = asArray<{ item_def_id?: unknown; quantity?: unknown }>((rewards as { items?: unknown }).items);
  const itemIds = Array.from(
    new Set(items.map((it) => asString(it.item_def_id)).map((x) => x.trim()).filter(Boolean)),
  );

  const itemDefMap = new Map<string, { name: string; icon: string | null }>();
  if (itemIds.length > 0) {
    const itemDefs = getItemDefinitionsByIds(itemIds);
    for (const itemId of itemIds) {
      const itemDef = itemDefs.get(itemId);
      if (!itemDef) continue;
      itemDefMap.set(itemId, {
        name: asString(itemDef.name).trim(),
        icon: asString(itemDef.icon).trim() || null,
      });
    }
  }

  const itemsDetail = items
    .map((it) => {
      const itemDefId = asString(it.item_def_id).trim();
      const quantity = Math.max(1, Math.floor(asNumber(it.quantity, 1)));
      if (!itemDefId) return null;
      const def = itemDefMap.get(itemDefId);
      return {
        item_def_id: itemDefId,
        quantity,
        name: (def?.name || itemDefId).trim(),
        icon: def?.icon ?? null,
      };
    })
    .filter(Boolean);

  const techniques = asArray<string>((rewards as { techniques?: unknown }).techniques).map((x) => asString(x).trim()).filter(Boolean);
  const techniqueDefMap = new Map<string, { name: string; icon: string | null }>();
  if (techniques.length > 0) {
    const idSet = new Set(techniques);
    for (const entry of getTechniqueDefinitions()) {
      if (entry.enabled === false) continue;
      if (!idSet.has(entry.id)) continue;
      techniqueDefMap.set(entry.id, {
        name: asString(entry.name).trim(),
        icon: asString(entry.icon).trim() || null,
      });
    }
  }

  const techniquesDetail = techniques.map((id) => {
    const def = techniqueDefMap.get(id);
    return { id, name: (def?.name || id).trim(), icon: def?.icon ?? null };
  });

  const out: Record<string, unknown> = { ...rewards };
  if (itemsDetail.length > 0) out.items_detail = itemsDetail;
  if (techniquesDetail.length > 0) out.techniques_detail = techniquesDetail;
  return out;
};

export const getMainQuestProgress = async (characterId: number): Promise<MainQuestProgressDto> => {
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

  // 兼容历史数据：玩家曾“全章节完结”后，后续新章节上线时自动补推进到新章节首节。
  await ensureMainQuestProgressForNewChapters(cid);
  await syncCurrentSectionStaticProgress(cid);
  progressRes = await query(`SELECT * FROM character_main_quest_progress WHERE character_id = $1`, [cid]);

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
        rewards: await decorateSectionRewards({ query }, asObject(section.rewards)),
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

export const startDialogue = async (
  characterId: number,
  dialogueId?: string,
): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  await ensureMainQuestProgressForNewChapters(cid);

  const progressRes = await query(
    `SELECT current_section_id, section_status
     FROM character_main_quest_progress WHERE character_id = $1`,
    [cid],
  );
  const progress = progressRes.rows?.[0] as { current_section_id?: unknown; section_status?: unknown } | undefined;
  if (!progress) return { success: false, message: '主线进度不存在' };

  let targetDialogueId = typeof dialogueId === 'string' && dialogueId.trim() ? dialogueId.trim() : '';
  if (!targetDialogueId && progress.current_section_id) {
    const section = getEnabledMainQuestSectionById(asString(progress.current_section_id));
    if (section) {
      const status = asString(progress.section_status);
      if (status === 'turnin' || status === 'completed') {
        targetDialogueId = asString(section.dialogue_complete_id) || asString(section.dialogue_id);
      } else {
        targetDialogueId = asString(section.dialogue_id);
      }
    }
  }

  if (!targetDialogueId) return { success: false, message: '没有可用的对话' };

  const dialogue = await loadDialogue(targetDialogueId);
  if (!dialogue) return { success: false, message: '对话不存在' };

  const dialogueState = createDialogueState(targetDialogueId, dialogue.nodes);

  await query(
    `UPDATE character_main_quest_progress
     SET section_status = CASE WHEN section_status = 'not_started' THEN 'dialogue' ELSE section_status END,
         dialogue_state = $2::jsonb,
         updated_at = NOW()
     WHERE character_id = $1`,
    [cid, JSON.stringify(dialogueState)],
  );

  return { success: true, message: 'ok', data: { dialogueState } };
};

export const advanceDialogue = async (
  userId: number,
  characterId: number,
): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState; effectResults?: unknown[] } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT dialogue_state, current_section_id, section_status
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
      return { success: false, message: '主线进度不存在' };
    }

    const row = progressRes.rows[0] as { dialogue_state?: unknown; current_section_id?: unknown; section_status?: unknown };
    let dialogueStateRaw = asObject(row.dialogue_state);
    let dialogueId = asString(dialogueStateRaw.dialogueId);
    const sectionId = asString(row.current_section_id);
    const sectionStatus = asString(row.section_status) as SectionStatus;

    if (!dialogueId) {
      if (!sectionId) {
        await client.query('ROLLBACK');
        return { success: false, message: '没有进行中的对话' };
      }

      const section = getEnabledMainQuestSectionById(sectionId);
      const startDialogueId =
        sectionStatus === 'turnin' || sectionStatus === 'completed'
          ? asString(section?.dialogue_complete_id) || asString(section?.dialogue_id)
          : asString(section?.dialogue_id);

      if (!startDialogueId) {
        await client.query('ROLLBACK');
        return { success: false, message: '没有可用的对话' };
      }

      const bootstrapDialogue = await loadDialogue(startDialogueId);
      if (!bootstrapDialogue) {
        await client.query('ROLLBACK');
        return { success: false, message: '对话不存在' };
      }

      const bootstrapState = createDialogueState(startDialogueId, bootstrapDialogue.nodes);
      dialogueStateRaw = bootstrapState as unknown as Record<string, unknown>;
      dialogueId = startDialogueId;
    }

    const dialogue = await loadDialogue(dialogueId);
    if (!dialogue) {
      await client.query('ROLLBACK');
      return { success: false, message: '对话不存在' };
    }

    const pendingEffects = asArray<DialogueEffect>(dialogueStateRaw.pendingEffects);
    let effectResults: unknown[] = [];
    if (pendingEffects.length > 0) {
      const applyResult = await applyDialogueEffectsTx(client, uid, cid, pendingEffects);
      effectResults = applyResult.results;
    }

    const selectedChoices = asArray<string>(dialogueStateRaw.selectedChoices);
    const currentNodeIdRaw = asString(dialogueStateRaw.currentNodeId);
    const currentNode =
      getDialogueNode(dialogue.nodes, currentNodeIdRaw) ?? createDialogueState(dialogueId, dialogue.nodes).currentNode;

    if (!currentNode) {
      await client.query('ROLLBACK');
      return { success: false, message: '对话节点不存在' };
    }

    if (currentNode.type === 'choice') {
      await client.query('ROLLBACK');
      return { success: false, message: '请选择选项' };
    }

    const nextNodeId = asString(currentNode.next);
    if (!nextNodeId) {
      const newDialogueState: DialogueState = {
        dialogueId,
        currentNodeId: currentNode.id,
        currentNode,
        selectedChoices,
        isComplete: true,
        pendingEffects: [],
      };

      let newSectionStatus: SectionStatus = 'dialogue';
      if (sectionId) {
        const section = getEnabledMainQuestSectionById(sectionId);
        const objectives = asArray(section?.objectives);
        newSectionStatus = objectives.length > 0 ? 'objectives' : 'turnin';
      } else {
        newSectionStatus = 'turnin';
      }

      await client.query(
        `UPDATE character_main_quest_progress
         SET dialogue_state = $2::jsonb,
             section_status = $3,
             updated_at = NOW()
         WHERE character_id = $1`,
        [cid, JSON.stringify(newDialogueState), newSectionStatus],
      );

      await client.query('COMMIT');
      if (newSectionStatus === 'objectives') {
        await syncCurrentSectionStaticProgress(cid);
      }
      return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
    }

    const nextNode = getDialogueNode(dialogue.nodes, nextNodeId);
    if (!nextNode) {
      await client.query('ROLLBACK');
      return { success: false, message: `无效的对话节点: ${nextNodeId}` };
    }

    const newDialogueState: DialogueState = {
      dialogueId,
      currentNodeId: nextNodeId,
      currentNode: nextNode,
      selectedChoices,
      isComplete: false,
      pendingEffects: asArray<DialogueEffect>(nextNode.effects),
    };

    const newSectionStatus: SectionStatus = 'dialogue';

    await client.query(
      `UPDATE character_main_quest_progress
       SET dialogue_state = $2::jsonb,
           section_status = $3,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(newDialogueState), newSectionStatus],
    );

    await client.query('COMMIT');
    return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('推进对话失败:', error);
    return { success: false, message: '服务器错误' };
  } finally {
    client.release();
  }
};

export const selectDialogueChoice = async (
  userId: number,
  characterId: number,
  choiceId: string,
): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState; effectResults?: unknown[] } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const ch = typeof choiceId === 'string' ? choiceId.trim() : '';
  if (!ch) return { success: false, message: '选项ID不能为空' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT dialogue_state
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
      return { success: false, message: '主线进度不存在' };
    }

    const dialogueStateRaw = asObject(progressRes.rows[0].dialogue_state);
    if (!dialogueStateRaw.dialogueId) {
      await client.query('ROLLBACK');
      return { success: false, message: '没有进行中的对话' };
    }

    const dialogue = await loadDialogue(asString(dialogueStateRaw.dialogueId));
    if (!dialogue) {
      await client.query('ROLLBACK');
      return { success: false, message: '对话不存在' };
    }

    const currentNodeId = asString(dialogueStateRaw.currentNodeId);
    const { nextNodeId, effects } = processChoice(dialogue.nodes, currentNodeId, ch);
    if (!nextNodeId) {
      await client.query('ROLLBACK');
      return { success: false, message: '无效的选项' };
    }

    let effectResults: unknown[] = [];
    if (effects.length > 0) {
      const applyResult = await applyDialogueEffectsTx(client, uid, cid, effects);
      effectResults = applyResult.results;
    }

    const nextNode = getDialogueNode(dialogue.nodes, nextNodeId);
    if (!nextNode) {
      await client.query('ROLLBACK');
      return { success: false, message: `无效的对话节点: ${nextNodeId}` };
    }
    const selectedChoices = [...asArray<string>(dialogueStateRaw.selectedChoices), ch];

    const newDialogueState: DialogueState = {
      dialogueId: asString(dialogueStateRaw.dialogueId),
      currentNodeId: nextNodeId,
      currentNode: nextNode,
      selectedChoices,
      isComplete: false,
      pendingEffects: asArray<DialogueEffect>(nextNode.effects),
    };

    await client.query(
      `UPDATE character_main_quest_progress
       SET dialogue_state = $2::jsonb,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(newDialogueState)],
    );

    await client.query('COMMIT');
    return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('选择对话选项失败:', error);
    return { success: false, message: '服务器错误' };
  } finally {
    client.release();
  }
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

export const updateSectionProgress = async (
  characterId: number,
  event: MainQuestProgressEvent,
): Promise<{ success: boolean; message: string; updated: boolean; completed: boolean }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在', updated: false, completed: false };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT current_section_id, section_status, objectives_progress
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
      return { success: false, message: '主线进度不存在', updated: false, completed: false };
    }

    const progress = progressRes.rows[0] as {
      current_section_id?: unknown;
      section_status?: unknown;
      objectives_progress?: unknown;
    };
    if (asString(progress.section_status) !== 'objectives') {
      await client.query('ROLLBACK');
      return { success: true, message: '当前不在目标阶段', updated: false, completed: false };
    }

    const sectionId = asString(progress.current_section_id);
    if (!sectionId) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务节不存在', updated: false, completed: false };
    }

    const section = getEnabledMainQuestSectionById(sectionId);
    if (!section) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务节不存在', updated: false, completed: false };
    }

    const objectives = asArray<{ id?: unknown; type?: unknown; target?: unknown; params?: unknown }>(section.objectives);
    const progressData = asObject(progress.objectives_progress);
    let updated = false;

    for (const obj of objectives) {
      const objId = asString(obj.id);
      const objType = asString(obj.type);
      const target = asNumber(obj.target, 1);
      const params = asObject(obj.params);
      const currentDone = asNumber(progressData[objId], 0);
      if (!objId) continue;
      if (currentDone >= target) continue;

      let matched = false;
      let delta = 0;

      if (event.type === 'talk_npc') {
        if (objType === 'talk_npc' && asString(params.npc_id) === event.npcId) {
          matched = true;
          delta = 1;
        }
      }

      if (event.type === 'kill_monster') {
        if (objType === 'kill_monster' && asString(params.monster_id) === event.monsterId) {
          matched = true;
          delta = Math.max(1, Math.floor(event.count));
        }
      }

      if (event.type === 'gather_resource') {
        if (objType === 'gather_resource' && asString(params.resource_id) === event.resourceId) {
          matched = true;
          delta = Math.max(1, Math.floor(event.count));
        }
      }

      if (event.type === 'collect') {
        if (objType === 'collect' && asString(params.item_id) === event.itemId) {
          matched = true;
          delta = Math.max(1, Math.floor(event.count));
        }
      }

      if (event.type === 'dungeon_clear') {
        if (objType === 'dungeon_clear') {
          const dungeonId = asString(params.dungeon_id);
          const difficultyId = asString(params.difficulty_id);
          const dungeonMatch = !dungeonId || dungeonId === event.dungeonId;
          const difficultyMatch = !difficultyId || difficultyId === asString(event.difficultyId);
          if (dungeonMatch && difficultyMatch) {
            matched = true;
            delta = Math.max(1, Math.floor(event.count));
          }
        }
      }

      if (event.type === 'craft_item') {
        if (objType === 'craft_item') {
          const recipeId = asString(params.recipe_id);
          const recipeType = asString(params.recipe_type);
          const craftKind = asString(params.craft_kind);
          const itemId = asString(params.item_id);

          const recipeMatch = !recipeId || recipeId === asString(event.recipeId);
          const recipeTypeMatch = !recipeType || recipeType === asString(event.recipeType);
          const craftKindMatch = !craftKind || craftKind === asString(event.craftKind);
          const itemMatch = !itemId || itemId === asString(event.itemId);
          if (recipeMatch && recipeTypeMatch && craftKindMatch && itemMatch) {
            matched = true;
            delta = Math.max(1, Math.floor(event.count));
          }
        }
      }

      if (event.type === 'reach') {
        if (objType === 'reach' && asString(params.room_id) === event.roomId) {
          matched = true;
          delta = 1;
        }
      }

      if (event.type === 'upgrade_technique') {
        if (objType === 'upgrade_technique' && event.layer >= asNumber(params.layer, 1)) {
          const techniqueId = asString(params.technique_id).trim();
          const requiredQuality = asString(params.quality).trim();

          if (techniqueId) {
            // 按具体功法 ID 匹配
            if (techniqueId === event.techniqueId) {
              matched = true;
              delta = 1;
            }
          } else if (requiredQuality) {
            // 按品质匹配：查询触发事件的功法品质
            const techDef = getTechniqueDefinitions().find(
              (t) => t.id === event.techniqueId && t.enabled !== false,
            );
            if (techDef && asString(techDef.quality).trim() === requiredQuality) {
              matched = true;
              delta = 1;
            }
          }
        }
      }

      if (event.type === 'upgrade_realm') {
        const requiredRealm = asString(params.realm).trim();
        const requiredRealmRank = getRealmRank(requiredRealm);
        const currentRealmRank = getRealmRank(event.realm);
        if (objType === 'upgrade_realm' && requiredRealm && requiredRealmRank >= 0 && currentRealmRank >= requiredRealmRank) {
          matched = true;
          delta = 1;
        }
      }

      if (matched && delta > 0) {
        progressData[objId] = Math.min(target, currentDone + delta);
        updated = true;
      }
    }

    if (!updated) {
      await client.query('ROLLBACK');
      return { success: true, message: '无匹配目标', updated: false, completed: false };
    }

    const allDone = objectives.every((obj) => {
      const objId = asString(obj.id);
      if (!objId) return true;
      const target = asNumber(obj.target, 1);
      return asNumber(progressData[objId], 0) >= target;
    });

    const newStatus: SectionStatus = allDone ? 'turnin' : 'objectives';
    await client.query(
      `UPDATE character_main_quest_progress
       SET objectives_progress = $2::jsonb,
           section_status = $3,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(progressData), newStatus],
    );
    await client.query('COMMIT');
    return { success: true, message: 'ok', updated: true, completed: allDone };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('更新主线目标进度失败:', error);
    return { success: false, message: '服务器错误', updated: false, completed: false };
  } finally {
    client.release();
  }
};

type RewardResult =
  | { type: 'exp'; amount: number }
  | { type: 'silver'; amount: number }
  | { type: 'spirit_stones'; amount: number }
  | { type: 'item'; itemDefId: string; quantity: number; itemName?: string; itemIcon?: string }
  | { type: 'technique'; techniqueId: string; techniqueName?: string; techniqueIcon?: string }
  | { type: 'title'; title: string }
  | { type: 'chapter_exp'; amount: number }
  | { type: 'chapter_silver'; amount: number }
  | { type: 'chapter_spirit_stones'; amount: number };

const grantSectionRewardsTx = async (
  client: PoolClient,
  userId: number,
  characterId: number,
  rewards: Record<string, unknown>,
): Promise<RewardResult[]> => {
  const results: RewardResult[] = [];

  const exp = asNumber((rewards as { exp?: unknown }).exp, 0);
  if (exp > 0) {
    await client.query(`UPDATE characters SET exp = exp + $1, updated_at = NOW() WHERE id = $2`, [exp, characterId]);
    results.push({ type: 'exp', amount: exp });
  }

  const silver = asNumber((rewards as { silver?: unknown }).silver, 0);
  if (silver > 0) {
    await client.query(`UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`, [silver, characterId]);
    results.push({ type: 'silver', amount: silver });
  }

  const spiritStones = asNumber((rewards as { spirit_stones?: unknown }).spirit_stones, 0);
  if (spiritStones > 0) {
    await client.query(`UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`, [
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
    const result = await createItem(userId, characterId, itemDefId, quantity, {
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
    const existsRes = await client.query(
      `SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1`,
      [characterId, t],
    );
    if (existsRes.rows.length === 0) {
      await client.query(
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
    await client.query(`UPDATE characters SET title = $1, updated_at = NOW() WHERE id = $2`, [finalTitle, characterId]);
    for (const t of normalizedTitles) {
      results.push({ type: 'title', title: t });
    }
  }

  return results;
};

export const completeCurrentSection = async (
  userId: number,
  characterId: number,
): Promise<{ success: boolean; message: string; data?: { rewards: RewardResult[]; nextSection?: SectionDto; chapterCompleted?: boolean } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progressRes = await client.query(
      `SELECT current_chapter_id, current_section_id, section_status, completed_chapters, completed_sections
       FROM character_main_quest_progress
       WHERE character_id = $1 FOR UPDATE`,
      [cid],
    );
    if (!progressRes.rows?.[0]) {
      await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
      return { success: false, message: '任务未完成，无法领取奖励' };
    }

    const currentSectionId = asString(progress.current_section_id);
    if (!currentSectionId) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务节不存在' };
    }

    const section = getEnabledMainQuestSectionById(currentSectionId);
    if (!section) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务节不存在' };
    }

    const sectionId = asString(section.id);
    const chapterId = asString(section.chapter_id);
    if (!sectionId || !chapterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '任务节不存在' };
    }

    const rewardResults = await grantSectionRewardsTx(client, uid, cid, asObject(section.rewards));

    const completedSections = asArray<string>(progress.completed_sections);
    if (!completedSections.includes(sectionId)) completedSections.push(sectionId);

    const completedChapters = asArray<string>(progress.completed_chapters);
    let chapterCompleted = false;
    let nextSectionDto: SectionDto | undefined;

    if (section.is_chapter_final === true) {
      chapterCompleted = true;
      if (!completedChapters.includes(chapterId)) completedChapters.push(chapterId);

      const chapterRewards = asObject(getMainQuestChapterById(chapterId)?.chapter_rewards);
      const chapterRewardResults = await grantSectionRewardsTx(client, uid, cid, chapterRewards);
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
          await client.query(
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
        await client.query(
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
          await client.query(
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
            rewards: await decorateSectionRewards(client, asObject(nextSection.rewards)),
            isChapterFinal: nextSection.is_chapter_final === true,
          };
        }
      }
    }

    await client.query('COMMIT');
    return { success: true, message: 'ok', data: { rewards: rewardResults, nextSection: nextSectionDto, chapterCompleted } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('完成主线任务节失败:', error);
    return { success: false, message: '服务器错误' };
  } finally {
    client.release();
  }
};

export const getChapterList = async (characterId: number): Promise<{ chapters: ChapterDto[] }> => {
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

export const getSectionList = async (characterId: number, chapterId: string): Promise<{ sections: SectionDto[] }> => {
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

export const setMainQuestTracked = async (
  characterId: number,
  tracked: boolean,
): Promise<{ success: boolean; message: string; data?: { tracked: boolean } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const existsRes = await query(`SELECT 1 FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`, [cid]);
  if ((existsRes.rows ?? []).length === 0) {
    await getMainQuestProgress(cid);
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
