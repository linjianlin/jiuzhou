import { query } from '../config/database.js';
import { updateSectionProgress } from './mainQuest/index.js';
import { initCharacterAchievements, updateAchievementProgress } from './achievementService.js';
import { applyStaminaRecoveryByUserId } from './staminaService.js';
import { withTransaction } from '../config/database.js';
import {
  normalizeAutoDisassembleSetting,
  type AutoDisassembleRuleSet,
} from './autoDisassembleRules.js';
import {
  getCharacterComputedByUserId,
  invalidateCharacterComputedCache,
  type CharacterComputedRow,
} from './characterComputedService.js';
import {
  loadCharacterWritebackRowByUserId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';
import { withUnlockedFeatures } from './featureUnlockService.js';
import { createInventoryForCharacter } from './shared/inventoryPersistence.js';
import { primeCharacterIdByUserIdCache } from './shared/characterId.js';
import {
  normalizeCharacterNicknameInput,
  validateCharacterNickname,
} from './shared/characterNameRules.js';
import { consumeRenameCardItemInstance } from './shared/characterRenameCard.js';
import { broadcastWorldSystemMessage } from './shared/worldChatBroadcast.js';

export type Character = CharacterComputedRow & {
  feature_unlocks: string[];
};

export interface CharacterResult {
  success: boolean;
  message: string;
  data?: {
    character: Character | null;
    hasCharacter: boolean;
  };
}

export const characterServiceSideEffects = {
  invalidateCharacterComputedCacheByCharacterId: invalidateCharacterComputedCache,
  broadcastWorldSystemMessage,
};

const attachUnlockedFeaturesToCharacter = async (
  character: CharacterComputedRow,
): Promise<Character> => {
  return withUnlockedFeatures(character);
};

// 检查用户是否有角色
export const checkCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (character) {
    const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(character);
    return {
      success: true,
      message: '已有角色',
      data: {
        character: characterWithUnlockedFeatures,
        hasCharacter: true,
      },
    };
  }
    
  return {
    success: true,
    message: '未创建角色',
    data: {
      character: null,
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
  const existingCharacter = await loadCharacterWritebackRowByUserId(userId);
  if (existingCharacter) {
    return { success: false, message: '已存在角色，无法重复创建' };
  }

  const nicknameValidation = await validateCharacterNickname(nickname);
  if (!nicknameValidation.success) {
    return { success: false, message: nicknameValidation.message };
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
    
  const result = await query(insertSQL, [userId, nicknameValidation.nickname, gender]);
    
  // 创建角色背包
  const characterId = result.rows[0].id;
  await createInventoryForCharacter(characterId);
  await primeCharacterIdByUserIdCache(userId, Number(characterId));

  await initCharacterAchievements(characterId);
  await characterServiceSideEffects.invalidateCharacterComputedCacheByCharacterId(characterId);

  const computedCharacter = await getCharacterComputedByUserId(userId);
  if (!computedCharacter) {
    return { success: false, message: '角色创建成功，但读取角色数据失败' };
  }
  const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(computedCharacter);

  return {
    success: true,
    message: '角色创建成功',
    data: {
      character: characterWithUnlockedFeatures,
      hasCharacter: true,
    },
  };
};

export const renameCharacterWithCard = async (
  userId: number,
  itemInstanceId: number,
  nickname: string,
): Promise<{ success: boolean; message: string }> => {
  const result = await withTransaction(async (): Promise<{
    success: boolean;
    message: string;
    broadcastContent: string | null;
  }> => {
    const characterRow = await loadCharacterWritebackRowByUserId(userId, { forUpdate: true });
    if (!characterRow) {
      return { success: false, message: '角色不存在', broadcastContent: null };
    }
    const characterId = Number(characterRow.id);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return { success: false, message: '角色不存在', broadcastContent: null };
    }
    const previousNickname = String(characterRow.nickname || '').trim();

    const nicknameValidation = await validateCharacterNickname(nickname, {
      excludeCharacterId: characterId,
    });
    if (!nicknameValidation.success) {
      return { success: false, message: nicknameValidation.message, broadcastContent: null };
    }

    const consumeResult = await consumeRenameCardItemInstance(characterId, itemInstanceId);
    if (!consumeResult.success) {
      return { success: false, message: consumeResult.message, broadcastContent: null };
    }

    queueCharacterWritebackSnapshot(characterId, {
      nickname: nicknameValidation.nickname,
    });

    await characterServiceSideEffects.invalidateCharacterComputedCacheByCharacterId(characterId);

    return {
      success: true,
      message: '改名成功',
      broadcastContent: `【易名符】『${previousNickname}』改名为『${nicknameValidation.nickname}』，仙名重铸，声传九州！`,
    };
  });
  if (result.success && result.broadcastContent) {
    characterServiceSideEffects.broadcastWorldSystemMessage({
      senderTitle: '天机传音',
      content: result.broadcastContent,
    });
  }

  return {
    success: result.success,
    message: result.message,
  };
};

// 获取角色信息
export const getCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(character);
    
  return {
    success: true,
    message: '获取成功',
    data: {
      character: characterWithUnlockedFeatures,
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

  const character = await loadCharacterWritebackRowByUserId(userId, {
    forUpdate: true,
  });
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  queueCharacterWritebackSnapshot(character.id, {
    current_map_id: mapId,
    current_room_id: roomId,
  });

  const characterId = Number(character.id);
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
  const character = await loadCharacterWritebackRowByUserId(userId, {
    forUpdate: true,
  });
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  queueCharacterWritebackSnapshot(character.id, {
    auto_cast_skills: Boolean(enabled),
  });

  return { success: true, message: '设置已保存' };
};

export const updateCharacterAutoDisassembleSettings = async (
  userId: number,
  enabled: boolean,
  rules?: AutoDisassembleRuleSet[],
): Promise<{ success: boolean; message: string }> => {
  try {
    const normalized = normalizeAutoDisassembleSetting({
      enabled,
      rules,
    });
    const character = await loadCharacterWritebackRowByUserId(userId, {
      forUpdate: true,
    });
    if (!character) {
      return { success: false, message: '角色不存在' };
    }
    queueCharacterWritebackSnapshot(character.id, {
      auto_disassemble_enabled: normalized.enabled,
      ...(rules === undefined ? {} : { auto_disassemble_rules: normalized.rules }),
    });

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
  const character = await loadCharacterWritebackRowByUserId(userId, {
    forUpdate: true,
  });
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  queueCharacterWritebackSnapshot(character.id, {
    dungeon_no_stamina_cost: Boolean(enabled),
  });

  return { success: true, message: '设置已保存' };
};
