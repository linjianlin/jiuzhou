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
  buildPartnerRecruitPromptNoiseHash,
  buildPartnerRecruitPromptInput,
  fillPartnerRecruitBaseAttrs,
  validatePartnerRecruitDraft,
} from '../shared/partnerRecruitRules.js';
import {
  PARTNER_RECRUIT_FORM_RULES,
} from '../shared/partnerRecruitCreativeDirection.js';
import { buildPartnerBattleAttrs } from '../shared/partnerRules.js';

const DEFAULT_BASE_ATTRS: PartnerRecruitDraft['partner']['baseAttrs'] = {
  max_qixue: 230,
  max_lingqi: 90,
  wugong: 24,
  fagong: 16,
  wufang: 36,
  fafang: 22,
  sudu: 5,
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
};

const DEFAULT_LEVEL_ATTR_GAINS: PartnerRecruitDraft['partner']['levelAttrGains'] = {
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
};

const buildValidDraft = (
  overrides?: Omit<Partial<PartnerRecruitDraft['partner']>, 'baseAttrs' | 'levelAttrGains'> & {
    baseAttrs?: Partial<PartnerRecruitDraft['partner']['baseAttrs']>;
    levelAttrGains?: Partial<PartnerRecruitDraft['partner']['levelAttrGains']>;
  },
  innateTechniques: PartnerRecruitDraft['innateTechniques'] = [{
    name: '砂幕诀',
    description: '以灵砂凝成护体砂幕，入阵时为自身添甲，久战更显沉稳。',
    kind: 'guard' as const,
    passiveKey: 'wufang' as const,
    passiveValue: 0.1,
  }],
): PartnerRecruitDraft => ({
  partner: {
    name: '岩迟',
    description: '出身边荒的少年行脚客，沉稳寡言，惯以厚重步伐护住同伴，在乱战中稳稳撑起前线。',
    quality: '黄' as const,
    attributeElement: 'tu' as const,
    role: '护卫',
    combatStyle: 'physical',
    maxTechniqueSlots: 2,
    ...overrides,
    baseAttrs: {
      ...DEFAULT_BASE_ATTRS,
      ...overrides?.baseAttrs,
    },
    levelAttrGains: {
      ...DEFAULT_LEVEL_ATTR_GAINS,
      ...overrides?.levelAttrGains,
    },
  },
  innateTechniques,
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

test('buildPartnerRecruitPromptInput: 应向 AI 注入青木小偶参考模板', () => {
  const promptInput = buildPartnerRecruitPromptInput('黄');
  const referencePartnerExample = promptInput.referencePartnerExample as {
    partner?: {
      name?: string;
      combatStyle?: string;
      baseAttrs?: { max_qixue?: number };
      levelAttrGains?: { sudu?: number; qixue_huifu?: number };
    };
  } | undefined;

  assert.equal(referencePartnerExample?.partner?.name, '青木小偶');
  assert.equal(referencePartnerExample?.partner?.combatStyle, 'physical');
  assert.equal(referencePartnerExample?.partner?.baseAttrs?.max_qixue, 220);
  assert.equal(referencePartnerExample?.partner?.levelAttrGains?.sudu, 0.01);
  assert.equal(referencePartnerExample?.partner?.levelAttrGains?.qixue_huifu, 0.2);
});

test('buildPartnerRecruitPromptInput: 应放开 role 枚举并要求显式提供 combatStyle', () => {
  const promptInput = buildPartnerRecruitPromptInput('黄') as {
    constraints?: string[];
    techniqueCount?: unknown;
    allowedRoles?: unknown;
    allowedCombatStyles?: string[];
  };

  assert.equal(promptInput.techniqueCount, 1);
  assert.equal(promptInput.allowedRoles, undefined);
  assert.deepEqual(promptInput.allowedCombatStyles, ['physical', 'magic']);
  assert.equal(
    promptInput.constraints?.includes(
      '品质高低顺序固定为 黄 < 玄 < 地 < 天；referencePartnerExample 中青木小偶的 quality=黄，表示它是最低品质参考模板，最终强度与风格仍必须以当前 quality 字段为准',
    ),
    true,
  );
  assert.equal(
    promptInput.constraints?.includes('innateTechniques 必须且只能生成 1 门天生功法，禁止多生成'),
    true,
  );
  assert.equal(
    promptInput.constraints?.includes('partner.combatStyle 必须严格从 allowedCombatStyles 中选择，用于决定攻击型天生功法走武技还是法诀；physical 表示偏武道，magic 表示偏术法'),
    true,
  );
  assert.equal(
    PARTNER_RECRUIT_FORM_RULES.every((rule) => promptInput.constraints?.includes(rule) === true),
    true,
  );
});

test('buildPartnerRecruitPromptInput: 应支持注入随机扰动 hash 且禁止显式输出', () => {
  const promptNoiseHash = buildPartnerRecruitPromptNoiseHash(20260315);
  const promptInput = buildPartnerRecruitPromptInput('黄', {
    promptNoiseHash,
  }) as {
    promptNoiseHash?: string;
    constraints?: string[];
  };

  assert.equal(promptInput.promptNoiseHash, promptNoiseHash);
  assert.equal(
    promptInput.constraints?.includes(
      '如果提供了 promptNoiseHash，它仅作为本次创作扰动码：只需隐式影响命名、描述意象、措辞节奏与功法文风，禁止解释、复述、拆解、计算或显式输出该字符串，也不要生成数字、字母、符号或密码感内容',
    ),
    true,
  );
});

test('validatePartnerRecruitDraft: 合法预算内的天生功法应通过校验', () => {
  const draft = buildValidDraft();

  assert.notEqual(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: 应允许自由发挥的 role 文本', () => {
  const draft = buildValidDraft({
    role: '傀儡师',
    combatStyle: 'magic',
  });

  assert.notEqual(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: 多于一门天生功法应被拒绝', () => {
  const draft = buildValidDraft(
    {
      maxTechniqueSlots: 4,
    },
    [
      {
        name: '砂幕诀',
        description: '以灵砂凝成护体砂幕，入阵时为自身添甲，久战更显沉稳。',
        kind: 'guard',
        passiveKey: 'wufang',
        passiveValue: 0.1,
      },
      {
        name: '归岳印',
        description: '行气归岳稳住周身脉势，使护体灵元层层叠起，越战越厚重。',
        kind: 'support',
        passiveKey: 'max_qixue',
        passiveValue: 0.1,
      },
    ],
  );

  assert.equal(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: 超出常规功法累计上限的被动值应被拒绝', () => {
  const draft = buildValidDraft();
  draft.innateTechniques[0] = {
    ...draft.innateTechniques[0],
    passiveValue: 0.5,
  };

  assert.equal(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: levelAttrGains 应支持全量非负数字成长', () => {
  const draft = buildValidDraft({
    levelAttrGains: {
      sudu: 0.01,
      baoji: 0.001,
      baoshang: 0.004,
      qixue_huifu: 0.2,
      lingqi_huifu: 0.15,
      kangbao: 0.001,
    },
  });

  assert.notEqual(validatePartnerRecruitDraft(draft), null);
});

test('validatePartnerRecruitDraft: 不应归一化成长小数', () => {
  const draft = buildValidDraft({
    levelAttrGains: {
      sudu: 0.01,
      qixue_huifu: 0.2,
      lingqi_huifu: 0.15,
    },
  });
  const parsed = validatePartnerRecruitDraft(draft);

  assert.equal(parsed?.partner.levelAttrGains.sudu, 0.01);
  assert.equal(parsed?.partner.levelAttrGains.qixue_huifu, 0.2);
  assert.equal(parsed?.partner.levelAttrGains.lingqi_huifu, 0.15);
});

test('fillPartnerRecruitBaseAttrs: 不应改写预览里的小数属性', () => {
  const attrs = fillPartnerRecruitBaseAttrs({
    sudu: 18.25,
    qixue_huifu: 0.2,
    lingqi_huifu: 0.15,
    baoji: 0.001,
  });

  assert.equal(attrs.sudu, 18.25);
  assert.equal(attrs.qixue_huifu, 0.2);
  assert.equal(attrs.lingqi_huifu, 0.15);
  assert.equal(attrs.baoji, 0.001);
});

test('buildPartnerBattleAttrs: 不应归一化伙伴结算后的属性小数', () => {
  const attrs = buildPartnerBattleAttrs({
    baseAttrs: {
      ...DEFAULT_BASE_ATTRS,
      sudu: 18,
      qixue_huifu: 2,
      lingqi_huifu: 1,
    },
    level: 2,
    levelAttrGains: {
      ...DEFAULT_LEVEL_ATTR_GAINS,
      sudu: 0.01,
      qixue_huifu: 0.2,
      lingqi_huifu: 0.15,
    },
    passiveAttrs: {},
    element: 'tu',
  });

  assert.equal(attrs.sudu, 18.01);
  assert.equal(attrs.qixue_huifu, 2.2);
  assert.equal(attrs.lingqi_huifu, 1.15);
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
