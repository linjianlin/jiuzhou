import { describe, expect, it } from 'vitest';
import type { PartnerRecruitStatusDto } from '../../../../services/api/partner';
import {
  resolvePartnerRecruitQualityRateItems,
  resolvePartnerRecruitGuaranteeText,
  resolvePartnerRecruitActionState,
  resolvePartnerRecruitCooldownDisplay,
  resolvePartnerRecruitLayoutState,
  resolvePartnerRecruitPanelView,
  resolvePartnerRecruitSubmitState,
} from '../PartnerModal/partnerRecruitShared';

const buildRecruitStatus = (
  overrides: Partial<PartnerRecruitStatusDto> = {},
): PartnerRecruitStatusDto => ({
  featureCode: 'partner_system',
  unlockRealm: '炼神返虚·养神期',
  unlocked: true,
  spiritStoneCost: 0,
  cooldownHours: 120,
  cooldownUntil: null,
  cooldownRemainingSeconds: 0,
  customBaseModelBypassesCooldown: true,
  customBaseModelMaxLength: 12,
  customBaseModelTokenCost: 1,
  customBaseModelTokenItemName: '高级招募令',
  customBaseModelTokenAvailableQty: 1,
  currentJob: null,
  hasUnreadResult: false,
  resultStatus: null,
  remainingUntilGuaranteedHeaven: 20,
  qualityRates: [
    { quality: '黄', weight: 4, rate: 40 },
    { quality: '玄', weight: 3, rate: 30 },
    { quality: '地', weight: 2, rate: 20 },
    { quality: '天', weight: 1, rate: 10 },
  ],
  ...overrides,
});

describe('partnerRecruitShared', () => {
  it('冷却中但启用高级招募令时应允许开始招募', () => {
    const actionState = resolvePartnerRecruitActionState(buildRecruitStatus({
      cooldownUntil: '2026-03-19T12:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(actionState.canGenerate).toBe(true);
  });

  it('冷却中且未启用高级招募令时应继续禁止开始招募', () => {
    const actionState = resolvePartnerRecruitActionState(buildRecruitStatus({
      cooldownUntil: '2026-03-19T12:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), false);

    expect(actionState.canGenerate).toBe(false);
  });

  it('启用高级招募令时应展示“无视冷却且不重置冷却”的统一提示', () => {
    const cooldownDisplay = resolvePartnerRecruitCooldownDisplay(buildRecruitStatus({
      cooldownUntil: '2026-03-19T12:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(cooldownDisplay.statusText).toContain('本次招募不受影响');
    expect(cooldownDisplay.ruleText).toContain('不会重置或新增招募冷却');
    expect(cooldownDisplay.bypassedByCustomBaseModel).toBe(true);
  });

  it('启用高级招募令模式后即使未填写底模也应允许提交', () => {
    const submitState = resolvePartnerRecruitSubmitState(buildRecruitStatus({
      cooldownUntil: '2026-03-19T12:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(submitState.canSubmit).toBe(true);
    expect(submitState.disabledReason).toBeNull();
  });

  it('启用高级招募令模式但令牌不足时应继续禁止提交', () => {
    const submitState = resolvePartnerRecruitSubmitState(buildRecruitStatus({
      customBaseModelTokenAvailableQty: 0,
      cooldownUntil: '2026-03-19T12:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(submitState.canSubmit).toBe(false);
    expect(submitState.disabledReason).toContain('高级招募令不足');
  });

  it('应把服务端下发的品质概率格式化为招募面板展示项', () => {
    expect(resolvePartnerRecruitQualityRateItems(buildRecruitStatus())).toEqual([
      { quality: '黄', rateText: '40%' },
      { quality: '玄', rateText: '30%' },
      { quality: '地', rateText: '20%' },
      { quality: '天', rateText: '10%' },
    ]);
  });

  it('保底态下应展示天级 100% 概率', () => {
    expect(resolvePartnerRecruitQualityRateItems(buildRecruitStatus({
      qualityRates: [
        { quality: '黄', weight: 0, rate: 0 },
        { quality: '玄', weight: 0, rate: 0 },
        { quality: '地', weight: 0, rate: 0 },
        { quality: '天', weight: 1, rate: 100 },
      ],
    }))).toEqual([
      { quality: '黄', rateText: '0%' },
      { quality: '玄', rateText: '0%' },
      { quality: '地', rateText: '0%' },
      { quality: '天', rateText: '100%' },
    ]);
  });

  it('应把服务端下发的保底剩余次数格式化为统一提示文案', () => {
    expect(resolvePartnerRecruitGuaranteeText(buildRecruitStatus({
      remainingUntilGuaranteedHeaven: 3,
    }))).toBe('再 3 次成功生成，必得天品伙伴');
  });

  it('生成结果预览态应隐藏顶部信息卡并压平预览卡片', () => {
    const panelView = resolvePartnerRecruitPanelView(buildRecruitStatus({
      currentJob: {
        generationId: 'draft-job',
        status: 'generated_draft',
        requestedBaseModel: null,
        previewExpireAt: null,
        preview: {
          partnerId: 'draft-partner',
          name: '碧翎蛊',
          avatar: '/uploads/partners/draft.webp',
          quality: '地',
          element: 'wood',
          role: '蛊术使',
          slotCount: 5,
          description: '测试预览',
          baseAttrs: {
            hp: 300,
            mp: 80,
            atk: 60,
            spellPower: 90,
            defense: 40,
            spellResist: 35,
            hit: 0.9,
            dodge: 0.1,
            critRate: 0.12,
            critDamage: 1.6,
            speed: 120,
          },
          levelAttrGains: {
            hp: 30,
            mp: 8,
            atk: 6,
            spellPower: 9,
            defense: 4,
            spellResist: 3,
            hit: 0.01,
            dodge: 0.005,
            critRate: 0.002,
            critDamage: 0.01,
            speed: 2,
          },
          innateTechniques: [],
        },
        errorMessage: null,
        refundedAt: null,
        createdAt: '2026-03-21T00:00:00.000Z',
        updatedAt: '2026-03-21T00:00:00.000Z',
      },
      hasUnreadResult: true,
      resultStatus: 'generated_draft',
    }));

    expect(resolvePartnerRecruitLayoutState(panelView)).toEqual({
      showMetaCards: false,
      flattenPreviewCard: true,
    });
  });

  it('失败结果态仍应保留顶部信息卡且不压平结果卡片', () => {
    const panelView = resolvePartnerRecruitPanelView(buildRecruitStatus({
      currentJob: {
        generationId: 'failed-job',
        status: 'failed',
        requestedBaseModel: null,
        previewExpireAt: null,
        preview: null,
        errorMessage: '招募失败',
        refundedAt: null,
        createdAt: '2026-03-21T00:00:00.000Z',
        updatedAt: '2026-03-21T00:00:00.000Z',
      },
      hasUnreadResult: true,
      resultStatus: 'failed',
    }));

    expect(resolvePartnerRecruitLayoutState(panelView)).toEqual({
      showMetaCards: true,
      flattenPreviewCard: false,
    });
  });
});
