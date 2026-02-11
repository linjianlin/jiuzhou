/**
 * 九州修仙录 - 地图数据表
 */
import { query } from '../config/database.js';

const mapDefTableSQL = `
CREATE TABLE IF NOT EXISTS map_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 地图ID
  code VARCHAR(64),                                   -- 地图英文码
  name VARCHAR(64) NOT NULL,                          -- 地图名称
  description TEXT,                                   -- 地图描述
  background_image VARCHAR(256),                      -- 背景图资源路径
  
  -- 地图分类
  map_type VARCHAR(32) NOT NULL DEFAULT 'field',      -- 地图类型（field野外/city城镇/dungeon副本/instance秘境）
  parent_map_id VARCHAR(64),                          -- 父地图ID（用于区域层级）
  
  -- 位置信息
  world_position JSONB,                               -- 世界坐标 {x, y}
  region VARCHAR(64),                                 -- 所属大区（如：东洲、西漠等）
  
  -- 进入条件
  req_realm_min VARCHAR(64),                          -- 最低境界要求
  req_level_min INTEGER DEFAULT 0,                    -- 最低等级要求
  req_quest_id VARCHAR(64),                           -- 需要完成的任务ID
  req_item_id VARCHAR(64),                            -- 需要消耗的物品ID
  
  -- 地图属性
  safe_zone BOOLEAN NOT NULL DEFAULT false,           -- 是否安全区（禁止PK）
  pk_mode VARCHAR(16) DEFAULT 'normal',               -- PK模式（normal/free/guild）
  revive_map_id VARCHAR(64),                          -- 死亡复活地图ID
  revive_room_id VARCHAR(64),                         -- 死亡复活房间ID
  
  -- 房间结构（核心）
  rooms JSONB NOT NULL DEFAULT '[]',                  -- 房间列表
  
  -- 运营控制
  sort_weight INTEGER NOT NULL DEFAULT 0,             -- 排序权重
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE map_def IS '地图定义表';
COMMENT ON COLUMN map_def.id IS '地图ID';
COMMENT ON COLUMN map_def.name IS '地图名称';
COMMENT ON COLUMN map_def.description IS '地图描述';
COMMENT ON COLUMN map_def.background_image IS '背景图资源路径';
COMMENT ON COLUMN map_def.map_type IS '地图类型（field野外/city城镇/dungeon副本/instance秘境）';
COMMENT ON COLUMN map_def.parent_map_id IS '父地图ID';
COMMENT ON COLUMN map_def.region IS '所属大区';
COMMENT ON COLUMN map_def.req_realm_min IS '最低境界要求';
COMMENT ON COLUMN map_def.safe_zone IS '是否安全区';
COMMENT ON COLUMN map_def.rooms IS '房间结构JSON';
COMMENT ON COLUMN map_def.enabled IS '是否启用';

-- 索引
CREATE INDEX IF NOT EXISTS idx_map_def_type ON map_def(map_type);
CREATE INDEX IF NOT EXISTS idx_map_def_region ON map_def(region);
CREATE INDEX IF NOT EXISTS idx_map_def_parent ON map_def(parent_map_id);
CREATE INDEX IF NOT EXISTS idx_map_def_enabled ON map_def(enabled);
`;

const characterRoomResourceStateTableSQL = `
CREATE TABLE IF NOT EXISTS character_room_resource_state (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  map_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(64) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  gather_until TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(character_id, map_id, room_id, resource_id)
);

COMMENT ON TABLE character_room_resource_state IS '角色房间资源采集状态';
COMMENT ON COLUMN character_room_resource_state.id IS '主键ID';
COMMENT ON COLUMN character_room_resource_state.character_id IS '角色ID';
COMMENT ON COLUMN character_room_resource_state.map_id IS '地图ID';
COMMENT ON COLUMN character_room_resource_state.room_id IS '房间ID';
COMMENT ON COLUMN character_room_resource_state.resource_id IS '资源ID（对应物品定义ID）';
COMMENT ON COLUMN character_room_resource_state.used_count IS '当前刷新周期已采集次数';
COMMENT ON COLUMN character_room_resource_state.cooldown_until IS '耗尽后刷新时间点';
COMMENT ON COLUMN character_room_resource_state.created_at IS '创建时间';
COMMENT ON COLUMN character_room_resource_state.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_crrs_character ON character_room_resource_state(character_id);
CREATE INDEX IF NOT EXISTS idx_crrs_room ON character_room_resource_state(map_id, room_id);
`;

/*
rooms JSONB 结构说明：
[
  {
    "id": "room-001",              // 房间ID
    "name": "村口",                // 房间名称
    "description": "青云村入口",   // 房间描述
    "position": { "x": 0, "y": 0 }, // 房间在地图中的位置
    "background": "/assets/...",   // 房间背景图（可选）
    "room_type": "normal",         // 房间类型（normal/safe/boss/event）
    
    // 房间连通
    "connections": [
      { "direction": "north", "target_room_id": "room-002" },
      { "direction": "east", "target_room_id": "room-003", "req_item_id": "key-001" }
    ],
    
    // 房间内容
    "npcs": ["npc-village-elder", "npc-blacksmith"],  // NPC ID列表
    "monsters": [                                      // 怪物刷新配置
      { "monster_def_id": "monster-wild-rabbit", "count": 3, "respawn_sec": 30 }
    ],
    "resources": [                                     // 资源点
      { "resource_id": "res-herb-001", "count": 2, "respawn_sec": 300 }
    ],
    "items": [                                         // 地面物品/宝箱
      { "item_def_id": "item-chest-001", "once": true }
    ],
    "portals": [                                       // 传送点
      { "target_map_id": "map-002", "target_room_id": "room-001", "name": "传送阵" }
    ],
    
    // 房间事件
    "events": [
      { "event_id": "evt-001", "trigger": "enter", "once": true }
    ]
  }
]
*/

export const initMapTable = async (): Promise<void> => {
  try {
    await query(mapDefTableSQL);
    await query(characterRoomResourceStateTableSQL);
    await query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'character_room_resource_state' AND column_name = 'gather_until'
        ) THEN
          EXECUTE $$ALTER TABLE character_room_resource_state ADD COLUMN gather_until TIMESTAMPTZ$$;
        END IF;
      END
      $do$;
    `);
    await query(`
      DO $do$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'character_room_resource_state' AND column_name = 'gather_until'
        ) THEN
          EXECUTE $$COMMENT ON COLUMN character_room_resource_state.gather_until IS '采集中完成时间点（5秒一次）'$$;
        END IF;
      END
      $do$;
    `);
    console.log('✓ 地图表检测完成');
  } catch (error) {
    console.error('✗ 地图表初始化失败:', error);
    throw error;
  }
};

