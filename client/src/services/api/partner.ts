import api from './core';
import type { CharacterFeatureCode } from '../feature';

export type PartnerGrowthDto = {
  max_qixue: number;
  wugong: number;
  fagong: number;
  wufang: number;
  fafang: number;
  sudu: number;
};

export type PartnerComputedAttrsDto = {
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
  sudu: number;
  kongzhi_kangxing: number;
  jin_kangxing: number;
  mu_kangxing: number;
  shui_kangxing: number;
  huo_kangxing: number;
  tu_kangxing: number;
  qixue_huifu: number;
  lingqi_huifu: number;
};

export type PartnerBaseAttrsDto = Omit<PartnerComputedAttrsDto, 'qixue' | 'lingqi'>;

export type PartnerPassiveAttrsDto = Record<string, number>;

export type PartnerTechniqueSkillDto = {
  id: string;
  name: string;
  icon: string;
  description?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
};

export type PartnerTechniqueDto = {
  techniqueId: string;
  name: string;
  description: string | null;
  icon: string | null;
  quality: string;
  currentLayer: number;
  maxLayer: number;
  skillIds: string[];
  skills: PartnerTechniqueSkillDto[];
  passiveAttrs: PartnerPassiveAttrsDto;
  isInnate: boolean;
};

export type PartnerTechniqueUpgradeCostDto = {
  currentLayer: number;
  maxLayer: number;
  nextLayer: number;
  spiritStones: number;
  exp: number;
  materials: Array<{
    itemId: string;
    qty: number;
    itemName?: string;
    itemIcon?: string | null;
  }>;
};

export type PartnerBookDto = {
  itemInstanceId: number;
  itemDefId: string;
  techniqueId: string;
  techniqueName: string;
  name: string;
  icon: string | null;
  quality: string;
  qty: number;
};

export type PartnerDetailDto = {
  id: number;
  partnerDefId: string;
  name: string;
  nickname: string;
  avatar: string | null;
  element: string;
  role: string;
  quality: string;
  level: number;
  progressExp: number;
  nextLevelCostExp: number;
  slotCount: number;
  isActive: boolean;
  obtainedFrom: string | null;
  growth: PartnerGrowthDto;
  computedAttrs: PartnerComputedAttrsDto;
  techniques: PartnerTechniqueDto[];
};

export type PartnerRecruitPreviewTechniqueDto = {
  techniqueId: string;
  name: string;
  description: string;
  quality: string;
  icon: string | null;
  skillNames: string[];
};

export type PartnerRecruitPreviewDto = {
  partnerDefId: string;
  name: string;
  description: string;
  avatar: string | null;
  quality: string;
  element: string;
  role: string;
  slotCount: number;
  baseAttrs: PartnerBaseAttrsDto;
  levelAttrGains: PartnerBaseAttrsDto;
  innateTechniques: PartnerRecruitPreviewTechniqueDto[];
};

export type PartnerRecruitJobStatusDto =
  | 'pending'
  | 'generated_draft'
  | 'accepted'
  | 'failed'
  | 'refunded'
  | 'discarded';

export type PartnerRecruitResultStatusDto = 'generated_draft' | 'failed' | null;

export type PartnerRecruitJobDto = {
  generationId: string;
  status: PartnerRecruitJobStatusDto;
  startedAt: string;
  finishedAt: string | null;
  previewExpireAt: string | null;
  preview: PartnerRecruitPreviewDto | null;
  errorMessage: string | null;
};

export type PartnerRecruitStatusDto = {
  featureCode: CharacterFeatureCode;
  unlockRealm: string;
  unlocked: boolean;
  spiritStoneCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  currentJob: PartnerRecruitJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: PartnerRecruitResultStatusDto;
};

export type PartnerRecruitConfirmResponseDto = {
  generationId: string;
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
  activated: boolean;
};

export type PartnerOverviewDto = {
  featureCode: CharacterFeatureCode;
  activePartnerId: number | null;
  characterExp: number;
  partners: PartnerDetailDto[];
  books: PartnerBookDto[];
};

export interface PartnerOverviewResponse {
  success: boolean;
  message: string;
  data?: PartnerOverviewDto;
}

export interface PartnerActivateResponse {
  success: boolean;
  message: string;
  data?: {
    activePartnerId: number;
    partner: PartnerDetailDto;
  };
}

export interface PartnerDismissResponse {
  success: boolean;
  message: string;
  data?: {
    activePartnerId: null;
  };
}

export interface PartnerInjectExpResponse {
  success: boolean;
  message: string;
  data?: {
    partner: PartnerDetailDto;
    spentExp: number;
    levelsGained: number;
    characterExp: number;
  };
}

export interface PartnerLearnTechniqueResponse {
  success: boolean;
  message: string;
  data?: {
    partner: PartnerDetailDto;
    learnedTechnique: PartnerTechniqueDto;
    replacedTechnique: PartnerTechniqueDto | null;
    remainingBooks: PartnerBookDto[];
  };
}

export interface PartnerTechniqueUpgradeCostResponse {
  success: boolean;
  message: string;
  data?: PartnerTechniqueUpgradeCostDto;
}

export interface PartnerUpgradeTechniqueResponse {
  success: boolean;
  message: string;
  data?: {
    partner: PartnerDetailDto;
    updatedTechnique: PartnerTechniqueDto;
    newLayer: number;
  };
}

export interface PartnerRecruitStatusResponse {
  success: boolean;
  message: string;
  data?: PartnerRecruitStatusDto;
}

export interface PartnerRecruitGenerateResponse {
  success: boolean;
  message: string;
  data?: {
    generationId: string;
  };
}

export interface PartnerRecruitConfirmResponse {
  success: boolean;
  message: string;
  data?: PartnerRecruitConfirmResponseDto;
}

export interface PartnerRecruitDiscardResponse {
  success: boolean;
  message: string;
  data?: {
    generationId: string;
  };
}

export interface PartnerRecruitViewedResponse {
  success: boolean;
  message: string;
  data?: {
    generationId: string | null;
  };
}

export const getPartnerOverview = (): Promise<PartnerOverviewResponse> => {
  return api.get('/partner/overview');
};

export const activatePartner = (partnerId: number): Promise<PartnerActivateResponse> => {
  return api.post('/partner/activate', { partnerId });
};

export const dismissPartner = (): Promise<PartnerDismissResponse> => {
  return api.post('/partner/dismiss');
};

export const injectPartnerExp = (
  partnerId: number,
  exp: number,
): Promise<PartnerInjectExpResponse> => {
  return api.post('/partner/inject-exp', { partnerId, exp });
};

export const learnPartnerTechnique = (
  partnerId: number,
  itemInstanceId: number,
): Promise<PartnerLearnTechniqueResponse> => {
  return api.post('/partner/learn-technique', { partnerId, itemInstanceId });
};

export const getPartnerTechniqueUpgradeCost = (
  partnerId: number,
  techniqueId: string,
): Promise<PartnerTechniqueUpgradeCostResponse> => {
  return api.get('/partner/technique-upgrade-cost', {
    params: { partnerId, techniqueId },
  });
};

export const upgradePartnerTechnique = (
  partnerId: number,
  techniqueId: string,
): Promise<PartnerUpgradeTechniqueResponse> => {
  return api.post('/partner/upgrade-technique', { partnerId, techniqueId });
};

export const getPartnerRecruitStatus = (): Promise<PartnerRecruitStatusResponse> => {
  return api.get('/partner/recruit/status');
};

export const generatePartnerRecruitDraft = (): Promise<PartnerRecruitGenerateResponse> => {
  return api.post('/partner/recruit/generate');
};

export const confirmPartnerRecruitDraft = (
  generationId: string,
): Promise<PartnerRecruitConfirmResponse> => {
  return api.post(`/partner/recruit/${generationId}/confirm`);
};

export const discardPartnerRecruitDraft = (
  generationId: string,
): Promise<PartnerRecruitDiscardResponse> => {
  return api.post(`/partner/recruit/${generationId}/discard`);
};

export const markPartnerRecruitResultViewed = (): Promise<PartnerRecruitViewedResponse> => {
  return api.post('/partner/recruit/mark-result-viewed');
};
