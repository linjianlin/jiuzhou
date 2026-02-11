/**
 * 九州修仙录 - NPC 数据表
 */
import { query } from '../config/database.js';

const npcDefTableSQL = `
CREATE TABLE IF NOT EXISTS npc_def (
  id VARCHAR(64) PRIMARY KEY,                         -- NPC配置ID
  code VARCHAR(64),                                   -- NPC英文码
  name VARCHAR(64) NOT NULL,                          -- NPC名称
  title VARCHAR(64),                                  -- NPC称号
  gender VARCHAR(16),                                 -- NPC性别
  realm VARCHAR(64),                                  -- NPC境界（展示用）
  avatar VARCHAR(256),                                -- NPC头像资源路径
  description TEXT,                                   -- NPC描述/简介
  
  -- NPC分类
  npc_type VARCHAR(32) NOT NULL DEFAULT 'world',      -- NPC类型（story/quest/merchant/function/world）
  
  -- 属性（与玩家角色属性字段一致）
  base_attrs JSONB,                                   -- 基础属性
  
  -- 功法与技能
  technique_slots JSONB,                              -- 功法装备栏位
  technique_layers JSONB,                             -- 功法修炼层数
  skill_ids JSONB,                                    -- 技能ID列表
  
  -- 交互配置
  talk_tree_id VARCHAR(64),                           -- 对话树ID
  shop_id VARCHAR(64),                                -- 商店ID
  exchange_id VARCHAR(64),                            -- 兑换表ID
  quest_giver_id VARCHAR(64),                         -- 任务发布配置ID
  
  -- 位置
  area VARCHAR(8),                                    -- 所属区域（九宫格）
  position_x INTEGER,                                 -- X坐标（可选）
  position_y INTEGER,                                 -- Y坐标（可选）
  
  -- 掉落（可抢夺NPC等）
  drop_pool_id VARCHAR(64),                           -- 掉落池ID
  
  -- 运营控制
  sort_weight INTEGER NOT NULL DEFAULT 0,             -- 排序权重
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE npc_def IS 'NPC定义表（静态配置）';
COMMENT ON COLUMN npc_def.id IS 'NPC配置ID';
COMMENT ON COLUMN npc_def.name IS 'NPC名称';
COMMENT ON COLUMN npc_def.title IS 'NPC称号';
COMMENT ON COLUMN npc_def.npc_type IS 'NPC类型（story剧情/quest任务/merchant商业/function功能/world世界）';
COMMENT ON COLUMN npc_def.base_attrs IS '基础属性（与玩家角色属性字段一致）';
COMMENT ON COLUMN npc_def.technique_slots IS '功法装备栏位';
COMMENT ON COLUMN npc_def.talk_tree_id IS '对话树ID';
COMMENT ON COLUMN npc_def.shop_id IS '商店ID';
COMMENT ON COLUMN npc_def.area IS '所属区域（九宫格NW/N/NE/W/C/E/SW/S/SE）';
COMMENT ON COLUMN npc_def.enabled IS '是否启用';

-- 索引
CREATE INDEX IF NOT EXISTS idx_npc_def_type ON npc_def(npc_type);
CREATE INDEX IF NOT EXISTS idx_npc_def_area ON npc_def(area);
CREATE INDEX IF NOT EXISTS idx_npc_def_enabled ON npc_def(enabled);
`;

const talkTreeDefTableSQL = `
CREATE TABLE IF NOT EXISTS talk_tree_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 对话树ID
  name VARCHAR(128) NOT NULL,                         -- 对话树名称
  greeting_lines JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 开场对白（JSON字符串数组）
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  sort_weight INTEGER NOT NULL DEFAULT 0,             -- 排序权重
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE talk_tree_def IS '对话树定义表（静态配置）';
COMMENT ON COLUMN talk_tree_def.id IS '对话树ID';
COMMENT ON COLUMN talk_tree_def.name IS '对话树名称';
COMMENT ON COLUMN talk_tree_def.greeting_lines IS '开场对白（JSON字符串数组）';
COMMENT ON COLUMN talk_tree_def.enabled IS '是否启用';
COMMENT ON COLUMN talk_tree_def.sort_weight IS '排序权重';
COMMENT ON COLUMN talk_tree_def.version IS '配置版本';
COMMENT ON COLUMN talk_tree_def.created_at IS '创建时间';
COMMENT ON COLUMN talk_tree_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_talk_tree_def_enabled ON talk_tree_def(enabled, sort_weight DESC);
`;

export const initNpcTable = async (): Promise<void> => {
  try {
    await query(npcDefTableSQL);
    await query(talkTreeDefTableSQL);
    console.log('✓ NPC表检测完成');
  } catch (error) {
    console.error('✗ NPC表初始化失败:', error);
    throw error;
  }
};

