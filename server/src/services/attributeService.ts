/**
 * 属性加点服务
 */
import { query } from '../config/database.js';

type AttributeKey = 'jing' | 'qi' | 'shen';

export interface AddPointResult {
  success: boolean;
  message: string;
  data?: {
    attribute: AttributeKey;
    newValue: number;
    remainingPoints: number;
  };
}

// 加点
export const addAttributePoint = async (
  userId: number,
  attribute: AttributeKey,
  amount: number = 1
): Promise<AddPointResult> => {
  try {
    // 验证属性名
    if (!['jing', 'qi', 'shen'].includes(attribute)) {
      return { success: false, message: '无效的属性类型' };
    }

    // 验证数量
    if (amount < 1 || amount > 100) {
      return { success: false, message: '加点数量无效' };
    }

    // 检查可用属性点
    const checkSQL = 'SELECT attribute_points FROM characters WHERE user_id = $1';
    const checkResult = await query(checkSQL, [userId]);

    if (checkResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const availablePoints = checkResult.rows[0].attribute_points;
    if (availablePoints < amount) {
      return { success: false, message: '属性点不足' };
    }

    // 执行加点（触发器会自动计算派生属性）
    const updateSQL = `
      UPDATE characters 
      SET ${attribute} = ${attribute} + $1,
          attribute_points = attribute_points - $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING ${attribute} as new_value, attribute_points as remaining_points
    `;

    const result = await query(updateSQL, [amount, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '加点失败' };
    }

    return {
      success: true,
      message: '加点成功',
      data: {
        attribute,
        newValue: result.rows[0].new_value,
        remainingPoints: result.rows[0].remaining_points,
      },
    };
  } catch (error) {
    console.error('加点失败:', error);
    return { success: false, message: '服务器错误' };
  }
};

// 减点
export const removeAttributePoint = async (
  userId: number,
  attribute: AttributeKey,
  amount: number = 1
): Promise<AddPointResult> => {
  try {
    // 验证属性名
    if (!['jing', 'qi', 'shen'].includes(attribute)) {
      return { success: false, message: '无效的属性类型' };
    }

    // 验证数量
    if (amount < 1 || amount > 100) {
      return { success: false, message: '减点数量无效' };
    }

    // 检查当前属性值
    const checkSQL = `SELECT ${attribute} FROM characters WHERE user_id = $1`;
    const checkResult = await query(checkSQL, [userId]);

    if (checkResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const currentValue = checkResult.rows[0][attribute];
    if (currentValue < amount) {
      return { success: false, message: '属性点不足以减少' };
    }

    // 执行减点（触发器会自动计算派生属性）
    const updateSQL = `
      UPDATE characters 
      SET ${attribute} = ${attribute} - $1,
          attribute_points = attribute_points + $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING ${attribute} as new_value, attribute_points as remaining_points
    `;

    const result = await query(updateSQL, [amount, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '减点失败' };
    }

    return {
      success: true,
      message: '减点成功',
      data: {
        attribute,
        newValue: result.rows[0].new_value,
        remainingPoints: result.rows[0].remaining_points,
      },
    };
  } catch (error) {
    console.error('减点失败:', error);
    return { success: false, message: '服务器错误' };
  }
};

// 批量加点
export const batchAddPoints = async (
  userId: number,
  points: { jing?: number; qi?: number; shen?: number }
): Promise<AddPointResult> => {
  try {
    const totalPoints = (points.jing || 0) + (points.qi || 0) + (points.shen || 0);

    if (totalPoints <= 0) {
      return { success: false, message: '请指定加点数量' };
    }

    // 检查可用属性点
    const checkSQL = 'SELECT attribute_points FROM characters WHERE user_id = $1';
    const checkResult = await query(checkSQL, [userId]);

    if (checkResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const availablePoints = checkResult.rows[0].attribute_points;
    if (availablePoints < totalPoints) {
      return { success: false, message: '属性点不足' };
    }

    // 构建更新SQL
    const updates: string[] = [];
    if (points.jing) updates.push(`jing = jing + ${points.jing}`);
    if (points.qi) updates.push(`qi = qi + ${points.qi}`);
    if (points.shen) updates.push(`shen = shen + ${points.shen}`);
    updates.push(`attribute_points = attribute_points - ${totalPoints}`);
    updates.push('updated_at = CURRENT_TIMESTAMP');

    const updateSQL = `
      UPDATE characters 
      SET ${updates.join(', ')}
      WHERE user_id = $1
      RETURNING jing, qi, shen, attribute_points as remaining_points
    `;

    const result = await query(updateSQL, [userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '加点失败' };
    }

    return {
      success: true,
      message: '批量加点成功',
      data: {
        attribute: 'jing',
        newValue: result.rows[0].jing,
        remainingPoints: result.rows[0].remaining_points,
      },
    };
  } catch (error) {
    console.error('批量加点失败:', error);
    return { success: false, message: '服务器错误' };
  }
};

// 重置属性点（可选功能）
export const resetAttributePoints = async (
  userId: number
): Promise<{ success: boolean; message: string; totalPoints?: number }> => {
  try {
    // 获取当前精气神总点数
    const checkSQL = 'SELECT jing, qi, shen FROM characters WHERE user_id = $1';
    const checkResult = await query(checkSQL, [userId]);

    if (checkResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const { jing, qi, shen } = checkResult.rows[0];
    const totalPoints = jing + qi + shen;

    // 重置属性
    const resetSQL = `
      UPDATE characters 
      SET jing = 0, qi = 0, shen = 0,
          attribute_points = attribute_points + $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
    `;

    await query(resetSQL, [totalPoints, userId]);

    return {
      success: true,
      message: '属性点已重置',
      totalPoints,
    };
  } catch (error) {
    console.error('重置属性点失败:', error);
    return { success: false, message: '服务器错误' };
  }
};

