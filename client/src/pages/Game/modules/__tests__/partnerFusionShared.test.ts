/**
 * 三魂归契前端共享纯函数测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住三魂归契页签的概率文案、任务态映射与素材禁用原因优先级。
 * 2. 做什么：验证前端展示口径与服务端规则一致，避免 JSX 内联判断回归。
 * 3. 不做什么：不渲染真实弹窗，不发请求，也不测试 WebSocket 订阅。
 *
 * 输入/输出：
 * - 输入：融合状态 DTO、伙伴 DTO、当前已选素材信息。
 * - 输出：面板视图态、概率文案和素材禁用原因。
 *
 * 数据流/状态流：
 * 伙伴总览 / 融合状态接口 -> partnerFusionShared -> PartnerModal 三魂归契面板。
 *
 * 关键边界条件与坑点：
 * 1. 黄/天边界的概率文案必须与服务端同口径，否则玩家会看到错误提示。
 * 2. 禁用原因只能返回一个最终文案，避免一张素材卡同时出现互相冲突的说明。
 */
import { describe, expect, it } from 'vitest';
import type {
  PartnerDetailDto,
  PartnerFusionJobDto,
  PartnerFusionStatusDto,
} from '../../../../services/api/partner';
import {
  groupPartnersByFusionQuality,
  resolvePartnerFusionMaterialDisabledReason,
  resolvePartnerFusionPanelView,
  resolvePartnerFusionRateLines,
} from '../PartnerModal/partnerFusionShared';

const createPartner = (overrides: Partial<PartnerDetailDto> = {}): PartnerDetailDto => ({
  id: 1,
  partnerDefId: 'partner-1',
  name: '青岚',
  nickname: null,
  description: '山中修行的木灵术修。',
  avatar: null,
  quality: '玄',
  role: '术修',
  element: 'mu',
  level: 12,
  currentEffectiveLevel: 12,
  progressExp: 20,
  nextLevelCostExp: 100,
  slotCount: 4,
  obtainedFrom: 'partner_recruit',
  growth: {
    max_qixue: 10,
    wugong: 1,
    fagong: 2,
    wufang: 1,
    fafang: 2,
    sudu: 1,
  },
  levelAttrGains: {
    max_qixue: 100,
    max_lingqi: 80,
    wugong: 10,
    fagong: 20,
    wufang: 12,
    fafang: 15,
    sudu: 8,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 0,
    lingqi_huifu: 0,
  },
  computedAttrs: {
    qixue: 100,
    max_qixue: 100,
    lingqi: 80,
    max_lingqi: 80,
    wugong: 10,
    fagong: 20,
    wufang: 12,
    fafang: 15,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    sudu: 8,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 1,
    lingqi_huifu: 1,
  },
  techniques: [],
  isActive: false,
  tradeStatus: 'none',
  marketListingId: null,
  fusionStatus: 'none',
  fusionJobId: null,
  ...overrides,
});

const createFusionJob = (overrides: Partial<PartnerFusionJobDto> = {}): PartnerFusionJobDto => ({
  fusionId: 'fusion-1',
  status: 'pending',
  startedAt: '2026-03-20T10:00:00.000Z',
  finishedAt: null,
  errorMessage: null,
  sourceQuality: '玄',
  resultQuality: '地',
  materialPartnerIds: [1, 2, 3],
  preview: null,
  ...overrides,
});

const createFusionStatus = (
  overrides: Partial<PartnerFusionStatusDto> = {},
): PartnerFusionStatusDto => ({
  featureCode: 'partner_system',
  unlocked: true,
  currentJob: null,
  hasUnreadResult: false,
  resultStatus: null,
  ...overrides,
});

describe('partnerFusionShared', () => {
  it('黄品概率文案应展示边界并回后的结果', () => {
    expect(resolvePartnerFusionRateLines('黄', [])).toEqual([
      '90% 获得黄品伙伴',
      '10% 获得玄品伙伴',
    ]);
  });

  it('天品概率文案应展示边界并回后的结果', () => {
    expect(resolvePartnerFusionRateLines('天', [])).toEqual([
      '5% 获得地品伙伴',
      '95% 获得天品伙伴',
    ]);
  });

  it('选中 2 个同五行素材时应把升品概率展示为 15%', () => {
    expect(resolvePartnerFusionRateLines('黄', [
      createPartner({ id: 1, quality: '黄', element: 'shui' }),
      createPartner({ id: 2, quality: '黄', element: 'shui' }),
    ])).toEqual([
      '85% 获得黄品伙伴',
      '15% 获得玄品伙伴',
    ]);
  });

  it('选中 3 个全同五行素材时应把升品概率展示为 20%', () => {
    expect(resolvePartnerFusionRateLines('玄', [
      createPartner({ id: 1, quality: '玄', element: 'shui' }),
      createPartner({ id: 2, quality: '玄', element: 'shui' }),
      createPartner({ id: 3, quality: '玄', element: 'shui' }),
    ])).toEqual([
      '5% 获得黄品伙伴',
      '75% 获得玄品伙伴',
      '20% 获得地品伙伴',
    ]);
  });

  it('none 五行不应参与升品加成展示', () => {
    expect(resolvePartnerFusionRateLines('黄', [
      createPartner({ id: 1, quality: '黄', element: 'none' }),
      createPartner({ id: 2, quality: '黄', element: 'none' }),
    ])).toEqual([
      '90% 获得黄品伙伴',
      '10% 获得玄品伙伴',
    ]);
  });

  it('generated_preview 应映射为预览态面板', () => {
    const preview = {
      partnerDefId: 'generated-1',
      name: '星漪',
      description: 'description',
      avatar: null,
      quality: '地',
      element: 'shui',
      role: '术修',
      slotCount: 4,
      baseAttrs: createPartner().levelAttrGains,
      levelAttrGains: createPartner().levelAttrGains,
      innateTechniques: [],
    };

    expect(resolvePartnerFusionPanelView(createFusionStatus({
      currentJob: createFusionJob({
        status: 'generated_preview',
        preview,
      }),
    }))).toEqual({
      kind: 'preview',
      job: createFusionJob({
        status: 'generated_preview',
        preview,
      }),
      preview,
    });
  });

  it('素材禁用原因应优先返回出战中', () => {
    expect(resolvePartnerFusionMaterialDisabledReason(createPartner({
      isActive: true,
      tradeStatus: 'market_listed',
      fusionStatus: 'fusion_locked',
    }), '玄', 2)).toBe('出战中');
  });

  it('同品级不足但已选满时应返回已选满3个', () => {
    expect(resolvePartnerFusionMaterialDisabledReason(createPartner({
      quality: '玄',
    }), '玄', 3)).toBe('已选满3个');
  });

  it('已选品级不一致时应返回品级不一致', () => {
    expect(resolvePartnerFusionMaterialDisabledReason(createPartner({
      quality: '地',
    }), '玄', 1)).toBe('品级不一致');
  });

  it('素材分组时应隐藏出战中和坊市中的伙伴', () => {
    expect(groupPartnersByFusionQuality([
      createPartner({ id: 1, quality: '黄', isActive: true }),
      createPartner({ id: 2, quality: '黄', tradeStatus: 'market_listed' }),
      createPartner({ id: 3, quality: '黄' }),
      createPartner({ id: 4, quality: '玄' }),
    ], null)).toEqual([
      {
        quality: '黄',
        partners: [createPartner({ id: 3, quality: '黄' })],
      },
      {
        quality: '玄',
        partners: [createPartner({ id: 4, quality: '玄' })],
      },
    ]);
  });

  it('选中品级后应只保留该品级分组', () => {
    expect(groupPartnersByFusionQuality([
      createPartner({ id: 1, quality: '黄' }),
      createPartner({ id: 2, quality: '玄' }),
      createPartner({ id: 3, quality: '地' }),
    ], '玄')).toEqual([
      {
        quality: '玄',
        partners: [createPartner({ id: 2, quality: '玄' })],
      },
    ]);
  });
});
