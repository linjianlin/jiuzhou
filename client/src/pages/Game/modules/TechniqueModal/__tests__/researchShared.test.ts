import { describe, expect, it } from 'vitest';
import type { TechniqueResearchStatusData } from '../researchShared';
import {
  formatTechniqueResearchCooldownRemaining,
  resolveTechniqueResearchActionState,
  resolveTechniqueResearchCooldownDisplay,
  resolveTechniqueResearchCurrentFragmentCost,
  resolveTechniqueResearchSubmitState,
} from '../researchShared';

const buildStatus = (
  overrides: Partial<TechniqueResearchStatusData> = {},
): TechniqueResearchStatusData => ({
  unlockRealm: '炼炁化神·结胎期',
  unlocked: true,
  fragmentBalance: 6_000,
  fragmentCost: 5_000,
  cooldownBypassFragmentCost: 2_500,
  cooldownHours: 72,
  cooldownUntil: null,
  cooldownRemainingSeconds: 0,
  cooldownBypassTokenBypassesCooldown: true,
  cooldownBypassTokenCost: 1,
  cooldownBypassTokenItemName: '顿悟符',
  cooldownBypassTokenAvailableQty: 1,
  burningWordPromptMaxLength: 2,
  currentDraft: null,
  draftExpireAt: null,
  nameRules: {
    minLength: 2,
    maxLength: 12,
    fixedPrefix: '',
    patternHint: '',
    immutableAfterPublish: true,
  },
  currentJob: null,
  hasUnreadResult: false,
  resultStatus: null,
  ...overrides,
});

describe('researchShared', () => {
  it('resolveTechniqueResearchActionState: pending 任务应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      currentJob: {
        generationId: 'gen-1',
        status: 'pending',
        quality: '玄',
        modelName: null,
        burningWordPrompt: null,
        draftTechniqueId: null,
        startedAt: '2026-03-08T10:00:00.000Z',
        finishedAt: null,
        draftExpireAt: null,
        preview: null,
        errorMessage: null,
      },
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 259_200,
    }), false);

    expect(actionState.canGenerate).toBe(false);
  });

  it('resolveTechniqueResearchActionState: 冷却中时应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), false);

    expect(actionState.canGenerate).toBe(false);
  });

  it('resolveTechniqueResearchActionState: 冷却中但启用顿悟符时应允许开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(actionState.canGenerate).toBe(true);
  });

  it('resolveTechniqueResearchCurrentFragmentCost: 启用顿悟符时应切换到折后残页消耗', () => {
    expect(resolveTechniqueResearchCurrentFragmentCost(buildStatus(), true)).toBe(2_500);
    expect(resolveTechniqueResearchCurrentFragmentCost(buildStatus(), false)).toBe(5_000);
  });

  it('resolveTechniqueResearchActionState: 未解锁时应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      unlocked: false,
    }), false);

    expect(actionState.canGenerate).toBe(false);
  });

  it('resolveTechniqueResearchActionState: 无 pending 且资源充足且冷却结束时应允许开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus(), false);

    expect(actionState.canGenerate).toBe(true);
  });

  it('resolveTechniqueResearchActionState: 功法残页不足时应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      fragmentBalance: 2_499,
    }), true);

    expect(actionState.canGenerate).toBe(false);
  });

  it('resolveTechniqueResearchActionState: 启用顿悟符后余额达到折后成本时应允许开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      fragmentBalance: 2_500,
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(actionState.canGenerate).toBe(true);
  });

  it('resolveTechniqueResearchActionState: 有草稿待抄写时应继续禁止开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      currentJob: {
        generationId: 'gen-2',
        status: 'generated_draft',
        quality: '地',
        modelName: 'gpt-4o-mini',
        burningWordPrompt: '焰',
        draftTechniqueId: 'draft-1',
        startedAt: '2026-03-08T10:00:00.000Z',
        finishedAt: '2026-03-08T10:05:00.000Z',
        draftExpireAt: '2026-03-09T10:05:00.000Z',
        preview: {
          draftTechniqueId: 'draft-1',
          aiSuggestedName: '太玄真解',
          quality: '地',
          type: '心法',
          maxLayer: 7,
          description: '测试草稿',
          longDesc: '测试草稿长描述',
          skillNames: [],
          skills: [],
        },
        errorMessage: null,
      },
    }), true);

    expect(actionState.canGenerate).toBe(false);
  });

  it('resolveTechniqueResearchCooldownDisplay: 启用顿悟符时应展示统一冷却豁免提示', () => {
    const cooldownDisplay = resolveTechniqueResearchCooldownDisplay(buildStatus({
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(cooldownDisplay.statusText).toBe('本次推演无冷却');
    expect(cooldownDisplay.ruleText).toContain('不会重置或新增研修冷却');
    expect(cooldownDisplay.bypassedByToken).toBe(true);
  });

  it('resolveTechniqueResearchSubmitState: 启用顿悟符但令牌不足时应禁止提交', () => {
    const submitState = resolveTechniqueResearchSubmitState(buildStatus({
      cooldownBypassTokenAvailableQty: 0,
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }), true);

    expect(submitState.canSubmit).toBe(false);
    expect(submitState.disabledReason).toContain('顿悟符不足');
  });

  it('formatTechniqueResearchCooldownRemaining: 应输出紧凑冷却文案', () => {
    expect(formatTechniqueResearchCooldownRemaining(172_800)).toBe('2天');
    expect(formatTechniqueResearchCooldownRemaining(3_661)).toBe('1小时1分');
    expect(formatTechniqueResearchCooldownRemaining(59)).toBe('59秒');
  });
});
