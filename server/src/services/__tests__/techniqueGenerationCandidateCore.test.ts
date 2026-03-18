/**
 * AI 功法 candidate 清洗回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定模型输出混用 camelCase / snake_case 时，功法技能与层级字段仍会被统一清洗进标准 candidate。
 * 2. 做什么：覆盖“layer 用 upgrade_skill_ids 指向技能升级，升级里的 cooldown 增量可继续进入战斗链路”这条自研技能冷却关键路径。
 * 3. 不做什么：不请求真实模型、不落数据库，也不覆盖发布/装备接口。
 *
 * 输入/输出：
 * - 输入：模拟的模型原始 JSON。
 * - 输出：清洗后的 candidate，以及升级应用后的技能数值断言。
 *
 * 数据流/状态流：
 * 模型原始 JSON -> sanitizeTechniqueGenerationCandidateFromModel -> candidate.layers/skills
 * -> applySkillUpgradeChanges -> 冷却增量写回技能战斗数据。
 *
 * 关键边界条件与坑点：
 * 1. 只要 AI 把 `upgradeSkillIds` 写成 `upgrade_skill_ids`，旧实现就会静默丢失技能升级挂载，表现为战斗拿不到升级后的冷却。
 * 2. 技能基础字段也可能混用 `cost_lingqi/target_type/ai_priority`；若清洗层不统一归一化，就会让预览、落库、战斗三条链口径分裂。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applySkillUpgradeChanges } from '../battle/shared/skills.js';
import type { SkillEffect } from '../../battle/types.js';
import {
  sanitizeTechniqueGenerationCandidateFromModel,
  validateTechniqueGenerationCandidate,
} from '../shared/techniqueGenerationCandidateCore.js';

test('sanitizeTechniqueGenerationCandidateFromModel: 应兼容 snake_case 层级与技能字段，并让冷却升级继续可用', () => {
  const raw = {
    technique: {
      name: '照渊真诀',
      required_realm: '凡人',
      attribute_type: 'magic',
      attribute_element: 'shui',
      description: '测试功法',
      long_desc: '测试功法长描述',
      tags: ['测试'],
    },
    skills: [
      {
        id: 'skill-zhaoyuan',
        name: '照渊凝心',
        description: '获得护盾并恢复灵气',
        cost_lingqi: 18,
        cost_lingqi_rate: 0,
        cost_qixue: 0,
        cost_qixue_rate: 0,
        cooldown: 0,
        target_type: 'self',
        target_count: 1,
        damage_type: 'magic',
        element: 'shui',
        ai_priority: 72,
        effects: [
          {
            type: 'shield',
            valueType: 'scale',
            scaleAttr: 'fagong',
            scaleRate: 1.1,
          },
        ],
        upgrades: [
          {
            layer: 2,
            changes: {
              cooldown: 2,
            },
          },
        ],
      },
    ],
    layers: [
      {
        layer: 1,
        cost_spirit_stones: 100,
        cost_exp: 50,
        passives: [{ key: 'fagong', value: 12 }],
        unlock_skill_ids: ['skill-zhaoyuan'],
        upgrade_skill_ids: [],
        layer_desc: '入门',
      },
      {
        layer: 2,
        cost_spirit_stones: 200,
        cost_exp: 100,
        passives: [{ key: 'fagong', value: 18 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: ['skill-zhaoyuan'],
        layer_desc: '精进',
      },
      {
        layer: 3,
        cost_spirit_stones: 300,
        cost_exp: 150,
        passives: [{ key: 'fagong', value: 24 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: [],
        layer_desc: '圆满',
      },
    ],
  };

  const candidate = sanitizeTechniqueGenerationCandidateFromModel(raw, '武技', '黄', 3);
  assert.ok(candidate);

  const validation = validateTechniqueGenerationCandidate({
    candidate,
    expectedTechniqueType: '武技',
    expectedQuality: '黄',
    expectedMaxLayer: 3,
  });
  assert.deepEqual(validation, { success: true });

  assert.equal(candidate.technique.requiredRealm, '凡人');
  assert.equal(candidate.technique.attributeType, 'magic');
  assert.equal(candidate.technique.attributeElement, 'shui');

  const skill = candidate.skills[0];
  assert.equal(skill.costLingqi, 18);
  assert.equal(skill.targetType, 'self');
  assert.equal(skill.aiPriority, 72);

  const layerTwo = candidate.layers.find((entry) => entry.layer === 2);
  assert.ok(layerTwo);
  assert.deepEqual(layerTwo.upgradeSkillIds, ['skill-zhaoyuan']);

  const battleSkillData = {
    cost_lingqi: skill.costLingqi,
    cost_lingqi_rate: skill.costLingqiRate,
    cost_qixue: skill.costQixue,
    cost_qixue_rate: skill.costQixueRate,
    cooldown: skill.cooldown,
    target_count: skill.targetCount,
    effects: skill.effects as SkillEffect[],
    ai_priority: skill.aiPriority,
  };
  applySkillUpgradeChanges(battleSkillData, skill.upgrades[0]!.changes as Record<string, unknown>);
  assert.equal(battleSkillData.cooldown, 2);
});

test('sanitizeTechniqueGenerationCandidateFromModel: 光环技能应统一归一成 passive，避免进入主动轮转', () => {
  const raw = {
    technique: {
      name: '镜月天书',
      required_realm: '凡人',
      attribute_type: 'magic',
      attribute_element: 'shui',
      description: '测试光环功法',
      long_desc: '测试光环功法长描述',
      tags: ['测试', '光环'],
    },
    skills: [
      {
        id: 'skill-aura-wrong-active',
        name: '镜月常明',
        description: '展开镜月光环',
        cooldown: 0,
        target_type: 'self',
        target_count: 1,
        element: 'shui',
        triggerType: 'active',
        ai_priority: 35,
        effects: [
          {
            type: 'buff',
            buffKind: 'aura',
            auraTarget: 'self',
            auraEffects: [
              {
                type: 'buff',
                buffKind: 'attr',
                attrKey: 'fagong',
                applyType: 'flat',
                value: 20,
                duration: 1,
              },
            ],
            duration: 1,
          },
        ],
      },
    ],
    layers: [
      {
        layer: 1,
        cost_spirit_stones: 100,
        cost_exp: 50,
        passives: [{ key: 'fagong', value: 12 }],
        unlock_skill_ids: ['skill-aura-wrong-active'],
        upgrade_skill_ids: [],
        layer_desc: '入门',
      },
      {
        layer: 2,
        cost_spirit_stones: 200,
        cost_exp: 100,
        passives: [{ key: 'fagong', value: 18 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: [],
        layer_desc: '精进',
      },
      {
        layer: 3,
        cost_spirit_stones: 300,
        cost_exp: 150,
        passives: [{ key: 'fagong', value: 24 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: [],
        layer_desc: '圆满',
      },
    ],
  };

  const candidate = sanitizeTechniqueGenerationCandidateFromModel(raw, '武技', '黄', 3);
  assert.ok(candidate);

  const skill = candidate.skills[0];
  assert.equal(skill.triggerType, 'passive');

  const validation = validateTechniqueGenerationCandidate({
    candidate,
    expectedTechniqueType: '武技',
    expectedQuality: '黄',
    expectedMaxLayer: 3,
  });
  assert.deepEqual(validation, { success: true });
});

test('validateTechniqueGenerationCandidate: 被动技能必须满足自目标且零消耗零冷却', () => {
  const raw = {
    technique: {
      name: '玄光护体诀',
      required_realm: '凡人',
      attribute_type: 'magic',
      attribute_element: 'jin',
      description: '测试被动技能约束',
      long_desc: '测试被动技能约束长描述',
      tags: ['测试', '被动'],
    },
    skills: [
      {
        id: 'skill-passive-invalid-shape',
        name: '玄光护体',
        description: '错误配置的被动技能',
        cost_lingqi: 12,
        cooldown: 1,
        target_type: 'all_ally',
        target_count: 1,
        triggerType: 'passive',
        ai_priority: 20,
        effects: [
          {
            type: 'buff',
            buffKind: 'aura',
            auraTarget: 'self',
            auraEffects: [
              {
                type: 'buff',
                buffKind: 'attr',
                attrKey: 'wufang',
                applyType: 'flat',
                value: 15,
                duration: 1,
              },
            ],
          },
        ],
      },
    ],
    layers: [
      {
        layer: 1,
        cost_spirit_stones: 100,
        cost_exp: 50,
        passives: [{ key: 'wufang', value: 12 }],
        unlock_skill_ids: ['skill-passive-invalid-shape'],
        upgrade_skill_ids: [],
        layer_desc: '入门',
      },
      {
        layer: 2,
        cost_spirit_stones: 200,
        cost_exp: 100,
        passives: [{ key: 'wufang', value: 18 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: [],
        layer_desc: '精进',
      },
      {
        layer: 3,
        cost_spirit_stones: 300,
        cost_exp: 150,
        passives: [{ key: 'wufang', value: 24 }],
        unlock_skill_ids: [],
        upgrade_skill_ids: [],
        layer_desc: '圆满',
      },
    ],
  };

  const candidate = sanitizeTechniqueGenerationCandidateFromModel(raw, '武技', '黄', 3);
  assert.ok(candidate);

  const validation = validateTechniqueGenerationCandidate({
    candidate,
    expectedTechniqueType: '武技',
    expectedQuality: '黄',
    expectedMaxLayer: 3,
  });
  assert.deepEqual(validation, {
    success: false,
    message: 'AI结果被动技能配置非法：被动技能 targetType 必须为 self',
    code: 'GENERATOR_INVALID',
  });
});
