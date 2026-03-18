import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPartnerBattleSkillPolicy,
  buildPartnerSkillPolicyDto,
  normalizePartnerSkillPolicySlotsForSave,
  type PartnerSkillPolicyRow,
} from '../shared/partnerSkillPolicy.js';
import type { PartnerEffectiveSkillEntry } from '../shared/partnerView.js';

/**
 * 伙伴技能策略共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住伙伴技能策略的默认补尾、禁用分组、失效技能剔除与保存归一化规则。
 * 2. 做什么：把最容易散落到路由、前端、战斗层的排序语义集中回归到共享纯函数。
 * 3. 不做什么：不连数据库、不走 HTTP，也不验证伙伴归属鉴权。
 *
 * 输入/输出：
 * - 输入：有效技能全集、持久化策略行、客户端提交 slots。
 * - 输出：策略面板 DTO、战斗策略 DTO、归一化后的保存结果。
 *
 * 数据流/状态流：
 * partnerView 技能全集 -> partnerSkillPolicy 共享模块 -> service / battle / UI。
 *
 * 关键边界条件与坑点：
 * 1. 新技能无配置时必须自动追加到启用列表末尾，不能因为缺表记录就消失。
 * 2. 已失效技能不能继续出现在视图或战斗策略里，否则会造成“面板看不到、战斗仍生效”的漂移。
 */

const createAvailableSkills = (): PartnerEffectiveSkillEntry[] => [
  {
    skillId: 'skill-a',
    skillName: '青木斩',
    skillIcon: '/a.png',
    skillDescription: '凝聚木灵之气斩击单体敌人',
    cost_lingqi: 20,
    cooldown: 1,
    target_type: 'single_enemy',
    damage_type: 'spell',
    element: '木',
    effects: [{ type: 'damage', ratio: 1.2 }],
    trigger_type: 'active',
    sourceTechniqueId: 'tech-a',
    sourceTechniqueName: '青木诀',
    sourceTechniqueQuality: '黄',
  },
  {
    skillId: 'skill-b',
    skillName: '落叶式',
    skillIcon: '/b.png',
    skillDescription: '快速出手，削弱敌方防御',
    cost_lingqi: 12,
    target_type: 'single_enemy',
    damage_type: 'physical',
    effects: [{ type: 'debuff_defense', value: 15 }],
    trigger_type: 'active',
    sourceTechniqueId: 'tech-a',
    sourceTechniqueName: '青木诀',
    sourceTechniqueQuality: '黄',
  },
  {
    skillId: 'skill-c',
    skillName: '灵藤护体',
    skillIcon: '/c.png',
    skillDescription: '召唤灵藤保护自身',
    cost_lingqi: 16,
    cooldown: 2,
    target_type: 'self',
    effects: [{ type: 'shield', value: 80 }],
    trigger_type: 'active',
    sourceTechniqueId: 'tech-b',
    sourceTechniqueName: '藤灵诀',
    sourceTechniqueQuality: '玄',
  },
];

const createPersistedRows = (): PartnerSkillPolicyRow[] => [
  {
    id: 1,
    partner_id: 9,
    skill_id: 'skill-b',
    priority: 1,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  },
  {
    id: 2,
    partner_id: 9,
    skill_id: 'skill-a',
    priority: 2,
    enabled: false,
    created_at: new Date(),
    updated_at: new Date(),
  },
  {
    id: 3,
    partner_id: 9,
    skill_id: 'skill-obsolete',
    priority: 3,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  },
];

test('buildPartnerSkillPolicyDto: 应补尾新技能并剔除失效技能', () => {
  const result = buildPartnerSkillPolicyDto({
    partnerId: 9,
    availableSkills: createAvailableSkills(),
    persistedRows: createPersistedRows(),
  });

  assert.deepEqual(
    result.entries.map((entry) => [entry.skillId, entry.priority, entry.enabled]),
    [
      ['skill-b', 1, true],
      ['skill-c', 2, true],
      ['skill-a', 3, false],
    ],
  );
});

test('buildPartnerBattleSkillPolicy: 应返回完整顺序，供战斗层统一消费', () => {
  const result = buildPartnerBattleSkillPolicy({
    availableSkills: createAvailableSkills(),
    persistedRows: createPersistedRows(),
  });

  assert.deepEqual(result.slots, [
    { skillId: 'skill-b', priority: 1, enabled: true },
    { skillId: 'skill-c', priority: 2, enabled: true },
    { skillId: 'skill-a', priority: 3, enabled: false },
  ]);
});

test('buildPartnerSkillPolicyDto: passive 技能不应进入伙伴手动策略列表', () => {
  const result = buildPartnerSkillPolicyDto({
    partnerId: 9,
    availableSkills: [
      ...createAvailableSkills(),
      {
        skillId: 'skill-passive-aura',
        skillName: '护体灵光',
        skillIcon: '/passive.png',
        skillDescription: '进场自动展开光环',
        cooldown: 0,
        target_type: 'self',
        effects: [{ type: 'buff', buffKind: 'aura' }],
        trigger_type: 'passive',
        sourceTechniqueId: 'tech-c',
        sourceTechniqueName: '护体诀',
        sourceTechniqueQuality: '玄',
      },
    ],
    persistedRows: createPersistedRows(),
  });

  assert.deepEqual(
    result.entries.map((entry) => entry.skillId),
    ['skill-b', 'skill-c', 'skill-a'],
  );
});

test('normalizePartnerSkillPolicySlotsForSave: 应拒绝缺失技能的完整覆盖提交', () => {
  const result = normalizePartnerSkillPolicySlotsForSave({
    availableSkills: createAvailableSkills(),
    slots: [
      { skillId: 'skill-a', priority: 1, enabled: true },
      { skillId: 'skill-b', priority: 2, enabled: false },
    ],
  });

  assert.equal(result.success, false);
});

test('normalizePartnerSkillPolicySlotsForSave: 应重排优先级并保留启用/禁用分组', () => {
  const result = normalizePartnerSkillPolicySlotsForSave({
    availableSkills: createAvailableSkills(),
    slots: [
      { skillId: 'skill-c', priority: 8, enabled: true },
      { skillId: 'skill-a', priority: 2, enabled: false },
      { skillId: 'skill-b', priority: 4, enabled: true },
    ],
  });

  assert.equal(result.success, true);
  if (!result.success) return;

  assert.deepEqual(result.value, [
    { skillId: 'skill-b', priority: 1, enabled: true },
    { skillId: 'skill-c', priority: 2, enabled: true },
    { skillId: 'skill-a', priority: 3, enabled: false },
  ]);
});

test('buildPartnerSkillPolicyDto: 保存后的自定义启用顺序不应被自然顺序覆盖', () => {
  const result = buildPartnerSkillPolicyDto({
    partnerId: 9,
    availableSkills: createAvailableSkills(),
    persistedRows: [
      {
        id: 1,
        partner_id: 9,
        skill_id: 'skill-b',
        priority: 1,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 2,
        partner_id: 9,
        skill_id: 'skill-a',
        priority: 2,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 3,
        partner_id: 9,
        skill_id: 'skill-c',
        priority: 3,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
  });

  assert.deepEqual(
    result.entries.map((entry) => [entry.skillId, entry.priority, entry.enabled]),
    [
      ['skill-b', 1, true],
      ['skill-a', 2, true],
      ['skill-c', 3, true],
    ],
  );
});
