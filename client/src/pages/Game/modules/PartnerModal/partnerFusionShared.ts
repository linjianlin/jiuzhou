/**
 * 三魂归契共享纯函数
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护三魂归契页签的任务态映射、素材选择禁用规则与概率文案。
 * 2. 做什么：把“归契中/坊市中/出战中/品级不一致”这些高频判断从组件 JSX 中抽离，避免重复分支散落。
 * 3. 不做什么：不发请求、不持有状态，也不直接渲染 UI。
 *
 * 输入/输出：
 * - 输入：伙伴 DTO、三魂归契状态 DTO、当前已选素材。
 * - 输出：页签视图态、红点、禁用原因与文案列表。
 *
 * 数据流/状态流：
 * API / WebSocket / 伙伴总览 -> 本模块纯函数 -> PartnerModal 三魂归契面板。
 *
 * 关键边界条件与坑点：
 * 1. 黄/天边界概率要与服务端同口径展示，否则玩家看到的概率与实际结果会不一致。
 * 2. 素材禁用原因必须只有一个最终文案，避免同一卡片同时出现多条冲突说明。
 */
import type {
  PartnerDetailDto,
  PartnerFusionJobDto,
  PartnerFusionPreviewDto,
  PartnerFusionStatusDto,
} from '../../../../services/api';

type PartnerFusionIndicator = {
  badgeDot: boolean;
};

export type PartnerFusionPanelView =
  | { kind: 'idle' }
  | { kind: 'pending'; job: PartnerFusionJobDto }
  | { kind: 'preview'; job: PartnerFusionJobDto; preview: PartnerFusionPreviewDto }
  | { kind: 'failed'; job: PartnerFusionJobDto; errorMessage: string };

const PARTNER_FUSION_QUALITY_ORDER = ['黄', '玄', '地', '天'] as const;

export const buildPartnerFusionIndicator = (
  status: PartnerFusionStatusDto | null,
): PartnerFusionIndicator => {
  return {
    badgeDot: Boolean(status?.hasUnreadResult),
  };
};

export const resolvePartnerFusionPanelView = (
  status: PartnerFusionStatusDto | null,
): PartnerFusionPanelView => {
  const job = status?.currentJob;
  if (!job) return { kind: 'idle' };
  if (job.status === 'pending') {
    return { kind: 'pending', job };
  }
  if (job.status === 'generated_preview' && job.preview) {
    return { kind: 'preview', job, preview: job.preview };
  }
  return {
    kind: 'failed',
    job,
    errorMessage: job.errorMessage || '三魂归契失败',
  };
};

export const resolvePartnerFusionRateLines = (sourceQuality: string): string[] => {
  const qualityIndex = PARTNER_FUSION_QUALITY_ORDER.findIndex((entry) => entry === sourceQuality);
  if (qualityIndex < 0) {
    return ['85% 同品级', '5% -1 品级', '10% +1 品级'];
  }
  const lowerQuality = PARTNER_FUSION_QUALITY_ORDER[qualityIndex - 1];
  const higherQuality = PARTNER_FUSION_QUALITY_ORDER[qualityIndex + 1];
  const lines: string[] = [];
  if (lowerQuality) {
    lines.push(`5% 获得${lowerQuality}品伙伴`);
  }
  lines.push(`${higherQuality ? (lowerQuality ? 85 : 90) : 95}% 获得${sourceQuality}品伙伴`);
  if (higherQuality) {
    lines.push(`10% 获得${higherQuality}品伙伴`);
  }
  return lines;
};

export const togglePartnerFusionMaterialSelection = (
  selectedIds: number[],
  partnerId: number,
): number[] => {
  if (selectedIds.includes(partnerId)) {
    return selectedIds.filter((entry) => entry !== partnerId);
  }
  if (selectedIds.length >= 3) {
    return selectedIds;
  }
  return [...selectedIds, partnerId];
};

export const resolvePartnerFusionSelectedQuality = (
  partners: PartnerDetailDto[],
  selectedIds: number[],
): string | null => {
  for (const partnerId of selectedIds) {
    const partner = partners.find((entry) => entry.id === partnerId);
    if (partner) return partner.quality;
  }
  return null;
};

export const resolvePartnerFusionMaterialDisabledReason = (
  partner: PartnerDetailDto,
  selectedQuality: string | null,
  selectedCount: number,
): string | null => {
  if (partner.isActive) return '出战中';
  if (partner.tradeStatus === 'market_listed') return '坊市中';
  if (partner.fusionStatus === 'fusion_locked') return '归契中';
  if (selectedQuality && partner.quality !== selectedQuality) return '品级不一致';
  if (selectedCount >= 3) return '已选满3个';
  return null;
};

export const groupPartnersByFusionQuality = (
  partners: PartnerDetailDto[],
  selectedQuality: string | null,
): Array<{ quality: string; partners: PartnerDetailDto[] }> => {
  const visiblePartners = partners.filter((partner) => {
    if (partner.isActive || partner.tradeStatus === 'market_listed') {
      return false;
    }
    if (selectedQuality && partner.quality !== selectedQuality) {
      return false;
    }
    return true;
  });
  return PARTNER_FUSION_QUALITY_ORDER
    .map((quality) => ({
      quality,
      partners: visiblePartners.filter((partner) => partner.quality === quality),
    }))
    .filter((entry) => entry.partners.length > 0);
};
