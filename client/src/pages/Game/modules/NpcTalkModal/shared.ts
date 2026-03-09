/**
 * 作用：
 * - 统一承接 NPC 对话弹窗的消息条目、主线节点映射、任务状态文案，避免 `Game/index.tsx` 在多个分支里重复拼对白和标签。
 * - 不负责接口请求、阶段切换与副作用；这些仍由页面容器控制。
 *
 * 输入/输出：
 * - 输入：NPC 初始对白、主线对话节点、任务状态。
 * - 输出：可直接渲染的 `NpcDialogueEntry[]` 与状态元信息。
 *
 * 数据流/状态流：
 * - API 返回的 `lines` / `DialogueNode` -> 本模块归一化 -> `NpcTalkModal` 渲染时间线。
 * - 任务状态 -> 本模块唯一映射表 -> 页面按钮与标签统一复用。
 *
 * 关键边界条件与坑点：
 * - 空字符串对白不会进入时间线，避免按钮点击后插入空气泡导致“闪一下”。
 * - `choice` 节点可能只有选项没有正文，此时不强造文案，只渲染操作按钮，避免前后端语义错位。
 */
import type { NpcTalkTaskStatus } from '../../../../services/api';
import type { DialogueNode } from '../../../../services/mainQuestApi';

export type NpcTalkMainQuestStatus = 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';

export type NpcDialogueRole = 'npc' | 'player' | 'system' | 'narration' | 'action';

export type NpcDialogueEntry = {
  id: string;
  role: NpcDialogueRole;
  text: string;
  speaker?: string;
};

type NpcDialogueEntryDraft = Omit<NpcDialogueEntry, 'id'>;

const normalizeDialogueText = (text: string | null | undefined): string => {
  return typeof text === 'string' ? text.trim() : '';
};

const isNpcDialogueEntry = (entry: NpcDialogueEntry | null): entry is NpcDialogueEntry => {
  return entry !== null;
};

export const createNpcDialogueEntry = (draft: NpcDialogueEntryDraft): NpcDialogueEntry | null => {
  const text = normalizeDialogueText(draft.text);
  if (!text) {
    return null;
  }
  const speaker = normalizeDialogueText(draft.speaker);
  return {
    id: crypto.randomUUID(),
    role: draft.role,
    text,
    speaker: speaker || undefined,
  };
};

export const createNpcDialogueEntriesFromLines = (
  lines: readonly string[],
  fallback: string,
): NpcDialogueEntry[] => {
  const entries = lines
    .map((line) => createNpcDialogueEntry({ role: 'npc', text: line }))
    .filter(isNpcDialogueEntry);
  if (entries.length > 0) {
    return entries;
  }
  const fallbackEntry = createNpcDialogueEntry({ role: 'npc', text: fallback });
  return fallbackEntry ? [fallbackEntry] : [];
};

export const createNpcDialogueEntriesFromDialogueNode = (node: DialogueNode): NpcDialogueEntry[] => {
  const speaker = normalizeDialogueText(node.speaker);
  if (node.type === 'npc') {
    const entry = createNpcDialogueEntry({ role: 'npc', text: node.text ?? '', speaker });
    return entry ? [entry] : [];
  }
  if (node.type === 'player') {
    const entry = createNpcDialogueEntry({ role: 'player', text: node.text ?? '', speaker: speaker || '你' });
    return entry ? [entry] : [];
  }
  if (node.type === 'system') {
    const entry = createNpcDialogueEntry({ role: 'system', text: node.text ?? '' });
    return entry ? [entry] : [];
  }
  if (node.type === 'narration') {
    const entry = createNpcDialogueEntry({ role: 'narration', text: node.text ?? '' });
    return entry ? [entry] : [];
  }
  if (node.type === 'action') {
    const entry = createNpcDialogueEntry({ role: 'action', text: node.text ?? '' });
    return entry ? [entry] : [];
  }
  if (node.type === 'choice') {
    const entry = createNpcDialogueEntry({ role: 'npc', text: node.text ?? '', speaker });
    return entry ? [entry] : [];
  }
  return [];
};

export const NPC_TALK_TASK_STATUS_META: Record<NpcTalkTaskStatus, { label: string; color: string }> = {
  locked: { label: '未解锁', color: 'default' },
  available: { label: '可接取', color: 'green' },
  accepted: { label: '进行中', color: 'blue' },
  turnin: { label: '可提交', color: 'purple' },
  claimable: { label: '可领取', color: 'gold' },
  claimed: { label: '已完成', color: 'default' },
};

export const resolveNpcTalkMainQuestStatusLabel = (status: NpcTalkMainQuestStatus): string => {
  if (status === 'not_started') return '可接取';
  if (status === 'dialogue') return '对话中';
  if (status === 'objectives') return '进行中';
  if (status === 'turnin') return '可交付';
  return '已完成';
};
