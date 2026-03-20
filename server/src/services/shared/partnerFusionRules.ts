/**
 * 三魂归契规则模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护三魂归契的素材数量、品级浮动概率与结果抽取规则。
 * 2. 做什么：把黄/天边界概率并回同品级的规则收口，避免服务层和前端各自手写一套。
 * 3. 不做什么：不读数据库、不创建任务，也不处理伙伴占用校验。
 *
 * 输入/输出：
 * - 输入：源品级。
 * - 输出：融合结果权重列表与一次抽取后的目标品级。
 *
 * 数据流/状态流：
 * 融合发起 -> 本模块算结果品级 -> 业务任务记录 result_quality -> AI 伙伴生成。
 *
 * 关键边界条件与坑点：
 * 1. 黄品不能降、天品不能升；无效概率必须并回同品级，保证总权重始终是 100。
 * 2. 抽取逻辑必须只依赖同一份权重表，避免“展示概率”和“实际概率”分叉。
 */
import {
  QUALITY_BY_RANK,
  QUALITY_RANK_MAP,
  type QualityName,
} from './itemQuality.js';

export const PARTNER_FUSION_MATERIAL_COUNT = 3;
const PARTNER_FUSION_DOWNGRADE_WEIGHT = 5;
const PARTNER_FUSION_SAME_WEIGHT = 85;
const PARTNER_FUSION_UPGRADE_WEIGHT = 10;

export type PartnerFusionQualityWeight = {
  quality: QualityName;
  weight: number;
};

export const resolvePartnerFusionQualityWeights = (
  sourceQuality: QualityName,
): PartnerFusionQualityWeight[] => {
  const sourceRank = QUALITY_RANK_MAP[sourceQuality];
  const weightsByQuality: Record<QualityName, number> = {
    黄: 0,
    玄: 0,
    地: 0,
    天: 0,
  };

  const lowerQuality = QUALITY_BY_RANK[sourceRank - 1];
  const higherQuality = QUALITY_BY_RANK[sourceRank + 1];
  if (lowerQuality) {
    weightsByQuality[lowerQuality] += PARTNER_FUSION_DOWNGRADE_WEIGHT;
  } else {
    weightsByQuality[sourceQuality] += PARTNER_FUSION_DOWNGRADE_WEIGHT;
  }

  weightsByQuality[sourceQuality] += PARTNER_FUSION_SAME_WEIGHT;

  if (higherQuality) {
    weightsByQuality[higherQuality] += PARTNER_FUSION_UPGRADE_WEIGHT;
  } else {
    weightsByQuality[sourceQuality] += PARTNER_FUSION_UPGRADE_WEIGHT;
  }

  return (Object.keys(weightsByQuality) as QualityName[])
    .map((quality) => ({
      quality,
      weight: weightsByQuality[quality],
    }))
    .filter((entry) => entry.weight > 0);
};

export const rollPartnerFusionResultQuality = (
  sourceQuality: QualityName,
  randomValue: number = Math.random(),
): QualityName => {
  const weights = resolvePartnerFusionQualityWeights(sourceQuality);
  const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    return sourceQuality;
  }

  let remaining = Math.max(0, Math.min(0.999999, randomValue)) * totalWeight;
  for (const entry of weights) {
    if (remaining < entry.weight) {
      return entry.quality;
    }
    remaining -= entry.weight;
  }

  return weights[weights.length - 1]?.quality ?? sourceQuality;
};
