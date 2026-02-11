/**
 * 九州修仙录 - 怪物数据表
 */
import { query } from '../config/database.js';

// ============================================
// 怪物定义表
// ============================================
const monsterDefTableSQL = `
CREATE TABLE IF NOT EXISTS monster_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 怪物配置ID
  code VARCHAR(64),                                   -- 怪物英文码
  name VARCHAR(64) NOT NULL,                          -- 怪物名称
  title VARCHAR(64),                                  -- 称号（妖兽/精英/首领等）
  realm VARCHAR(64),                                  -- 境界（挑战门槛/展示）
  level INTEGER NOT NULL DEFAULT 1,                   -- 等级/档位
  avatar VARCHAR(256),                                -- 头像资源路径
  
  -- 怪物分类
  kind VARCHAR(32) NOT NULL DEFAULT 'normal',         -- 类型（normal/elite/boss/event）
  element VARCHAR(16),                                -- 五行/元素（金木水火土/无）
  
  -- 属性（与玩家角色属性字段一致）
  base_attrs JSONB NOT NULL,                          -- 基础属性
  attr_variance NUMERIC(5,4) DEFAULT 0.05,            -- 属性随机波动比例（±5%）
  attr_multiplier_min NUMERIC(6,4) DEFAULT 0.9000,
  attr_multiplier_max NUMERIC(6,4) DEFAULT 1.1000,
  
  -- 展示属性
  display_stats JSONB,                                -- 展示属性列表（label/value）
  
  -- AI配置
  ai_profile JSONB,                                   -- AI配置（技能权重、条件、优先级）
  
  -- 功法与技能
  technique_slots JSONB,                              -- 功法装备栏位
  technique_layers JSONB,                             -- 功法修炼层数
  skill_ids JSONB,                                    -- 技能ID列表
  
  -- 掉落
  drop_pool_id VARCHAR(64),                           -- 掉落池ID
  exp_reward INTEGER NOT NULL DEFAULT 0,              -- 经验奖励
  silver_reward_min INTEGER NOT NULL DEFAULT 0,       -- 银两奖励下限
  silver_reward_max INTEGER NOT NULL DEFAULT 0,       -- 银两奖励上限
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE monster_def IS '怪物定义表（静态配置）';
COMMENT ON COLUMN monster_def.id IS '怪物配置ID';
COMMENT ON COLUMN monster_def.name IS '怪物名称';
COMMENT ON COLUMN monster_def.title IS '称号（妖兽/精英/首领等）';
COMMENT ON COLUMN monster_def.realm IS '境界（挑战门槛/展示）';
COMMENT ON COLUMN monster_def.level IS '等级/档位';
COMMENT ON COLUMN monster_def.kind IS '类型（normal普通/elite精英/boss首领/event事件）';
COMMENT ON COLUMN monster_def.element IS '五行/元素（金木水火土/无）';
COMMENT ON COLUMN monster_def.base_attrs IS '基础属性（与玩家角色属性字段一致）';
COMMENT ON COLUMN monster_def.attr_variance IS '属性随机波动比例';
COMMENT ON COLUMN monster_def.display_stats IS '展示属性列表';
COMMENT ON COLUMN monster_def.ai_profile IS 'AI配置';
COMMENT ON COLUMN monster_def.drop_pool_id IS '掉落池ID';
COMMENT ON COLUMN monster_def.exp_reward IS '击杀经验奖励';
COMMENT ON COLUMN monster_def.enabled IS '是否启用';

-- 索引
CREATE INDEX IF NOT EXISTS idx_monster_def_kind ON monster_def(kind);
CREATE INDEX IF NOT EXISTS idx_monster_def_realm ON monster_def(realm);
CREATE INDEX IF NOT EXISTS idx_monster_def_level ON monster_def(level);
CREATE INDEX IF NOT EXISTS idx_monster_def_enabled ON monster_def(enabled);
`;

// ============================================
// 刷新配置表
// ============================================
const spawnRuleTableSQL = `
CREATE TABLE IF NOT EXISTS spawn_rule (
  id VARCHAR(64) PRIMARY KEY,                         -- 刷新规则ID
  area VARCHAR(8) NOT NULL,                           -- 所属区域（九宫格）
  
  -- 刷新池
  pool_type VARCHAR(16) NOT NULL DEFAULT 'monster',   -- 池类型（monster/npc）
  pool_entries JSONB NOT NULL,                        -- 池条目（monster_def_id/npc_def_id + weight）
  
  -- 刷新规则
  max_alive INTEGER NOT NULL DEFAULT 10,              -- 最大同时存在数量
  respawn_sec INTEGER NOT NULL DEFAULT 30,            -- 补齐检查周期（秒）
  
  -- 精英/Boss概率
  elite_chance NUMERIC(6,4) DEFAULT 0.02,             -- 精英额外概率
  boss_window JSONB,                                  -- Boss时间窗/事件窗
  
  -- 条件
  req_realm_min VARCHAR(64),                          -- 进入/触发所需最低境界
  req_quest_id VARCHAR(64),                           -- 需要完成的任务ID
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE spawn_rule IS '刷新配置表';
COMMENT ON COLUMN spawn_rule.id IS '刷新规则ID';
COMMENT ON COLUMN spawn_rule.area IS '所属区域（九宫格NW/N/NE/W/C/E/SW/S/SE）';
COMMENT ON COLUMN spawn_rule.pool_type IS '池类型（monster/npc）';
COMMENT ON COLUMN spawn_rule.pool_entries IS '池条目列表';
COMMENT ON COLUMN spawn_rule.max_alive IS '最大同时存在数量';
COMMENT ON COLUMN spawn_rule.respawn_sec IS '补齐检查周期（秒）';
COMMENT ON COLUMN spawn_rule.elite_chance IS '精英额外概率';
COMMENT ON COLUMN spawn_rule.req_realm_min IS '进入所需最低境界';
COMMENT ON COLUMN spawn_rule.enabled IS '是否启用';

-- 索引
CREATE INDEX IF NOT EXISTS idx_spawn_rule_area ON spawn_rule(area);
CREATE INDEX IF NOT EXISTS idx_spawn_rule_enabled ON spawn_rule(enabled);
`;

// ============================================
// 掉落池表
// ============================================
const dropPoolTableSQL = `
CREATE TABLE IF NOT EXISTS drop_pool (
  id VARCHAR(64) PRIMARY KEY,                         -- 掉落池ID
  name VARCHAR(64) NOT NULL,                          -- 掉落池名称
  description TEXT,                                   -- 掉落池说明
  mode VARCHAR(16) NOT NULL DEFAULT 'prob',           -- 掉落模式（prob概率/weight权重）
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE drop_pool IS '掉落池表';
COMMENT ON COLUMN drop_pool.id IS '掉落池ID';
COMMENT ON COLUMN drop_pool.name IS '掉落池名称';
COMMENT ON COLUMN drop_pool.mode IS '掉落模式（prob概率/weight权重）';
`;

const dropPoolEntryTableSQL = `
CREATE TABLE IF NOT EXISTS drop_pool_entry (
  id BIGSERIAL PRIMARY KEY,                           -- 主键
  drop_pool_id VARCHAR(64) NOT NULL,                  -- 掉落池ID
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID
  
  -- 掉落规则
  chance NUMERIC(8,6) DEFAULT 1.0,                    -- 掉落概率（prob模式）
  weight INTEGER DEFAULT 100,                         -- 权重（weight模式）
  qty_min INTEGER NOT NULL DEFAULT 1,                 -- 最小数量
  qty_max INTEGER NOT NULL DEFAULT 1,                 -- 最大数量
  
  -- 品质控制（装备专用）
  quality_weights JSONB,                              -- 品质权重
  
  -- 绑定与展示
  bind_type VARCHAR(16) DEFAULT 'none',               -- 绑定规则
  show_in_ui BOOLEAN NOT NULL DEFAULT true,           -- 是否在前端掉落预览展示
  sort_order INTEGER NOT NULL DEFAULT 0,              -- 展示/结算顺序
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE drop_pool_entry IS '掉落池条目表';
COMMENT ON COLUMN drop_pool_entry.drop_pool_id IS '掉落池ID';
COMMENT ON COLUMN drop_pool_entry.item_def_id IS '物品定义ID';
COMMENT ON COLUMN drop_pool_entry.chance IS '掉落概率（prob模式，1.0=100%）';
COMMENT ON COLUMN drop_pool_entry.weight IS '权重（weight模式）';
COMMENT ON COLUMN drop_pool_entry.qty_min IS '最小数量';
COMMENT ON COLUMN drop_pool_entry.qty_max IS '最大数量';
COMMENT ON COLUMN drop_pool_entry.quality_weights IS '品质权重（装备专用）';
COMMENT ON COLUMN drop_pool_entry.show_in_ui IS '是否在前端掉落预览展示';

CREATE INDEX IF NOT EXISTS idx_drop_pool_entry_pool ON drop_pool_entry(drop_pool_id);
`;

export const initMonsterTables = async (): Promise<void> => {
  try {
    await query(monsterDefTableSQL);
    console.log('✓ 怪物定义表检测完成');

    await query(
      `ALTER TABLE monster_def ADD COLUMN IF NOT EXISTS attr_multiplier_min NUMERIC(6,4) DEFAULT 0.9000`
    );
    await query(
      `ALTER TABLE monster_def ADD COLUMN IF NOT EXISTS attr_multiplier_max NUMERIC(6,4) DEFAULT 1.1000`
    );
    await query(`COMMENT ON COLUMN monster_def.attr_multiplier_min IS '整体属性倍率下限'`);
    await query(`COMMENT ON COLUMN monster_def.attr_multiplier_max IS '整体属性倍率上限'`);
    
    await query(spawnRuleTableSQL);
    console.log('✓ 刷新配置表检测完成');
    
    await query(dropPoolTableSQL);
    await query(dropPoolEntryTableSQL);
    console.log('✓ 掉落池表检测完成');
  } catch (error) {
    console.error('✗ 怪物系统表初始化失败:', error);
    throw error;
  }
};

