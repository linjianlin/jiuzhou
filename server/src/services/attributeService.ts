/**
 * 属性加点服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承接角色属性加点、减点、批量加点与重置，避免 HTTP / Socket 各保留一套写库规则。
 * 2. 做什么：把单属性变更收敛成单条条件更新，减少“先查再改”带来的同角色行锁放大。
 * 3. 不做什么：不负责角色面板推送，不在这里持有额外 advisory lock，也不处理前端展示格式。
 *
 * 输入/输出：
 * - 输入：`userId`、属性类型、点数数量。
 * - 输出：统一的成功/失败结果对象，包含最新属性值与剩余属性点。
 *
 * 数据流/状态流：
 * route / socket -> attributeService -> 单条条件 UPDATE characters -> 失效角色计算缓存。
 *
 * 关键边界条件与坑点：
 * 1. 属性点校验必须和写库放在同一条 SQL 里，否则并发请求会把“可用点数”判断与真实更新拆开。
 * 2. Socket 与 HTTP 入口必须复用这里的单一数据源，不能在其他文件再手写一套 `UPDATE characters`。
 */
import { query } from '../config/database.js';
import { invalidateCharacterComputedCacheByUserId } from './characterComputedService.js';

type AttributeKey = 'jing' | 'qi' | 'shen';
const ATTRIBUTE_KEYS: readonly AttributeKey[] = ['jing', 'qi', 'shen'];

type SingleAttributeMutationRow = {
  character_exists: boolean;
  updated: boolean;
  new_value: string | number;
  remaining_points: string | number;
};

type BatchAttributeMutationRow = {
  character_exists: boolean;
  updated: boolean;
  jing: string | number;
  qi: string | number;
  shen: string | number;
  remaining_points: string | number;
};

type ResetAttributeMutationRow = {
  character_exists: boolean;
  updated: boolean;
  refunded_points: string | number;
};

export interface AddPointResult {
  success: boolean;
  message: string;
  data?: {
    attribute: AttributeKey;
    newValue: number;
    remainingPoints: number;
  };
}

const isAttributeKey = (attribute: string): attribute is AttributeKey => {
  return ATTRIBUTE_KEYS.includes(attribute as AttributeKey);
};

const normalizeInteger = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
};

const buildSingleAttributeMutationSql = (
  attribute: AttributeKey,
  direction: 'add' | 'remove',
): string => {
  const attributeGuardSql = direction === 'add'
    ? 'characters.attribute_points >= $2'
    : `characters.${attribute} >= $2`;
  const attributeMutationSql = direction === 'add'
    ? `${attribute} = ${attribute} + $2`
    : `${attribute} = ${attribute} - $2`;
  const attributePointMutationSql = direction === 'add'
    ? 'attribute_points = attribute_points - $2'
    : 'attribute_points = attribute_points + $2';

  return `
    WITH target_character AS (
      SELECT id
      FROM characters
      WHERE user_id = $1
      LIMIT 1
    ),
    updated_character AS (
      UPDATE characters
      SET ${attributeMutationSql},
          ${attributePointMutationSql},
          updated_at = CURRENT_TIMESTAMP
      FROM target_character
      WHERE characters.id = target_character.id
        AND ${attributeGuardSql}
      RETURNING
        characters.${attribute} AS new_value,
        characters.attribute_points AS remaining_points
    )
    SELECT
      EXISTS(SELECT 1 FROM target_character) AS character_exists,
      EXISTS(SELECT 1 FROM updated_character) AS updated,
      COALESCE((SELECT new_value FROM updated_character), 0) AS new_value,
      COALESCE((SELECT remaining_points FROM updated_character), 0) AS remaining_points
  `;
};

const runSingleAttributeMutation = async (
  userId: number,
  attribute: AttributeKey,
  amount: number,
  direction: 'add' | 'remove',
): Promise<AddPointResult> => {
  const result = await query<SingleAttributeMutationRow>(
    buildSingleAttributeMutationSql(attribute, direction),
    [userId, amount],
  );
  const row = result.rows[0];

  if (!row?.character_exists) {
    return { success: false, message: '角色不存在' };
  }
  if (!row.updated) {
    return {
      success: false,
      message: direction === 'add' ? '属性点不足' : '属性点不足以减少',
    };
  }

  await invalidateCharacterComputedCacheByUserId(userId);

  return {
    success: true,
    message: direction === 'add' ? '加点成功' : '减点成功',
    data: {
      attribute,
      newValue: normalizeInteger(row.new_value),
      remainingPoints: normalizeInteger(row.remaining_points),
    },
  };
};

// 加点
export const addAttributePoint = async (
  userId: number,
  attribute: AttributeKey,
  amount: number = 1
): Promise<AddPointResult> => {
  // 验证属性名
  if (!isAttributeKey(attribute)) {
    return { success: false, message: '无效的属性类型' };
  }

  // 验证数量
  if (amount < 1 || amount > 100) {
    return { success: false, message: '加点数量无效' };
  }

  return runSingleAttributeMutation(userId, attribute, amount, 'add');
};

// 减点
export const removeAttributePoint = async (
  userId: number,
  attribute: AttributeKey,
  amount: number = 1
): Promise<AddPointResult> => {
  // 验证属性名
  if (!isAttributeKey(attribute)) {
    return { success: false, message: '无效的属性类型' };
  }

  // 验证数量
  if (amount < 1 || amount > 100) {
    return { success: false, message: '减点数量无效' };
  }

  return runSingleAttributeMutation(userId, attribute, amount, 'remove');
};

// 批量加点
export const batchAddPoints = async (
  userId: number,
  points: { jing?: number; qi?: number; shen?: number }
): Promise<AddPointResult> => {
  const totalPoints = (points.jing || 0) + (points.qi || 0) + (points.shen || 0);

  if (totalPoints <= 0) {
    return { success: false, message: '请指定加点数量' };
  }

  const result = await query<BatchAttributeMutationRow>(
    `
      WITH target_character AS (
        SELECT id
        FROM characters
        WHERE user_id = $1
        LIMIT 1
      ),
      updated_character AS (
        UPDATE characters
        SET jing = jing + $2,
            qi = qi + $3,
            shen = shen + $4,
            attribute_points = attribute_points - $5,
            updated_at = CURRENT_TIMESTAMP
        FROM target_character
        WHERE characters.id = target_character.id
          AND characters.attribute_points >= $5
        RETURNING
          characters.jing AS jing,
          characters.qi AS qi,
          characters.shen AS shen,
          characters.attribute_points AS remaining_points
      )
      SELECT
        EXISTS(SELECT 1 FROM target_character) AS character_exists,
        EXISTS(SELECT 1 FROM updated_character) AS updated,
        COALESCE((SELECT jing FROM updated_character), 0) AS jing,
        COALESCE((SELECT qi FROM updated_character), 0) AS qi,
        COALESCE((SELECT shen FROM updated_character), 0) AS shen,
        COALESCE((SELECT remaining_points FROM updated_character), 0) AS remaining_points
    `,
    [userId, points.jing || 0, points.qi || 0, points.shen || 0, totalPoints],
  );
  const row = result.rows[0];

  if (!row?.character_exists) {
    return { success: false, message: '角色不存在' };
  }
  if (!row.updated) {
    return { success: false, message: '属性点不足' };
  }

  await invalidateCharacterComputedCacheByUserId(userId);

  return {
    success: true,
    message: '批量加点成功',
    data: {
      attribute: 'jing',
      newValue: normalizeInteger(row.jing),
      remainingPoints: normalizeInteger(row.remaining_points),
    },
  };
};

// 重置属性点（可选功能）
export const resetAttributePoints = async (
  userId: number
): Promise<{ success: boolean; message: string; totalPoints?: number }> => {
  const result = await query<ResetAttributeMutationRow>(
    `
      WITH target_character AS (
        SELECT id, jing, qi, shen
        FROM characters
        WHERE user_id = $1
        LIMIT 1
      ),
      updated_character AS (
        UPDATE characters
        SET jing = 0,
            qi = 0,
            shen = 0,
            attribute_points = attribute_points + target_character.jing + target_character.qi + target_character.shen,
            updated_at = CURRENT_TIMESTAMP
        FROM target_character
        WHERE characters.id = target_character.id
        RETURNING target_character.jing + target_character.qi + target_character.shen AS refunded_points
      )
      SELECT
        EXISTS(SELECT 1 FROM target_character) AS character_exists,
        EXISTS(SELECT 1 FROM updated_character) AS updated,
        COALESCE((SELECT refunded_points FROM updated_character), 0) AS refunded_points
    `,
    [userId],
  );
  const row = result.rows[0];

  if (!row?.character_exists) {
    return { success: false, message: '角色不存在' };
  }
  if (!row.updated) {
    return { success: false, message: '重置失败' };
  }

  await invalidateCharacterComputedCacheByUserId(userId);

  return {
    success: true,
    message: '属性点已重置',
    totalPoints: normalizeInteger(row.refunded_points),
  };
};
