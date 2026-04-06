/**
 * 功法生成 HASH 扰动请求测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定功法生成共享核心会显式携带随机 seed，并把基于 seed 生成的扰动 hash 注入 prompt 输入。
 * 2. 做什么：确保洞府研修与伙伴天生功法复用的功法生成核心共用同一套 HASH 扰动入口，避免调用方各自拼接。
 * 3. 不做什么：不请求真实模型、不验证 candidate 清洗，也不覆盖落库链路。
 *
 * 输入/输出：
 * - 输入：功法类型、品质、最大层数、固定 seed、可选 extraContext。
 * - 输出：文本模型请求参数中的 seed、promptNoiseHash 与 userMessage。
 *
 * 数据流/状态流：
 * 固定 seed -> buildTechniqueGenerationTextModelRequest -> prompt 输入 JSON -> 文本模型调用。
 *
 * 关键边界条件与坑点：
 * 1. promptNoiseHash 必须与 seed 同源，否则不同调用方接入后会出现“同样 seed，不同扰动”的漂移。
 * 2. extraContext 仍需保留，避免本次接入 HASH 扰动时把伙伴招募已有的补充语境覆盖掉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTechniqueGenerationRetryPromptContext,
  buildTechniqueGenerationTextModelRequest,
} from '../shared/techniqueGenerationCandidateCore.js';
import {
  buildTechniqueAuraAttackPercentSoftRangePromptRule,
  buildTechniqueAuraPolarityPromptRule,
  TECHNIQUE_PROMPT_QIXUE_ATTACK_RATIO_RULE,
} from '../shared/techniqueGenerationConstraints.js';
import {
  TECHNIQUE_BURNING_WORD_PROMPT_GENERAL_RULE,
  TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_GENERAL_RULE,
  TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES,
} from '../shared/techniqueBurningWordPrompt.js';
import {
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_DIVERSITY_RULES,
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_GENERAL_RULE,
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_SCOPE_GENERAL_RULE,
  buildTechniqueRecentSuccessfulDescriptionPromptContext,
} from '../shared/techniqueRecentSuccessfulDescriptionPrompt.js';
import {
  TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE,
  TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES,
  buildTechniqueResearchCreativeDirectionPromptContext,
} from '../shared/techniqueResearchCreativeDirectionPrompt.js';
import {
  TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE,
} from '../shared/techniqueSkillGenerationSpec.js';
import {
  buildTextModelPromptNoiseHash,
  TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE,
} from '../shared/techniqueTextModelShared.js';

test('buildTechniqueGenerationTextModelRequest: 应显式传入 seed 并在 prompt 中注入对应扰动 hash', () => {
  const seed = 20260315;
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '武技',
    quality: '黄',
    maxLayer: 3,
    seed,
    promptContext: {
      source: 'unit-test',
    },
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    promptNoiseHash?: string;
    extraContext?: { source?: string };
  };

  assert.equal(request.seed, seed);
  assert.equal(parsedUserMessage.promptNoiseHash, buildTextModelPromptNoiseHash('technique-generation', seed));
  assert.equal(parsedUserMessage.extraContext?.source, 'unit-test');
});

test('buildTechniqueGenerationTextModelRequest: 提示词语境与作用范围限制应保留在 extraContext 中', () => {
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '法诀',
    quality: '地',
    maxLayer: 7,
    seed: 20260323,
    promptContext: {
      techniqueBurningWordPrompt: '焰心',
      techniqueBurningWordPromptScopeRules: [...TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES],
    },
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    extraContext?: {
      techniqueBurningWordPrompt?: string;
      techniqueBurningWordPromptScopeRules?: string[];
    };
    constraints?: { generalRules?: string[] };
  };

  assert.equal(parsedUserMessage.extraContext?.techniqueBurningWordPrompt, '焰心');
  assert.deepEqual(parsedUserMessage.extraContext?.techniqueBurningWordPromptScopeRules, [
    ...TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES,
  ]);
  assert.equal(
    parsedUserMessage.extraContext?.techniqueBurningWordPromptScopeRules?.includes(
      '若提示词与当前功法类型不完全贴合，应做同主题的合理化转译；可以保留更鲜明的核心套路与招式母题，但不要为了迎合提示词强行拼接多体系、全覆盖或违和机制。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.extraContext?.techniqueBurningWordPromptScopeRules?.includes(
      '可以把提示词延展成更鲜明、更偏锋的套路气质与招式表现，但不要生成全能通吃、超大范围、多段超高倍率、超长控制、超高回复或明显超出既有硬约束与预算的功法。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_BURNING_WORD_PROMPT_GENERAL_RULE,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_GENERAL_RULE,
    ),
    true,
  );
});

test('buildTechniqueGenerationTextModelRequest: 最近成功生成功法参考应透传到 extraContext 并声明差异化规则', () => {
  const promptContext = buildTechniqueRecentSuccessfulDescriptionPromptContext([
    {
      name: '焚潮诀',
      quality: '地',
      type: '法诀',
      description: '以火潮叠势灼烧敌阵，越拖越烈。',
      longDesc: '借焰潮层层加压，待敌方印记满盈后引爆灵焰，形成后发制人的法诀节奏。',
    },
    {
      name: '回岳篇',
      quality: '玄',
      type: '心法',
      description: '行气归岳，守中反震。',
      longDesc: '先稳住周身脉势，再把承受的冲击转为护体反震，越守越厚重。',
    },
  ]);
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '武技',
    quality: '天',
    maxLayer: 9,
    seed: 20260326,
    promptContext,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    extraContext?: {
      techniqueRecentSuccessfulDescriptions?: Array<{
        name?: string;
        quality?: string;
        type?: string;
        description?: string;
        longDesc?: string;
      }>;
      techniqueRecentSuccessfulDescriptionDiversityRules?: string[];
    };
    constraints?: { generalRules?: string[] };
  };

  assert.deepEqual(parsedUserMessage.extraContext?.techniqueRecentSuccessfulDescriptions, [
    {
      name: '焚潮诀',
      quality: '地',
      type: '法诀',
      description: '以火潮叠势灼烧敌阵，越拖越烈。',
      longDesc: '借焰潮层层加压，待敌方印记满盈后引爆灵焰，形成后发制人的法诀节奏。',
    },
    {
      name: '回岳篇',
      quality: '玄',
      type: '心法',
      description: '行气归岳，守中反震。',
      longDesc: '先稳住周身脉势，再把承受的冲击转为护体反震，越守越厚重。',
    },
  ]);
  assert.deepEqual(
    parsedUserMessage.extraContext?.techniqueRecentSuccessfulDescriptionDiversityRules,
    [...TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_DIVERSITY_RULES],
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_GENERAL_RULE,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_SCOPE_GENERAL_RULE,
    ),
    true,
  );
});

test('buildTechniqueGenerationTextModelRequest: 洞府研修专属创作方向应通过 extraContext 注入，而不是写死为共享直接规则', () => {
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '心法',
    quality: '地',
    maxLayer: 7,
    seed: 20260327,
    promptContext: buildTechniqueResearchCreativeDirectionPromptContext(),
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    extraContext?: {
      techniqueResearchCreativeDirectionRules?: string[];
    };
    constraints?: { generalRules?: string[] };
  };

  assert.deepEqual(
    parsedUserMessage.extraContext?.techniqueResearchCreativeDirectionRules,
    [...TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES],
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_PROMPT_QIXUE_ATTACK_RATIO_RULE,
    ),
    true,
  );
});

test('buildTechniqueGenerationRetryPromptContext: 应保留原语境并注入重复 effect 纠偏约束', () => {
  const promptContext = buildTechniqueGenerationRetryPromptContext({
    promptContext: { source: 'unit-test' },
    previousFailureReason: 'AI结果技能效果非法：skill.effects 不允许包含重复 effect',
  });

  assert.equal(promptContext?.source, 'unit-test');

  type RetryPromptContext = {
    previousFailureReason?: string;
    correctionRules?: string[];
  };

  const retryGuidance = promptContext?.techniqueRetryGuidance as RetryPromptContext | undefined;
  assert.equal(retryGuidance?.previousFailureReason, 'AI结果技能效果非法：skill.effects 不允许包含重复 effect');
  assert.equal(
    retryGuidance?.correctionRules?.includes('同一技能的 effects 数组内，任意两个 effect 对象都不能完全相同。'),
    true,
  );
  assert.equal(
    retryGuidance?.correctionRules?.includes('如果只是想增强同一效果，请直接提高该 effect 的 value、baseValue、scaleRate 或 duration，不要新增重复对象。'),
    true,
  );
});

test('buildTechniqueGenerationRetryPromptContext: 升级项把 scaleRate 写在 changes 顶层时应注入定向纠偏约束', () => {
  const promptContext = buildTechniqueGenerationRetryPromptContext({
    promptContext: { source: 'unit-test' },
    previousFailureReason: 'AI结果技能升级配置非法：upgrades.changes 包含未支持字段：scaleRate',
  });

  type RetryPromptContext = {
    previousFailureReason?: string;
    correctionRules?: string[];
  };

  const retryGuidance = promptContext?.techniqueRetryGuidance as RetryPromptContext | undefined;
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      'upgrades.changes 不能直接写 scaleRate；它属于单个 effect 的内部字段，不属于升级改动顶层键。',
    ),
    true,
  );
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      '如果要修改已有效果中的 scaleRate，必须改写 changes.effects，提供完整 effects 数组；不要返回 changes.scaleRate。',
    ),
    true,
  );
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      '错误示例：{"layer":3,"changes":{"scaleRate":1.8}}',
    ),
    true,
  );
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      '正确示例：{"layer":3,"changes":{"effects":[{"type":"damage","valueType":"scale","scaleAttr":"wugong","scaleRate":1.8,"damageType":"physical","element":"none","hit_count":1}]}}',
    ),
    true,
  );
});

test('buildTechniqueGenerationRetryPromptContext: 升级项超预算总伤害倍率应注入定向纠偏约束', () => {
  const promptContext = buildTechniqueGenerationRetryPromptContext({
    promptContext: { source: 'unit-test' },
    previousFailureReason: `AI结果技能升级配置非法：upgrades.changes.effects.scaleRate × hit_count 不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
  });

  type RetryPromptContext = {
    previousFailureReason?: string;
    correctionRules?: string[];
  };

  const retryGuidance = promptContext?.techniqueRetryGuidance as RetryPromptContext | undefined;
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      '只有升级链路需要限制总伤害倍率；基础技能 effects 不受这条规则约束。',
    ),
    true,
  );
  assert.equal(
    retryGuidance?.correctionRules?.includes(
      `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则总倍率（scaleRate × hit_count）不能超过 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}。`,
    ),
    true,
  );
});

test('buildTechniqueGenerationTextModelRequest: 重试语境存在时应把纠偏规则提升到主提示并降低 temperature', () => {
  const retryPromptContext = buildTechniqueGenerationRetryPromptContext({
    promptContext: { source: 'unit-test' },
    previousFailureReason: 'AI结果技能效果非法：skill.effects 不允许包含重复 effect',
  });
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '辅修',
    quality: '玄',
    maxLayer: 5,
    seed: 20260319,
    promptContext: retryPromptContext,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    retryGuidance?: {
      previousFailureReason?: string;
      correctionRules?: string[];
    };
    extraContext?: {
      source?: string;
      techniqueRetryGuidance?: {
        previousFailureReason?: string;
      };
    };
  };

  assert.equal(request.temperature, TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE);
  assert.equal(parsedUserMessage.retryGuidance?.previousFailureReason, 'AI结果技能效果非法：skill.effects 不允许包含重复 effect');
  assert.equal(parsedUserMessage.extraContext?.source, 'unit-test');
  assert.equal(
    parsedUserMessage.extraContext?.techniqueRetryGuidance?.previousFailureReason,
    'AI结果技能效果非法：skill.effects 不允许包含重复 effect',
  );
});

test('buildTechniqueGenerationTextModelRequest: 主提示应允许围绕核心机制做更鲜明的套路与文风设计', () => {
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '心法',
    quality: '地',
    maxLayer: 7,
    seed: 20260324,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    constraints?: {
      generalRules?: string[];
    };
  };

  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      '功法可以围绕 1~2 个核心机制展开，不必平均覆盖输出、控制、生存、回复等所有方向。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      '允许采用偏科、连段、蓄势、印记、反制、献祭、铺场、光环、延迟爆发等鲜明套路；只要主题统一且满足既有硬约束，不必为了“全面”强行补齐无关效果。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      'skills、layers 与 layerDesc 应服务同一核心套路的递进深化；允许多个层级持续强化同一机制，不必为追求差异而频繁换套路。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      '命名、description、longDesc、layerDesc 与 skill.description 可以更有门派感、人物气质和招式辨识度，避免模板化套话。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE,
    ),
    true,
  );
});

test('buildTechniqueGenerationTextModelRequest: 主提示应明确升级链路的伤害总倍率预算', () => {
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '武技',
    quality: '天',
    maxLayer: 9,
    seed: 20260319,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    constraints?: {
      generalRules?: string[];
      outputChecklist?: string[];
      upgradeRule?: string;
    };
  };

  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      'value/valueType/baseValue/scaleAttr/scaleRate/duration/chance 等 effect 内字段不得直接放在 upgrades[*].changes 顶层，只能写进 changes.effects[*] 或 changes.addEffect',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.outputChecklist?.includes(
      'scaleRate/value/baseValue/valueType/scaleAttr/duration/chance 等 effect 字段不得直接出现在 upgrades[*].changes 顶层',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.outputChecklist?.includes(
      `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.upgradeRule?.includes('也严禁把 scaleRate/value/baseValue/valueType/scaleAttr/duration/chance 这类 effect 字段直接写在 changes 顶层。'),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.upgradeRule?.includes(
      `升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}。`,
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      'buffKind=aura 的 auraEffects 若包含进攻类百分比 attr 增益（如法攻/物攻/暴击/暴伤/增伤），请参考接近天品强度的建议范围设计总和，不要再按品质拆固定上限，也不要为了凑满范围硬塞数值。',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      buildTechniqueAuraAttackPercentSoftRangePromptRule(),
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      buildTechniqueAuraPolarityPromptRule(),
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.outputChecklist?.includes(
      'buffKind=aura 若包含多个进攻类百分比 attr Buff，请参考 numericRanges.effect.auraAttackPercentSuggestedRange 设计总和，不要再按品质拆固定上限',
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.outputChecklist?.includes(
      buildTechniqueAuraAttackPercentSoftRangePromptRule(),
    ),
    true,
  );
  assert.equal(
    parsedUserMessage.constraints?.outputChecklist?.includes(
      buildTechniqueAuraPolarityPromptRule(),
    ),
    true,
  );
});

test('buildTechniqueGenerationTextModelRequest: 主提示应暴露 effectTargetEnum 与最新默认目标规则', () => {
  const request = buildTechniqueGenerationTextModelRequest({
    techniqueType: '武技',
    quality: '地',
    maxLayer: 7,
    seed: 20260402,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    constraints?: {
      generalRules?: string[];
      effectTargetEnum?: string[];
      effectGuideByType?: {
        buff?: { optional?: string[]; rules?: string[] };
        debuff?: { optional?: string[]; rules?: string[] };
      };
    };
  };

  assert.equal(
    parsedUserMessage.constraints?.generalRules?.includes(
      'buff 未填写 target 时默认施加给自身；debuff 未填写 target 时默认命中敌方目标；heal/shield/cleanse/cleanse_control/restore_lingqi 与正向 resource 若技能主目标是敌方，则未填 target 时默认作用自身，否则默认跟随技能主目标',
    ),
    true,
  );
  assert.deepEqual(parsedUserMessage.constraints?.effectTargetEnum, ['self', 'target', 'enemy', 'ally']);
  assert.equal(parsedUserMessage.constraints?.effectGuideByType?.buff?.optional?.includes('target'), true);
  assert.equal(parsedUserMessage.constraints?.effectGuideByType?.debuff?.optional?.includes('target'), true);
});
