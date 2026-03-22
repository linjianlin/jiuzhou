import { query } from '../config/database.js';
import { itemService } from './itemService.js';
import { assertServiceSuccess } from './shared/assertServiceSuccess.js';
import {
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';
import { getDialogueDefinitions } from './staticConfigLoader.js';

export type DialogueNodeType = 'narration' | 'npc' | 'player' | 'choice' | 'system' | 'action';

export type DialogueEffect = {
  type: string;
  params?: Record<string, unknown>;
};

export type DialogueChoice = {
  id: string;
  text: string;
  next: string;
  condition?: Record<string, unknown>;
  effects?: DialogueEffect[];
};

export type DialogueNode = {
  id: string;
  type: DialogueNodeType;
  speaker?: string;
  text?: string;
  emotion?: string;
  choices?: DialogueChoice[];
  next?: string;
  effects?: DialogueEffect[];
};

export type DialogueDef = {
  id: string;
  name: string;
  nodes: DialogueNode[];
  enabled: boolean;
};

export type DialogueState = {
  dialogueId: string;
  currentNodeId: string;
  currentNode: DialogueNode | null;
  selectedChoices: string[];
  isComplete: boolean;
  pendingEffects: DialogueEffect[];
};

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const loadDialogue = async (dialogueId: string): Promise<DialogueDef | null> => {
  const id = typeof dialogueId === 'string' ? dialogueId.trim() : '';
  if (!id) return null;
  const row = getDialogueDefinitions().find((entry) => entry.id === id && entry.enabled !== false);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nodes: asArray<DialogueNode>(row.nodes ?? []),
    enabled: row.enabled !== false,
  };
};

export const getDialogueNode = (nodes: DialogueNode[], nodeId: string): DialogueNode | null => {
  const id = typeof nodeId === 'string' ? nodeId : '';
  if (!nodes || !id) return null;
  return nodes.find((n) => n.id === id) ?? null;
};

export const getStartNode = (nodes: DialogueNode[]): DialogueNode | null => {
  if (!nodes || nodes.length === 0) return null;
  return nodes.find((n) => n.id === 'start') ?? nodes[0] ?? null;
};

export const processChoice = (
  nodes: DialogueNode[],
  currentNodeId: string,
  choiceId: string,
): { nextNodeId: string; effects: DialogueEffect[] } => {
  const currentNode = getDialogueNode(nodes, currentNodeId);
  if (!currentNode || currentNode.type !== 'choice' || !Array.isArray(currentNode.choices)) {
    return { nextNodeId: '', effects: [] };
  }
  const choice = currentNode.choices.find((c) => c.id === choiceId);
  if (!choice) return { nextNodeId: '', effects: [] };
  return { nextNodeId: choice.next || '', effects: asArray<DialogueEffect>(choice.effects) };
};

export const advanceToNextNode = (
  nodes: DialogueNode[],
  currentNodeId: string,
): { nextNodeId: string; effects: DialogueEffect[] } => {
  const currentNode = getDialogueNode(nodes, currentNodeId);
  if (!currentNode) return { nextNodeId: '', effects: [] };
  if (currentNode.type === 'choice') return { nextNodeId: currentNodeId, effects: [] };
  return { nextNodeId: currentNode.next || '', effects: asArray<DialogueEffect>(currentNode.effects) };
};

export const isDialogueComplete = (nodes: DialogueNode[], currentNodeId: string): boolean => {
  const id = typeof currentNodeId === 'string' ? currentNodeId : '';
  if (!id) return true;
  const currentNode = getDialogueNode(nodes, id);
  if (!currentNode) return true;
  return !currentNode.next && currentNode.type !== 'choice';
};

export const createDialogueState = (dialogueId: string, nodes: DialogueNode[]): DialogueState => {
  const startNode = getStartNode(nodes);
  return {
    dialogueId,
    currentNodeId: startNode?.id || '',
    currentNode: startNode,
    selectedChoices: [],
    isComplete: !startNode,
    pendingEffects: asArray<DialogueEffect>(startNode?.effects),
  };
};

export const applyDialogueEffectsTx = async (
  userId: number,
  characterId: number,
  effects: DialogueEffect[],
): Promise<{ success: boolean; message: string; results: unknown[] }> => {
  const results: unknown[] = [];
  let characterWriteback = await loadCharacterWritebackRowByCharacterId(characterId, {
    forUpdate: true,
  });
  if (!characterWriteback) {
    return { success: false, message: '角色不存在', results };
  }
  for (const effect of effects) {
    const type = typeof effect?.type === 'string' ? effect.type : '';
    const params = asObject(effect?.params);
    try {
      if (type === 'give_silver') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          characterWriteback = {
            ...characterWriteback,
            silver: characterWriteback.silver + amount,
          };
          queueCharacterWritebackSnapshot(characterId, {
            silver: characterWriteback.silver,
          });
          results.push({ type: 'silver', amount });
        }
        continue;
      }
      if (type === 'give_spirit_stones') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          characterWriteback = {
            ...characterWriteback,
            spirit_stones: characterWriteback.spirit_stones + amount,
          };
          queueCharacterWritebackSnapshot(characterId, {
            spirit_stones: characterWriteback.spirit_stones,
          });
          results.push({ type: 'spirit_stones', amount });
        }
        continue;
      }
      if (type === 'give_exp') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          characterWriteback = {
            ...characterWriteback,
            exp: characterWriteback.exp + amount,
          };
          queueCharacterWritebackSnapshot(characterId, {
            exp: characterWriteback.exp,
          });
          results.push({ type: 'exp', amount });
        }
        continue;
      }
      if (type === 'give_technique') {
        const techniqueId = typeof params.technique_id === 'string' ? params.technique_id : '';
        if (techniqueId) {
          const existsRes = await query(
            `SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1`,
            [characterId, techniqueId],
          );
          if (existsRes.rows.length === 0) {
            await query(
              `INSERT INTO character_technique (character_id, technique_id, current_layer, acquired_at)
               VALUES ($1, $2, 1, NOW())`,
              [characterId, techniqueId],
            );
            results.push({ type: 'technique', techniqueId });
          }
        }
        continue;
      }
      if (type === 'give_item') {
        const itemDefId = typeof params.item_def_id === 'string' ? params.item_def_id : '';
        const qty = Number(params.quantity) || 1;
        if (itemDefId && qty > 0) {
          const result = await itemService.createItem(userId, characterId, itemDefId, qty, {
            location: 'bag',
            obtainedFrom: 'dialogue',
          });
          assertServiceSuccess(result);
          results.push({ type: 'item', itemDefId, quantity: qty });
        }
        continue;
      }
      if (type === 'set_flag') {
        const flagName = typeof params.flag === 'string' ? params.flag : '';
        const flagValue = params.value ?? true;
        if (flagName) {
          throw new Error(`当前库结构不支持对话旗标写入: ${flagName}=${JSON.stringify(flagValue)}`);
        }
        continue;
      }
      void userId;
    } catch (err) {
      console.error('应用对话效果失败:', type, err);
    }
  }
  return { success: true, message: 'ok', results };
};
