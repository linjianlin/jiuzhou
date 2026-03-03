/**
 * 悟道系统服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供悟道总览查询与经验注入写操作；校验解锁条件、计算可注入等级、扣减经验并更新进度。
 * 2) 不做什么：不负责 HTTP 参数解析，不负责客户端提示文案渲染。
 *
 * 输入/输出：
 * - 输入：userId、注入等级数。
 * - 输出：统一的 `{ success, message, data }` 业务结果。
 *
 * 数据流/状态流：
 * route -> insightService.getOverview/injectExp -> query(character + insight_progress) ->
 *   规则计算 -> 更新数据库 -> 失效角色属性缓存。
 *
 * 关键边界条件与坑点：
 * 1) injectExp 必须在事务中执行，且对角色与悟道进度行加锁，避免并发双花经验。
 * 2) 本服务不做“经验保底”兼容逻辑，允许经验被扣减到 0（符合产品要求）。
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import { getInsightGrowthConfig } from './staticConfigLoader.js';
import {
  buildInsightPctBonusByLevel,
  calcAffordableInjectLevels,
  calcInsightCostByLevel,
  calcInsightTotalCost,
} from './shared/insightRules.js';
import { getRealmRankZeroBased, normalizeRealmKeepingUnknown } from './shared/realmRules.js';

export interface InsightOverviewDto {
  unlocked: boolean;
  unlockRealm: string;
  currentLevel: number;
  currentBonusPct: number;
  nextLevelCostExp: number;
  characterExp: number;
}

export interface InsightInjectRequest {
  levels: number;
}

export interface InsightInjectResultDto {
  beforeLevel: number;
  afterLevel: number;
  actualInjectedLevels: number;
  spentExp: number;
  remainingExp: number;
  gainedBonusPct: number;
  currentBonusPct: number;
}

export interface InsightResult<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
}

interface CharacterInsightRow {
  characterId: number;
  realm: string;
  subRealm: string | null;
  exp: number;
}

export interface InsightInjectResolution {
  actualInjectedLevels: number;
  spentExp: number;
  remainingExp: number;
  afterLevel: number;
  beforeBonusPct: number;
  afterBonusPct: number;
}

const normalizeInteger = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

const loadCharacterInsightRow = async (userId: number, forUpdate: boolean): Promise<CharacterInsightRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, realm, sub_realm, exp
      FROM characters
      WHERE user_id = $1
      LIMIT 1
      ${lockSql}
    `,
    [userId],
  );
  if (result.rows.length <= 0) return null;

  const row = result.rows[0] as Record<string, unknown>;
  return {
    characterId: normalizeInteger(row.id),
    realm: typeof row.realm === 'string' ? row.realm : '凡人',
    subRealm: typeof row.sub_realm === 'string' ? row.sub_realm : null,
    exp: normalizeInteger(row.exp),
  };
};

const loadInsightLevel = async (characterId: number, forUpdate: boolean): Promise<number> => {
  if (forUpdate) {
    await query(
      `
        INSERT INTO character_insight_progress (character_id, level, total_exp_spent, created_at, updated_at)
        VALUES ($1, 0, 0, NOW(), NOW())
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterId],
    );
  }

  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const progressRes = await query(
    `
      SELECT level
      FROM character_insight_progress
      WHERE character_id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (progressRes.rows.length <= 0) return 0;
  const row = progressRes.rows[0] as Record<string, unknown>;
  return normalizeInteger(row.level);
};

export const isInsightUnlocked = (realm: string, subRealm: string | null, unlockRealm: string): boolean => {
  const currentRealm = normalizeRealmKeepingUnknown(realm, subRealm);
  const currentRank = getRealmRankZeroBased(currentRealm);
  const unlockRank = getRealmRankZeroBased(unlockRealm);
  return currentRank >= unlockRank;
};

export const resolveInsightInjectPlan = (params: {
  beforeLevel: number;
  characterExp: number;
  requestedLevels: number;
  config: ReturnType<typeof getInsightGrowthConfig>;
}): InsightInjectResolution => {
  const { beforeLevel, characterExp, requestedLevels, config } = params;
  const actualInjectedLevels = calcAffordableInjectLevels(beforeLevel, characterExp, requestedLevels, config);
  const spentExp = calcInsightTotalCost(beforeLevel, actualInjectedLevels, config);
  const afterLevel = beforeLevel + actualInjectedLevels;
  const beforeBonusPct = buildInsightPctBonusByLevel(beforeLevel, config);
  const afterBonusPct = buildInsightPctBonusByLevel(afterLevel, config);
  return {
    actualInjectedLevels,
    spentExp,
    remainingExp: Math.max(0, characterExp - spentExp),
    afterLevel,
    beforeBonusPct,
    afterBonusPct,
  };
};

class InsightService {
  /**
   * 获取悟道总览（读操作）
   */
  async getOverview(userId: number): Promise<InsightResult<InsightOverviewDto>> {
    try {
      const config = getInsightGrowthConfig();
      const character = await loadCharacterInsightRow(userId, false);
      if (!character || character.characterId <= 0) {
        return { success: false, message: '角色不存在' };
      }

      const currentLevel = await loadInsightLevel(character.characterId, false);
      const unlocked = isInsightUnlocked(character.realm, character.subRealm, config.unlock_realm);

      return {
        success: true,
        message: 'ok',
        data: {
          unlocked,
          unlockRealm: config.unlock_realm,
          currentLevel,
          currentBonusPct: buildInsightPctBonusByLevel(currentLevel, config),
          nextLevelCostExp: calcInsightCostByLevel(currentLevel + 1, config),
          characterExp: character.exp,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `悟道配置异常：${reason}` };
    }
  }

  /**
   * 注入经验进行悟道升级（写操作，事务）
   */
  @Transactional
  async injectExp(userId: number, request: InsightInjectRequest): Promise<InsightResult<InsightInjectResultDto>> {
    try {
      const config = getInsightGrowthConfig();
      const requestedLevels = normalizeInteger(request.levels);
      if (requestedLevels <= 0) {
        return {
          success: false,
          message: '注入等级无效，需大于 0',
        };
      }

      const character = await loadCharacterInsightRow(userId, true);
      if (!character || character.characterId <= 0) {
        return { success: false, message: '角色不存在' };
      }

      const unlocked = isInsightUnlocked(character.realm, character.subRealm, config.unlock_realm);
      if (!unlocked) {
        return { success: false, message: `未达到${config.unlock_realm}，无法悟道` };
      }

      const beforeLevel = await loadInsightLevel(character.characterId, true);
      const injectPlan = resolveInsightInjectPlan({
        beforeLevel,
        characterExp: character.exp,
        requestedLevels,
        config,
      });
      if (injectPlan.actualInjectedLevels <= 0) {
        return { success: false, message: '经验不足，无法悟道' };
      }

      const currentBonusPct = injectPlan.afterBonusPct;

      await query(
        `
          UPDATE characters
          SET exp = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [character.characterId, injectPlan.remainingExp],
      );

      await query(
        `
          UPDATE character_insight_progress
          SET level = $2,
              total_exp_spent = total_exp_spent + $3,
              updated_at = NOW()
          WHERE character_id = $1
        `,
        [character.characterId, injectPlan.afterLevel, injectPlan.spentExp],
      );

      await invalidateCharacterComputedCache(character.characterId);

      return {
        success: true,
        message: '悟道成功',
        data: {
          beforeLevel,
          afterLevel: injectPlan.afterLevel,
          actualInjectedLevels: injectPlan.actualInjectedLevels,
          spentExp: injectPlan.spentExp,
          remainingExp: injectPlan.remainingExp,
          gainedBonusPct: injectPlan.afterBonusPct - injectPlan.beforeBonusPct,
          currentBonusPct,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `悟道失败：${reason}` };
    }
  }
}

export const insightService = new InsightService();
export default insightService;
