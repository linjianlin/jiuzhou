/**
 * BattleArea 单位头像背景判定测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“只有 player / partner 且 avatar 非空时才显示卡片背景图”的展示规则。
 * 2. 做什么：复用纯函数测试 URL 解析结果，避免 BattleUnitCard JSX 中散落类型判断。
 * 3. 不做什么：不挂载 React 组件，不验证 CSS 效果与遮罩细节。
 *
 * 输入/输出：
 * - 输入：最小化 `BattleUnit` 片段（`unitType + avatar`）。
 * - 输出：背景图 URL 或 `undefined`。
 *
 * 数据流/状态流：
 * - BattleUnit 视图模型 -> battleUnitBackground 纯函数 -> BattleUnitCard 背景层。
 *
 * 关键边界条件与坑点：
 * 1. 空 avatar 必须返回 `undefined`，不能私自补默认图，避免违背当前任务范围。
 * 2. monster / npc / summon 即使未来带了图片字段，也不能自动接成头像背景。
 */

import { describe, expect, it } from 'vitest';
import { resolveBattleUnitBackgroundImage } from '../BattleArea/battleUnitBackground';

describe('resolveBattleUnitBackgroundImage', () => {
  it('玩家单位应返回解析后的头像 URL', () => {
    expect(
      resolveBattleUnitBackgroundImage({
        unitType: 'player',
        avatar: '/uploads/avatar-player.png',
      }),
    ).toBe('http://localhost:6011/uploads/avatar-player.png');
  });

  it('伙伴单位应返回解析后的资源 URL', () => {
    expect(
      resolveBattleUnitBackgroundImage({
        unitType: 'partner',
        avatar: 'partners/avatar-fox.png',
      }),
    ).toBe(`${window.location.origin}/assets/partners/avatar-fox.png`);
  });

  it('空头像时不应兜底默认图', () => {
    expect(
      resolveBattleUnitBackgroundImage({
        unitType: 'player',
        avatar: null,
      }),
    ).toBeUndefined();
  });

  it('怪物单位即使带 avatar 字段也不应显示背景图', () => {
    expect(
      resolveBattleUnitBackgroundImage({
        unitType: 'monster',
        avatar: '/uploads/monster.png',
      }),
    ).toBeUndefined();
  });

  it('关闭战斗头像显示时应直接隐藏背景图', () => {
    expect(
      resolveBattleUnitBackgroundImage(
        {
          unitType: 'partner',
          avatar: 'partners/avatar-fox.png',
        },
        false,
      ),
    ).toBeUndefined();
  });
});
