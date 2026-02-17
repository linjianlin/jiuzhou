import { query } from '../config/database.js';
import { runDbMigrationOnce } from './migrationHistoryTable.js';

// 角色主表（仅保留基础信息，不再持久化可计算的战斗属性）
const characterTableSQL = `
CREATE TABLE IF NOT EXISTS characters (
  id SERIAL PRIMARY KEY,                              -- 角色ID，自增主键
  user_id INTEGER NOT NULL REFERENCES users(id),      -- 关联用户ID
  nickname VARCHAR(50) NOT NULL,                      -- 昵称
  title VARCHAR(50) DEFAULT '散修',                   -- 称号
  gender VARCHAR(10) NOT NULL,                        -- 性别：male/female
  avatar VARCHAR(255) DEFAULT NULL,                   -- 头像路径

  -- 货币与体力
  spirit_stones BIGINT DEFAULT 0,                     -- 灵石
  silver BIGINT DEFAULT 0,                            -- 银两
  stamina INTEGER NOT NULL DEFAULT 100,               -- 体力
  stamina_recover_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- 体力恢复基准时间

  -- 境界与经验
  realm VARCHAR(50) DEFAULT '凡人',                   -- 境界
  sub_realm VARCHAR(50) DEFAULT NULL,                 -- 子境界
  exp BIGINT DEFAULT 0,                               -- 经验

  -- 属性点（用于运行时计算基础属性）
  attribute_points INTEGER DEFAULT 0,                 -- 可分配属性点
  jing INTEGER DEFAULT 0,                             -- 精
  qi INTEGER DEFAULT 0,                               -- 气
  shen INTEGER DEFAULT 0,                             -- 神

  -- 属性类型：physical/magic + 五行(none/jin/mu/shui/huo/tu)
  attribute_type VARCHAR(20) DEFAULT 'physical',      -- 属性类型
  attribute_element VARCHAR(10) DEFAULT 'none',       -- 五行属性

  -- 位置（用于下次登录/刷新回到上次位置）
  current_map_id VARCHAR(64) DEFAULT 'map-qingyun-village',  -- 当前所在地图ID
  current_room_id VARCHAR(64) DEFAULT 'room-village-center', -- 当前所在房间ID
  last_offline_at TIMESTAMPTZ DEFAULT NULL,           -- 最后离线时间

  -- 战斗设置
  auto_cast_skills BOOLEAN DEFAULT true,               -- 自动释放技能开关
  auto_disassemble_enabled BOOLEAN DEFAULT false,      -- 自动分解物品开关
  auto_disassemble_rules JSONB DEFAULT '[]'::jsonb,    -- 自动分解高级规则（数组）

  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id)
);
`;

// 说明：
// 1) 这里单独拆出注释 SQL，避免历史库缺少某些新列时，
//    在 CREATE TABLE IF NOT EXISTS 之后立刻 COMMENT ON COLUMN 直接失败。
// 2) 初始化流程会先补齐缺失列，再执行本段注释，保证升级路径可达。
const characterTableCommentSQL = `
COMMENT ON TABLE characters IS '玩家角色表（可计算战斗属性不入库）';
COMMENT ON COLUMN characters.id IS '角色ID，自增主键';
COMMENT ON COLUMN characters.user_id IS '关联用户ID';
COMMENT ON COLUMN characters.nickname IS '昵称';
COMMENT ON COLUMN characters.title IS '称号';
COMMENT ON COLUMN characters.gender IS '性别：male/female';
COMMENT ON COLUMN characters.avatar IS '头像路径';
COMMENT ON COLUMN characters.spirit_stones IS '灵石';
COMMENT ON COLUMN characters.silver IS '银两';
COMMENT ON COLUMN characters.stamina IS '体力';
COMMENT ON COLUMN characters.stamina_recover_at IS '体力恢复基准时间';
COMMENT ON COLUMN characters.realm IS '境界';
COMMENT ON COLUMN characters.sub_realm IS '子境界';
COMMENT ON COLUMN characters.exp IS '经验';
COMMENT ON COLUMN characters.attribute_points IS '可分配属性点';
COMMENT ON COLUMN characters.jing IS '精';
COMMENT ON COLUMN characters.qi IS '气';
COMMENT ON COLUMN characters.shen IS '神';
COMMENT ON COLUMN characters.attribute_type IS '属性类型：physical物理/magic法术';
COMMENT ON COLUMN characters.attribute_element IS '五行属性：none/jin/mu/shui/huo/tu';
COMMENT ON COLUMN characters.current_map_id IS '当前所在地图ID';
COMMENT ON COLUMN characters.current_room_id IS '当前所在房间ID';
COMMENT ON COLUMN characters.last_offline_at IS '最后离线时间';
COMMENT ON COLUMN characters.auto_cast_skills IS '自动释放技能开关';
COMMENT ON COLUMN characters.auto_disassemble_enabled IS '自动分解物品开关';
COMMENT ON COLUMN characters.auto_disassemble_rules IS '自动分解高级规则JSON数组（规则间 OR）';
`;

const columnsToCheck = [
  { name: 'title', type: "VARCHAR(50) DEFAULT '散修'", comment: '称号' },
  { name: 'avatar', type: 'VARCHAR(255) DEFAULT NULL', comment: '头像路径' },
  { name: 'stamina', type: 'INTEGER NOT NULL DEFAULT 100', comment: '体力' },
  { name: 'stamina_recover_at', type: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()', comment: '体力恢复基准时间' },
  { name: 'realm', type: "VARCHAR(50) DEFAULT '凡人'", comment: '境界' },
  { name: 'sub_realm', type: 'VARCHAR(50) DEFAULT NULL', comment: '子境界' },
  { name: 'exp', type: 'BIGINT DEFAULT 0', comment: '经验' },
  { name: 'attribute_points', type: 'INTEGER DEFAULT 0', comment: '可分配属性点' },
  { name: 'jing', type: 'INTEGER DEFAULT 0', comment: '精' },
  { name: 'qi', type: 'INTEGER DEFAULT 0', comment: '气' },
  { name: 'shen', type: 'INTEGER DEFAULT 0', comment: '神' },
  { name: 'attribute_type', type: "VARCHAR(20) DEFAULT 'physical'", comment: '属性类型' },
  { name: 'attribute_element', type: "VARCHAR(10) DEFAULT 'none'", comment: '五行属性' },
  { name: 'current_map_id', type: "VARCHAR(64) DEFAULT 'map-qingyun-village'", comment: '当前所在地图ID' },
  { name: 'current_room_id', type: "VARCHAR(64) DEFAULT 'room-village-center'", comment: '当前所在房间ID' },
  { name: 'last_offline_at', type: 'TIMESTAMPTZ DEFAULT NULL', comment: '最后离线时间' },
  { name: 'auto_cast_skills', type: 'BOOLEAN DEFAULT true', comment: '自动释放技能开关' },
  { name: 'auto_disassemble_enabled', type: 'BOOLEAN DEFAULT false', comment: '自动分解物品开关' },
  { name: 'auto_disassemble_rules', type: "JSONB DEFAULT '[]'::jsonb", comment: '自动分解高级规则JSON数组（规则间 OR）' },
] as const;

const deprecatedAttrColumns = [
  'qixue',
  'max_qixue',
  'lingqi',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
  'sudu',
  'fuyuan',
] as const;

const checkAndAddColumns = async () => {
  const addedFields: string[] = [];
  for (const col of columnsToCheck) {
    try {
      const checkSQL = `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'characters' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);

      if (result.rows.length === 0) {
        const addSQL = `ALTER TABLE characters ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);
        addedFields.push(col.name);
      }

      const commentSQL = `COMMENT ON COLUMN characters.${col.name} IS '${col.comment}'`;
      await query(commentSQL);
    } catch (error) {
      console.error(`  ✗ 检查字段 ${col.name} 时出错:`, error);
    }
  }

  if (addedFields.length > 0) {
    console.log(`  → 角色表已添加字段: ${addedFields.join(', ')}`);
  }
};


const dropDeprecatedAttrColumns = async (): Promise<void> => {
  // 删除旧触发器与函数，避免依赖已下线字段。
  await query('DROP TRIGGER IF EXISTS trigger_calculate_attributes ON characters');
  await query('DROP FUNCTION IF EXISTS calculate_attributes()');

  for (const col of deprecatedAttrColumns) {
    await query(`ALTER TABLE characters DROP COLUMN IF EXISTS ${col}`);
  }
};

const dropDeprecatedAutoDisassembleGlobalQualityColumn = async (): Promise<void> => {
  // 自动分解“最高品质”已迁移到 rules 内；清理旧全局列，避免产生错误心智。
  await query('ALTER TABLE characters DROP COLUMN IF EXISTS auto_disassemble_max_quality_rank');
};

// 初始化角色表
export const initCharacterTable = async (): Promise<void> => {
  try {
    // 检查表是否存在
    const tableCheck = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'characters'
      )
    `);

    if (tableCheck.rows[0].exists) {
      // 检查关键字段是否存在，如果不存在则删除重建
      const columnCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'characters' AND column_name = 'spirit_stones'
      `);

      if (columnCheck.rows.length === 0) {
        console.log('  → 角色表结构不完整，重建表...');
        await query('DROP TABLE IF EXISTS characters CASCADE');
      }
    }

    // 创建角色表
    await query(characterTableSQL);

    // 检查并补齐缺失字段
    await checkAndAddColumns();

    // 字段补齐后再写注释，避免旧库缺字段时在注释阶段中断初始化。
    await query(characterTableCommentSQL);

    // 一次性下线旧属性字段，避免启动重复迁移导致不可预期结果。
    await runDbMigrationOnce({
      migrationKey: 'characters_runtime_attr_columns_drop_v1',
      description: '角色可计算属性改为运行时计算并删除旧字段',
      execute: dropDeprecatedAttrColumns,
    });

    await runDbMigrationOnce({
      migrationKey: 'characters_auto_disassemble_global_quality_drop_v1',
      description: '自动分解最高品质迁移到规则并删除旧全局字段',
      execute: dropDeprecatedAutoDisassembleGlobalQualityColumn,
    });

    console.log('✓ 角色表检测完成');
  } catch (error) {
    console.error('✗ 角色表初始化失败:', error);
    throw error;
  }
};
