import { describe, expect, it } from 'vitest';
import type { TechniqueResearchStatusData } from '../researchShared';
import {
  formatTechniqueResearchCooldownRemaining,
  resolveTechniqueResearchActionState,
} from '../researchShared';

const buildStatus = (
  overrides: Partial<TechniqueResearchStatusData> = {},
): TechniqueResearchStatusData => ({
  fragmentBalance: 6_000,
  fragmentCost: 5_000,
  cooldownHours: 72,
  cooldownUntil: null,
  cooldownRemainingSeconds: 0,
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
  it('resolveTechniqueResearchActionState: pending 任务应暴露放弃入口并禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      currentJob: {
        generationId: 'gen-1',
        status: 'pending',
        quality: '玄',
        draftTechniqueId: null,
        startedAt: '2026-03-08T10:00:00.000Z',
        finishedAt: null,
        draftExpireAt: null,
        preview: null,
        errorMessage: null,
      },
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 259_200,
    }));

    expect(actionState.canGenerate).toBe(false);
    expect(actionState.pendingGenerationId).toBe('gen-1');
  });

  it('resolveTechniqueResearchActionState: 冷却中时应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      cooldownUntil: '2026-03-11T10:00:00.000Z',
      cooldownRemainingSeconds: 3_600,
    }));

    expect(actionState.canGenerate).toBe(false);
    expect(actionState.pendingGenerationId).toBeNull();
  });

  it('resolveTechniqueResearchActionState: 无 pending 且资源充足且冷却结束时应允许开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus());

    expect(actionState.canGenerate).toBe(true);
    expect(actionState.pendingGenerationId).toBeNull();
  });

  it('resolveTechniqueResearchActionState: 功法残页不足时应禁用开始领悟', () => {
    const actionState = resolveTechniqueResearchActionState(buildStatus({
      fragmentBalance: 4_999,
    }));

    expect(actionState.canGenerate).toBe(false);
    expect(actionState.pendingGenerationId).toBeNull();
  });

  it('formatTechniqueResearchCooldownRemaining: 应输出紧凑冷却文案', () => {
    expect(formatTechniqueResearchCooldownRemaining(172_800)).toBe('2天');
    expect(formatTechniqueResearchCooldownRemaining(3_661)).toBe('1小时1分');
    expect(formatTechniqueResearchCooldownRemaining(59)).toBe('59秒');
  });
});
