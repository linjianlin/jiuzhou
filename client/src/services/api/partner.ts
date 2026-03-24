import api from './core';
import type { CharacterFeatureCode } from '../feature';
import type { AxiosRequestConfig } from 'axios';

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
  jianfantan: number;
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

export type PartnerTradeStatus = 'none' | 'market_listed';
export type PartnerFusionStatus = 'none' | 'fusion_locked';

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

export type PartnerDisplayDto = {
  id: number;
  partnerDefId: string;
  name: string;
  nickname: string;
  description: string;
  avatar: string | null;
  element: string;
  role: string;
  quality: string;
  level: number;
  currentEffectiveLevel: number;
  progressExp: number;
  nextLevelCostExp: number;
  slotCount: number;
  isActive: boolean;
  obtainedFrom: string | null;
  growth: PartnerGrowthDto;
  levelAttrGains: PartnerBaseAttrsDto;
  computedAttrs: PartnerComputedAttrsDto;
  techniques: PartnerTechniqueDto[];
};

export type PartnerDetailDto = PartnerDisplayDto & {
  tradeStatus: PartnerTradeStatus;
  marketListingId: number | null;
  fusionStatus: PartnerFusionStatus;
  fusionJobId: string | null;
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

export type PartnerRecruitQualityRateDto = {
  quality: '黄' | '玄' | '地' | '天';
  weight: number;
  rate: number;
};

export type PartnerRecruitJobDto = {
  generationId: string;
  status: PartnerRecruitJobStatusDto;
  startedAt: string;
  finishedAt: string | null;
  previewExpireAt: string | null;
  requestedBaseModel: string | null;
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
  customBaseModelBypassesCooldown: boolean;
  customBaseModelMaxLength: number;
  customBaseModelTokenCost: number;
  customBaseModelTokenItemName: string;
  customBaseModelTokenAvailableQty: number;
  currentJob: PartnerRecruitJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: PartnerRecruitResultStatusDto;
  remainingUntilGuaranteedHeaven: number;
  qualityRates: PartnerRecruitQualityRateDto[];
};

export type PartnerRecruitConfirmResponseDto = {
  generationId: string;
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
  activated: boolean;
};

export type PartnerFusionPreviewDto = PartnerRecruitPreviewDto;

export type PartnerFusionJobStatusDto =
  | 'pending'
  | 'generated_preview'
  | 'accepted'
  | 'failed';

export type PartnerFusionJobDto = {
  fusionId: string;
  status: PartnerFusionJobStatusDto;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  sourceQuality: string;
  resultQuality: string | null;
  materialPartnerIds: number[];
  preview: PartnerFusionPreviewDto | null;
};

export type PartnerFusionStatusDto = {
  featureCode: CharacterFeatureCode;
  unlocked: true;
  currentJob: PartnerFusionJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_preview' | 'failed' | null;
};

export type PartnerFusionConfirmResponseDto = {
  fusionId: string;
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

export type PartnerSkillPolicySlotDto = {
  skillId: string;
  priority: number;
  enabled: boolean;
};

export type PartnerSkillPolicyEntryDto = {
  skillId: string;
  skillName: string;
  skillIcon: string;
  skillDescription?: string;
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
  sourceTechniqueId: string;
  sourceTechniqueName: string;
  sourceTechniqueQuality: string;
  priority: number;
  enabled: boolean;
};

export type PartnerSkillPolicyDto = {
  partnerId: number;
  entries: PartnerSkillPolicyEntryDto[];
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

export interface PartnerRenameResponse {
  success: boolean;
  message: string;
  data?: {
    partner: PartnerDetailDto;
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
    quality: PartnerRecruitQualityRateDto['quality'];
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

export interface PartnerFusionStatusResponse {
  success: boolean;
  message: string;
  data?: PartnerFusionStatusDto;
}

export interface PartnerFusionStartResponse {
  success: boolean;
  message: string;
  data?: {
    fusionId: string;
    sourceQuality: string;
    resultQuality: string;
  };
}

export interface PartnerFusionConfirmResponse {
  success: boolean;
  message: string;
  data?: PartnerFusionConfirmResponseDto;
}

export interface PartnerFusionViewedResponse {
  success: boolean;
  message: string;
  data?: {
    fusionId: string | null;
  };
}

export interface PartnerSkillPolicyResponse {
  success: boolean;
  message: string;
  data?: PartnerSkillPolicyDto;
}

export interface UpdatePartnerSkillPolicyResponse {
  success: boolean;
  message: string;
  data?: PartnerSkillPolicyDto;
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

export const renamePartnerWithCard = (
  params: {
    partnerId: number;
    itemInstanceId: number;
    nickname: string;
    avatar?: string | null;
  },
  requestConfig?: AxiosRequestConfig,
): Promise<PartnerRenameResponse> => {
  return api.post('/partner/renameWithCard', {
    partnerId: params.partnerId,
    itemInstanceId: params.itemInstanceId,
    nickname: params.nickname,
    avatar: params.avatar,
  }, requestConfig);
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

export const getPartnerSkillPolicy = (
  partnerId: number,
): Promise<PartnerSkillPolicyResponse> => {
  return api.get('/partner/skill-policy', {
    params: { partnerId },
  });
};

export const updatePartnerSkillPolicy = (
  partnerId: number,
  slots: PartnerSkillPolicySlotDto[],
): Promise<UpdatePartnerSkillPolicyResponse> => {
  return api.put('/partner/skill-policy', { partnerId, slots });
};

export const getPartnerRecruitStatus = (): Promise<PartnerRecruitStatusResponse> => {
  return api.get('/partner/recruit/status');
};

export const generatePartnerRecruitDraft = (
  params: {
    customBaseModelEnabled: boolean;
    requestedBaseModel?: string;
  },
): Promise<PartnerRecruitGenerateResponse> => {
  return api.post('/partner/recruit/generate', {
    customBaseModelEnabled: params.customBaseModelEnabled,
    requestedBaseModel: params.requestedBaseModel,
  });
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

export const getPartnerFusionStatus = (): Promise<PartnerFusionStatusResponse> => {
  return api.get('/partner/fusion/status');
};

export const startPartnerFusion = (partnerIds: number[]): Promise<PartnerFusionStartResponse> => {
  return api.post('/partner/fusion/start', { partnerIds });
};

export const confirmPartnerFusionPreview = (
  fusionId: string,
): Promise<PartnerFusionConfirmResponse> => {
  return api.post(`/partner/fusion/${fusionId}/confirm`);
};

export const markPartnerFusionResultViewed = (): Promise<PartnerFusionViewedResponse> => {
  return api.post('/partner/fusion/mark-result-viewed');
};
