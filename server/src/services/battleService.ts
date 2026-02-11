/**
 * 九州修仙录 - 战斗服务层
 */

import { query } from '../config/database.js';
import { redis } from '../config/redis.js';
import {
  BattleEngine,
  createPVEBattle,
  createPVPBattle,
  calculateRewards,
  type BattleState,
  type BattleSetBonusEffect,
  type CharacterData,
  type MonsterData,
  type SkillData
} from '../battle/index.js';
import {
  distributeBattleRewards,
  type BattleParticipant,
  type DistributeResult
} from './battleDropService.js';
import { getRoomInMap } from './mapService.js';
import { getGameServer } from '../game/GameServer.js';
import { recordKillMonsterEvent } from './taskService.js';
import { calculateTechniquePassives, getBattleSkills } from './characterTechniqueService.js';
import { getArenaStatus } from './arenaService.js';

// 活跃战斗缓存
const activeBattles = new Map<string, BattleEngine>();
// 战斗参与者映射（battleId -> userId[]）
const battleParticipants = new Map<string, number[]>();
const finishedBattleResults = new Map<string, { result: BattleResult; at: number }>();
const FINISHED_BATTLE_TTL_MS = 2 * 60 * 1000;
const characterAutoCastCache = new Map<number, { enabled: boolean; at: number }>();
const CHARACTER_AUTO_CAST_CACHE_TTL_MS = 2000;
const battleTickers = new Map<string, ReturnType<typeof setInterval>>();
const battleTickLocks = new Set<string>();
const characterOwnerCache = new Map<number, { userId: number; at: number }>();
const CHARACTER_OWNER_CACHE_TTL_MS = 5000;
const BATTLE_TICK_MS = 650;
const battleLastEmittedLogLen = new Map<string, number>();
const MAX_BATTLE_LOG_DELTA = 80;
const BATTLE_SET_BONUS_TRIGGER_SET = new Set([
  'on_turn_start',
  'on_skill',
  'on_hit',
  'on_crit',
  'on_be_hit',
  'on_heal',
]);
const BATTLE_SET_BONUS_EFFECT_TYPE_SET = new Set([
  'buff',
  'debuff',
  'damage',
  'heal',
  'resource',
]);

// Redis 战斗持久化常量
const REDIS_BATTLE_KEY_PREFIX = 'battle:state:';
const REDIS_BATTLE_PARTICIPANTS_PREFIX = 'battle:participants:';
const REDIS_BATTLE_TTL_SECONDS = 30 * 60; // 30分钟

/**
 * 保存战斗状态到 Redis
 */
async function saveBattleToRedis(battleId: string, engine: BattleEngine, participants: number[]): Promise<void> {
  try {
    const state = engine.getState();
    await Promise.all([
      redis.setex(
        `${REDIS_BATTLE_KEY_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(state)
      ),
      redis.setex(
        `${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(participants)
      ),
    ]);
  } catch (error) {
    console.error('保存战斗到 Redis 失败:', error);
  }
}

/**
 * 从 Redis 删除战斗状态
 */
async function removeBattleFromRedis(battleId: string): Promise<void> {
  try {
    await Promise.all([
      redis.del(`${REDIS_BATTLE_KEY_PREFIX}${battleId}`),
      redis.del(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
    ]);
  } catch (error) {
    console.error('从 Redis 删除战斗失败:', error);
  }
}

/**
 * 从 Redis 恢复所有活跃战斗（服务启动时调用）
 */
export async function recoverBattlesFromRedis(): Promise<number> {
  let recoveredCount = 0;
  try {
    const keys = await redis.keys(`${REDIS_BATTLE_KEY_PREFIX}*`);
    if (keys.length === 0) {
      console.log('✓ 没有需要恢复的战斗');
      return 0;
    }

    for (const key of keys) {
      const battleId = key.replace(REDIS_BATTLE_KEY_PREFIX, '');
      try {
        const [stateJson, participantsJson] = await Promise.all([
          redis.get(key),
          redis.get(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
        ]);

        if (!stateJson) {
          await removeBattleFromRedis(battleId);
          continue;
        }

        const state = JSON.parse(stateJson) as BattleState;
        const participants = participantsJson ? JSON.parse(participantsJson) as number[] : [];

        // 跳过已结束的战斗
        if (state.phase === 'finished') {
          await removeBattleFromRedis(battleId);
          continue;
        }

        // 恢复战斗引擎
        const engine = new BattleEngine(state);
        activeBattles.set(battleId, engine);
        battleParticipants.set(battleId, participants);
        startBattleTicker(battleId);

        recoveredCount++;
        console.log(`  恢复战斗: ${battleId} (${participants.length} 名参与者)`);
      } catch (error) {
        console.error(`  恢复战斗 ${battleId} 失败:`, error);
        await removeBattleFromRedis(battleId);
      }
    }

    console.log(`✓ 已恢复 ${recoveredCount} 场战斗`);
  } catch (error) {
    console.error('恢复战斗失败:', error);
  }
  return recoveredCount;
}

export interface BattleResult {
  success: boolean;
  message: string;
  data?: any;
}

function uniqueStringIds(ids: string[]): string[] {
  return [...new Set(ids.filter((x) => typeof x === 'string' && x.length > 0))];
}

function patchBattleUpdatePayload(battleId: string, payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  const kind = String((payload as any).kind || '');

  if (kind === 'battle_started') {
    const state = (payload as any).state as any;
    const logsLen = Array.isArray(state?.logs) ? state.logs.length : 0;
    battleLastEmittedLogLen.set(battleId, logsLen);
    return payload;
  }

  if (kind === 'battle_finished' || kind === 'battle_abandoned') {
    battleLastEmittedLogLen.delete(battleId);
    return payload;
  }

  if (kind !== 'battle_state') return payload;

  const state = (payload as any).state as any;
  if (!state || typeof state !== 'object') return payload;

  const logs = Array.isArray(state.logs) ? state.logs : [];
  const currentLen = logs.length;
  const prevLenRaw = battleLastEmittedLogLen.get(battleId);
  const prevLen = typeof prevLenRaw === 'number' && prevLenRaw >= 0 ? prevLenRaw : 0;
  const startIndex = currentLen >= prevLen ? prevLen : 0;
  const deltaLogs = logs.slice(startIndex);

  battleLastEmittedLogLen.set(battleId, currentLen);

  if (deltaLogs.length > MAX_BATTLE_LOG_DELTA) {
    return { ...(payload as any), logStart: 0, logDelta: false };
  }

  const patchedState: BattleState = { ...(state as BattleState), logs: deltaLogs } as BattleState;
  return { ...(payload as any), state: patchedState, logStart: startIndex, logDelta: true };
}

function randomIntInclusive(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}

function withBattleStartResources<T extends { qixue?: number; max_qixue?: number; lingqi?: number; max_lingqi?: number }>(data: T): T {
  const maxQixue = Number(data.max_qixue ?? 0);
  const maxLingqi = Number(data.max_lingqi ?? 0);
  const currentLingqiRaw = Number(data.lingqi ?? 0);
  const currentLingqi = Number.isFinite(currentLingqiRaw) ? currentLingqiRaw : 0;
  const targetLingqi = maxLingqi > 0 ? Math.max(0, Math.floor(maxLingqi * 0.5)) : currentLingqi;
  return {
    ...data,
    qixue: maxQixue > 0 ? maxQixue : Number(data.qixue ?? 0),
    lingqi: currentLingqi < targetLingqi ? targetLingqi : currentLingqi,
  };
}

async function restoreBattleStartResourcesInDb(userIds: number[]): Promise<void> {
  const uniqUserIds = [...new Set(userIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (uniqUserIds.length === 0) return;
  await query(
    `
      UPDATE characters
      SET
        qixue = max_qixue,
        lingqi = GREATEST(COALESCE(lingqi, 0), FLOOR(COALESCE(max_lingqi, 0) * 0.5)),
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ANY($1)
    `,
    [uniqUserIds]
  );
}

async function applyTechniquePassivesToCharacterData<T extends Record<string, any>>(
  characterId: number,
  base: T
): Promise<T> {
  if (!Number.isFinite(characterId) || characterId <= 0) return base;
  try {
    const passiveRes = await calculateTechniquePassives(characterId);
    if (!passiveRes.success || !passiveRes.data) return base;
    const passives = passiveRes.data;
    const keys = Object.keys(passives);
    if (keys.length === 0) return base;

    const merged: any = { ...base };
    const permyriadAdditiveKeys = new Set([
      'mingzhong',
      'shanbi',
      'zhaojia',
      'baoji',
      'baoshang',
      'kangbao',
      'zengshang',
      'zhiliao',
      'jianliao',
      'xixue',
      'lengque',
      'kongzhi_kangxing',
      'jin_kangxing',
      'mu_kangxing',
      'shui_kangxing',
      'huo_kangxing',
      'tu_kangxing',
      'qixue_huifu',
      'lingqi_huifu',
      'shuxing_shuzhi',
    ]);
    const percentMultiplyKeys = new Set(['wugong', 'fagong', 'wufang', 'fafang', 'max_qixue']);
    const scaledHundredAddKeys = new Set(['sudu', 'max_lingqi']);

    for (const key of keys) {
      const value = passives[key];
      if (typeof value !== 'number') continue;
      if (!(key in merged)) continue;
      const baseValue = typeof merged[key] === 'number' ? (merged[key] as number) : undefined;
      if (baseValue == null) continue;
      if (permyriadAdditiveKeys.has(key)) {
        merged[key] = baseValue + value;
        continue;
      }
      if (percentMultiplyKeys.has(key)) {
        merged[key] = Math.floor((baseValue * (10000 + value)) / 10000);
        continue;
      }
      if (scaledHundredAddKeys.has(key)) {
        merged[key] = baseValue + value / 100;
        continue;
      }
      merged[key] = baseValue + value;
    }

    return merged as T;
  } catch {
    return base;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function getCharacterBattleSetBonusEffects(characterId: number): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      WITH set_counts AS (
        SELECT id.set_id, COUNT(*)::int AS equipped_count
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.owner_character_id = $1
          AND ii.location = 'equipped'
          AND id.set_id IS NOT NULL
        GROUP BY id.set_id
      )
      SELECT sc.set_id, s.name AS set_name, b.piece_count, b.effect_defs
      FROM set_counts sc
      JOIN item_set s ON s.id = sc.set_id
      JOIN item_set_bonus b ON b.set_id = sc.set_id
      WHERE sc.equipped_count >= b.piece_count
      ORDER BY b.priority ASC, b.piece_count ASC
    `,
    [characterId]
  );

  const out: BattleSetBonusEffect[] = [];
  for (const row of result.rows) {
    const setId = toText((row as any).set_id);
    const setName = toText((row as any).set_name) || setId;
    const pieceCount = Math.max(1, Math.floor(toNumber((row as any).piece_count) ?? 1));
    const effectDefs = Array.isArray((row as any).effect_defs) ? (row as any).effect_defs as unknown[] : [];

    for (const raw of effectDefs) {
      const effectRow = toRecord(raw);
      const trigger = toText(effectRow.trigger);
      const effectType = toText(effectRow.effect_type);
      if (!BATTLE_SET_BONUS_TRIGGER_SET.has(trigger)) continue;
      if (!BATTLE_SET_BONUS_EFFECT_TYPE_SET.has(effectType)) continue;

      const targetRaw = toText(effectRow.target);
      const target = targetRaw === 'enemy' ? 'enemy' : 'self';
      const params = toRecord(effectRow.params);
      const duration = toNumber(effectRow.duration_round);
      const element = toText(effectRow.element);

      out.push({
        setId,
        setName,
        pieceCount,
        trigger: trigger as BattleSetBonusEffect['trigger'],
        target,
        effectType: effectType as BattleSetBonusEffect['effectType'],
        durationRound: duration === null ? undefined : Math.max(1, Math.floor(duration)),
        element: element || undefined,
        params,
      });
    }
  }

  return out;
}

async function attachSetBonusEffectsToCharacterData<T extends CharacterData>(
  characterId: number,
  data: T
): Promise<T> {
  try {
    const setBonusEffects = await getCharacterBattleSetBonusEffects(characterId);
    if (setBonusEffects.length === 0) return data;
    return {
      ...data,
      setBonusEffects,
    };
  } catch {
    return data;
  }
}

async function getCharacterBattleSkillData(characterId: number): Promise<SkillData[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const battleSkillsRes = await getBattleSkills(characterId);
  if (!battleSkillsRes.success || !battleSkillsRes.data) return [];

  const orderedSkillIds = battleSkillsRes.data
    .map((s) => String(s?.skillId ?? '').trim())
    .filter((x) => x.length > 0);

  if (orderedSkillIds.length === 0) return [];

  const uniqIds = uniqueStringIds(orderedSkillIds);
  const skillResult = await query(
    `
      SELECT
        id, name,
        cost_lingqi, cost_qixue, cooldown,
        target_type, target_count,
        damage_type, element,
        coefficient, fixed_damage,
        effects, ai_priority
      FROM skill_def
      WHERE enabled = true AND id = ANY($1)
    `,
    [uniqIds]
  );

  const byId = new Map<string, any>();
  for (const row of skillResult.rows) {
    const id = String((row as any)?.id ?? '').trim();
    if (id) byId.set(id, row);
  }

  const skills: SkillData[] = [];
  for (const skillId of orderedSkillIds) {
    const row = byId.get(skillId);
    if (!row) continue;
    skills.push({
      id: String(row.id),
      name: String(row.name || row.id),
      cost_lingqi: Number(row.cost_lingqi) || 0,
      cost_qixue: Number(row.cost_qixue) || 0,
      cooldown: Number(row.cooldown) || 0,
      target_type: String(row.target_type || 'single_enemy'),
      target_count: Math.max(1, Math.floor(Number(row.target_count) || 1)),
      damage_type: String(row.damage_type || 'none'),
      element: String(row.element || 'none'),
      coefficient: Number(row.coefficient) || 0,
      fixed_damage: Number(row.fixed_damage) || 0,
      effects: Array.isArray(row.effects) ? row.effects : (row.effects ?? []),
      ai_priority: Number(row.ai_priority) || 50,
    });
  }

  return skills;
}

async function getBattleMonsters(engine: BattleEngine): Promise<MonsterData[]> {
  const state = engine.getState();
  if (state.battleType !== 'pve') return [];
  const orderedIds = state.teams.defender.units
    .filter((u) => u.type === 'monster')
    .map((u) => String(u.sourceId))
    .filter(Boolean);
  if (orderedIds.length === 0) return [];
  const uniqIds = [...new Set(orderedIds)];
  const res = await query('SELECT * FROM monster_def WHERE enabled = true AND id = ANY($1)', [uniqIds]);
  const defs = res.rows as MonsterData[];
  const defMap = new Map(defs.map((m) => [m.id, m] as const));
  const monsters: MonsterData[] = [];
  for (const id of orderedIds) {
    const def = defMap.get(id);
    if (def) monsters.push(def);
  }
  return monsters;
}

async function getCharacterAutoCastSkillsEnabled(characterId: number): Promise<boolean> {
  if (!Number.isFinite(characterId) || characterId <= 0) return false;
  const cached = characterAutoCastCache.get(characterId);
  const now = Date.now();
  if (cached && now - cached.at <= CHARACTER_AUTO_CAST_CACHE_TTL_MS) return cached.enabled;

  try {
    const res = await query('SELECT auto_cast_skills FROM characters WHERE id = $1', [characterId]);
    const enabled = Boolean(res.rows?.[0]?.auto_cast_skills);
    characterAutoCastCache.set(characterId, { enabled, at: now });
    return enabled;
  } catch {
    characterAutoCastCache.set(characterId, { enabled: false, at: now });
    return false;
  }
}

async function getUserIdByCharacterId(characterId: number): Promise<number | null> {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  const cached = characterOwnerCache.get(characterId);
  const now = Date.now();
  if (cached && now - cached.at <= CHARACTER_OWNER_CACHE_TTL_MS) return cached.userId;

  try {
    const res = await query('SELECT user_id FROM characters WHERE id = $1', [characterId]);
    const userId = Number(res.rows?.[0]?.user_id);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    characterOwnerCache.set(characterId, { userId, at: now });
    return userId;
  } catch {
    return null;
  }
}

function emitBattleUpdate(battleId: string, payload: any): void {
  try {
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) return;
    const gameServer = getGameServer();
    const patched = patchBattleUpdatePayload(battleId, payload);
    for (const userId of participants) {
      if (!Number.isFinite(userId)) continue;
      gameServer.emitToUser(userId, 'battle:update', patched);
    }
    // 保存战斗状态到 Redis（异步，不阻塞）
    const engine = activeBattles.get(battleId);
    if (engine) {
      void saveBattleToRedis(battleId, engine, participants);
    }
  } catch {
    // 忽略
  }
}

async function tickBattle(battleId: string): Promise<void> {
  if (battleTickLocks.has(battleId)) return;
  battleTickLocks.add(battleId);
  try {
    const engine = activeBattles.get(battleId);
    if (!engine) {
      stopBattleTicker(battleId);
      return;
    }

    const state = engine.getState();
    if (state.phase === 'finished') {
      const monsters = await getBattleMonsters(engine);
      await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return;
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) return;

    if (currentUnit.type === 'player') {
      if (state.currentTeam !== 'attacker') {
        if (state.battleType === 'pvp' && state.currentTeam === 'defender') {
          engine.aiAction(true);
          emitBattleUpdate(battleId, { kind: 'battle_state', battleId, state: engine.getState() });
        }
        return;
      }
      const characterId = Number(currentUnit.sourceId);
      const ownerUserId = await getUserIdByCharacterId(characterId);
      const participants = battleParticipants.get(battleId) || [];
      if (ownerUserId && !participants.includes(ownerUserId)) {
        engine.aiAction(true);
        emitBattleUpdate(battleId, { kind: 'battle_state', battleId, state: engine.getState() });
        return;
      }
      const autoEnabled = await getCharacterAutoCastSkillsEnabled(characterId);
      if (!autoEnabled) return;
      engine.aiAction(true);
      emitBattleUpdate(battleId, { kind: 'battle_state', battleId, state: engine.getState() });
      return;
    }

    engine.aiAction();
    emitBattleUpdate(battleId, { kind: 'battle_state', battleId, state: engine.getState() });
  } finally {
    battleTickLocks.delete(battleId);
  }
}

function startBattleTicker(battleId: string): void {
  if (battleTickers.has(battleId)) return;
  const timer = setInterval(() => {
    void tickBattle(battleId);
  }, BATTLE_TICK_MS);
  battleTickers.set(battleId, timer);
  void tickBattle(battleId);
}

function stopBattleTicker(battleId: string): void {
  const t = battleTickers.get(battleId);
  if (t) clearInterval(t);
  battleTickers.delete(battleId);
  battleTickLocks.delete(battleId);
  battleLastEmittedLogLen.delete(battleId);
}

/**
 * 获取角色所在队伍的所有成员数据
 */
async function getTeamMembersData(userId: number, characterId: number): Promise<{
  isInTeam: boolean;
  isLeader: boolean;
  teamId: string | null;
  members: Array<{ data: CharacterData; skills: SkillData[] }>;
}> {
  // 查询角色是否在队伍中
  const memberResult = await query(
    `SELECT tm.team_id, tm.role FROM team_members tm 
     JOIN characters c ON tm.character_id = c.id 
     WHERE c.user_id = $1`,
    [userId]
  );

  if (memberResult.rows.length === 0) {
    return { isInTeam: false, isLeader: false, teamId: null, members: [] };
  }

  const { team_id: teamId, role } = memberResult.rows[0];
  const isLeader = role === 'leader';

  // 获取队伍中其他成员的数据（排除自己）
  const teamMembersResult = await query(
    `SELECT c.* FROM team_members tm
     JOIN characters c ON tm.character_id = c.id
     WHERE tm.team_id = $1 AND c.id != $2
     ORDER BY tm.role DESC, tm.joined_at ASC`,
    [teamId, characterId]
  );

  const members: Array<{ data: CharacterData; skills: SkillData[] }> = [];
  
  for (const row of teamMembersResult.rows) {
    const base = row as CharacterData;
    const memberCharacterId = Number((row as any)?.id);
    const withPassives = await applyTechniquePassivesToCharacterData(memberCharacterId, base);
    const data = await attachSetBonusEffectsToCharacterData(memberCharacterId, withPassives);
    const skills = await getCharacterBattleSkillData(memberCharacterId);
    members.push({
      data,
      skills,
    });
  }

  return { isInTeam: true, isLeader, teamId, members };
}

/**
 * 发起PVE战斗（支持组队）
 */
export async function startPVEBattle(
  userId: number,
  monsterIds: string[]
): Promise<BattleResult> {
  try {
    const charResult = await query(
      'SELECT * FROM characters WHERE user_id = $1',
      [userId]
    );
    
    if (charResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }
    
    const charRow = charResult.rows[0] as any;
    const characterId = Number(charRow.id);
    const characterBase = charRow as CharacterData & {
      current_map_id?: string;
      current_room_id?: string;
    };
    const characterWithPassives = await applyTechniquePassivesToCharacterData(characterId, characterBase);
    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(characterId, characterWithPassives);
    
    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: '气血不足，无法战斗' };
    }
    if (isCharacterInBattle(characterId)) {
      return { success: false, message: '角色正在战斗中' };
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterIds.filter((x) => typeof x === 'string' && x.length > 0);
    const selectedMonsterId = requestedMonsterIds[0];
    if (!selectedMonsterId) {
      return { success: false, message: '请指定战斗目标' };
    }

    const mapId = character.current_map_id || '';
    const roomId = character.current_room_id || '';
    if (!mapId || !roomId) {
      return { success: false, message: '角色位置异常，无法战斗' };
    }

    const room = await getRoomInMap(mapId, roomId);
    if (!room) {
      return { success: false, message: '当前房间不存在，无法战斗' };
    }

    const roomMonsterIds = uniqueStringIds(
      (Array.isArray(room.monsters) ? room.monsters : [])
        .map((m) => m?.monster_def_id)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
    );
    const roomMonsterIdSet = new Set(roomMonsterIds);

    for (const id of requestedMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        return { success: false, message: '战斗目标不在当前房间' };
      }
    }

    const playerSkills = await getCharacterBattleSkillData(characterId);

    // 检查是否在队伍中，获取队友数据
    const teamInfo = await getTeamMembersData(userId, character.id);
    if (teamInfo.isInTeam && !teamInfo.isLeader) {
      return { success: false, message: '组队中只有队长可以发起战斗' };
    }
    
    // 如果在队伍中，检查队友状态
    const validTeamMembers: Array<{ data: CharacterData; skills: SkillData[] }> = [];
    const participantUserIds: number[] = [userId];
    
    if (teamInfo.isInTeam && teamInfo.members.length > 0) {
      for (const member of teamInfo.members) {
        const memberCharacterId = Number((member.data as any)?.id);
        if (Number.isFinite(memberCharacterId) && memberCharacterId > 0 && isCharacterInBattle(memberCharacterId)) {
          continue;
        }
        // 检查队友气血
        if (member.data.qixue > 0) {
          validTeamMembers.push({ ...member, data: withBattleStartResources(member.data) });
          participantUserIds.push(member.data.user_id);
        }
      }
    }

    try {
      await restoreBattleStartResourcesInDb(participantUserIds);
      const gameServer = getGameServer();
      for (const uid of participantUserIds) {
        if (!Number.isFinite(uid) || uid <= 0) continue;
        void gameServer.pushCharacterUpdate(uid);
      }
    } catch {}

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = playerCount > 1 ? Math.min(playerCount, 5) : 2;

    let finalMonsterIds: string[] = [];
    if (playerCount <= 1) {
      const desired = randomIntInclusive(1, 2);
      finalMonsterIds = Array.from({ length: desired }, () => selectedMonsterId);
    } else {
      finalMonsterIds = Array.from({ length: maxMonsters }, () => selectedMonsterId);
    }

    for (const id of finalMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        return { success: false, message: '战斗目标不在当前房间' };
      }
    }

    const monsterResult = await query(
      'SELECT * FROM monster_def WHERE enabled = true AND id = ANY($1)',
      [uniqueStringIds(finalMonsterIds)]
    );

    if (monsterResult.rows.length === 0) {
      return { success: false, message: '怪物不存在' };
    }

    const monsterDefs = monsterResult.rows as MonsterData[];
    const monsterDefMap = new Map(monsterDefs.map((m) => [m.id, m] as const));
    const monsters: MonsterData[] = [];
    for (const id of finalMonsterIds) {
      const def = monsterDefMap.get(id);
      if (!def) {
        return { success: false, message: '怪物不存在' };
      }
      monsters.push(def);
    }

    const monsterSkillsMap: Record<string, SkillData[]> = {};
    for (const monster of monsters) {
      monsterSkillsMap[monster.id] = [];
    }
    
    // 生成战斗ID
    const battleId = `battle-${userId}-${Date.now()}`;
    
    // 创建战斗状态（传入队友数据）
    const battleState = createPVEBattle(
      battleId,
      character,
      playerSkills,
      monsters,
      monsterSkillsMap,
      validTeamMembers.length > 0 ? validTeamMembers : undefined
    );
    
    // 创建战斗引擎
    const engine = new BattleEngine(battleState);
    
    // 开始战斗
    engine.startBattle();

    // 缓存战斗
    activeBattles.set(battleId, engine);
    // 记录战斗参与者
    battleParticipants.set(battleId, participantUserIds);
    startBattleTicker(battleId);
    emitBattleUpdate(battleId, { kind: 'battle_started', battleId, state: engine.getState() });
    
    return {
      success: true,
      message: playerCount > 1 ? `组队战斗开始（${playerCount}人）` : '战斗开始',
      data: {
        battleId,
        state: engine.getState(),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
      },
    };
  } catch (error) {
    console.error('发起战斗失败:', error);
    return { success: false, message: '发起战斗失败' };
  }
}

/**
 * 玩家行动
 */
export async function playerAction(
  userId: number,
  battleId: string,
  skillId: string,
  targetIds: string[]
): Promise<BattleResult> {
  try {
    const engine = activeBattles.get(battleId);
    
    if (!engine) {
      return { success: false, message: '战斗不存在或已结束' };
    }
    
    const state = engine.getState();
    
    // 验证是否是该战斗的参与者
    const participants = battleParticipants.get(battleId) || [];
    if (!participants.includes(userId) && state.teams.attacker.odwnerId !== userId) {
      return { success: false, message: '无权操作此战斗' };
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      return { success: false, message: '没有当前行动单位' };
    }
    if (currentUnit.type !== 'player' || state.currentTeam !== 'attacker') {
      return { success: false, message: '当前不是玩家行动回合' };
    }
    const characterId = Number(currentUnit.sourceId);
    const ownerUserId = await getUserIdByCharacterId(characterId);
    if (!ownerUserId) {
      return { success: false, message: '角色归属异常，无法行动' };
    }
    const allowedUserIds = participants.length > 0
      ? participants
      : (Number.isFinite(state.teams.attacker.odwnerId) ? [state.teams.attacker.odwnerId as number] : []);
    if (!allowedUserIds.includes(ownerUserId)) {
      return { success: false, message: '无权操作此战斗' };
    }
    
    // 执行玩家行动
    const result = engine.playerAction(userId, skillId, targetIds);
    
    if (!result.success) {
      return { success: false, message: result.error || '行动失败' };
    }
    emitBattleUpdate(battleId, { kind: 'battle_state', battleId, state: engine.getState() });
    
    // 检查战斗是否结束
    const currentState = engine.getState();
    if (currentState.phase === 'finished') {
      const monsters = await getBattleMonsters(engine);
      const battleResult = await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return battleResult;
    }
    
    return {
      success: true,
      message: '行动成功',
      data: {
        state: currentState,
      },
    };
  } catch (error) {
    console.error('玩家行动失败:', error);
    return { success: false, message: '行动失败' };
  }
}

export async function startDungeonPVEBattle(userId: number, monsterDefIds: string[]): Promise<BattleResult> {
  try {
    const charResult = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    if (charResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const baseCharacter = charResult.rows[0] as CharacterData;
    const characterId = Number((baseCharacter as any)?.id);
    const characterWithPassives = await applyTechniquePassivesToCharacterData(characterId, baseCharacter);
    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(characterId, characterWithPassives);
    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: '气血不足，无法战斗' };
    }
    if (isCharacterInBattle(characterId)) {
      return { success: false, message: '角色正在战斗中' };
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterDefIds.filter((x) => typeof x === 'string' && x.length > 0);
    if (requestedMonsterIds.length === 0) {
      return { success: false, message: '请指定战斗目标' };
    }

    const playerSkills = await getCharacterBattleSkillData(characterId);

    const teamInfo = await getTeamMembersData(userId, character.id);
    if (teamInfo.isInTeam && !teamInfo.isLeader) {
      return { success: false, message: '组队中只有队长可以发起战斗' };
    }

    const validTeamMembers: Array<{ data: CharacterData; skills: SkillData[] }> = [];
    const participantUserIds: number[] = [userId];
    if (teamInfo.isInTeam && teamInfo.members.length > 0) {
      for (const member of teamInfo.members) {
        const memberCharacterId = Number((member.data as any)?.id);
        if (Number.isFinite(memberCharacterId) && memberCharacterId > 0 && isCharacterInBattle(memberCharacterId)) {
          continue;
        }
        if (member.data.qixue > 0) {
          validTeamMembers.push({ ...member, data: withBattleStartResources(member.data) });
          participantUserIds.push(member.data.user_id);
        }
      }
    }

    try {
      await restoreBattleStartResourcesInDb(participantUserIds);
      const gameServer = getGameServer();
      for (const uid of participantUserIds) {
        if (!Number.isFinite(uid) || uid <= 0) continue;
        void gameServer.pushCharacterUpdate(uid);
      }
    } catch {}

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = Math.min(5, Math.max(1, playerCount > 1 ? playerCount : 3));
    const finalMonsterIds = requestedMonsterIds.slice(0, maxMonsters);

    const uniqIds = uniqueStringIds(finalMonsterIds);
    const monsterResult = await query('SELECT * FROM monster_def WHERE enabled = true AND id = ANY($1)', [uniqIds]);
    if (monsterResult.rows.length === 0) {
      return { success: false, message: '怪物不存在' };
    }
    const monsterDefs = monsterResult.rows as MonsterData[];
    const monsterDefMap = new Map(monsterDefs.map((m) => [m.id, m] as const));
    const monsters: MonsterData[] = [];
    for (const id of finalMonsterIds) {
      const def = monsterDefMap.get(id);
      if (!def) {
        return { success: false, message: '怪物不存在' };
      }
      monsters.push(def);
    }

    const monsterSkillsMap: Record<string, SkillData[]> = {};
    for (const monster of monsters) {
      monsterSkillsMap[monster.id] = [];
    }

    const battleId = `dungeon-battle-${userId}-${Date.now()}`;
    const battleState = createPVEBattle(
      battleId,
      character,
      playerSkills,
      monsters,
      monsterSkillsMap,
      validTeamMembers.length > 0 ? validTeamMembers : undefined
    );

    const engine = new BattleEngine(battleState);
    engine.startBattle();
    activeBattles.set(battleId, engine);
    battleParticipants.set(battleId, participantUserIds);
    startBattleTicker(battleId);

    emitBattleUpdate(battleId, { kind: 'battle_started', battleId, state: engine.getState() });

    return {
      success: true,
      message: '战斗开始',
      data: {
        battleId,
        state: engine.getState(),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
      },
    };
  } catch (error) {
    console.error('发起秘境战斗失败:', error);
    return { success: false, message: '发起秘境战斗失败' };
  }
}

export async function startPVPBattle(
  userId: number,
  opponentCharacterId: number,
  battleId?: string
): Promise<BattleResult> {
  try {
    const charResult = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    if (charResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const challengerBase = charResult.rows[0] as CharacterData;
    const challengerCharacterId = Number((challengerBase as any)?.id);
    if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) {
      return { success: false, message: '角色数据异常' };
    }

    const oppId = Number(opponentCharacterId);
    if (!Number.isFinite(oppId) || oppId <= 0) {
      return { success: false, message: '对手参数错误' };
    }

    const oppRes = await query('SELECT * FROM characters WHERE id = $1 LIMIT 1', [oppId]);
    if (oppRes.rows.length === 0) {
      return { success: false, message: '对手不存在' };
    }

    const opponentBase = oppRes.rows[0] as CharacterData;
    const opponentUserId = Number((opponentBase as any)?.user_id);
    if (!Number.isFinite(opponentUserId) || opponentUserId <= 0) {
      return { success: false, message: '对手数据异常' };
    }

    const requestedBattleId = typeof battleId === 'string' ? battleId.trim() : '';
    const isArenaBattle = requestedBattleId.startsWith('arena-battle-');

    if (isCharacterInBattle(challengerCharacterId) || (!isArenaBattle && isCharacterInBattle(oppId))) {
      return { success: false, message: '角色正在战斗中' };
    }

    const challengerWithPassives = await applyTechniquePassivesToCharacterData(challengerCharacterId, challengerBase);
    const opponentWithPassives = await applyTechniquePassivesToCharacterData(oppId, opponentBase);
    const challenger = await attachSetBonusEffectsToCharacterData(challengerCharacterId, challengerWithPassives);
    const opponent = await attachSetBonusEffectsToCharacterData(oppId, opponentWithPassives);
    const recoveredChallenger = withBattleStartResources(challenger);
    const recoveredOpponent = withBattleStartResources(opponent);

    const challengerSkills = await getCharacterBattleSkillData(challengerCharacterId);
    const opponentSkills = await getCharacterBattleSkillData(oppId);

    try {
      await restoreBattleStartResourcesInDb(isArenaBattle ? [userId] : [userId, opponentUserId]);
      const gameServer = getGameServer();
      if (Number.isFinite(userId) && userId > 0) void gameServer.pushCharacterUpdate(userId);
      if (!isArenaBattle && Number.isFinite(opponentUserId) && opponentUserId > 0) void gameServer.pushCharacterUpdate(opponentUserId);
    } catch {}

    const finalBattleId = requestedBattleId ? requestedBattleId : `pvp-battle-${userId}-${Date.now()}`;
    const battleState = createPVPBattle(
      finalBattleId,
      recoveredChallenger,
      challengerSkills,
      recoveredOpponent,
      opponentSkills,
      isArenaBattle ? { defenderUnitType: 'npc' } : undefined
    );

    const engine = new BattleEngine(battleState);
    engine.startBattle();
    activeBattles.set(finalBattleId, engine);
    battleParticipants.set(finalBattleId, isArenaBattle ? [userId] : [userId, opponentUserId]);
    startBattleTicker(finalBattleId);

    emitBattleUpdate(finalBattleId, { kind: 'battle_started', battleId: finalBattleId, state: engine.getState() });

    return {
      success: true,
      message: '战斗开始',
      data: {
        battleId: finalBattleId,
        state: engine.getState(),
      },
    };
  } catch (error) {
    console.error('发起PVP战斗失败:', error);
    return { success: false, message: '发起PVP战斗失败' };
  }
}

/**
 * 自动战斗（快速结算）
 */
export async function autoBattle(
  userId: number,
  monsterIds: string[]
): Promise<BattleResult> {
  try {
    // 发起战斗
    const startResult = await startPVEBattle(userId, monsterIds);
    
    if (!startResult.success) {
      return startResult;
    }
    
    const battleId = startResult.data.battleId;
    const engine = activeBattles.get(battleId);
    
    if (!engine) {
      return { success: false, message: '战斗创建失败' };
    }

    const participants = battleParticipants.get(battleId) || [];
    if (participants.length > 1) {
      activeBattles.delete(battleId);
      battleParticipants.delete(battleId);
      stopBattleTicker(battleId);
      return { success: false, message: '组队中不支持快速战斗' };
    }
    
    stopBattleTicker(battleId);
    // 自动执行战斗
    engine.autoExecute();
    
    const monsters = await getBattleMonsters(engine);
    
    // 结算战斗
    return await finishBattle(battleId, engine, monsters);
  } catch (error) {
    console.error('自动战斗失败:', error);
    return { success: false, message: '自动战斗失败' };
  }
}

/**
 * 结束战斗并结算奖励（支持组队分配）
 */
async function settleArenaBattleIfNeeded(
  battleId: string,
  battleResult: 'attacker_win' | 'defender_win' | 'draw'
): Promise<void> {
  const res = await query(
    `SELECT challenger_character_id, opponent_character_id, status FROM arena_battle WHERE battle_id = $1 LIMIT 1`,
    [battleId]
  );
  if (res.rows.length === 0) return;

  const row = res.rows[0] as any;
  if (String(row.status ?? '') === 'finished') return;

  const challengerCharacterId = Number(row.challenger_character_id);
  const opponentCharacterId = Number(row.opponent_character_id);
  if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) return;
  if (!Number.isFinite(opponentCharacterId) || opponentCharacterId <= 0) return;

  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, 1000) ON CONFLICT (character_id) DO NOTHING`,
    [challengerCharacterId]
  );
  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, 1000) ON CONFLICT (character_id) DO NOTHING`,
    [opponentCharacterId]
  );

  const challengerRatingRes = await query(`SELECT rating FROM arena_rating WHERE character_id = $1`, [challengerCharacterId]);
  const opponentRatingRes = await query(`SELECT rating FROM arena_rating WHERE character_id = $1`, [opponentCharacterId]);
  const challengerBefore = Number(challengerRatingRes.rows?.[0]?.rating ?? 1000) || 1000;
  const opponentBefore = Number(opponentRatingRes.rows?.[0]?.rating ?? 1000) || 1000;

  const challengerOutcome = battleResult === 'attacker_win' ? 'win' : battleResult === 'defender_win' ? 'lose' : 'draw';
  const challengerDelta = challengerOutcome === 'win' ? 10 : challengerOutcome === 'lose' ? -5 : 0;
  const challengerAfter = Math.max(0, challengerBefore + challengerDelta);

  const opponentOutcome = challengerOutcome === 'win' ? 'lose' : challengerOutcome === 'lose' ? 'win' : 'draw';
  const opponentDelta = opponentOutcome === 'win' ? 10 : opponentOutcome === 'lose' ? -5 : 0;
  const opponentAfter = Math.max(0, opponentBefore + opponentDelta);

  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [challengerCharacterId, challengerAfter, challengerOutcome === 'win' ? 1 : 0, challengerOutcome === 'lose' ? 1 : 0]
  );
  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [opponentCharacterId, opponentAfter, opponentOutcome === 'win' ? 1 : 0, opponentOutcome === 'lose' ? 1 : 0]
  );

  await query(
    `
      UPDATE arena_battle
      SET
        status = 'finished',
        result = $2,
        delta_score = $3,
        score_before = $4,
        score_after = $5,
        finished_at = NOW()
      WHERE battle_id = $1
        AND status <> 'finished'
    `,
    [battleId, challengerOutcome, challengerDelta, challengerBefore, challengerAfter]
  );
}

async function finishBattle(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[]
): Promise<BattleResult> {
  const state = engine.getState();
  const result = engine.getResult();
  
  // 获取战斗参与者
  const participantUserIds = (battleParticipants.get(battleId) || []).slice();
  const participantCount = Math.max(1, participantUserIds.length);
  const isVictory = result.result === 'attacker_win';
  
  // 构建参与者信息
  const participants: BattleParticipant[] = [];
  for (const participantUserId of participantUserIds) {
    const charResult = await query(
      'SELECT id, nickname, fuyuan FROM characters WHERE user_id = $1',
      [participantUserId]
    );
    if (charResult.rows.length > 0) {
      participants.push({
        userId: participantUserId,
        characterId: charResult.rows[0].id,
        nickname: charResult.rows[0].nickname,
        fuyuan: Number(charResult.rows[0].fuyuan ?? 1),
      });
    }
  }
  
  // 使用掉落服务分发奖励
  let dropResult: DistributeResult | null = null;

  if (state.battleType === 'pve') {
    if (isVictory) {
      dropResult = await distributeBattleRewards(monsters, participants, true);

      for (const participantUserId of participantUserIds) {
        await query(
          `
            UPDATE characters
            SET qixue = LEAST(qixue + FLOOR(max_qixue * 0.3), max_qixue),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
          `,
          [participantUserId]
        );
      }

      try {
        const killCounts = new Map<string, number>();
        for (const m of monsters) {
          const id = String((m as any)?.id ?? '').trim();
          if (!id) continue;
          killCounts.set(id, (killCounts.get(id) ?? 0) + 1);
        }
        if (killCounts.size > 0) {
          for (const p of participants) {
            const characterId = Number(p.characterId);
            if (!Number.isFinite(characterId) || characterId <= 0) continue;
            for (const [monsterId, count] of killCounts.entries()) {
              await recordKillMonsterEvent(characterId, monsterId, count);
            }
          }
        }
      } catch {}
    } else if (result.result === 'defender_win') {
      for (const participantUserId of participantUserIds) {
        await query(
          `
            UPDATE characters
            SET qixue = GREATEST(1, qixue - FLOOR(max_qixue * 0.1)),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
          `,
          [participantUserId]
        );
      }
    }
  }
  
  // 构建奖励数据
  const rewardsData = dropResult ? {
    exp: dropResult.rewards.exp,
    silver: dropResult.rewards.silver,
    totalExp: dropResult.rewards.exp,
    totalSilver: dropResult.rewards.silver,
    participantCount,
    items: dropResult.rewards.items.map(item => ({
      itemDefId: item.itemDefId,
      name: item.itemName,
      quantity: item.quantity,
      receiverId: item.receiverId,
    })),
    perPlayerRewards: dropResult.perPlayerRewards,
  } : null;
  
  const battleResult: BattleResult = {
    success: true,
    message: result.result === 'attacker_win' ? '战斗胜利' : 
             result.result === 'defender_win' ? '战斗失败' : '战斗平局',
    data: {
      result: result.result,
      rounds: result.rounds,
      rewards: rewardsData,
      stats: result.stats,
      logs: result.logs,
      state,
      isTeamBattle: participantCount > 1,
    },
  };

  try {
    if (state.battleType === 'pvp') {
      await settleArenaBattleIfNeeded(battleId, result.result as 'attacker_win' | 'defender_win' | 'draw');
    }
  } catch (error) {
    console.warn('竞技场战斗结算失败:', error);
  }

  try {
    const gameServer = getGameServer();
    for (const participantUserId of participantUserIds) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(participantUserId, 'battle:update', { kind: 'battle_finished', battleId, ...battleResult });
      void gameServer.pushCharacterUpdate(participantUserId);
    }
    if (state.battleType === 'pvp') {
      for (const p of participants) {
        const characterId = Number(p.characterId);
        if (!Number.isFinite(characterId) || characterId <= 0) continue;
        const statusRes = await getArenaStatus(characterId);
        if (!statusRes.success || !statusRes.data) continue;
        gameServer.emitToUser(p.userId, 'arena:update', { kind: 'arena_status', status: statusRes.data });
      }
    }
  } catch {
    // 忽略
  }

  activeBattles.delete(state.battleId);
  battleParticipants.delete(state.battleId);
  stopBattleTicker(state.battleId);
  finishedBattleResults.set(state.battleId, { result: battleResult, at: Date.now() });
  // 从 Redis 删除战斗状态
  void removeBattleFromRedis(state.battleId);

  return battleResult;
}

/**
 * 获取战斗状态
 */
export async function getBattleState(battleId: string): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);
  
  if (!engine) {
    const cached = finishedBattleResults.get(battleId);
    if (cached && Date.now() - cached.at <= FINISHED_BATTLE_TTL_MS) {
      return cached.result;
    }
    return { success: false, message: '战斗不存在' };
  }

  const state = engine.getState();
  if (state.phase === 'finished') {
    const monsters = await getBattleMonsters(engine);
    return await finishBattle(battleId, engine, monsters);
  }
  
  return {
    success: true,
    message: '获取成功',
    data: {
      state,
    },
  };
}

/**
 * 放弃战斗
 */
export async function abandonBattle(
  userId: number,
  battleId: string
): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);
  
  if (!engine) {
    return { success: false, message: '战斗不存在' };
  }
  
  const state = engine.getState();
  const participants = (battleParticipants.get(battleId) || []).slice();
  
  if (participants.length > 1 && state.teams.attacker.odwnerId !== userId) {
    return { success: false, message: '组队战斗只有队长可以逃跑' };
  }
  if (participants.length <= 1 && !participants.includes(userId) && state.teams.attacker.odwnerId !== userId) {
    return { success: false, message: '无权操作此战斗' };
  }
  
  // 扣除所有参与者气血作为惩罚
  for (const participantUserId of participants) {
    await query(`
      UPDATE characters 
      SET 
        qixue = GREATEST(1, qixue - FLOOR(max_qixue * 0.1)),
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
    `, [participantUserId]);
  }

  try {
    if (state.battleType === 'pvp') {
      await settleArenaBattleIfNeeded(battleId, 'defender_win');
    }
  } catch (error) {
    console.warn('放弃战斗时竞技场结算失败:', error);
  }
  
  try {
    const gameServer = getGameServer();
    for (const participantUserId of participants) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(participantUserId, 'battle:update', { kind: 'battle_abandoned', battleId, success: true, message: '已放弃战斗' });
      void gameServer.pushCharacterUpdate(participantUserId);
      if (state.battleType === 'pvp') {
        const charRes = await query('SELECT id FROM characters WHERE user_id = $1', [participantUserId]);
        const characterId = Number(charRes.rows?.[0]?.id);
        if (Number.isFinite(characterId) && characterId > 0) {
          const statusRes = await getArenaStatus(characterId);
          if (statusRes.success && statusRes.data) {
            gameServer.emitToUser(participantUserId, 'arena:update', { kind: 'arena_status', status: statusRes.data });
          }
        }
      }
    }
  } catch {
    // 忽略
  }

  activeBattles.delete(battleId);
  battleParticipants.delete(battleId);
  stopBattleTicker(battleId);
  finishedBattleResults.set(battleId, { result: { success: true, message: '已放弃战斗' }, at: Date.now() });
  // 从 Redis 删除战斗状态
  void removeBattleFromRedis(battleId);
  return {
    success: true,
    message: '已放弃战斗',
  };
}

/**
 * 清理过期战斗
 */
export function cleanupExpiredBattles(): void {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30分钟
  
  for (const [battleId, engine] of activeBattles.entries()) {
    const state = engine.getState();
    const parts = String(battleId || '').split('-');
    let battleTime = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = Number(parts[i]);
      if (!Number.isFinite(n)) continue;
      if (n <= 0) continue;
      battleTime = Math.floor(n);
      break;
    }
    
    if (!Number.isFinite(battleTime) || battleTime <= 0) continue;
    if (now - battleTime > maxAge) {
      activeBattles.delete(battleId);
      battleParticipants.delete(battleId);
      stopBattleTicker(battleId);
      // 从 Redis 删除过期战斗
      void removeBattleFromRedis(battleId);
    }
  }

  for (const [battleId, cached] of finishedBattleResults.entries()) {
    if (now - cached.at > FINISHED_BATTLE_TTL_MS) {
      finishedBattleResults.delete(battleId);
    }
  }
}

// 定期清理过期战斗
setInterval(cleanupExpiredBattles, 5 * 60 * 1000);

/**
 * 检查角色是否在战斗中
 */
export function isCharacterInBattle(characterId: number): boolean {
  for (const [, engine] of activeBattles.entries()) {
    const state = engine.getState();
    for (const unit of state.teams.attacker.units) {
      if (unit.type === 'player' && Number(unit.sourceId) === characterId) return true;
    }
    for (const unit of state.teams.defender.units) {
      if (unit.type === 'player' && Number(unit.sourceId) === characterId) return true;
    }
  }
  return false;
}

function listActiveBattleIdsByUserId(userId: number): string[] {
  const ids: string[] = [];
  if (!Number.isFinite(userId) || userId <= 0) return ids;
  for (const [battleId, participants] of battleParticipants.entries()) {
    if (!Array.isArray(participants)) continue;
    if (participants.includes(userId)) ids.push(battleId);
  }
  return ids;
}

export async function onUserJoinTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = (state.teams?.attacker?.units ?? []).filter((u) => u.type === 'player').length;
    if (state.battleType !== 'pve') continue;
    if (playerCount > 1) continue;
    try {
      await abandonBattle(userId, battleId);
    } catch {
      // 忽略
    }
  }
}

export async function onUserLeaveTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = (state.teams?.attacker?.units ?? []).filter((u) => u.type === 'player').length;
    if (state.battleType !== 'pve') continue;
    if (playerCount <= 1) continue;
    const participants = battleParticipants.get(battleId) || [];
    const nextParticipants = participants.filter((id) => id !== userId);
    battleParticipants.set(battleId, nextParticipants);
    try {
      const gameServer = getGameServer();
      gameServer.emitToUser(userId, 'battle:update', { kind: 'battle_abandoned', battleId, success: true, message: '已离开队伍，退出队伍战斗' });
    } catch {
      // 忽略
    }
  }
}

export default {
  startPVEBattle,
  startDungeonPVEBattle,
  startPVPBattle,
  playerAction,
  autoBattle,
  getBattleState,
  abandonBattle,
  isCharacterInBattle,
  recoverBattlesFromRedis,
};
