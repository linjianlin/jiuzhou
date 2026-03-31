/**
 * 功法层级技能展示规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“技能首次出现在 `upgrade_skill_ids` 时，本层也会展示为已解锁技能”的前端口径。
 * 2. 做什么：验证该层展示值会立即套用本层 upgrade，避免前端 tooltip 与服务端有效技能属性继续漂移。
 * 3. 不做什么：不请求接口、不渲染组件，也不验证技能详情文案格式化。
 *
 * 输入/输出：
 * - 输入：手工构造的 `TechniqueLayerDto[]`、`SkillDefDto[]` 与图标解析函数。
 * - 输出：按层分组的技能展示映射。
 *
 * 数据流/状态流：
 * 功法层配置 + 技能定义 -> buildTechniqueLayerSkillProgression -> TechniqueModal 各视图复用。
 *
 * 关键边界条件与坑点：
 * 1. 只在 `upgrade_skill_ids` 首次出现的技能，必须在该层直接进入展示结果，否则“功法面板看得到、角色技能栏看不到”的错觉会反复出现。
 * 2. 首次出现即视为解锁后，升级增量也必须在同层生效，不能先按基础值展示、下一层才补上强化效果。
 */
import { describe, expect, it } from 'vitest';

import type { SkillDefDto, TechniqueLayerDto } from '../../../../../services/api/technique';
import { buildTechniqueLayerSkillProgression } from '../techniqueSkillProgression';

const buildSkill = (overrides: Partial<SkillDefDto>): SkillDefDto => ({
  id: 'skill-default',
  code: null,
  name: '默认技能',
  description: null,
  icon: null,
  source_type: 'technique',
  source_id: 'tech-test',
  cost_lingqi: 20,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 4,
  target_type: 'single_enemy',
  target_count: 1,
  damage_type: 'magic',
  element: 'none',
  effects: [],
  trigger_type: 'active',
  conditions: null,
  ai_priority: 50,
  ai_conditions: null,
  upgrades: [],
  sort_weight: 0,
  version: 1,
  enabled: true,
  ...overrides,
});

const buildLayer = (overrides: Partial<TechniqueLayerDto>): TechniqueLayerDto => ({
  technique_id: 'tech-test',
  layer: 1,
  cost_spirit_stones: 0,
  cost_exp: 0,
  cost_materials: [],
  passives: [],
  unlock_skill_ids: [],
  upgrade_skill_ids: [],
  required_realm: null,
  required_quest_id: null,
  layer_desc: null,
  ...overrides,
});

describe('techniqueSkillProgression', () => {
  it('buildTechniqueLayerSkillProgression: upgrade 首次出现的技能也应从该层开始展示为已解锁', () => {
    const skillA = buildSkill({
      id: 'skill-a',
      name: '先天印',
    });
    const skillB = buildSkill({
      id: 'skill-b',
      name: '断息鸣',
      cooldown: 5,
      upgrades: [
        {
          layer: 2,
          changes: {
            cooldown: -2,
          },
        },
      ],
    });

    const progression = buildTechniqueLayerSkillProgression(
      [
        buildLayer({
          layer: 1,
          unlock_skill_ids: ['skill-a'],
        }),
        buildLayer({
          layer: 2,
          upgrade_skill_ids: ['skill-b'],
        }),
      ],
      [skillA, skillB],
      (icon) => icon ?? '',
    );

    expect(progression.get(1)?.map((entry) => entry.id)).toEqual(['skill-a']);
    expect(progression.get(2)).toEqual([
      expect.objectContaining({
        id: 'skill-b',
        name: '断息鸣',
        cooldown: 3,
      }),
    ]);
  });
});
