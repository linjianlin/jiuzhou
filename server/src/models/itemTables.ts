/**
 * 九州修仙录 - 物品系统动态数据表
 *
 * 说明：
 * 1. 物品定义/词条池/套装/配方已改为静态 JSON 直读，不再建表。
 * 2. 仅保留运行时动态数据表（实例、冷却、使用计数）。
 */
import { query } from '../config/database.js';

// ============================================
// 1. 物品实例表（动态）
// ============================================
const itemInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS item_instance (
  id BIGSERIAL PRIMARY KEY,                           -- 物品实例ID
  owner_user_id BIGINT NOT NULL,                      -- 拥有者用户ID
  owner_character_id BIGINT,                          -- 拥有者角色ID（账号共享仓库可为空）
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）
  qty INTEGER NOT NULL DEFAULT 1,                     -- 数量（堆叠）
  quality CHAR(1),                                    -- 实例品质（装备生成结果；为空则按定义）
  quality_rank INTEGER,                               -- 实例品质排序值

  -- 绑定状态
  bind_type VARCHAR(16) NOT NULL DEFAULT 'none',      -- 实例绑定状态
  bind_owner_user_id BIGINT,                          -- 绑定到的用户ID
  bind_owner_character_id BIGINT,                     -- 绑定到的角色ID

  -- 位置信息
  location VARCHAR(16) NOT NULL DEFAULT 'bag',        -- 位置（bag/warehouse/equipped/mail/auction）
  location_slot INTEGER,                              -- 位置格子
  equipped_slot VARCHAR(32),                          -- 装备槽位（若已装备）

  -- 强化与精炼
  strengthen_level INTEGER DEFAULT 0,                 -- 强化等级
  refine_level INTEGER DEFAULT 0,                     -- 精炼等级

  -- 镶嵌与词条
  socketed_gems JSONB,                                -- 已镶嵌宝石信息
  random_seed BIGINT,                                 -- 随机种子
  affixes JSONB,                                      -- 随机词条结果
  identified BOOLEAN NOT NULL DEFAULT true,           -- 是否已鉴定

  -- 其他
  custom_name VARCHAR(64),                            -- 自定义名称
  locked BOOLEAN NOT NULL DEFAULT false,              -- 是否锁定
  expire_at TIMESTAMPTZ,                              -- 实例过期时间

  -- 来源追溯
  obtained_from VARCHAR(32),                          -- 获取来源（drop/quest/shop/craft/mail/admin）
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID
  metadata JSONB,                                     -- 扩展字段

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_instance IS '物品实例表（动态数据）';
COMMENT ON COLUMN item_instance.id IS '物品实例ID';
COMMENT ON COLUMN item_instance.owner_user_id IS '拥有者用户ID';
COMMENT ON COLUMN item_instance.owner_character_id IS '拥有者角色ID';
COMMENT ON COLUMN item_instance.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_instance.qty IS '数量（堆叠数量）';
COMMENT ON COLUMN item_instance.location IS '位置（bag/warehouse/equipped/mail/auction）';
COMMENT ON COLUMN item_instance.location_slot IS '位置格子（从0开始）';
COMMENT ON COLUMN item_instance.equipped_slot IS '装备槽位（已装备时记录）';
COMMENT ON COLUMN item_instance.strengthen_level IS '强化等级';
COMMENT ON COLUMN item_instance.affixes IS '随机词条结果（JSONB）';
COMMENT ON COLUMN item_instance.locked IS '是否锁定（防误操作）';
COMMENT ON COLUMN item_instance.obtained_from IS '获取来源类型';

CREATE INDEX IF NOT EXISTS idx_item_instance_owner ON item_instance(owner_user_id, owner_character_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_item_def ON item_instance(item_def_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_location ON item_instance(location);
CREATE INDEX IF NOT EXISTS idx_item_instance_equipped ON item_instance(equipped_slot) WHERE equipped_slot IS NOT NULL;
`;

// ============================================
// 2. 物品使用冷却表（动态）
// ============================================
const itemUseCooldownTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_cooldown (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）
  cooldown_until TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_cooldown IS '物品使用冷却表';
COMMENT ON COLUMN item_use_cooldown.character_id IS '角色ID';
COMMENT ON COLUMN item_use_cooldown.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_use_cooldown.cooldown_until IS '冷却结束时间';

CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_char ON item_use_cooldown(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_item ON item_use_cooldown(item_def_id);
`;

// ============================================
// 3. 物品使用次数表（动态）
// ============================================
const itemUseCountTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_count (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）

  daily_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_daily_reset DATE NOT NULL DEFAULT CURRENT_DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_count IS '物品使用次数表';
COMMENT ON COLUMN item_use_count.character_id IS '角色ID';
COMMENT ON COLUMN item_use_count.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_use_count.daily_count IS '当日使用次数';
COMMENT ON COLUMN item_use_count.total_count IS '累计使用次数';
COMMENT ON COLUMN item_use_count.last_daily_reset IS '最后一次日重置日期';

CREATE INDEX IF NOT EXISTS idx_item_use_count_char ON item_use_count(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_count_item ON item_use_count(item_def_id);
`;

const itemInstanceColumnsToCheck = [
  { name: 'identified', type: 'BOOLEAN NOT NULL DEFAULT true', comment: '是否已鉴定' },
  { name: 'quality', type: 'CHAR(1)', comment: '实例品质（为空则按定义表）' },
  { name: 'quality_rank', type: 'INTEGER', comment: '实例品质排序值（为空则按定义表）' },
];

const checkAndAddItemInstanceColumns = async () => {
  for (const col of itemInstanceColumnsToCheck) {
    try {
      const checkSQL = `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'item_instance' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);

      if (result.rows.length === 0) {
        const addSQL = `ALTER TABLE item_instance ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);

        const commentSQL = `COMMENT ON COLUMN item_instance.${col.name} IS '${col.comment}'`;
        await query(commentSQL);

        console.log(`物品实例表已添加缺失字段: ${col.name}`);
      }
    } catch (error) {
      console.error(`检查字段 ${col.name} 时出错:`, error);
    }
  }
};

/**
 * 历史版本里动态表对静态定义表有外键依赖。
 * 现在定义改为 JSON 直读，初始化时统一解除这些依赖。
 */
const dropLegacyStaticDefForeignKeys = async () => {
  await query('ALTER TABLE item_instance DROP CONSTRAINT IF EXISTS item_instance_item_def_id_fkey');
  await query('ALTER TABLE item_use_cooldown DROP CONSTRAINT IF EXISTS item_use_cooldown_item_def_id_fkey');
  await query('ALTER TABLE item_use_count DROP CONSTRAINT IF EXISTS item_use_count_item_def_id_fkey');
};

// ============================================
// 初始化物品系统表
// ============================================
export const initItemTables = async (): Promise<void> => {
  try {
    console.log('  → 物品定义/词条池/套装/配方改为静态JSON加载，跳过建表');

    await query(itemInstanceTableSQL);
    await query(itemUseCooldownTableSQL);
    await query(itemUseCountTableSQL);

    await dropLegacyStaticDefForeignKeys();
    await checkAndAddItemInstanceColumns();

    await query("COMMENT ON COLUMN item_instance.identified IS '是否已鉴定';");
    await query("COMMENT ON COLUMN item_instance.quality IS '实例品质（为空则按定义表）';");
    await query("COMMENT ON COLUMN item_instance.quality_rank IS '实例品质排序值（为空则按定义表）';");

    console.log('✓ 物品系统表检测完成');
  } catch (error) {
    console.error('✗ 物品系统表初始化失败:', error);
    throw error;
  }
};
