/**
 * 伙伴招募功法数值约束测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证伙伴招募复用了常规功法的被动预算上限，避免 AI 生成夸张的天生功法数值。
 * 2. 做什么：锁定提示词输入里会暴露被动预算指南，确保模型约束与服务端校验共享同一来源。
 * 3. 不做什么：不覆盖招募落库、不覆盖 worker，只验证共享规则纯函数。
 *
 * 输入/输出：
 * - 输入：伙伴招募草稿、目标品质。
 * - 输出：草稿是否合法，以及提示词输入中的被动预算指南。
 *
 * 数据流/状态流：
 * 招募模型输出 -> validatePartnerRecruitDraft -> 伙伴招募服务；品质 -> buildPartnerRecruitPromptInput -> 模型提示词。
 *
 * 关键边界条件与坑点：
 * 1. 百分比被动必须继续用小数表达，不能把 50% 写成 50。
 * 2. flat/percent 两种被动共用一套预算来源，但每个 key 的 `maxTotal` 不同，校验必须按 key 区分。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type PartnerRecruitDraft,
  buildPartnerRecruitPromptInput,
  validatePartnerRecruitDraft,
} from '../shared/partnerRecruitRules.js';

const buildValidDraft = (): PartnerRecruitDraft => ({
  partner: {
    name: '岩迟',
    description: '出身边荒的少年行脚客，沉稳寡言，惯以厚重步伐护住同伴，在乱战中稳稳撑起前线。',
    quality: '黄' as const,
    attributeElement: 'tu' as const,
    role: '护卫' as const,
    maxTechniqueSlots: 2,
    baseAttrs: {
      max_qixue: 260,
      max_lingqi: 90,
      wugong: 24,
      fagong: 16,
      wufang: 36,
      fafang: 22,
      sudu: 42,
      mingzhong: 0,
      shanbi: 0,
      zhaojia: 0,
      baoji: 0,
      baoshang: 0,
      jianbaoshang: 0,
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
      qixue_huifu: 7,
      lingqi_huifu: 5,
    },
    levelAttrGains: {
      max_qixue: 30,
      max_lingqi: 9,
      wugong: 3,
      fagong: 2,
      wufang: 5,
      fafang: 3,
      sudu: 2,
      mingzhong: 0,
      shanbi: 0,
      zhaojia: 0,
      baoji: 0,
      baoshang: 0,
      jianbaoshang: 0,
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
      qixue_huifu: 1,
      lingqi_huifu: 1,
    },
  },
  innateTechniques: [{
    name: '砂幕诀',
    description: '以灵砂凝成护体砂幕，入阵时为自身添甲，久战更显沉稳。',
    kind: 'guard' as const,
    passiveKey: 'wufang' as const,
    passiveValue: 0.1,
  }],
});

test('buildPartnerRecruitPromptInput: 应暴露与常规功法一致的被动预算指南', () => {
  const promptInput = buildPartnerRecruitPromptInput('黄');
  const guide = promptInput.passiveValueGuideByKey;

  assert.deepEqual(guide, {
    max_qixue: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    wugong: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    fagong: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    wufang: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    fafang: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    sudu: { mode: 'flat', maxPerLayer: 10, maxTotal: 20 },
    zengshang: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
    zhiliao: { mode: 'percent', maxPerLayer: 0.05, maxTotal: 0.1 },
  });
});

test('validatePartnerRecruitDraft: 合法预算内的天生功法应通过校验', () => {
  const draft = buildValidDraft();

  assert.notEqual(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: 超出常规功法累计上限的被动值应被拒绝', () => {
  const draft = buildValidDraft();
  draft.innateTechniques[0] = {
    ...draft.innateTechniques[0],
    passiveValue: 0.5,
  };

  assert.equal(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: flat 被动也应遵守对应累计上限', () => {
  const draft = buildValidDraft();
  draft.innateTechniques[0] = {
    ...draft.innateTechniques[0],
    passiveKey: 'sudu',
    passiveValue: 21,
  };

  assert.equal(validatePartnerRecruitDraft(draft), null);
});
