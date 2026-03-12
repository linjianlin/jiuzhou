import type { AxiosRequestConfig } from 'axios';
import api, { API_BASE } from './core';

export interface AuthResponse {
  success: boolean;
  message: string;
  data?: {
    user: {
      id: number;
      username: string;
    };
    token: string;
  };
}

export interface CharacterResponse {
  success: boolean;
  message: string;
  data?: {
    character: {
      id: number;
      nickname: string;
      gender: string;
      title: string;
      realm: string;
      sub_realm: string | null;
      auto_cast_skills?: boolean;
      auto_disassemble_enabled?: boolean;
      auto_disassemble_rules?: AutoDisassembleRulesDto | null;
      dungeon_no_stamina_cost?: boolean;
      spirit_stones: number;
      silver: number;
      qixue: number;
      max_qixue: number;
      wugong: number;
      wufang: number;
    };
    hasCharacter: boolean;
  };
}

export interface AutoDisassembleRuleDto {
  categories?: string[];
  subCategories?: string[];
  excludedSubCategories?: string[];
  includeNameKeywords?: string[];
  excludeNameKeywords?: string[];
  /** 规则级最高品质（1黄/2玄/3地/4天），不是全局配置 */
  maxQualityRank: number;
}

export type AutoDisassembleRulesDto = AutoDisassembleRuleDto[];

// 登录
export const login = (username: string, password: string): Promise<AuthResponse> => {
  return api.post('/auth/login', { username, password });
};

// 注册
export const register = (username: string, password: string): Promise<AuthResponse> => {
  return api.post('/auth/register', { username, password });
};

// 验证会话（持久登录检查）
export interface VerifyResponse {
  success: boolean;
  message: string;
  kicked?: boolean;
  data?: { userId: number };
}

export const verifySession = (): Promise<VerifyResponse> => {
  return api.get('/auth/verify');
};

// 检查是否有角色
export const checkCharacter = (): Promise<CharacterResponse> => {
  return api.get('/character/check');
};

// 创建角色
export const createCharacter = (nickname: string, gender: 'male' | 'female'): Promise<CharacterResponse> => {
  return api.post('/character/create', { nickname, gender });
};

// 获取角色信息
export const getCharacterInfo = (): Promise<CharacterResponse> => {
  return api.get('/character/info');
};

export const updateCharacterPosition = (
  currentMapId: string,
  currentRoomId: string,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updatePosition', { currentMapId, currentRoomId }, requestConfig);
};

export const updateCharacterPositionKeepalive = (currentMapId: string, currentRoomId: string): void => {
  const mapId = String(currentMapId || '').trim();
  const roomId = String(currentRoomId || '').trim();
  if (!mapId || !roomId) return;

  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  void fetch(`${API_BASE}/character/updatePosition`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ currentMapId: mapId, currentRoomId: roomId }),
    keepalive: true,
  }).catch(() => undefined);
};

export const updateCharacterAutoCastSkills = (enabled: boolean): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateAutoCastSkills', { enabled });
};

export const updateCharacterAutoDisassemble = (
  enabled: boolean,
  rules?: AutoDisassembleRulesDto
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateAutoDisassemble', {
    enabled,
    ...(rules ? { rules } : {}),
  });
};

export const updateCharacterDungeonNoStaminaCost = (
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateDungeonNoStaminaCost', { enabled });
};
