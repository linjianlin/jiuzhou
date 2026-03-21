/**
 * 千层塔主服务。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理塔进度读写、开战恢复、会话创建、排行榜读取与塔专属结算补充。
 * 2. 做什么：把“算法生成楼层”与“BattleSession / battle runtime / 持久化表”连接起来，形成单一业务入口。
 * 3. 不做什么：不替代 battle session 通用生命周期，也不在这里实现普通 PVE / 秘境逻辑。
 *
 * 输入/输出：
 * - 输入：userId、battleId、session context、结算参与者等。
 * - 输出：overview/start/rank 响应，以及结算阶段需要的塔进度更新结果。
 *
 * 数据流/状态流：
 * - overview/start -> 读写 `character_tower_progress` -> 算法生成楼层 -> 创建 battle/session
 * - settlement/abandon/return_to_map -> 清理或推进同一条 progress run。
 *
 * 关键边界条件与坑点：
 * 1. 同一角色任一时刻只允许一条 tower run；所有进度更新都必须围绕 `character_tower_progress` 这张表做单一写入口。
 * 2. 塔结算只更新冲层进度与战后资源，不再额外发放塔专属奖励；overview 与 battle settlement 必须共享同一口径。
 */

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../config/database.js';
import type { BattleState } from '../../battle/types.js';
import { getBattleState } from '../battle/queries.js';
import type { BattleParticipant } from '../battleDropService.js';
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByCharacterId,
  getCharacterComputedByUserId,
  setCharacterResourcesByCharacterId,
} from '../characterComputedService.js';
import {
  createBattleSessionRecord,
  deleteBattleSessionRecord,
  listBattleSessionRecords,
  toBattleSessionSnapshot,
  updateBattleSessionRecord,
} from '../battleSession/runtime.js';
import type {
  BattleSessionRecord,
  BattleSessionSnapshot,
  TowerBattleSessionContext,
} from '../battleSession/types.js';
import { isCharacterInBattle } from '../battle/runtime/state.js';
import { TOWER_PVE_BATTLE_START_POLICY } from '../battle/shared/startPolicy.js';
import { startResolvedPVEBattleByPolicy } from '../battle/pve.js';
import { resolveOrderedMonsters } from '../battle/shared/monsters.js';
import { resolveTowerFloor } from './algorithm.js';
import { canReuseTowerSession, pickLatestActiveTowerSession } from './activeSession.js';
import {
  deleteTowerBattleRuntime,
  getTowerBattleRuntime,
  registerTowerBattleRuntime,
} from './runtime.js';
import type {
  TowerBattleRuntimeRecord,
  TowerFloorPreview,
  TowerOverviewDto,
  TowerProgressRecord,
  TowerRankRow,
} from './types.js';

type TowerProgressRow = {
  character_id: number | string;
  best_floor: number | string;
  next_floor: number | string;
  current_run_id: string | null;
  current_floor: number | string | null;
  current_battle_id: string | null;
  last_settled_floor: number | string;
  updated_at: string | Date;
  reached_at: string | Date | null;
};

type TowerRankQueryRow = {
  rank: number | string;
  character_id: number | string;
  name: string;
  realm: string;
  best_floor: number | string;
  reached_at: string | Date | null;
};

type TowerStartResponse =
  | {
      success: true;
      data: {
        session: BattleSessionSnapshot;
        state?: BattleState;
      };
    }
  | {
      success: false;
      message: string;
    };

const normalizeTowerProgressRow = (row: TowerProgressRow): TowerProgressRecord => {
  return {
    characterId: Number(row.character_id),
    bestFloor: Math.max(0, Number(row.best_floor) || 0),
    nextFloor: Math.max(1, Number(row.next_floor) || 1),
    currentRunId: row.current_run_id ? String(row.current_run_id) : null,
    currentFloor:
      row.current_floor == null
        ? null
        : Math.max(1, Number(row.current_floor) || 1),
    currentBattleId: row.current_battle_id ? String(row.current_battle_id) : null,
    lastSettledFloor: Math.max(0, Number(row.last_settled_floor) || 0),
    updatedAt: String(row.updated_at),
    reachedAt: row.reached_at ? String(row.reached_at) : null,
  };
};

const normalizeTowerRankRow = (row: TowerRankQueryRow): TowerRankRow => {
  return {
    rank: Number(row.rank),
    characterId: Number(row.character_id),
    name: String(row.name),
    realm: String(row.realm),
    bestFloor: Number(row.best_floor),
    reachedAt: row.reached_at ? String(row.reached_at) : null,
  };
};

const createTowerSessionRecord = (params: {
  ownerUserId: number;
  runId: string;
  floor: number;
  status: BattleSessionRecord['status'];
  currentBattleId: string | null;
  nextAction: BattleSessionRecord['nextAction'];
  canAdvance: boolean;
  lastResult: BattleSessionRecord['lastResult'];
}): BattleSessionRecord => {
  const context: TowerBattleSessionContext = {
    runId: params.runId,
    floor: params.floor,
  };

  return createBattleSessionRecord({
    sessionId: crypto.randomUUID(),
    type: 'tower',
    ownerUserId: params.ownerUserId,
    participantUserIds: [params.ownerUserId],
    currentBattleId: params.currentBattleId,
    status: params.status,
    nextAction: params.nextAction,
    canAdvance: params.canAdvance,
    lastResult: params.lastResult,
    context,
  });
};

const ensureTowerProgressRow = async (
  characterId: number,
  client?: PoolClient,
): Promise<void> => {
  const executor = client ?? null;
  if (executor) {
    await executor.query(
      `
        INSERT INTO character_tower_progress (
          character_id,
          best_floor,
          next_floor,
          current_run_id,
          current_floor,
          current_battle_id,
          last_settled_floor,
          reached_at,
          updated_at
        )
        VALUES ($1, 0, 1, NULL, NULL, NULL, 0, NULL, NOW())
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterId],
    );
    return;
  }

  await query(
    `
      INSERT INTO character_tower_progress (
        character_id,
        best_floor,
        next_floor,
        current_run_id,
        current_floor,
        current_battle_id,
        last_settled_floor,
        reached_at,
        updated_at
      )
      VALUES ($1, 0, 1, NULL, NULL, NULL, 0, NULL, NOW())
      ON CONFLICT (character_id) DO NOTHING
    `,
    [characterId],
  );
};

const loadTowerProgressByCharacterId = async (
  characterId: number,
): Promise<TowerProgressRecord> => {
  await ensureTowerProgressRow(characterId);
  const result = await query<TowerProgressRow>(
    `
      SELECT
        character_id,
        best_floor,
        next_floor,
        current_run_id,
        current_floor,
        current_battle_id,
        last_settled_floor,
        updated_at,
        reached_at
      FROM character_tower_progress
      WHERE character_id = $1
      LIMIT 1
    `,
    [characterId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`千层塔进度不存在: characterId=${characterId}`);
  }
  return normalizeTowerProgressRow(row);
};

const lockTowerProgressByCharacterId = async (
  characterId: number,
  client: PoolClient,
): Promise<TowerProgressRecord> => {
  await ensureTowerProgressRow(characterId, client);
  const result = await client.query<TowerProgressRow>(
    `
      SELECT
        character_id,
        best_floor,
        next_floor,
        current_run_id,
        current_floor,
        current_battle_id,
        last_settled_floor,
        updated_at,
        reached_at
      FROM character_tower_progress
      WHERE character_id = $1
      FOR UPDATE
    `,
    [characterId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`千层塔进度锁定失败: characterId=${characterId}`);
  }
  return normalizeTowerProgressRow(row);
};

const updateTowerProgressForRunStart = async (params: {
  client: PoolClient;
  characterId: number;
  runId: string;
  floor: number;
  battleId: string;
}): Promise<void> => {
  await params.client.query(
    `
      UPDATE character_tower_progress
      SET
        current_run_id = $2,
        current_floor = $3,
        current_battle_id = $4,
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [params.characterId, params.runId, params.floor, params.battleId],
  );
};

const clearTowerRunState = async (params: {
  client: PoolClient;
  characterId: number;
}): Promise<void> => {
  await params.client.query(
    `
      UPDATE character_tower_progress
      SET
        current_run_id = NULL,
        current_floor = NULL,
        current_battle_id = NULL,
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [params.characterId],
  );
};

const buildTowerOverviewDto = (params: {
  progress: TowerProgressRecord;
  activeSession: BattleSessionSnapshot | null;
  characterId: number;
}): TowerOverviewDto => {
  return {
    progress: {
      bestFloor: params.progress.bestFloor,
      nextFloor: params.progress.nextFloor,
      currentRunId: params.progress.currentRunId,
      currentFloor: params.progress.currentFloor,
      lastSettledFloor: params.progress.lastSettledFloor,
    },
    activeSession: params.activeSession,
    nextFloorPreview: resolveTowerFloor({
      characterId: params.characterId,
      floor: params.progress.nextFloor,
    }).preview,
  };
};

const assertTowerEntryAllowed = async (
  userId: number,
  options?: {
    skipInBattleCheck?: boolean;
  },
): Promise<{
  userId: number;
  characterId: number;
}> => {
  const computed = await getCharacterComputedByUserId(userId);
  if (!computed) {
    throw new Error('角色不存在');
  }
  const characterId = Number(computed.id);
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error('角色不存在');
  }

  const teamCheck = await query(
    `SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1`,
    [characterId],
  );
  if (teamCheck.rows.length > 0) {
    throw new Error('组队状态下无法进入千层塔');
  }

  const activeSession = listBattleSessionRecords()
    .filter((session) => session.ownerUserId === userId)
    .filter((session) => session.status === 'running' || session.status === 'waiting_transition')
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;

  if (activeSession && activeSession.type !== 'tower') {
    throw new Error('当前已有进行中的战斗');
  }

  if (!activeSession && !options?.skipInBattleCheck && isCharacterInBattle(characterId)) {
    throw new Error('角色正在战斗中');
  }

  return {
    userId,
    characterId,
  };
};

const createTowerBattleForFloor = async (params: {
  userId: number;
  characterId: number;
  runId: string;
  floor: number;
}): Promise<{ battleId: string; state: BattleState; runtime: TowerBattleRuntimeRecord }> => {
  const resolvedFloor = resolveTowerFloor({
    characterId: params.characterId,
    floor: params.floor,
  });
  const battleId = `tower-battle-${params.userId}-${Date.now()}`;
  const skillResolveResult = resolveOrderedMonsters(
    resolvedFloor.monsters.map((monster) => monster.id),
  );
  if (!skillResolveResult.success) {
    throw new Error(skillResolveResult.error);
  }
  const battleResult = await startResolvedPVEBattleByPolicy({
    userId: params.userId,
    battleId,
    monsters: resolvedFloor.monsters,
    monsterSkillsMap: skillResolveResult.monsterSkillsMap,
    startPolicy: TOWER_PVE_BATTLE_START_POLICY,
    allowTeamBattle: false,
    syncResourceContext: '同步战前资源（千层塔战斗）',
    startSuccessMessage: `第${params.floor}层挑战开始`,
    errorMessage: '发起千层塔战斗失败',
  });
  if (!battleResult.success || !battleResult.data?.state || !battleResult.data?.battleId) {
    throw new Error(battleResult.message || '发起千层塔战斗失败');
  }
  const runtime = registerTowerBattleRuntime({
    battleId,
    characterId: params.characterId,
    userId: params.userId,
    runId: params.runId,
    floor: params.floor,
    monsters: resolvedFloor.monsters,
    preview: resolvedFloor.preview,
  });
  return {
    battleId,
    state: battleResult.data.state as BattleState,
    runtime,
  };
};

const loadLiveBattleState = async (battleId: string | null): Promise<BattleState | null> => {
  if (!battleId) {
    return null;
  }
  const stateRes = await getBattleState(battleId);
  if (!stateRes.success || !stateRes.data?.state) {
    return null;
  }
  return stateRes.data.state as BattleState;
};

export const getTowerOverview = async (userId: number): Promise<{
  success: true;
  data: TowerOverviewDto;
} | {
  success: false;
  message: string;
}> => {
  try {
    const computed = await getCharacterComputedByUserId(userId);
    const characterId = Number(computed?.id);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return {
        success: false,
        message: '角色不存在',
      };
    }
    const progress = await loadTowerProgressByCharacterId(characterId);
    const activeSession = pickLatestActiveTowerSession(listBattleSessionRecords(), userId);
    const activeSessionState = activeSession
      ? await loadLiveBattleState(activeSession.currentBattleId)
      : null;
    const visibleActiveSession =
      activeSession && canReuseTowerSession(activeSession, activeSessionState)
        ? toBattleSessionSnapshot(activeSession)
        : null;

    return {
      success: true,
      data: buildTowerOverviewDto({
        progress,
        activeSession: visibleActiveSession,
        characterId,
      }),
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '获取千层塔概览失败',
    };
  }
};

export const startTowerChallenge = async (userId: number): Promise<TowerStartResponse> => {
  try {
    const access = await assertTowerEntryAllowed(userId, {
      skipInBattleCheck: true,
    });
    const existingTowerSession = pickLatestActiveTowerSession(listBattleSessionRecords(), userId);

    if (existingTowerSession) {
      const existingState = await loadLiveBattleState(existingTowerSession.currentBattleId);
      if (canReuseTowerSession(existingTowerSession, existingState)) {
        return {
          success: true,
          data: {
            session: toBattleSessionSnapshot(existingTowerSession),
            state: existingState,
          },
        };
      }
      deleteBattleSessionRecord(existingTowerSession.sessionId);
    }

    const progress = await loadTowerProgressByCharacterId(access.characterId);
    if (progress.currentRunId && progress.currentBattleId) {
      const restoredState = await loadLiveBattleState(progress.currentBattleId);
      if (restoredState && progress.currentFloor) {
        const restoredSession = createTowerSessionRecord({
          ownerUserId: userId,
          runId: progress.currentRunId,
          floor: progress.currentFloor,
          status: 'running',
          currentBattleId: progress.currentBattleId,
          nextAction: 'none',
          canAdvance: false,
          lastResult: null,
        });
        return {
          success: true,
          data: {
            session: toBattleSessionSnapshot(restoredSession),
            state: restoredState,
          },
        };
      }
    }

    if (isCharacterInBattle(access.characterId)) {
      return {
        success: false,
        message: '角色正在战斗中',
      };
    }

    const runId = progress.currentRunId ?? crypto.randomUUID();
    const floor = progress.currentFloor && progress.currentBattleId
      ? progress.currentFloor
      : progress.nextFloor;
    const battle = await createTowerBattleForFloor({
      userId,
      characterId: access.characterId,
      runId,
      floor,
    });

    const session = await withTransaction(async (client) => {
      await updateTowerProgressForRunStart({
        client,
        characterId: access.characterId,
        runId,
        floor,
        battleId: battle.battleId,
      });

      return createTowerSessionRecord({
        ownerUserId: userId,
        runId,
        floor,
        status: 'running',
        currentBattleId: battle.battleId,
        nextAction: 'none',
        canAdvance: false,
        lastResult: null,
      });
    });

    return {
      success: true,
      data: {
        session: toBattleSessionSnapshot(session),
        state: battle.state,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '开启千层塔挑战失败',
    };
  }
};

export const advanceTowerRun = async (params: {
  userId: number;
  session: BattleSessionRecord;
}): Promise<TowerStartResponse> => {
  const context = params.session.context as TowerBattleSessionContext;
  try {
    const access = await assertTowerEntryAllowed(params.userId);
    const progress = await loadTowerProgressByCharacterId(access.characterId);
    if (!progress.currentRunId || progress.currentRunId !== context.runId) {
      return { success: false, message: '千层塔挑战已结束' };
    }

    const nextFloor = context.floor + 1;
    const battle = await createTowerBattleForFloor({
      userId: params.userId,
      characterId: access.characterId,
      runId: context.runId,
      floor: nextFloor,
    });

    const updatedSession = await withTransaction(async (client) => {
      await updateTowerProgressForRunStart({
        client,
        characterId: access.characterId,
        runId: context.runId,
        floor: nextFloor,
        battleId: battle.battleId,
      });

      const updated = updateBattleSessionRecord(params.session.sessionId, {
        currentBattleId: battle.battleId,
        participantUserIds: [params.userId],
        status: 'running',
        nextAction: 'none',
        canAdvance: false,
        lastResult: null,
        context: {
          runId: context.runId,
          floor: nextFloor,
        },
      });
      if (!updated) {
        throw new Error('千层塔战斗会话不存在');
      }
      return updated;
    });

    return {
      success: true,
      data: {
        session: toBattleSessionSnapshot(updatedSession),
        state: battle.state,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '推进千层塔失败',
    };
  }
};

export const endTowerRunBySession = async (session: BattleSessionRecord): Promise<void> => {
  const context = session.context as TowerBattleSessionContext;
  const computed = await getCharacterComputedByUserId(session.ownerUserId);
  const characterId = Number(computed?.id);
  if (!Number.isInteger(characterId) || characterId <= 0) {
    return;
  }

  await withTransaction(async (client) => {
    const progress = await lockTowerProgressByCharacterId(characterId, client);
    if (progress.currentRunId !== context.runId) {
      return;
    }
    await clearTowerRunState({
      client,
      characterId,
    });
  });
};

export const settleTowerBattle = async (params: {
  battleId: string;
  result: 'attacker_win' | 'defender_win' | 'draw';
  participants: BattleParticipant[];
}): Promise<null> => {
  const runtime = getTowerBattleRuntime(params.battleId);
  if (!runtime) return null;

  try {
    if (params.result === 'attacker_win') {
      await withTransaction(async (client) => {
        const progress = await lockTowerProgressByCharacterId(runtime.characterId, client);
        const isFirstClear = runtime.floor > progress.bestFloor;
        if (!isFirstClear) {
          await client.query(
            `
              UPDATE character_tower_progress
              SET
                current_battle_id = NULL,
                updated_at = NOW()
              WHERE character_id = $1
            `,
            [runtime.characterId],
          );
          return;
        }

        await client.query(
          `
            UPDATE character_tower_progress
            SET
              best_floor = $2,
              next_floor = $3,
              current_floor = $2,
              current_battle_id = NULL,
              last_settled_floor = $2,
              reached_at = NOW(),
              updated_at = NOW()
            WHERE character_id = $1
          `,
          [runtime.characterId, runtime.floor, runtime.floor + 1],
        );
      });

      return null;
    }

    await withTransaction(async (client) => {
      await clearTowerRunState({
        client,
        characterId: runtime.characterId,
      });
    });
    return null;
  } finally {
    deleteTowerBattleRuntime(params.battleId);
  }
};

export const applyTowerPostBattleResourceChange = async (params: {
  battleId: string;
  result: 'attacker_win' | 'defender_win' | 'draw';
}): Promise<void> => {
  const runtime = getTowerBattleRuntime(params.battleId);
  if (!runtime) return;

  const computed = await getCharacterComputedByCharacterId(runtime.characterId);
  if (!computed) return;

  if (params.result === 'attacker_win') {
    const healAmount = Math.floor(computed.max_qixue * 0.3);
    await setCharacterResourcesByCharacterId(runtime.characterId, {
      qixue: Math.min(computed.max_qixue, computed.qixue + healAmount),
      lingqi: computed.lingqi,
    });
    return;
  }

  if (params.result === 'defender_win') {
    const loss = Math.floor(computed.max_qixue * 0.1);
    await applyCharacterResourceDeltaByCharacterId(
      runtime.characterId,
      { qixue: -loss },
      { minQixue: 1 },
    );
  }
};

export const getTowerBattleRuntimePreview = (battleId: string): TowerFloorPreview | null => {
  return getTowerBattleRuntime(battleId)?.preview ?? null;
};

export const getTowerRankList = async (limit: number = 50): Promise<{
  success: true;
  data: TowerRankRow[];
} | {
  success: false;
  message: string;
}> => {
  try {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await query<TowerRankQueryRow>(
      `
        SELECT
          ROW_NUMBER() OVER (
            ORDER BY ctp.best_floor DESC, ctp.reached_at ASC NULLS LAST, ctp.character_id ASC
          )::int AS rank,
          ctp.character_id,
          COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name,
          COALESCE(c.realm, '凡人') AS realm,
          ctp.best_floor,
          ctp.reached_at
        FROM character_tower_progress ctp
        JOIN characters c ON c.id = ctp.character_id
        WHERE ctp.best_floor > 0
        ORDER BY rank
        LIMIT $1
      `,
      [normalizedLimit],
    );

    return {
      success: true,
      data: result.rows.map(normalizeTowerRankRow),
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '获取千层塔排行失败',
    };
  }
};
