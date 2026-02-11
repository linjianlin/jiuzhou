/**
 * 九州修仙录 - 功法系统数据表
 * 包含：功法定义表、功法层级表、技能定义表、角色功法表、角色技能槽表
 */
import { query } from '../config/database.js';

// ============================================
// 1. 功法定义表 (technique_def) - 静态配置
// ============================================
const techniqueDefTableSQL = `
CREATE TABLE IF NOT EXISTS technique_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 功法ID，如 'tech-tunajue'
  code VARCHAR(64),                                   -- 功法英文码
  name VARCHAR(50) NOT NULL,                          -- 功法名称
  type VARCHAR(20) NOT NULL,                          -- 类型：心法/武技/法诀/身法/辅修
  quality VARCHAR(10) NOT NULL,                       -- 品质：黄/玄/地/天
  quality_rank INTEGER NOT NULL DEFAULT 1,            -- 品质排序值（1-4）
  max_layer INTEGER NOT NULL,                         -- 最大层数：3/5/7/9
  required_realm VARCHAR(50) NOT NULL,                -- 最低境界要求
  
  -- 功法属性（装备主功法后角色属性跟随）
  attribute_type VARCHAR(20) NOT NULL DEFAULT 'physical', -- 属性类型：physical/magic
  attribute_element VARCHAR(10) NOT NULL DEFAULT 'none',  -- 五行属性：none/jin/mu/shui/huo/tu
  
  tags TEXT[] DEFAULT '{}',                           -- 标签数组
  description TEXT,                                   -- 功法描述
  long_desc TEXT,                                     -- 详细描述
  icon VARCHAR(255),                                  -- 图标路径
  
  -- 获取条件
  obtain_type VARCHAR(32) DEFAULT 'drop',             -- 获取方式：drop/shop/quest/sect/event
  obtain_hint TEXT[],                                 -- 获取途径提示
  
  -- 运营控制
  sort_weight INTEGER NOT NULL DEFAULT 0,             -- 排序权重
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE technique_def IS '功法定义表（静态配置）';
COMMENT ON COLUMN technique_def.id IS '功法唯一ID';
COMMENT ON COLUMN technique_def.type IS '功法类型：心法/武技/法诀/身法/辅修';
COMMENT ON COLUMN technique_def.quality IS '品质：黄/玄/地/天';
COMMENT ON COLUMN technique_def.max_layer IS '最大层数：黄3/玄5/地7/天9';
COMMENT ON COLUMN technique_def.required_realm IS '学习所需最低境界';
COMMENT ON COLUMN technique_def.tags IS '标签：流派/元素/机制等';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_technique_def_type ON technique_def(type);
CREATE INDEX IF NOT EXISTS idx_technique_def_quality ON technique_def(quality);
CREATE INDEX IF NOT EXISTS idx_technique_def_enabled ON technique_def(enabled);
`;

// ============================================
// 2. 功法层级表 (technique_layer) - 每层配置
// ============================================
const techniqueLayerTableSQL = `
CREATE TABLE IF NOT EXISTS technique_layer (
  id SERIAL PRIMARY KEY,
  technique_id VARCHAR(64) NOT NULL REFERENCES technique_def(id) ON DELETE CASCADE,
  layer INTEGER NOT NULL,                             -- 层数 1-9
  
  -- 升级消耗
  cost_spirit_stones INTEGER NOT NULL DEFAULT 0,      -- 灵石消耗
  cost_exp INTEGER NOT NULL DEFAULT 0,                -- 经验消耗
  cost_materials JSONB DEFAULT '[]',                  -- 材料消耗 [{itemId, qty}]
  
  -- 被动加成（万分比）
  passives JSONB DEFAULT '[]',                        -- [{key, value}] value为万分比
  
  -- 技能解锁/强化
  unlock_skill_ids TEXT[] DEFAULT '{}',               -- 本层解锁的技能ID
  upgrade_skill_ids TEXT[] DEFAULT '{}',              -- 本层强化的技能ID
  
  -- 前置条件
  required_realm VARCHAR(50),                         -- 本层境界要求（可选）
  required_quest_id VARCHAR(64),                      -- 前置任务ID（可选）
  
  -- 描述
  layer_desc TEXT,                                    -- 本层描述/心得
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(technique_id, layer)
);

-- 添加表注释
COMMENT ON TABLE technique_layer IS '功法层级表';
COMMENT ON COLUMN technique_layer.technique_id IS '功法ID';
COMMENT ON COLUMN technique_layer.layer IS '层数 1-9';
COMMENT ON COLUMN technique_layer.cost_spirit_stones IS '升级灵石消耗';
COMMENT ON COLUMN technique_layer.cost_exp IS '升级经验消耗';
COMMENT ON COLUMN technique_layer.cost_materials IS '升级材料消耗 [{itemId, qty}]';
COMMENT ON COLUMN technique_layer.passives IS '被动加成 [{key, value}] 万分比';
COMMENT ON COLUMN technique_layer.unlock_skill_ids IS '本层解锁的技能ID列表';
COMMENT ON COLUMN technique_layer.upgrade_skill_ids IS '本层强化的技能ID列表';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_technique_layer_tech ON technique_layer(technique_id);
`;

// ============================================
// 3. 技能定义表 (skill_def) - 静态配置
// ============================================
const skillDefTableSQL = `
CREATE TABLE IF NOT EXISTS skill_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 技能ID
  code VARCHAR(64),                                   -- 技能英文码
  name VARCHAR(50) NOT NULL,                          -- 技能名称
  description TEXT,                                   -- 技能描述
  icon VARCHAR(255),                                  -- 图标路径
  
  -- 来源
  source_type VARCHAR(20) NOT NULL,                   -- innate/technique/equipment/item
  source_id VARCHAR(64),                              -- 来源ID（功法ID/装备ID）
  
  -- 消耗与冷却
  cost_lingqi INTEGER DEFAULT 0,                      -- 灵气消耗
  cost_qixue INTEGER DEFAULT 0,                       -- 气血消耗（百分比，万分比）
  cooldown INTEGER DEFAULT 0,                         -- 冷却回合数
  
  -- 目标
  target_type VARCHAR(20) NOT NULL,                   -- self/single_enemy/single_ally/all_enemy/all_ally/random_enemy/random_ally
  target_count INTEGER DEFAULT 1,                     -- 目标数量
  
  -- 伤害/治疗
  damage_type VARCHAR(20),                            -- physical/magic/true/null
  element VARCHAR(10) DEFAULT 'none',                 -- 元素：none/jin/mu/shui/huo/tu
  
  -- 效果列表
  effects JSONB DEFAULT '[]',                         -- SkillEffect[]
  
  -- 触发类型
  trigger_type VARCHAR(20) DEFAULT 'active',          -- active/passive/counter/chase
  
  -- 条件
  conditions JSONB,                                   -- 释放条件
  
  -- AI优先级
  ai_priority INTEGER DEFAULT 50,                     -- AI使用优先级 0-100
  ai_conditions JSONB,                                -- AI使用条件
  
  -- 技能升级定义
  upgrades JSONB DEFAULT '[]',                        -- SkillUpgrade[]
  
  -- 运营控制
  sort_weight INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE skill_def IS '技能定义表';
COMMENT ON COLUMN skill_def.id IS '技能唯一ID';
COMMENT ON COLUMN skill_def.source_type IS '来源类型：innate/technique/equipment/item';
COMMENT ON COLUMN skill_def.source_id IS '来源ID（功法ID/装备ID）';
COMMENT ON COLUMN skill_def.target_type IS '目标类型：self/single_enemy/single_ally/all_enemy/all_ally/random_enemy/random_ally';
COMMENT ON COLUMN skill_def.damage_type IS '伤害类型：physical/magic/true';
COMMENT ON COLUMN skill_def.element IS '元素：none/jin/mu/shui/huo/tu';
COMMENT ON COLUMN skill_def.effects IS '技能效果列表';
COMMENT ON COLUMN skill_def.trigger_type IS '触发类型：active/passive/counter/chase';
COMMENT ON COLUMN skill_def.upgrades IS '技能升级定义';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_skill_def_source ON skill_def(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_skill_def_trigger ON skill_def(trigger_type);
CREATE INDEX IF NOT EXISTS idx_skill_def_enabled ON skill_def(enabled);
`;


// ============================================
// 4. 角色功法表 (character_technique) - 动态数据
// ============================================
const characterTechniqueTableSQL = `
CREATE TABLE IF NOT EXISTS character_technique (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  technique_id VARCHAR(64) NOT NULL REFERENCES technique_def(id),
  
  current_layer INTEGER DEFAULT 1,                    -- 当前层数
  slot_type VARCHAR(10),                              -- 装备槽：main/sub/null(未装备)
  slot_index INTEGER,                                 -- 副功法槽位 1-3（main时为null）
  
  -- 来源追溯
  obtained_from VARCHAR(32),                          -- 获取来源：drop/shop/quest/sect/gift/admin
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID
  
  acquired_at TIMESTAMPTZ DEFAULT NOW(),              -- 获得时间
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(character_id, technique_id)
);

-- 添加表注释
COMMENT ON TABLE character_technique IS '角色功法表（动态数据）';
COMMENT ON COLUMN character_technique.character_id IS '角色ID';
COMMENT ON COLUMN character_technique.technique_id IS '功法ID';
COMMENT ON COLUMN character_technique.current_layer IS '当前修炼层数';
COMMENT ON COLUMN character_technique.slot_type IS '装备槽类型：main主功法/sub副功法/null未装备';
COMMENT ON COLUMN character_technique.slot_index IS '副功法槽位索引 1-3';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_char_tech_char ON character_technique(character_id);
CREATE INDEX IF NOT EXISTS idx_char_tech_slot ON character_technique(character_id, slot_type);
CREATE INDEX IF NOT EXISTS idx_char_tech_equipped ON character_technique(character_id) WHERE slot_type IS NOT NULL;
`;

// ============================================
// 5. 角色技能槽表 (character_skill_slot) - 动态数据
// ============================================
const characterSkillSlotTableSQL = `
CREATE TABLE IF NOT EXISTS character_skill_slot (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL,                        -- 槽位 1-10
  skill_id VARCHAR(64) NOT NULL REFERENCES skill_def(id),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(character_id, slot_index),
  UNIQUE(character_id, skill_id)
);

-- 添加表注释
COMMENT ON TABLE character_skill_slot IS '角色技能槽表';
COMMENT ON COLUMN character_skill_slot.character_id IS '角色ID';
COMMENT ON COLUMN character_skill_slot.slot_index IS '技能槽位 1-10';
COMMENT ON COLUMN character_skill_slot.skill_id IS '装配的技能ID';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_char_skill_char ON character_skill_slot(character_id);
`;

// ============================================
// 初始化功法系统表
// ============================================
export const initTechniqueTables = async (): Promise<void> => {
  try {
    // 1. 创建功法定义表
    await query(techniqueDefTableSQL);
    await query(
      "ALTER TABLE technique_def ADD COLUMN IF NOT EXISTS attribute_type VARCHAR(20) NOT NULL DEFAULT 'physical'"
    );
    await query(
      "ALTER TABLE technique_def ADD COLUMN IF NOT EXISTS attribute_element VARCHAR(10) NOT NULL DEFAULT 'none'"
    );
    await query("COMMENT ON COLUMN technique_def.attribute_type IS '属性类型：physical物理/magic法术'");
    await query("COMMENT ON COLUMN technique_def.attribute_element IS '五行属性：none/jin/mu/shui/huo/tu'");
    
    // 2. 创建功法层级表
    await query(techniqueLayerTableSQL);
    
    // 3. 创建技能定义表
    await query(skillDefTableSQL);
    
    // 4. 创建角色功法表
    await query(characterTechniqueTableSQL);
    
    // 5. 创建角色技能槽表
    await query(characterSkillSlotTableSQL);
    
    console.log('✓ 功法系统表检测完成');
  } catch (error) {
    console.error('✗ 功法系统表初始化失败:', error);
    throw error;
  }
};

export default initTechniqueTables;
