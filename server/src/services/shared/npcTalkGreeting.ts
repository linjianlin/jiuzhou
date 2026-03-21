/**
 * NPC 对话开场文案解析
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一决定 NPC 弹窗首屏该显示通用 greeting，还是显示当前主线任务对应的开场对白，避免 `taskService.npcTalk` 把静态文案、主线阶段判断、对话预览提取散落在同一个函数里。
 * 2. 做什么：在 NPC 参与主线但当前并非该 NPC 的任务阶段时，阻止弹出未来/过期主线文案，避免玩家看到“下一节任务提前剧透”。
 * 3. 不做什么：不读取数据库，不推进任务状态，也不决定按钮行为；它只负责“当前该显示哪一句开场文案”。
 *
 * 输入/输出：
 * - 输入：NPC 标识、当前主线任务节标识、当前主线阶段，以及 NPC 自身 talk tree 的 greeting 文案。
 * - 输出：NPC 弹窗首屏应展示的文案列表；空数组表示不应使用 talk tree，由上层沿用已有的默认占位文案。
 *
 * 数据流/状态流：
 * `taskService.npcTalk` 先拿到当前主线快照
 * -> 本模块判断该 NPC 是否正处于当前主线阶段
 * -> 若命中当前主线，则从对应主线对白里抽取首条可展示文本
 * -> 否则决定保留或屏蔽 talk tree greeting
 * -> 结果返回给 NPC 弹窗首屏。
 *
 * 关键边界条件与坑点：
 * 1. 第一节主线的对白起点是 narration，不能直接拿 `start` 节点，否则 NPC 弹窗会把旁白当成 NPC 开场白；这里必须优先提取首个 `npc` 节点。
 * 2. 同一个 NPC 可能贯穿多个主线节，静态 greeting 一旦写成某一节的任务台词，就会在别的阶段串线；因此只要当前主线不在该 NPC 身上，就必须屏蔽这类 greeting。
 */
import {
  getDialogueDefinitions,
} from '../staticConfigLoader.js';
import { asArray, asString } from './typeCoercion.js';
import type { SectionStatus } from '../mainQuest/types.js';
import {
  getEnabledMainQuestSectionById,
  getEnabledMainQuestSectionsSorted,
} from '../mainQuest/shared/questConfig.js';

type ResolveNpcTalkGreetingLinesParams = {
  npcId: string;
  currentSectionId: string | null;
  currentSectionStatus: SectionStatus;
  talkTreeLines: string[];
};

type DialogueNodeRecord = {
  id?: unknown;
  type?: unknown;
  text?: unknown;
};

const extractDialoguePreviewLines = (dialogueId: string): string[] => {
  const targetDialogueId = dialogueId.trim();
  if (!targetDialogueId) {
    return [];
  }

  const dialogue = getDialogueDefinitions().find((entry) => entry.enabled !== false && entry.id === targetDialogueId);
  if (!dialogue) {
    return [];
  }

  const nodes = asArray<DialogueNodeRecord>(dialogue.nodes);
  const firstNpcNode = nodes.find((node) => asString(node.type) === 'npc' && asString(node.text).trim());
  if (firstNpcNode) {
    return [asString(firstNpcNode.text).trim()];
  }

  const firstTextNode = nodes.find((node) => {
    const nodeType = asString(node.type);
    return nodeType !== 'choice' && asString(node.text).trim();
  });
  if (!firstTextNode) {
    return [];
  }

  return [asString(firstTextNode.text).trim()];
};

const resolveCurrentSectionDialogueId = (
  currentSectionId: string | null,
  currentSectionStatus: SectionStatus,
): string => {
  if (!currentSectionId) {
    return '';
  }

  const currentSection = getEnabledMainQuestSectionById(currentSectionId);
  if (!currentSection) {
    return '';
  }

  if (currentSectionStatus === 'turnin' || currentSectionStatus === 'completed') {
    const completionDialogueId = asString(currentSection.dialogue_complete_id).trim();
    if (completionDialogueId) {
      return completionDialogueId;
    }
  }

  return asString(currentSection.dialogue_id).trim();
};

export const resolveNpcTalkGreetingLines = (
  params: ResolveNpcTalkGreetingLinesParams,
): string[] => {
  const npcId = params.npcId.trim();
  if (!npcId) {
    return [];
  }

  const currentSection = params.currentSectionId ? getEnabledMainQuestSectionById(params.currentSectionId) : null;
  const currentSectionNpcId = asString(currentSection?.npc_id).trim();
  const npcMainQuestSections = getEnabledMainQuestSectionsSorted().filter(
    (section) => asString(section.npc_id).trim() === npcId,
  );

  if (npcMainQuestSections.length === 0) {
    return params.talkTreeLines;
  }

  if (!currentSection || currentSectionNpcId !== npcId) {
    return [];
  }

  const currentDialogueId = resolveCurrentSectionDialogueId(currentSection.id, params.currentSectionStatus);
  return extractDialoguePreviewLines(currentDialogueId);
};
