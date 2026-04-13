/**
 * 战斗冷却管理器
 *
 * 作用：
 * - 管理所有玩家的战斗冷却定时器
 * - 在冷却开始/结束时通过 WebSocket 推送事件给客户端
 * - 处理取消、重连等边界情况
 *
 * 数据流：
 * 战斗结束 → scheduleBattleCooldownPush → 启动定时器 → 冷却结束 → pushBattleCooldownReady → 客户端收到推送
 *
 * 复用点：
 * - startPVEBattle / startDungeonPVEBattle / startPVPBattle 调用 scheduleBattleCooldownPush
 * - abandonBattle / 玩家断线 调用 cancelBattleCooldown
 * - 玩家重连时调用 getRemainingCooldown 同步状态
 */

import { getGameServer } from '../../game/gameServer.js';

// 冷却定时器映射：characterId -> timer
const cooldownTimers = new Map<number, NodeJS.Timeout>();

// 冷却结束时间映射：characterId -> timestamp（用于重连同步）
const cooldownEndTimes = new Map<number, number>();

/**
 * 设置战斗冷却并在结束时推送
 *
 * @param characterId 角色 ID
 * @param cooldownMs 冷却时长（毫秒）
 */
export function scheduleBattleCooldownPush(
  characterId: number,
  cooldownMs: number
): void {
  const normalizedCooldownMs = Math.max(0, Math.floor(cooldownMs));
  // 清理旧定时器（防止重复设置）
  cancelBattleCooldown(characterId);

  if (normalizedCooldownMs <= 0) {
    return;
  }

  const endTime = Date.now() + normalizedCooldownMs;
  cooldownEndTimes.set(characterId, endTime);
  pushBattleCooldownSync(characterId, normalizedCooldownMs);

  // 启动定时器
  const timer = setTimeout(() => {
    const latestEndTime = cooldownEndTimes.get(characterId);
    if (latestEndTime !== endTime) {
      return;
    }
    cooldownTimers.delete(characterId);
    cooldownEndTimes.delete(characterId);

    // 只有当前这轮冷却对应的定时器才允许发 ready，避免旧 timer 竞态误推送。
    pushBattleCooldownReady(characterId);
  }, normalizedCooldownMs);

  cooldownTimers.set(characterId, timer);
}

/**
 * 取消战斗冷却
 *
 * 场景：
 * - 玩家逃跑/取消战斗
 * - 玩家断线
 * - 玩家切换场景
 *
 * @param characterId 角色 ID
 */
export function cancelBattleCooldown(characterId: number): void {
  const timer = cooldownTimers.get(characterId);
  if (timer) {
    clearTimeout(timer);
    cooldownTimers.delete(characterId);
  }
  cooldownEndTimes.delete(characterId);
}

/**
 * 获取剩余冷却时间（用于重连同步）
 *
 * @param characterId 角色 ID
 * @returns 剩余冷却时间（毫秒），0 表示无冷却
 */
export function getRemainingCooldown(characterId: number): number {
  const endTime = cooldownEndTimes.get(characterId);
  if (!endTime) return 0;

  const remaining = endTime - Date.now();
  return Math.max(0, remaining);
}

/**
 * 推送冷却结束事件到客户端
 *
 * @param characterId 角色 ID
 */
function pushBattleCooldownReady(characterId: number): void {
  const gameServer = getGameServer();
  if (!gameServer) return;

  gameServer.emitToCharacter(characterId, 'battle:cooldown-ready', {
    characterId,
    timestamp: Date.now(),
  });
}

function pushBattleCooldownSync(characterId: number, remainingMs: number): void {
  const gameServer = getGameServer();
  if (!gameServer) return;

  gameServer.emitToCharacter(characterId, 'battle:cooldown-sync', {
    characterId,
    remainingMs,
    timestamp: Date.now(),
  });
}

/**
 * 清理所有冷却定时器（用于服务器关闭时清理）
 */
export function clearAllCooldowns(): void {
  cooldownTimers.forEach((timer) => clearTimeout(timer));
  cooldownTimers.clear();
  cooldownEndTimes.clear();
}
