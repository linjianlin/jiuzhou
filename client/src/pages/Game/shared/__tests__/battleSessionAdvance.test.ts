/**
 * 战斗会话推进策略回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定自动推进、手动继续、不可控等待三种 battle session 推进模式，避免 Game 页再次在 effect / useMemo 里各写一套条件。
 * 2. 做什么：覆盖“自动推进失败后必须切成手动继续”的回归风险，防止秘境/普通 PVE 在失败一次后永久卡死。
 * 3. 不做什么：不挂载 React 组件、不请求接口，也不验证具体定时器行为。
 *
 * 输入/输出：
 * - 输入：battle session 快照、队伍控制权、自动推进失败锁定 key。
 * - 输出：`resolveBattleSessionAdvanceMode` 返回的推进模式。
 *
 * 数据流/状态流：
 * - Game 页拿到 session -> 本测试模块验证共享策略 -> Game/BattleArea 复用同一推进口径。
 *
 * 关键边界条件与坑点：
 * 1. 只要同一 session 的自动推进已失败，就必须降级成 `manual_session`，不能继续保持自动推进假象。
 * 2. 队伍跟随者即使拿到 `canAdvance` 的 session，也不能被误判成可控推进方。
 */

import { describe, expect, it } from 'vitest';

import type { BattleSessionSnapshotDto } from '../../../../services/api/battleSession';
import {
  buildBattleSessionAdvanceKey,
  resolveBattleSessionAdvanceMode,
} from '../battleSessionAdvance';

const createSession = (
  overrides?: Partial<BattleSessionSnapshotDto>,
): BattleSessionSnapshotDto => ({
  sessionId: 'session-1',
  type: 'dungeon',
  ownerUserId: 1,
  participantUserIds: [1, 2],
  currentBattleId: 'dungeon-battle-1',
  status: 'waiting_transition',
  nextAction: 'advance',
  canAdvance: true,
  lastResult: 'attacker_win',
  context: { instanceId: 'dungeon-instance-1' },
  ...overrides,
});

describe('resolveBattleSessionAdvanceMode', () => {
  it('秘境 leader 在可推进时，应继续自动推进下一波', () => {
    expect(
      resolveBattleSessionAdvanceMode({
        session: createSession(),
        inTeam: true,
        isTeamLeader: true,
        blockedAutoAdvanceSessionKey: '',
      }),
    ).toBe('auto_session');
  });

  it('普通 PVE 的继续战斗在等待冷却时，应走自动冷却推进', () => {
    expect(
      resolveBattleSessionAdvanceMode({
        session: createSession({
          type: 'pve',
          context: { monsterIds: ['monster-gray-wolf'] },
        }),
        inTeam: false,
        isTeamLeader: true,
        blockedAutoAdvanceSessionKey: '',
      }),
    ).toBe('auto_session_cooldown');
  });

  it('同一 session 的自动推进失败后，应降级为手动继续', () => {
    const session = createSession();
    expect(
      resolveBattleSessionAdvanceMode({
        session,
        inTeam: true,
        isTeamLeader: true,
        blockedAutoAdvanceSessionKey: buildBattleSessionAdvanceKey(session),
      }),
    ).toBe('manual_session');
  });

  it('千层塔即使可推进，也必须停在手动继续', () => {
    expect(
      resolveBattleSessionAdvanceMode({
        session: createSession({
          type: 'tower',
          context: { runId: 'tower-run-1', floor: 12 },
        }),
        inTeam: false,
        isTeamLeader: true,
        blockedAutoAdvanceSessionKey: '',
      }),
    ).toBe('manual_session');
  });

  it('队伍跟随者即使拿到可推进 session，也应保持不可控', () => {
    expect(
      resolveBattleSessionAdvanceMode({
        session: createSession(),
        inTeam: true,
        isTeamLeader: false,
        blockedAutoAdvanceSessionKey: '',
      }),
    ).toBe('none');
  });
});
