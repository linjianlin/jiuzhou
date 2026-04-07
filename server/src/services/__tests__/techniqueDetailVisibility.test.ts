/**
 * 功法详情可见性共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定公开功法详情的敏感层字段裁剪规则，避免坊市/背包功法书再次透出未学习时不该看的被动与升层消耗。
 * 2. 做什么：保证已学功法仍复用同一套详情结构，不需要前端再维护第二套 DTO。
 * 3. 不做什么：不访问数据库、不验证路由鉴权链路，只验证服务层共享裁剪函数。
 *
 * 输入/输出：
 * - 输入：功法层数组与可见性模式（`preview` / `learned`）。
 * - 输出：裁剪后的功法层数组。
 *
 * 数据流/状态流：
 * 路由解析查看者角色 -> 服务层判定是否已学 -> applyTechniqueLayerVisibility -> 前端详情页 / tooltip 消费统一结构。
 *
 * 关键边界条件与坑点：
 * 1. `preview` 只能保留公开基础信息；被动、升级消耗和每层技能解锁进度都必须裁掉，避免功法书预览接口泄露成长路线。
 * 2. `learned` 必须原样透传，避免角色已学后详情页仍被错误裁剪，导致修炼面板看不到真实成长信息。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTechniqueLayerVisibility,
  type TechniqueLayerRow,
} from '../techniqueService.js';

const buildLayer = (): TechniqueLayerRow => ({
  technique_id: 'tech-test',
  layer: 2,
  cost_spirit_stones: 320,
  cost_exp: 180,
  cost_materials: [{ itemId: 'mat-001', qty: 3, itemName: '灵木', itemIcon: 'mat-001.png' }],
  passives: [{ key: 'fagong', value: 12 }],
  unlock_skill_ids: ['skill-a'],
  upgrade_skill_ids: ['skill-b'],
  required_realm: '筑基',
  required_quest_id: 'quest-001',
  layer_desc: '测试层描述',
});

test('applyTechniqueLayerVisibility: 未学习预览应裁掉被动、升级消耗与技能解锁进度', () => {
  const [layer] = applyTechniqueLayerVisibility([buildLayer()], 'preview');

  assert.equal(layer.cost_spirit_stones, 0);
  assert.equal(layer.cost_exp, 0);
  assert.deepEqual(layer.cost_materials, []);
  assert.deepEqual(layer.passives, []);
  assert.deepEqual(layer.unlock_skill_ids, []);
  assert.deepEqual(layer.upgrade_skill_ids, []);
  assert.equal(layer.required_realm, '筑基');
});

test('applyTechniqueLayerVisibility: 已学视图应保留原始层信息', () => {
  const sourceLayer = buildLayer();
  const [layer] = applyTechniqueLayerVisibility([sourceLayer], 'learned');

  assert.deepEqual(layer, sourceLayer);
});
