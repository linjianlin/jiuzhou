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

test('buildTechniqueGenerationTextModelRequest: 主提示应明确禁止在 upgrades.changes 顶层直接写 scaleRate 等 effect 字段', () => {
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
    parsedUserMessage.constraints?.upgradeRule?.includes('也严禁把 scaleRate/value/baseValue/valueType/scaleAttr/duration/chance 这类 effect 字段直接写在 changes 顶层。'),
    true,
  );
});
