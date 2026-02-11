/**
 * 九州修仙录 - 背包系统数据表
 * 设计考虑：
 * 1. 每个角色只有一个背包，初始100格
 * 2. 背包容量可扩展
 * 3. 性能优化：使用索引、避免频繁查询
 */
import { query } from '../config/database.js';

// ============================================
// 背包表 (inventory) - 存储背包元数据
// ============================================
const inventoryTableSQL = `
CREATE TABLE IF NOT EXISTS inventory (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  
  -- 背包容量
  bag_capacity INTEGER NOT NULL DEFAULT 100,          -- 背包格子数量，初始100
  warehouse_capacity INTEGER NOT NULL DEFAULT 1000,   -- 仓库格子数量，初始1000（分仓：5*200）
  
  -- 扩展记录
  bag_expand_count INTEGER NOT NULL DEFAULT 0,        -- 背包扩容次数
  warehouse_expand_count INTEGER NOT NULL DEFAULT 0,  -- 仓库扩容次数
  
  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE inventory IS '背包元数据表';
COMMENT ON COLUMN inventory.character_id IS '角色ID（一对一）';
COMMENT ON COLUMN inventory.bag_capacity IS '背包格子数量';
COMMENT ON COLUMN inventory.warehouse_capacity IS '仓库格子数量';
COMMENT ON COLUMN inventory.bag_expand_count IS '背包扩容次数';
COMMENT ON COLUMN inventory.warehouse_expand_count IS '仓库扩容次数';

-- 索引
CREATE INDEX IF NOT EXISTS idx_inventory_character ON inventory(character_id);
`;

// ============================================
// 为 item_instance 表添加性能优化索引
// ============================================
const itemInstanceIndexSQL = `
-- 背包查询优化索引（角色+位置复合索引）
CREATE INDEX IF NOT EXISTS idx_item_instance_bag 
  ON item_instance(owner_character_id, location) 
  WHERE location IN ('bag', 'warehouse', 'equipped');

-- 格子位置索引（快速查找空位）
CREATE INDEX IF NOT EXISTS idx_item_instance_slot 
  ON item_instance(owner_character_id, location, location_slot);

-- 物品堆叠查询索引（查找可堆叠物品）
CREATE INDEX IF NOT EXISTS idx_item_instance_stack 
  ON item_instance(owner_character_id, item_def_id, location) 
  WHERE location = 'bag';
`;

const itemInstanceUniqueSlotIndexSQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_instance_slot
  ON item_instance(owner_character_id, location, location_slot)
  WHERE owner_character_id IS NOT NULL
    AND location_slot IS NOT NULL
    AND location IN ('bag', 'warehouse');
`;

const repairDuplicateSlots = async (): Promise<void> => {
  const dupResult = await query(
    `
      SELECT owner_character_id, location, location_slot, ARRAY_AGG(id ORDER BY id) AS ids
      FROM item_instance
      WHERE owner_character_id IS NOT NULL
        AND location IN ('bag', 'warehouse')
        AND location_slot IS NOT NULL
      GROUP BY owner_character_id, location, location_slot
      HAVING COUNT(*) > 1
    `
  );

  if (dupResult.rows.length === 0) return;

  for (const row of dupResult.rows) {
    const ownerCharacterId = Number(row.owner_character_id);
    const location = String(row.location) as 'bag' | 'warehouse';
    const ids = (row.ids as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x));
    const extraIds = ids.slice(1);
    if (extraIds.length === 0) continue;

    const capResult = await query(
      `SELECT bag_capacity, warehouse_capacity FROM inventory WHERE character_id = $1`,
      [ownerCharacterId]
    );
    const bagCapacity = Number(capResult.rows[0]?.bag_capacity ?? 100);
    const warehouseCapacity = Number(capResult.rows[0]?.warehouse_capacity ?? 1000);
    const capacity = location === 'bag' ? bagCapacity : warehouseCapacity;

    for (const instanceId of extraIds) {
      const slotResult = await query(
        `
          SELECT s AS slot
          FROM generate_series(0, $3::int - 1) AS s
          WHERE NOT EXISTS (
            SELECT 1 FROM item_instance
            WHERE owner_character_id = $1 AND location = $2 AND location_slot = s
          )
          ORDER BY s
          LIMIT 1
        `,
        [ownerCharacterId, location, capacity]
      );

      const nextSlot = slotResult.rows.length > 0 ? Number(slotResult.rows[0].slot) : null;
      if (nextSlot === null || !Number.isFinite(nextSlot)) break;

      await query(
        `UPDATE item_instance SET location_slot = $1, updated_at = NOW() WHERE id = $2`,
        [nextSlot, instanceId]
      );
    }
  }
};

// ============================================
// 初始化背包表
// ============================================
export const initInventoryTable = async (): Promise<void> => {
  try {
    // 创建背包表
    await query(inventoryTableSQL);

    await query(`ALTER TABLE inventory ALTER COLUMN warehouse_capacity SET DEFAULT 1000`);
    await query(`COMMENT ON COLUMN inventory.warehouse_capacity IS '仓库格子数量'`);
    await query(`UPDATE inventory SET warehouse_capacity = 1000 WHERE warehouse_capacity < 1000`);
    
    // 添加性能优化索引
    await query(itemInstanceIndexSQL);

    await repairDuplicateSlots();
    try {
      await query(itemInstanceUniqueSlotIndexSQL);
    } catch (error) {
      console.warn('背包格子唯一性索引创建失败（可能存在无法自动修复的重复格子）:', error);
    }
    
    console.log('✓ 背包系统表检测完成');
  } catch (error) {
    console.error('✗ 背包系统表初始化失败:', error);
    throw error;
  }
};

// ============================================
// 创建角色背包（角色创建时调用）
// ============================================
export const createInventoryForCharacter = async (characterId: number): Promise<void> => {
  const sql = `
    INSERT INTO inventory (character_id, bag_capacity, warehouse_capacity)
    VALUES ($1, 100, 1000)
    ON CONFLICT (character_id) DO NOTHING
  `;
  await query(sql, [characterId]);
};

