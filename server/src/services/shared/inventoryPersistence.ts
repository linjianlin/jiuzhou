import { query } from '../../config/database.js';

/**
 * 背包持久化辅助
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中承接角色创建时的背包初始化写库逻辑。
 * 2. 做什么：把仍在运行时使用的库存持久化 helper 从旧的表初始化文件中拆出来，避免删除遗留建表 SQL 时误删业务入口。
 * 3. 不做什么：不负责建表、不负责背包扩容、不负责物品实例读写。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：确保该角色存在一条 inventory 记录；重复调用幂等。
 *
 * 数据流/状态流：
 * createCharacter -> createInventoryForCharacter -> inventory 表插入或忽略重复冲突。
 *
 * 关键边界条件与坑点：
 * 1. 这里依赖 Prisma schema 已经同步出 `inventory` 表；不再承担任何结构兜底职责。
 * 2. 角色创建链路要求幂等，因此必须保留 `ON CONFLICT (character_id) DO NOTHING`，避免重试时重复失败。
 */
export const createInventoryForCharacter = async (characterId: number): Promise<void> => {
  await query(
    `
      INSERT INTO inventory (character_id, bag_capacity, warehouse_capacity)
      VALUES ($1, 100, 1000)
      ON CONFLICT (character_id) DO NOTHING
    `,
    [characterId],
  );
};
