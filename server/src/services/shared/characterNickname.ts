/**
 * 角色昵称查询共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中封装“根据角色 ID 查询角色昵称”的只读能力，避免多个业务各自手写相同 SQL。
 * 2) 做什么：为全服广播、秘境结算文案等需要角色展示名的场景提供单一入口。
 * 3) 不做什么：不负责角色存在性校验结果提示，不拼接业务文案，也不处理批量昵称映射。
 *
 * 输入/输出：
 * - 输入：`characterId`，单个角色 ID。
 * - 输出：角色昵称字符串；查无角色、ID 非法或昵称为空时返回 `null`。
 *
 * 数据流/状态流：
 * 业务服务传入 characterId -> 本模块查询 `characters.nickname` -> 返回规范化后的昵称给上层业务。
 *
 * 关键边界条件与坑点：
 * 1) 这里只处理单角色查询；批量场景仍应使用专门的批量查询模块，避免在循环里重复调用。
 * 2) 广播文案依赖昵称可读性，因此空白昵称不能直接透传，必须在这里统一裁剪并返回 `null`。
 */
import { query } from '../../config/database.js';

type CharacterNicknameRow = {
  nickname?: string | null;
};

const normalizeCharacterId = (characterId: number): number | null => {
  const normalized = Number(characterId);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
};

export const getCharacterNicknameById = async (characterId: number): Promise<string | null> => {
  const normalizedCharacterId = normalizeCharacterId(characterId);
  if (!normalizedCharacterId) {
    return null;
  }

  const result = await query(
    `
      SELECT nickname
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedCharacterId],
  );
  if (result.rows.length <= 0) {
    return null;
  }

  const nickname = (result.rows[0] as CharacterNicknameRow).nickname?.trim();
  return nickname || null;
};
