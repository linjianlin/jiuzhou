/**
 * BattleArea 战斗状态新鲜度测试。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定同日志数、同回合、同当前行动单位下，伙伴气血等动态资源变化仍会被 BattleArea 接收。
 * - 做什么：锁定旧日志流不能因单位字段不同而覆盖新日志流，避免乱序 socket 包回退 UI。
 * - 不做什么：不测试 socket 归一化、不测试战斗日志格式化，也不渲染 BattleArea。
 *
 * 输入 / 输出：
 * - 输入：最小 BattleStateDto 快照与日志条数。
 * - 输出：isNewerBattleState 的布尔判定。
 *
 * 数据流 / 状态流：
 * - battle:update 完整缓存 -> isNewerBattleState -> BattleArea 是否调用 applyBattleStateSnapshot。
 * - 本测试直接构造快照，避免 UI 渲染与网络层干扰状态判定。
 *
 * 复用设计说明：
 * - 伙伴治疗、回灵、Buff 数变化都属于同一类“单位动态字段修正”，统一通过 battleStateFreshness 入口判定。
 * - 测试复用 BattleStateDto/BattleUnitDto 类型，避免在测试里复制一份形似但不同源的状态结构。
 * - 高频业务变化点是单位动态字段集合，因此回归用例集中覆盖该纯函数，不在组件测试里重复铺样板。
 *
 * 关键边界条件与坑点：
 * 1. 日志条数更少的包仍然必须判旧，不能为了接收 qixue 修正放开旧日志覆盖。
 * 2. 伙伴位通常不改变 currentUnitId，必须单独比较单位动态字段才能刷新血条。
 */

import { describe, expect, it } from 'vitest';

import type { BattleStateDto, BattleUnitDto } from '../../../../services/api/combat-realm';
import { isNewerBattleState } from '../BattleArea/battleStateFreshness';

const createUnit = (
  overrides: Pick<BattleUnitDto, 'id' | 'name' | 'type'> & Partial<BattleUnitDto>,
): BattleUnitDto => ({
  id: overrides.id,
  name: overrides.name,
  type: overrides.type,
  qixue: overrides.qixue ?? 100,
  lingqi: overrides.lingqi ?? 50,
  currentAttrs: overrides.currentAttrs ?? {
    max_qixue: 100,
    max_lingqi: 50,
  },
  isAlive: overrides.isAlive ?? true,
  buffs: overrides.buffs ?? [],
  formationOrder: overrides.formationOrder,
  ownerUnitId: overrides.ownerUnitId,
  monthCardActive: overrides.monthCardActive,
  avatar: overrides.avatar,
});

const createState = (
  attackerUnits: BattleUnitDto[],
  defenderUnits: BattleUnitDto[],
  overrides: Partial<BattleStateDto> = {},
): BattleStateDto => ({
  battleId: overrides.battleId ?? 'battle-1',
  battleType: overrides.battleType ?? 'pve',
  teams: overrides.teams ?? {
    attacker: {
      odwnerId: 1,
      totalSpeed: 100,
      units: attackerUnits,
    },
    defender: {
      odwnerId: 0,
      totalSpeed: 80,
      units: defenderUnits,
    },
  },
  roundCount: overrides.roundCount ?? 1,
  currentTeam: overrides.currentTeam ?? 'attacker',
  currentUnitId: overrides.currentUnitId ?? 'player-1',
  phase: overrides.phase ?? 'action',
  firstMover: overrides.firstMover ?? 'attacker',
  result: overrides.result,
});

describe('isNewerBattleState', () => {
  it('同日志数同回合时，伙伴气血变化仍应接管当前状态', () => {
    const current = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 42 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 88 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );
    const next = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 76 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 88 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );

    expect(isNewerBattleState(next, current, 5, 5)).toBe(true);
  });

  it('日志条数更少时，即使单位气血不同也不应覆盖当前状态', () => {
    const current = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 76 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 88 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );
    const next = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 42 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 88 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );

    expect(isNewerBattleState(next, current, 4, 5)).toBe(false);
  });
});
