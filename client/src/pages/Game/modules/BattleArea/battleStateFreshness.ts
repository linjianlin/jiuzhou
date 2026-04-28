/**
 * BattleArea 状态新鲜度判定。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一判断一份服务端战斗快照是否应该接管当前 UI，覆盖日志、回合、阶段、行动单位与单位动态资源变化。
 * - 不做什么：不合并 battle state、不格式化日志、不参与技能释放，只返回是否接受下一份状态。
 *
 * 输入 / 输出：
 * - 输入：下一份 BattleStateDto、当前 BattleStateDto、两边完整日志条数。
 * - 输出：boolean；true 表示下一份状态应写入 BattleArea。
 *
 * 数据流 / 状态流：
 * - gameSocket 归一化后的 battle:update -> isNewerBattleState -> BattleArea.applyBattleStateSnapshot。
 * - 日志/回合/阶段先决定宏观顺序；若宏观顺序完全一致，再比较单位 qixue/lingqi/isAlive/最大资源/Buff 数等动态字段。
 *
 * 复用设计说明：
 * - 之前判定内联在 BattleArea 主组件，无法单独测试，且遗漏了伙伴气血这类不改变行动指针的状态修正。
 * - 抽成纯函数后，BattleArea 与回归测试共用同一入口，后续新增动态字段只需要改这里一处。
 * - 高频变化点是“哪些字段代表可展示状态变化”，集中放在本模块能避免主组件和 socket 层重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 日志条数不一致时仍以日志游标为主，避免旧日志流覆盖新日志流。
 * 2. 同日志数、同回合、同当前行动单位下，伙伴 qixue 变化仍必须接管 UI，否则会出现治疗日志已显示但血条未更新。
 */

import type { BattleStateDto, BattleUnitDto } from '../../../../services/api/combat-realm';

const getPhaseRank = (phase: BattleStateDto['phase']): number => {
  if (phase === 'roundStart') return 1;
  if (phase === 'action') return 2;
  if (phase === 'roundEnd') return 3;
  if (phase === 'finished') return 4;
  return 0;
};

const hasUnitDynamicChange = (
  nextUnit: BattleUnitDto,
  currentUnit: BattleUnitDto,
): boolean => {
  return nextUnit.id !== currentUnit.id
    || nextUnit.qixue !== currentUnit.qixue
    || nextUnit.lingqi !== currentUnit.lingqi
    || nextUnit.isAlive !== currentUnit.isAlive
    || nextUnit.currentAttrs.max_qixue !== currentUnit.currentAttrs.max_qixue
    || nextUnit.currentAttrs.max_lingqi !== currentUnit.currentAttrs.max_lingqi
    || nextUnit.buffs.length !== currentUnit.buffs.length;
};

const hasTeamDynamicChange = (
  nextUnits: BattleUnitDto[],
  currentUnits: BattleUnitDto[],
): boolean => {
  if (nextUnits.length !== currentUnits.length) return true;
  for (let index = 0; index < nextUnits.length; index++) {
    const nextUnit = nextUnits[index];
    const currentUnit = currentUnits[index];
    if (!nextUnit || !currentUnit) return true;
    if (hasUnitDynamicChange(nextUnit, currentUnit)) return true;
  }
  return false;
};

const hasBattleUnitDynamicChange = (
  next: BattleStateDto,
  current: BattleStateDto,
): boolean => {
  return hasTeamDynamicChange(next.teams.attacker.units, current.teams.attacker.units)
    || hasTeamDynamicChange(next.teams.defender.units, current.teams.defender.units)
    || next.teams.attacker.totalSpeed !== current.teams.attacker.totalSpeed
    || next.teams.defender.totalSpeed !== current.teams.defender.totalSpeed;
};

export const isNewerBattleState = (
  next: BattleStateDto,
  current: BattleStateDto | null,
  nextLogCount: number,
  currentLogCount: number,
): boolean => {
  if (!current) return true;
  if (next.battleId !== current.battleId) return true;

  if (current.phase === 'finished' && next.phase !== 'finished') return false;

  if (nextLogCount !== currentLogCount) return nextLogCount > currentLogCount;

  if (next.phase === 'finished' && current.phase !== 'finished') return true;

  const nextRound = Number(next.roundCount) || 0;
  const currentRound = Number(current.roundCount) || 0;
  if (nextRound !== currentRound) return nextRound > currentRound;

  const nextRank = getPhaseRank(next.phase);
  const currentRank = getPhaseRank(current.phase);
  if (nextRank !== currentRank) return nextRank > currentRank;

  const nextIndex = next.currentUnitId ?? '';
  const currentIndex = current.currentUnitId ?? '';
  if (nextIndex !== currentIndex) return true;

  const nextTeam = String(next.currentTeam || '');
  const currentTeam = String(current.currentTeam || '');
  if (nextTeam !== currentTeam) return true;

  return hasBattleUnitDynamicChange(next, current);
};
