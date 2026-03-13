import { query } from '../config/database.js';
import { updateSectionProgress } from './mainQuest/index.js';
import { initCharacterAchievements, updateAchievementProgress } from './achievementService.js';
import { applyStaminaRecoveryByUserId } from './staminaService.js';
import {
  normalizeAutoDisassembleSetting,
  type AutoDisassembleRuleSet,
} from './autoDisassembleRules.js';
import { getCharacterComputedByUserId, invalidateCharacterComputedCache } from './characterComputedService.js';
import { withUnlockedFeatures } from './featureUnlockService.js';
import { createInventoryForCharacter } from './shared/inventoryPersistence.js';
import { guardSensitiveText } from './sensitiveWordService.js';

export interface Character {
  id: number;
  user_id: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  auto_cast_skills: boolean;
  auto_disassemble_enabled: boolean;
  auto_disassemble_rules: AutoDisassembleRuleSet[] | null;
  dungeon_no_stamina_cost: boolean;
  spirit_stones: number;
  silver: number;
  stamina: number;
  stamina_max: number;
  realm: string;
  sub_realm: string | null;
  exp: number;
  attribute_points: number;
  jing: number;
  qi: number;
  shen: number;
  attribute_type: string;
  attribute_element: string;
  qixue: number;
  max_qixue: number;
  lingqi: number;
  max_lingqi: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  mingzhong: number;
  shanbi: number;
  zhaojia: number;
  baoji: number;
  baoshang: number;
  jianbaoshang: number;
  kangbao: number;
  zengshang: number;
  zhiliao: number;
  jianliao: number;
  xixue: number;
  lengque: number;
  shuxing_shuzhi: number;
  kongzhi_kangxing: number;
  jin_kangxing: number;
  mu_kangxing: number;
  shui_kangxing: number;
  huo_kangxing: number;
  tu_kangxing: number;
  qixue_huifu: number;
  lingqi_huifu: number;
  sudu: number;
  fuyuan: number;
  current_map_id: string;
  current_room_id: string;
  feature_unlocks: string[];
  created_at: Date;
  updated_at: Date;
}

export interface CharacterResult {
  success: boolean;
  message: string;
  data?: {
    character: Character;
    hasCharacter: boolean;
  };
}

// 检查用户是否有角色
export const checkCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (character) {
    const characterWithUnlockedFeatures = await withUnlockedFeatures(
      character as unknown as Record<string, unknown> & { id: number },
    );
    return {
      success: true,
      message: '已有角色',
      data: {
        character: characterWithUnlockedFeatures as unknown as Character,
        hasCharacter: true,
      },
    };
  }
    
  return {
    success: true,
    message: '未创建角色',
    data: {
      character: null as unknown as Character,
      hasCharacter: false,
    },
  };
};

// 创建角色
export const createCharacter = async (
  userId: number,
  nickname: string,
  gender: 'male' | 'female'
): Promise<CharacterResult> => {
  // 检查是否已有角色
  const existCheck = await query('SELECT id FROM characters WHERE user_id = $1', [userId]);
  if (existCheck.rows.length > 0) {
    return { success: false, message: '已存在角色，无法重复创建' };
  }

  const sensitiveGuard = await guardSensitiveText(
    nickname,
    '道号包含敏感词，请重新输入',
    '敏感词检测服务暂不可用，请稍后重试',
  );
  if (!sensitiveGuard.success) {
    return { success: false, message: sensitiveGuard.message };
  }

  // 检查昵称是否已被使用
  const nicknameCheck = await query('SELECT id FROM characters WHERE nickname = $1', [nickname]);
  if (nicknameCheck.rows.length > 0) {
    return { success: false, message: '该道号已被使用' };
  }

  // 创建角色
  const insertSQL = `
    INSERT INTO characters (
      user_id, nickname, gender, title,
      spirit_stones, silver, realm, exp,
      attribute_points, jing, qi, shen,
      attribute_type, attribute_element,
      current_map_id, current_room_id
    ) VALUES (
      $1, $2, $3, '散修',
      0, 0, '凡人', 0,
      0, 0, 0, 0,
      'physical', 'none',
      'map-qingyun-village', 'room-village-center'
    ) RETURNING id
  `;
    
  const result = await query(insertSQL, [userId, nickname, gender]);
    
  // 创建角色背包
  const characterId = result.rows[0].id;
  await createInventoryForCharacter(characterId);

  await initCharacterAchievements(characterId);
  await invalidateCharacterComputedCache(characterId);

  const computedCharacter = await getCharacterComputedByUserId(userId);
  if (!computedCharacter) {
    return { success: false, message: '角色创建成功，但读取角色数据失败' };
  }
  const characterWithUnlockedFeatures = await withUnlockedFeatures(
    computedCharacter as unknown as Record<string, unknown> & { id: number },
  );

  return {
    success: true,
    message: '角色创建成功',
    data: {
      character: characterWithUnlockedFeatures as unknown as Character,
      hasCharacter: true,
    },
  };
};

// 获取角色信息
export const getCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  const characterWithUnlockedFeatures = await withUnlockedFeatures(
    character as unknown as Record<string, unknown> & { id: number },
  );
    
  return {
    success: true,
    message: '获取成功',
    data: {
      character: characterWithUnlockedFeatures as unknown as Character,
      hasCharacter: true,
    },
  };
};

export const updateCharacterPosition = async (
  userId: number,
  currentMapId: string,
  currentRoomId: string
): Promise<{ success: boolean; message: string }> => {
  const mapId = String(currentMapId || '').trim();
  const roomId = String(currentRoomId || '').trim();

  if (!mapId || !roomId) {
    return { success: false, message: '位置参数不能为空' };
  }

  if (mapId.length > 64 || roomId.length > 64) {
    return { success: false, message: '位置参数过长' };
  }

  const sql = `
    UPDATE characters
    SET current_map_id = $1,
        current_room_id = $2,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $3
    RETURNING id
  `;
  const result = await query(sql, [mapId, roomId, userId]);

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  const characterId = Number(result.rows?.[0]?.id);
  if (Number.isFinite(characterId) && characterId > 0) {
    await updateSectionProgress(characterId, { type: 'reach', roomId });
    await updateAchievementProgress(characterId, `map:discover:${mapId}`, 1);
    await updateAchievementProgress(characterId, `room:reach:${roomId}`, 1);
  }

  return { success: true, message: '位置更新成功' };
};

export const updateCharacterAutoCastSkills = async (
  userId: number,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  const sql = `
    UPDATE characters
    SET auto_cast_skills = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
  `;
  const result = await query(sql, [Boolean(enabled), userId]);

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  return { success: true, message: '设置已保存' };
};

export const updateCharacterAutoDisassembleSettings = async (
  userId: number,
  enabled: boolean,
  rules?: unknown
): Promise<{ success: boolean; message: string }> => {
  try {
    const normalized = normalizeAutoDisassembleSetting({
      enabled,
      rules,
    });
    const parsedRulesJson = rules === undefined ? null : JSON.stringify(normalized.rules);
    const sql = `
      UPDATE characters
      SET auto_disassemble_enabled = $1,
          auto_disassemble_rules = COALESCE($2::jsonb, auto_disassemble_rules, '[]'::jsonb),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $3
    `;
    const result = await query(sql, [normalized.enabled, parsedRulesJson, userId]);

    if (result.rowCount === 0) {
      return { success: false, message: '角色不存在' };
    }

    return { success: true, message: '设置已保存' };
  } catch (error) {
    console.error('更新自动分解设置失败:', error);
    return { success: false, message: '更新设置失败' };
  }
};

export const updateCharacterDungeonNoStaminaCostSetting = async (
  userId: number,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  const sql = `
    UPDATE characters
    SET dungeon_no_stamina_cost = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
  `;
  const result = await query(sql, [Boolean(enabled), userId]);

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  return { success: true, message: '设置已保存' };
};
