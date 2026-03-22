/**
 * 秘境参与者工具
 *
 * 作用：解析/构建/查询秘境实例的参与者信息。
 * 不做什么：不处理战斗或奖励逻辑。
 *
 * 输入：JSON 参与者数据 / userId / teamId。
 * 输出：类型安全的参与者列表 / 昵称映射 / 角色信息。
 *
 * 复用点：instance.ts（创建/加入/查询）、combat.ts（开战/推进/结算）。
 *
 * 边界条件：
 * 1) parseParticipants 对 userId 去重（同一用户只保留最后一条记录）。
 * 2) getUserAndCharacter 拼接 realm + sub_realm 为完整境界名。
 */

import { query } from '../../../config/database.js';
import {
  loadCharacterWritebackRowByCharacterId,
  loadCharacterWritebackRowByUserId,
} from '../../playerWritebackCacheService.js';
import { asObject, asArray, asString } from './typeUtils.js';
import type { DungeonInstanceParticipant } from '../types.js';

/** 从 JSON 值解析参与者列表（自动去重） */
export const parseParticipants = (v: unknown): DungeonInstanceParticipant[] => {
  const arr = asArray(v);
  const list: DungeonInstanceParticipant[] = [];
  for (const it of arr) {
    const obj = asObject(it);
    if (!obj) continue;
    const userId = Number(obj.userId);
    const characterId = Number(obj.characterId);
    const role = obj.role === 'leader' ? 'leader' : obj.role === 'member' ? 'member' : null;
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!role) continue;
    list.push({ userId, characterId, role });
  }
  const uniq = new Map<number, DungeonInstanceParticipant>();
  for (const p of list) uniq.set(p.userId, p);
  return Array.from(uniq.values());
};

/** 构建参与者展示标签（如"队长【张三】(角色ID:1)"） */
export const buildParticipantLabel = (
  participant: DungeonInstanceParticipant,
  nicknameMap: Map<number, string>
): string => {
  const roleLabel = participant.role === 'leader' ? '队长' : '队员';
  const nickname = nicknameMap.get(participant.characterId);
  if (nickname) return `${roleLabel}【${nickname}】(角色ID:${participant.characterId})`;
  return `${roleLabel}(角色ID:${participant.characterId})`;
};

/** 批量加载参与者昵称映射（characterId -> nickname） */
export const getParticipantNicknameMap = async (participants: DungeonInstanceParticipant[]): Promise<Map<number, string>> => {
  const characterIds = Array.from(
    new Set(
      participants
        .map((participant) => participant.characterId)
        .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
    ),
  );
  if (characterIds.length === 0) return new Map<number, string>();

  const nicknameMap = new Map<number, string>();
  const rows = await Promise.all(
    characterIds.map(async (characterId) => loadCharacterWritebackRowByCharacterId(characterId)),
  );
  for (const row of rows) {
    const characterId = Number(row?.id);
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    const nickname = asString(row?.nickname, '').trim();
    if (!nickname) continue;
    nicknameMap.set(characterId, nickname);
  }
  return nicknameMap;
};

/** 拼接主副境界为完整境界名（如"炼精化炁·养气期"） */
export const getFullRealm = (realm: string, subRealm: string | null): string => {
  if (!subRealm || realm === '凡人') return realm;
  return `${realm}·${subRealm}`;
};

/** 获取用户角色信息（含境界、队伍） */
export const getUserAndCharacter = async (
  userId: number
): Promise<
  | { ok: true; userId: number; characterId: number; realm: string; teamId: string | null; isLeader: boolean }
  | { ok: false; message: string }
> => {
  const character = await loadCharacterWritebackRowByUserId(userId);
  if (!character) return { ok: false, message: '角色不存在' };
  const characterId = Number(character.id);
  if (!Number.isFinite(characterId) || characterId <= 0) return { ok: false, message: '角色不存在' };
  const realm = getFullRealm(String(character.realm || '凡人'), (character.sub_realm ?? null) as string | null);

  const memberRes = await query(`SELECT team_id, role FROM team_members WHERE character_id = $1 LIMIT 1`, [characterId]);
  const teamId = memberRes.rows.length > 0 ? asString(memberRes.rows[0]?.team_id, '') : '';
  const role = memberRes.rows.length > 0 ? asString(memberRes.rows[0]?.role, '') : '';
  return { ok: true, userId, characterId, realm, teamId: teamId || null, isLeader: role === 'leader' };
};

/** 获取队伍所有成员作为秘境参与者 */
export const getTeamParticipants = async (teamId: string): Promise<DungeonInstanceParticipant[]> => {
  const res = await query(
    `
      SELECT c.user_id, c.id AS character_id, tm.role
      FROM team_members tm
      JOIN characters c ON c.id = tm.character_id
      WHERE tm.team_id = $1
      ORDER BY tm.role DESC, tm.joined_at ASC
    `,
    [teamId]
  );
  const list: DungeonInstanceParticipant[] = [];
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const userId = Number(row.user_id);
    const characterId = Number(row.character_id);
    const role = row.role === 'leader' ? 'leader' : 'member';
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    list.push({ userId, characterId, role });
  }
  return list;
};
