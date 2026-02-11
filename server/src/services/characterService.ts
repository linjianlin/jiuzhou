import { query } from '../config/database.js';
import { createInventoryForCharacter } from '../models/inventoryTable.js';
import { updateSectionProgress } from './mainQuestService.js';
import { initCharacterAchievements, updateAchievementProgress } from './achievementService.js';

export interface Character {
  id: number;
  user_id: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  auto_cast_skills: boolean;
  auto_disassemble_enabled: boolean;
  auto_disassemble_max_quality_rank: number;
  spirit_stones: number;
  silver: number;
  stamina: number;
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
  try {
    const result = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    
    if (result.rows.length > 0) {
      return {
        success: true,
        message: '已有角色',
        data: {
          character: result.rows[0],
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
  } catch (error) {
    console.error('检查角色失败:', error);
    return { success: false, message: '检查角色失败' };
  }
};

// 创建角色
export const createCharacter = async (
  userId: number,
  nickname: string,
  gender: 'male' | 'female'
): Promise<CharacterResult> => {
  try {
    // 检查是否已有角色
    const existCheck = await query('SELECT id FROM characters WHERE user_id = $1', [userId]);
    if (existCheck.rows.length > 0) {
      return { success: false, message: '已存在角色，无法重复创建' };
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
        qixue, max_qixue, lingqi, max_lingqi,
        wugong, fagong, wufang, fafang,
        mingzhong, shanbi, zhaojia, baoji, baoshang,
        kangbao, zengshang, zhiliao, jianliao, xixue, lengque,
        shuxing_shuzhi, kongzhi_kangxing,
        jin_kangxing, mu_kangxing, shui_kangxing, huo_kangxing, tu_kangxing,
        qixue_huifu, lingqi_huifu, sudu, fuyuan
      ) VALUES (
        $1, $2, $3, '散修',
        0, 0, '凡人', 0,
        0, 0, 0, 0,
        'physical', 'none',
        100, 100, 0, 0,
        5, 0, 2, 0,
        9000, 500, 500, 1000, 15000,
        0, 0, 0, 0, 0, 0,
        0, 0,
        0, 0, 0, 0, 0,
        0, 0, 1, 1
      ) RETURNING *
    `;
    
    const result = await query(insertSQL, [userId, nickname, gender]);
    
    // 创建角色背包
    const characterId = result.rows[0].id;
    await createInventoryForCharacter(characterId);

    try {
      await initCharacterAchievements(characterId);
    } catch (error) {
      console.error('初始化角色成就失败:', error);
    }

    return {
      success: true,
      message: '角色创建成功',
      data: {
        character: result.rows[0],
        hasCharacter: true,
      },
    };
  } catch (error) {
    console.error('创建角色失败:', error);
    return { success: false, message: '创建角色失败' };
  }
};

// 获取角色信息
export const getCharacter = async (userId: number): Promise<CharacterResult> => {
  try {
    const result = await query('SELECT * FROM characters WHERE user_id = $1', [userId]);
    
    if (result.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }
    
    return {
      success: true,
      message: '获取成功',
      data: {
        character: result.rows[0],
        hasCharacter: true,
      },
    };
  } catch (error) {
    console.error('获取角色失败:', error);
    return { success: false, message: '获取角色失败' };
  }
};

export const updateCharacterPosition = async (
  userId: number,
  currentMapId: string,
  currentRoomId: string
): Promise<{ success: boolean; message: string }> => {
  try {
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
      try {
        await updateSectionProgress(characterId, { type: 'reach', roomId });
      } catch {}
      try {
        await updateAchievementProgress(characterId, `map:discover:${mapId}`, 1);
        await updateAchievementProgress(characterId, `room:reach:${roomId}`, 1);
      } catch {}
    }

    return { success: true, message: '位置更新成功' };
  } catch (error) {
    console.error('更新位置失败:', error);
    return { success: false, message: '更新位置失败' };
  }
};

export const updateCharacterAutoCastSkills = async (
  userId: number,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  try {
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
  } catch (error) {
    console.error('更新自动释放技能开关失败:', error);
    return { success: false, message: '更新设置失败' };
  }
};

const clampQualityRank = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(4, n));
};

export const updateCharacterAutoDisassembleSettings = async (
  userId: number,
  enabled: boolean,
  maxQualityRank?: number
): Promise<{ success: boolean; message: string }> => {
  try {
    const parsedRank = maxQualityRank == null ? null : clampQualityRank(maxQualityRank);
    const sql = `
      UPDATE characters
      SET auto_disassemble_enabled = $1,
          auto_disassemble_max_quality_rank = GREATEST(1, LEAST(4, COALESCE($2, auto_disassemble_max_quality_rank, 1))),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $3
    `;
    const result = await query(sql, [Boolean(enabled), parsedRank, userId]);

    if (result.rowCount === 0) {
      return { success: false, message: '角色不存在' };
    }

    return { success: true, message: '设置已保存' };
  } catch (error) {
    console.error('更新自动分解设置失败:', error);
    return { success: false, message: '更新设置失败' };
  }
};

