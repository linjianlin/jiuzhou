import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN,
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID,
  shouldTechniqueResearchBypassCooldownWithToken,
  shouldTechniqueResearchUseCooldownBypassToken,
} from '../shared/techniqueResearchCooldownBypass.js';

test('shouldTechniqueResearchUseCooldownBypassToken: 启用时应要求消耗研修令牌', () => {
  assert.equal(shouldTechniqueResearchUseCooldownBypassToken(true), true);
  assert.equal(shouldTechniqueResearchUseCooldownBypassToken(false), false);
});

test('shouldTechniqueResearchBypassCooldownWithToken: 启用研修令牌后应绕过冷却', () => {
  assert.equal(TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID, 'token-005');
  assert.equal(TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST, 1);
  assert.equal(TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN, true);
  assert.equal(shouldTechniqueResearchBypassCooldownWithToken(true), true);
  assert.equal(shouldTechniqueResearchBypassCooldownWithToken(false), false);
});
