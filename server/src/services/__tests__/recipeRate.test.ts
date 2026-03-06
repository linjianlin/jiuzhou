import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipeRateToPercent, normalizeRecipeRateToRatio } from '../shared/recipeRate.js';

test('gem_synthesis 概率应按 0~1 小数换算为百分比', () => {
  assert.equal(normalizeRecipeRateToPercent(0.85, 'gem_synthesis', 1), 85);
  assert.equal(normalizeRecipeRateToRatio(0.85, 'gem_synthesis', 1), 0.85);
});

test('普通配方概率应按 0~100 百分数换算为比例', () => {
  assert.equal(normalizeRecipeRateToPercent(85, 'craft', 1), 85);
  assert.equal(normalizeRecipeRateToRatio(85, 'craft', 1), 0.85);
});

test('普通配方返还率应按 0~100 百分数换算为比例', () => {
  assert.equal(normalizeRecipeRateToRatio(50, 'craft', 0), 0.5);
  assert.equal(normalizeRecipeRateToPercent(50, 'craft', 0), 50);
});
