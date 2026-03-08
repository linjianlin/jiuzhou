import api from './core';

export type TechniqueDefDto = {
  id: string;
  code: string | null;
  name: string;
  type: string;
  quality: string;
  quality_rank: number;
  max_layer: number;
  required_realm: string;
  attribute_type: string;
  attribute_element: string;
  tags: string[];
  description: string | null;
  long_desc: string | null;
  icon: string | null;
  obtain_type: string | null;
  obtain_hint: string[];
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export type TechniqueLayerDto = {
  technique_id: string;
  layer: number;
  cost_spirit_stones: number;
  cost_exp: number;
  cost_materials: unknown;
  passives: unknown;
  unlock_skill_ids: string[];
  upgrade_skill_ids: string[];
  required_realm: string | null;
  required_quest_id: string | null;
  layer_desc: string | null;
};

export type SkillDefDto = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  source_type: string;
  source_id: string | null;
  cost_lingqi: number;
  cost_qixue: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string | null;
  element: string;
  effects: unknown[];
  trigger_type: string;
  conditions: unknown;
  ai_priority: number;
  ai_conditions: unknown;
  upgrades: unknown;
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export interface TechniqueListResponse {
  success: boolean;
  message?: string;
  data?: { techniques: TechniqueDefDto[] };
}

export const getEnabledTechniques = (): Promise<TechniqueListResponse> => {
  return api.get('/technique');
};

export interface TechniqueDetailResponse {
  success: boolean;
  message?: string;
  data?: {
    technique: TechniqueDefDto;
    layers: TechniqueLayerDto[];
    skills: SkillDefDto[];
  };
}

export const getTechniqueDetail = (techniqueId: string): Promise<TechniqueDetailResponse> => {
  return api.get(`/technique/${techniqueId}`);
};

export type CharacterTechniqueDto = {
  id: number;
  character_id: number;
  technique_id: string;
  current_layer: number;
  slot_type: 'main' | 'sub' | null;
  slot_index: number | null;
  acquired_at: string;
  technique_name?: string;
  technique_type?: string;
  technique_quality?: string;
  max_layer?: number;
  attribute_type?: string;
  attribute_element?: string;
};

export type CharacterSkillSlotDto = {
  slot_index: number;
  skill_id: string;
  skill_name?: string;
  skill_icon?: string;
};

export interface CharacterTechniqueStatusResponse {
  success: boolean;
  message: string;
  data?: {
    techniques: CharacterTechniqueDto[];
    equippedMain: CharacterTechniqueDto | null;
    equippedSubs: CharacterTechniqueDto[];
    equippedSkills: CharacterSkillSlotDto[];
    availableSkills: Array<{
      skillId: string;
      skillName: string;
      skillIcon: string;
      techniqueId: string;
      techniqueName: string;
      // 完整技能数据
      description: string | null;
      costLingqi: number;
      costQixue: number;
      cooldown: number;
      targetType: string;
      targetCount: number;
      damageType: string | null;
      element: string;
      effects: unknown[];
    }>;
    passives: Record<string, number>;
  };
}

export const getCharacterTechniqueStatus = (characterId: number): Promise<CharacterTechniqueStatusResponse> => {
  return api.get(`/character/${characterId}/technique/status`);
};

export const learnCharacterTechnique = (
  characterId: number,
  techniqueId: string,
  obtainedFrom?: string,
  obtainedRefId?: string
): Promise<{ success: boolean; message: string; data?: unknown }> => {
  return api.post(`/character/${characterId}/technique/learn`, { techniqueId, obtainedFrom, obtainedRefId });
};

export interface TechniqueUpgradeCostResponse {
  success: boolean;
  message: string;
  data?: {
    currentLayer: number;
    maxLayer: number;
    spirit_stones: number;
    exp: number;
    materials: Array<{ itemId: string; qty: number; itemName?: string; itemIcon?: string | null }>;
  };
}

export const getCharacterTechniqueUpgradeCost = (characterId: number, techniqueId: string): Promise<TechniqueUpgradeCostResponse> => {
  return api.get(`/character/${characterId}/technique/${techniqueId}/upgrade-cost`);
};

export const upgradeCharacterTechnique = (
  characterId: number,
  techniqueId: string
): Promise<{ success: boolean; message: string; data?: { newLayer: number; unlockedSkills: string[]; upgradedSkills: string[] } }> => {
  return api.post(`/character/${characterId}/technique/${techniqueId}/upgrade`);
};

export const equipCharacterTechnique = (
  characterId: number,
  techniqueId: string,
  slotType: 'main' | 'sub',
  slotIndex?: number
): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/technique/equip`, { techniqueId, slotType, slotIndex });
};

export const unequipCharacterTechnique = (characterId: number, techniqueId: string): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/technique/unequip`, { techniqueId });
};

export const equipCharacterSkill = (
  characterId: number,
  skillId: string,
  slotIndex: number
): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/skill/equip`, { skillId, slotIndex });
};

export const unequipCharacterSkill = (characterId: number, slotIndex: number): Promise<{ success: boolean; message: string }> => {
  return api.post(`/character/${characterId}/skill/unequip`, { slotIndex });
};

export type TechniqueResearchNameRulesDto = {
  minLength: number;
  maxLength: number;
  fixedPrefix: string;
  patternHint: string;
  immutableAfterPublish: boolean;
};

export type TechniqueResearchDraftDto = {
  generationId: string;
  id: string;
  quality: '黄' | '玄' | '地' | '天';
  type: string;
  maxLayer: number;
  description: string;
  longDesc: string;
  suggestedName: string;
  draftExpireAt: string;
};

export type TechniqueResearchResultStatusDto = 'generated_draft' | 'failed';

export type TechniqueResearchJobDto = {
  generationId: string;
  status: 'pending' | 'generated_draft' | 'published' | 'failed' | 'refunded';
  quality: '黄' | '玄' | '地' | '天';
  draftTechniqueId: string | null;
  startedAt: string;
  finishedAt: string | null;
  draftExpireAt: string | null;
  preview: {
    draftTechniqueId: string;
    aiSuggestedName: string;
    quality: '黄' | '玄' | '地' | '天';
    type: string;
    maxLayer: number;
    description: string;
    longDesc: string;
    skillNames: string[];
    skills: Array<{
      id: string;
      name: string;
      description: string;
      icon: string | null;
      costLingqi: number;
      costQixue: number;
      cooldown: number;
      targetType: string;
      targetCount: number;
      damageType: string | null;
      element: string;
      effects: unknown[];
    }>;
  } | null;
  errorMessage: string | null;
};

export interface TechniqueResearchStatusResponse {
  success: boolean;
  message: string;
  code?: string;
  data?: {
    fragmentBalance: number;
    fragmentCost: number;
    cooldownHours: number;
    cooldownUntil: string | null;
    cooldownRemainingSeconds: number;
    currentDraft: TechniqueResearchDraftDto | null;
    draftExpireAt: string | null;
    nameRules: TechniqueResearchNameRulesDto;
    currentJob: TechniqueResearchJobDto | null;
    hasUnreadResult: boolean;
    resultStatus: TechniqueResearchResultStatusDto | null;
  };
}

export const getTechniqueResearchStatus = (characterId: number): Promise<TechniqueResearchStatusResponse> => {
  return api.get(`/character/${characterId}/technique/research/status`);
};

export interface TechniqueResearchGenerateResponse {
  success: boolean;
  message: string;
  code?: string;
  data?: {
    generationId: string;
    quality: '黄' | '玄' | '地' | '天';
    status: 'pending';
  };
}

export const generateTechniqueResearchDraft = (
  characterId: number,
): Promise<TechniqueResearchGenerateResponse> => {
  return api.post(`/character/${characterId}/technique/research/generate`);
};

export interface TechniqueResearchPublishResponse {
  success: boolean;
  message: string;
  code?: string;
  data?: {
    techniqueId: string;
    finalName: string;
    bookItemInstanceId: number;
  };
}

export const publishTechniqueResearchDraft = (
  characterId: number,
  generationId: string,
  customName: string,
): Promise<TechniqueResearchPublishResponse> => {
  return api.post(`/character/${characterId}/technique/research/generate/${generationId}/publish`, { customName });
};

export const abandonTechniqueResearchDraft = (
  characterId: number,
  generationId: string,
): Promise<{ success: boolean; message: string; code?: string; data?: { generationId: string; status: 'failed' } }> => {
  return api.post(`/character/${characterId}/technique/research/generate/${generationId}/abandon`);
};

export const markTechniqueResearchResultViewed = (
  characterId: number,
): Promise<{ success: boolean; message: string; data?: { marked: boolean } }> => {
  return api.post(`/character/${characterId}/technique/research/mark-result-viewed`);
};
