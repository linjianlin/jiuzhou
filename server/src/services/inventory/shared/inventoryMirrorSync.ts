/**
 * 槽位冲突时的库存镜像同步辅助
 *
 * 作用：
 * 1. 做什么：当 Redis 口径判断“背包仍有空位”，但 PostgreSQL 槽位唯一约束实际发生冲突时，按需把脏库存镜像同步到数据库并返回“已同步”信号。
 * 2. 不做什么：不主动分配槽位、不主动创建物品，也不把每次实例创建都退化成刷库。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：`boolean`；`true` 表示本次确实执行了库存镜像同步，调用方应基于同一份 Redis 状态重试插入，`false` 表示当前没有脏库存可同步。
 *
 * 数据流/状态流：
 * 实例创建入口 -> PostgreSQL 槽位插入冲突 -> 读取 Redis meta -> 若 `dirtyInventory=true` 则同步 inventory 镜像 -> 调用方重试插入。
 *
 * 关键边界条件与坑点：
 * 1. 调用方必须先串行化同角色背包写操作；本模块只负责口径修复，不替代背包互斥锁。
 * 2. 只有“真的发生槽位冲突”时才该调用本模块，否则会把缓存主路径重新拖回数据库写路径。
 */
import { loadPlayerStateMetaByCharacterId } from '../../playerStateRepository.js';
import { refreshPlayerStateFromDatabaseByCharacterId } from '../../playerStateRepository.js';
import { syncInventoryMirrorByCharacterId } from '../../playerStateFlushService.js';

export const syncDirtyInventoryMirrorOnSlotConflict = async (
  characterId: number,
): Promise<boolean> => {
  const meta = await loadPlayerStateMetaByCharacterId(characterId);
  if (meta?.dirtyInventory) {
    await syncInventoryMirrorByCharacterId(characterId);
    return true;
  }

  await refreshPlayerStateFromDatabaseByCharacterId(characterId);
  return true;
};
