import { query } from '../config/database.js';
import type { PoolClient } from 'pg';
import { createItem } from './itemService.js';

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
  const res = await query(`SELECT id, name, nodes, enabled FROM dialogue_def WHERE id = $1 AND enabled = true LIMIT 1`, [
    id,
  ]);
  if (!res.rows?.[0]) return null;
  const row = res.rows[0] as { id: string; name: string; nodes: unknown; enabled: boolean };
  return {
    id: row.id,
    name: row.name,
    nodes: asArray<DialogueNode>(row.nodes),
    enabled: row.enabled === true,
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
  client: PoolClient,
  userId: number,
  characterId: number,
  effects: DialogueEffect[],
): Promise<{ success: boolean; message: string; results: unknown[] }> => {
  const results: unknown[] = [];
  for (const effect of effects) {
    const type = typeof effect?.type === 'string' ? effect.type : '';
    const params = asObject(effect?.params);
    try {
      if (type === 'give_silver') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          await client.query(`UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`, [
            amount,
            characterId,
          ]);
          results.push({ type: 'silver', amount });
        }
        continue;
      }
      if (type === 'give_spirit_stones') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          await client.query(`UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`, [
            amount,
            characterId,
          ]);
          results.push({ type: 'spirit_stones', amount });
        }
        continue;
      }
      if (type === 'give_exp') {
        const amount = Number(params.amount) || 0;
        if (amount > 0) {
          await client.query(`UPDATE characters SET exp = exp + $1, updated_at = NOW() WHERE id = $2`, [
            amount,
            characterId,
          ]);
          results.push({ type: 'exp', amount });
        }
        continue;
      }
      if (type === 'give_technique') {
        const techniqueId = typeof params.technique_id === 'string' ? params.technique_id : '';
        if (techniqueId) {
          const existsRes = await client.query(
            `SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1`,
            [characterId, techniqueId],
          );
          if (existsRes.rows.length === 0) {
            await client.query(
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
          const result = await createItem(userId, characterId, itemDefId, qty, {
            dbClient: client,
            location: 'bag',
            obtainedFrom: 'dialogue',
          });
          if (!result.success) throw new Error(result.message);
          results.push({ type: 'item', itemDefId, quantity: qty });
        }
        continue;
      }
      if (type === 'set_flag') {
        const flagName = typeof params.flag === 'string' ? params.flag : '';
        const flagValue = params.value ?? true;
        if (flagName) {
          await client.query(
            `UPDATE characters 
             SET extra_data = COALESCE(extra_data, '{}'::jsonb) || jsonb_build_object($1, $2::jsonb),
                 updated_at = NOW()
             WHERE id = $3`,
            [flagName, JSON.stringify(flagValue), characterId],
          );
          results.push({ type: 'flag', flag: flagName, value: flagValue });
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

