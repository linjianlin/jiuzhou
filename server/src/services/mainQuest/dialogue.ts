/**
 * 主线对话命令
 *
 * 作用：处理主线对话的启动、推进和选项选择。
 * 输入：characterId、userId、dialogueId、choiceId。
 * 输出：对话状态 + 效果结果。
 *
 * 数据流：
 * 1. startDialogue：查进度 → 确定对话 ID → 加载对话 → 创建状态 → 更新 DB
 * 2. advanceDialogue：读进度（FOR UPDATE）→ 应用待处理效果 → 推进节点 → 更新 DB
 * 3. selectDialogueChoice：读进度（FOR UPDATE）→ 处理选项 → 应用效果 → 推进节点 → 更新 DB
 *
 * 边界条件：
 * 1) advanceDialogue/selectDialogueChoice 需要事务上下文（getTransactionClient），调用方需通过 @Transactional 保证。
 * 2) 对话结束时根据是否有 objectives 决定下一阶段（objectives 或 turnin）。
 */
import { query, getTransactionClient } from '../../config/database.js';
import {
  loadDialogue,
  getDialogueNode,
  processChoice,
  createDialogueState,
  applyDialogueEffectsTx,
  type DialogueEffect,
  type DialogueState,
} from '../dialogueService.js';
import { asString, asArray, asObject } from '../shared/typeCoercion.js';
import { getEnabledMainQuestSectionById } from './shared/questConfig.js';
import { syncCurrentSectionStaticProgress } from './objectiveProgress.js';
import { ensureMainQuestProgressForNewChapters } from './service.js';
import type { SectionStatus } from './types.js';

/** 启动对话（无事务） */
export const startDialogueLegacy = async (
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

/** 推进对话（需 @Transactional） */
export const advanceDialogueLegacy = async (
  userId: number,
  characterId: number,
): Promise<{ success: boolean; message: string; data?: { dialogueState: DialogueState; effectResults?: unknown[] } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };

  const client = getTransactionClient();
  if (!client) throw new Error('事务上下文不存在');

  const progressRes = await query(
    `SELECT dialogue_state, current_section_id, section_status
     FROM character_main_quest_progress
     WHERE character_id = $1 FOR UPDATE`,
    [cid],
  );
  if (!progressRes.rows?.[0]) {
    return { success: false, message: '主线进度不存在' };
  }

  const row = progressRes.rows[0] as { dialogue_state?: unknown; current_section_id?: unknown; section_status?: unknown };
  let dialogueStateRaw = asObject(row.dialogue_state);
  let dialogueId = asString(dialogueStateRaw.dialogueId);
  const sectionId = asString(row.current_section_id);
  const sectionStatus = asString(row.section_status) as SectionStatus;

  if (!dialogueId) {
    if (!sectionId) {
      return { success: false, message: '没有进行中的对话' };
    }

    const section = getEnabledMainQuestSectionById(sectionId);
    const startDialogueId =
      sectionStatus === 'turnin' || sectionStatus === 'completed'
        ? asString(section?.dialogue_complete_id) || asString(section?.dialogue_id)
        : asString(section?.dialogue_id);

    if (!startDialogueId) {
      return { success: false, message: '没有可用的对话' };
    }

    const bootstrapDialogue = await loadDialogue(startDialogueId);
    if (!bootstrapDialogue) {
      return { success: false, message: '对话不存在' };
    }

    const bootstrapState = createDialogueState(startDialogueId, bootstrapDialogue.nodes);
    dialogueStateRaw = bootstrapState as unknown as Record<string, unknown>;
    dialogueId = startDialogueId;
  }

  const dialogue = await loadDialogue(dialogueId);
  if (!dialogue) {
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
    return { success: false, message: '对话节点不存在' };
  }

  if (currentNode.type === 'choice') {
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

    await query(
      `UPDATE character_main_quest_progress
       SET dialogue_state = $2::jsonb,
           section_status = $3,
           updated_at = NOW()
       WHERE character_id = $1`,
      [cid, JSON.stringify(newDialogueState), newSectionStatus],
    );
    if (newSectionStatus === 'objectives') {
      await syncCurrentSectionStaticProgress(cid);
    }
    return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
  }

  const nextNode = getDialogueNode(dialogue.nodes, nextNodeId);
  if (!nextNode) {
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

  await query(
    `UPDATE character_main_quest_progress
     SET dialogue_state = $2::jsonb,
         section_status = $3,
         updated_at = NOW()
     WHERE character_id = $1`,
    [cid, JSON.stringify(newDialogueState), newSectionStatus],
  );
  return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
};

/** 选择选项（需 @Transactional） */
export const selectDialogueChoiceLegacy = async (
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

  const client = getTransactionClient();
  if (!client) throw new Error('事务上下文不存在');

  const progressRes = await query(
    `SELECT dialogue_state
     FROM character_main_quest_progress
     WHERE character_id = $1 FOR UPDATE`,
    [cid],
  );
  if (!progressRes.rows?.[0]) {
    return { success: false, message: '主线进度不存在' };
  }

  const dialogueStateRaw = asObject(progressRes.rows[0].dialogue_state);
  if (!dialogueStateRaw.dialogueId) {
    return { success: false, message: '没有进行中的对话' };
  }

  const dialogue = await loadDialogue(asString(dialogueStateRaw.dialogueId));
  if (!dialogue) {
    return { success: false, message: '对话不存在' };
  }

  const currentNodeId = asString(dialogueStateRaw.currentNodeId);
  const { nextNodeId, effects } = processChoice(dialogue.nodes, currentNodeId, ch);
  if (!nextNodeId) {
    return { success: false, message: '无效的选项' };
  }

  let effectResults: unknown[] = [];
  if (effects.length > 0) {
    const applyResult = await applyDialogueEffectsTx(client, uid, cid, effects);
    effectResults = applyResult.results;
  }

  const nextNode = getDialogueNode(dialogue.nodes, nextNodeId);
  if (!nextNode) {
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

  await query(
    `UPDATE character_main_quest_progress
     SET dialogue_state = $2::jsonb,
         updated_at = NOW()
     WHERE character_id = $1`,
    [cid, JSON.stringify(newDialogueState)],
  );
  return { success: true, message: 'ok', data: { dialogueState: newDialogueState, effectResults } };
};
