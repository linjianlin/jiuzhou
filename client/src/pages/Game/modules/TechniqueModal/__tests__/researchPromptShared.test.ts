import { describe, expect, it } from 'vitest';
import {
  TECHNIQUE_RESEARCH_BURNING_WORD_LABEL,
  buildTechniqueResearchBurningWordHelperText,
  buildTechniqueResearchBurningWordTagText,
  getTechniqueResearchBurningWordInputLength,
  normalizeTechniqueResearchBurningWordInput,
  resolveTechniqueResearchBurningWordDisplayValue,
  resolveTechniqueResearchBurningWordRequestValue,
} from '../researchPromptShared';

describe('researchPromptShared', () => {
  it('normalizeTechniqueResearchBurningWordInput: 应按上限保留中文字符', () => {
    expect(normalizeTechniqueResearchBurningWordInput(' 焰火流 ', 2)).toBe('焰火');
    expect(normalizeTechniqueResearchBurningWordInput('a焰b火c', 2)).toBe('焰火');
  });

  it('normalizeTechniqueResearchBurningWordInput: 非中文输入应被清空', () => {
    expect(normalizeTechniqueResearchBurningWordInput('abc', 1)).toBe('');
  });

  it('resolveTechniqueResearchBurningWordDisplayValue: 组合输入阶段应保留原始值', () => {
    expect(resolveTechniqueResearchBurningWordDisplayValue('yan', 2, true)).toBe('yan');
    expect(resolveTechniqueResearchBurningWordDisplayValue('焰火流', 2, false)).toBe('焰火');
  });

  it('resolveTechniqueResearchBurningWordRequestValue: 留空应返回 undefined', () => {
    expect(resolveTechniqueResearchBurningWordRequestValue('', 2)).toBeUndefined();
    expect(resolveTechniqueResearchBurningWordRequestValue('焰', 2)).toBe('焰');
    expect(resolveTechniqueResearchBurningWordRequestValue(' a焰火流 ', 2)).toBe('焰火');
  });

  it('getTechniqueResearchBurningWordInputLength: 应按字符数统计', () => {
    expect(getTechniqueResearchBurningWordInputLength('焰火')).toBe(2);
  });

  it('应输出统一的帮助文案与回显标签', () => {
    expect(buildTechniqueResearchBurningWordHelperText(2)).toContain('不会突破原有强度规则');
    expect(buildTechniqueResearchBurningWordHelperText(2)).toContain(TECHNIQUE_RESEARCH_BURNING_WORD_LABEL);
    expect(buildTechniqueResearchBurningWordTagText('焰火')).toBe(`${TECHNIQUE_RESEARCH_BURNING_WORD_LABEL} 焰火`);
  });
});
