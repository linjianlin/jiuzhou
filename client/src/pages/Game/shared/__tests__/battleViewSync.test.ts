/**
 * Game 页 socket 战斗视图接管规则测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定普通地图本地战斗、组队观战、重连接管三类场景的判定边界，避免 socket 更新再次把普通地图连战误判成 reconnect。
 * 2. 做什么：覆盖“本地普通地图战斗必须继续由 BattleArea 持有”和“真正的重连 battle-* 仍然能接管”的回归风险。
 * 3. 不做什么：不挂载 React 组件、不建立 socket 连接，也不验证 BattleArea 内部自动下一场的定时器行为。
 *
 * 输入/输出：
 * - 输入：battleId、队伍身份、当前视图、本地目标是否存在、当前 battleSession/reconnect 上下文。
 * - 输出：`resolveRealtimeBattleViewSyncMode` 返回的接管模式。
 *
 * 数据流/状态流：
 * - socket battle:update -> 共享判定 -> Game 页决定 keep local / team replay / reconnect。
 *
 * 关键边界条件与坑点：
 * 1. 普通地图本地战斗只有在 BattleArea 已经持有时才应跳过 reconnect；如果是重连进来的同类 battleId，仍必须允许接管。
 * 2. 队伍跟随者必须始终走队友战斗视图，不能被普通地图本地分支抢走。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveRealtimeBattleViewSyncMode,
  shouldRestoreBattleSessionFromRealtime,
} from '../battleViewSync.js';

test('普通地图本地战斗已由 BattleArea 持有时，不应再接成 reconnect 战斗', () => {
  assert.equal(
    resolveRealtimeBattleViewSyncMode({
      battleId: 'battle-1001-1700000000000',
      inTeam: false,
      isTeamLeader: true,
      viewMode: 'battle',
      hasLocalBattleTargets: true,
      currentSessionBattleId: null,
      currentReconnectBattleId: null,
    }),
    'keep_local_battle',
  );
});

test('真正的普通地图重连场景仍应接管 reconnect 战斗视图', () => {
  assert.equal(
    resolveRealtimeBattleViewSyncMode({
      battleId: 'battle-1001-1700000000000',
      inTeam: false,
      isTeamLeader: true,
      viewMode: 'map',
      hasLocalBattleTargets: false,
      currentSessionBattleId: null,
      currentReconnectBattleId: null,
    }),
    'sync_reconnect_battle',
  );
});

test('队伍跟随者收到战斗更新时，应始终进入队友战斗视图', () => {
  assert.equal(
    resolveRealtimeBattleViewSyncMode({
      battleId: 'battle-1001-1700000000000',
      inTeam: true,
      isTeamLeader: false,
      viewMode: 'battle',
      hasLocalBattleTargets: true,
      currentSessionBattleId: null,
      currentReconnectBattleId: null,
    }),
    'sync_team_battle',
  );
});

test('已经处于 reconnect 外部上下文时，不应错误回退成本地战斗持有', () => {
  assert.equal(
    resolveRealtimeBattleViewSyncMode({
      battleId: 'battle-1001-1700000000000',
      inTeam: false,
      isTeamLeader: true,
      viewMode: 'battle',
      hasLocalBattleTargets: true,
      currentSessionBattleId: null,
      currentReconnectBattleId: 'battle-1001-1700000000000',
    }),
    'sync_reconnect_battle',
  );
});

test('队友战斗若服务端已附带 session，应继续恢复正式 battle session', () => {
  assert.equal(
    shouldRestoreBattleSessionFromRealtime({
      syncMode: 'sync_team_battle',
      hasSessionPayload: true,
    }),
    true,
  );
});

test('普通队友战斗若没有 session，不应额外发起 battle session 恢复请求', () => {
  assert.equal(
    shouldRestoreBattleSessionFromRealtime({
      syncMode: 'sync_team_battle',
      hasSessionPayload: false,
    }),
    false,
  );
});
