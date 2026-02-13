import { query } from '../config/database.js';
import { runDbMigrationOnce } from './migrationHistoryTable.js';

// 角色表结构定义
const characterTableSQL = `
CREATE TABLE IF NOT EXISTS characters (
  id SERIAL PRIMARY KEY,                              -- 角色ID，自增主键
  user_id INTEGER NOT NULL REFERENCES users(id),      -- 关联用户ID
  nickname VARCHAR(50) NOT NULL,                      -- 昵称
  title VARCHAR(50) DEFAULT '散修',                   -- 称号
  gender VARCHAR(10) NOT NULL,                        -- 性别：male/female
  avatar VARCHAR(255) DEFAULT NULL,                   -- 头像路径
  
  -- 货币
  spirit_stones BIGINT DEFAULT 0,                     -- 灵石
  silver BIGINT DEFAULT 0,                            -- 银两
  stamina INTEGER NOT NULL DEFAULT 100,               -- 体力
  stamina_recover_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- 体力恢复基准时间
  
  -- 境界与经验
  realm VARCHAR(50) DEFAULT '凡人',                   -- 境界
  sub_realm VARCHAR(50) DEFAULT NULL,                 -- 子境界
  exp BIGINT DEFAULT 0,                               -- 经验
  
  -- 属性点
  attribute_points INTEGER DEFAULT 0,                 -- 可分配属性点
  jing INTEGER DEFAULT 0,                             -- 精
  qi INTEGER DEFAULT 0,                               -- 气
  shen INTEGER DEFAULT 0,                             -- 神
  
  -- 属性类型：physical/magic + 五行(none/jin/mu/shui/huo/tu)
  attribute_type VARCHAR(20) DEFAULT 'physical',      -- 属性类型
  attribute_element VARCHAR(10) DEFAULT 'none',       -- 五行属性
  
  -- 基础属性
  qixue INTEGER DEFAULT 100,                          -- 气血
  max_qixue INTEGER DEFAULT 100,                      -- 最大气血
  lingqi INTEGER DEFAULT 0,                           -- 灵气
  max_lingqi INTEGER DEFAULT 0,                       -- 最大灵气
  
  -- 攻防属性
  wugong INTEGER DEFAULT 5,                           -- 物攻
  fagong INTEGER DEFAULT 0,                           -- 法攻
  wufang INTEGER DEFAULT 2,                           -- 物防
  fafang INTEGER DEFAULT 0,                           -- 法防
  
  -- 战斗属性（比例值，1 = 100%）
  mingzhong DOUBLE PRECISION DEFAULT 0.9,            -- 命中 90%
  shanbi DOUBLE PRECISION DEFAULT 0.05,              -- 闪避 5%
  zhaojia DOUBLE PRECISION DEFAULT 0.05,             -- 招架 5%
  baoji DOUBLE PRECISION DEFAULT 0.1,                -- 暴击 10%
  baoshang DOUBLE PRECISION DEFAULT 1.5,             -- 爆伤 150%
  kangbao DOUBLE PRECISION DEFAULT 0,                -- 抗暴 0%
  zengshang DOUBLE PRECISION DEFAULT 0,              -- 增伤 0%
  zhiliao DOUBLE PRECISION DEFAULT 0,                -- 治疗 0%
  jianliao DOUBLE PRECISION DEFAULT 0,               -- 减疗 0%
  xixue DOUBLE PRECISION DEFAULT 0,                  -- 吸血 0%
  lengque DOUBLE PRECISION DEFAULT 0,                -- 技能冷却 0%
  shuxing_shuzhi DOUBLE PRECISION DEFAULT 0,         -- 属性数值 0%
  kongzhi_kangxing DOUBLE PRECISION DEFAULT 0,       -- 控制抗性 0%
  
  -- 五行抗性（比例值）
  jin_kangxing DOUBLE PRECISION DEFAULT 0,           -- 金属性抗性 0%
  mu_kangxing DOUBLE PRECISION DEFAULT 0,            -- 木属性抗性 0%
  shui_kangxing DOUBLE PRECISION DEFAULT 0,          -- 水属性抗性 0%
  huo_kangxing DOUBLE PRECISION DEFAULT 0,           -- 火属性抗性 0%
  tu_kangxing DOUBLE PRECISION DEFAULT 0,            -- 土属性抗性 0%
  
  -- 恢复与其他
  qixue_huifu INTEGER DEFAULT 0,                      -- 气血恢复
  lingqi_huifu INTEGER DEFAULT 0,                     -- 灵气恢复
  sudu INTEGER DEFAULT 1,                             -- 速度
  fuyuan INTEGER DEFAULT 1,                           -- 福源

  -- 位置（用于下次登录/刷新回到上次位置）
  current_map_id VARCHAR(64) DEFAULT 'map-qingyun-village',  -- 当前所在地图ID
  current_room_id VARCHAR(64) DEFAULT 'room-village-center', -- 当前所在房间ID

  -- 战斗设置
  auto_cast_skills BOOLEAN DEFAULT true,               -- 自动释放技能开关
  auto_disassemble_enabled BOOLEAN DEFAULT false,      -- 自动分解物品开关
  auto_disassemble_max_quality_rank INTEGER DEFAULT 1, -- 自动分解最高品质（1黄/2玄/3地/4天）
  auto_disassemble_rules JSONB DEFAULT '[]'::jsonb,    -- 自动分解高级规则（数组）

  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 创建时间
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 更新时间
  
  UNIQUE(user_id)                                     -- 一个用户只能有一个角色
);

-- 添加表注释
COMMENT ON TABLE characters IS '玩家角色表';
COMMENT ON COLUMN characters.id IS '角色ID，自增主键';
COMMENT ON COLUMN characters.user_id IS '关联用户ID';
COMMENT ON COLUMN characters.nickname IS '昵称';
COMMENT ON COLUMN characters.title IS '称号';
COMMENT ON COLUMN characters.gender IS '性别：male/female';
COMMENT ON COLUMN characters.avatar IS '头像路径';
COMMENT ON COLUMN characters.spirit_stones IS '灵石';
COMMENT ON COLUMN characters.silver IS '银两';
COMMENT ON COLUMN characters.realm IS '境界';
COMMENT ON COLUMN characters.sub_realm IS '子境界';
COMMENT ON COLUMN characters.exp IS '经验';
COMMENT ON COLUMN characters.attribute_points IS '可分配属性点';
COMMENT ON COLUMN characters.jing IS '精';
COMMENT ON COLUMN characters.qi IS '气';
COMMENT ON COLUMN characters.shen IS '神';
COMMENT ON COLUMN characters.attribute_type IS '属性类型：physical物理/magic法术';
COMMENT ON COLUMN characters.attribute_element IS '五行属性：none/jin/mu/shui/huo/tu';
COMMENT ON COLUMN characters.qixue IS '当前气血';
COMMENT ON COLUMN characters.max_qixue IS '最大气血';
COMMENT ON COLUMN characters.lingqi IS '当前灵气';
COMMENT ON COLUMN characters.max_lingqi IS '最大灵气';
COMMENT ON COLUMN characters.wugong IS '物理攻击';
COMMENT ON COLUMN characters.fagong IS '法术攻击';
COMMENT ON COLUMN characters.wufang IS '物理防御';
COMMENT ON COLUMN characters.fafang IS '法术防御';
COMMENT ON COLUMN characters.mingzhong IS '命中率（比例值，1=100%）';
COMMENT ON COLUMN characters.shanbi IS '闪避率（比例值，1=100%）';
COMMENT ON COLUMN characters.zhaojia IS '招架率（比例值，1=100%）';
COMMENT ON COLUMN characters.baoji IS '暴击率（比例值，1=100%）';
COMMENT ON COLUMN characters.baoshang IS '爆伤倍率（比例值，1=100%）';
COMMENT ON COLUMN characters.kangbao IS '抗暴（比例值，1=100%）';
COMMENT ON COLUMN characters.zengshang IS '增伤（比例值，1=100%）';
COMMENT ON COLUMN characters.zhiliao IS '治疗（比例值，1=100%）';
COMMENT ON COLUMN characters.jianliao IS '减疗（比例值，1=100%）';
COMMENT ON COLUMN characters.xixue IS '吸血（比例值，1=100%）';
COMMENT ON COLUMN characters.lengque IS '技能冷却（比例值，1=100%）';
COMMENT ON COLUMN characters.shuxing_shuzhi IS '属性数值（比例值，1=100%）';
COMMENT ON COLUMN characters.kongzhi_kangxing IS '控制抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.jin_kangxing IS '金属性抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.mu_kangxing IS '木属性抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.shui_kangxing IS '水属性抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.huo_kangxing IS '火属性抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.tu_kangxing IS '土属性抗性（比例值，1=100%）';
COMMENT ON COLUMN characters.qixue_huifu IS '气血恢复';
COMMENT ON COLUMN characters.lingqi_huifu IS '灵气恢复';
COMMENT ON COLUMN characters.sudu IS '速度';
COMMENT ON COLUMN characters.fuyuan IS '福源';
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'stamina'
  ) THEN
    EXECUTE $$COMMENT ON COLUMN characters.stamina IS '体力'$$;
  END IF;
END
$do$;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'stamina_recover_at'
  ) THEN
    EXECUTE $$COMMENT ON COLUMN characters.stamina_recover_at IS '体力恢复基准时间'$$;
  END IF;
END
$do$;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'auto_cast_skills'
  ) THEN
    EXECUTE $$COMMENT ON COLUMN characters.auto_cast_skills IS '自动释放技能开关'$$;
  END IF;
END
$do$;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'auto_disassemble_enabled'
  ) THEN
    EXECUTE $$COMMENT ON COLUMN characters.auto_disassemble_enabled IS '自动分解物品开关'$$;
  END IF;
END
$do$;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'auto_disassemble_max_quality_rank'
  ) THEN
    EXECUTE $$COMMENT ON COLUMN characters.auto_disassemble_max_quality_rank IS '自动分解最高品质（1黄/2玄/3地/4天）'$$;
  END IF;
END
$do$;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'characters' AND column_name = 'auto_disassemble_rules'
  ) THEN
    EXECUTE $$ALTER TABLE characters ALTER COLUMN auto_disassemble_rules SET DEFAULT '[]'::jsonb$$;
    EXECUTE $$COMMENT ON COLUMN characters.auto_disassemble_rules IS '自动分解高级规则JSON数组（规则间 OR）'$$;
  END IF;
END
$do$;
`;

// 创建属性计算触发器函数
const createAttributeTriggerSQL = `
-- 创建或替换属性计算函数
CREATE OR REPLACE FUNCTION calculate_attributes()
RETURNS TRIGGER AS $$
DECLARE
  jing_diff INTEGER;
  qi_diff INTEGER;
  shen_diff INTEGER;
BEGIN
  -- 计算精气神的变化量
  jing_diff := NEW.jing - COALESCE(OLD.jing, 0);
  qi_diff := NEW.qi - COALESCE(OLD.qi, 0);
  shen_diff := NEW.shen - COALESCE(OLD.shen, 0);
  
  -- 精每点加成：生命+5、物防+2、法防+2
  IF jing_diff != 0 THEN
    NEW.max_qixue := NEW.max_qixue + (jing_diff * 5);
    NEW.qixue := LEAST(NEW.qixue, NEW.max_qixue);
    NEW.wufang := NEW.wufang + (jing_diff * 2);
    NEW.fafang := NEW.fafang + (jing_diff * 2);
  END IF;
  
  -- 气每点加成：灵气+5、物攻+2、法攻+2
  IF qi_diff != 0 THEN
    NEW.max_lingqi := NEW.max_lingqi + (qi_diff * 5);
    NEW.lingqi := LEAST(NEW.lingqi, NEW.max_lingqi);
    NEW.wugong := NEW.wugong + (qi_diff * 2);
    NEW.fagong := NEW.fagong + (qi_diff * 2);
  END IF;
  
  -- 神每点加成：命中+0.2%、暴击+0.1%（比例制分别为 0.002 / 0.001）
  IF shen_diff != 0 THEN
    NEW.mingzhong := NEW.mingzhong + (shen_diff * 0.002);
    NEW.baoji := NEW.baoji + (shen_diff * 0.001);
  END IF;
  
  -- 更新时间
  NEW.updated_at := CURRENT_TIMESTAMP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 删除已存在的触发器（如果存在）
DROP TRIGGER IF EXISTS trigger_calculate_attributes ON characters;

-- 创建触发器
CREATE TRIGGER trigger_calculate_attributes
  BEFORE INSERT OR UPDATE OF jing, qi, shen ON characters
  FOR EACH ROW
  EXECUTE FUNCTION calculate_attributes();
`;

// 需要检查的字段列表
const columnsToCheck = [
  { name: 'title', type: "VARCHAR(50) DEFAULT '散修'", comment: '称号' },
  { name: 'avatar', type: 'VARCHAR(255) DEFAULT NULL', comment: '头像路径' },
  { name: 'stamina', type: 'INTEGER NOT NULL DEFAULT 100', comment: '体力' },
  { name: 'stamina_recover_at', type: 'TIMESTAMPTZ NOT NULL DEFAULT NOW()', comment: '体力恢复基准时间' },
  { name: 'attribute_type', type: "VARCHAR(20) DEFAULT 'physical'", comment: '属性类型' },
  { name: 'attribute_element', type: "VARCHAR(10) DEFAULT 'none'", comment: '五行属性' },
  { name: 'lengque', type: 'DOUBLE PRECISION DEFAULT 0', comment: '技能冷却（比例值，1=100%）' },
  { name: 'shuxing_shuzhi', type: 'DOUBLE PRECISION DEFAULT 0', comment: '属性数值（比例值，1=100%）' },
  { name: 'kongzhi_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '控制抗性（比例值，1=100%）' },
  { name: 'jin_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '金属性抗性（比例值，1=100%）' },
  { name: 'mu_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '木属性抗性（比例值，1=100%）' },
  { name: 'shui_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '水属性抗性（比例值，1=100%）' },
  { name: 'huo_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '火属性抗性（比例值，1=100%）' },
  { name: 'tu_kangxing', type: 'DOUBLE PRECISION DEFAULT 0', comment: '土属性抗性（比例值，1=100%）' },
  { name: 'qixue_huifu', type: 'INTEGER DEFAULT 0', comment: '气血恢复' },
  { name: 'lingqi_huifu', type: 'INTEGER DEFAULT 0', comment: '灵气恢复' },
  { name: 'sudu', type: 'INTEGER DEFAULT 1', comment: '速度' },
  { name: 'fuyuan', type: 'INTEGER DEFAULT 1', comment: '福源' },
  { name: 'current_map_id', type: "VARCHAR(64) DEFAULT 'map-qingyun-village'", comment: '当前所在地图ID' },
  { name: 'current_room_id', type: "VARCHAR(64) DEFAULT 'room-village-center'", comment: '当前所在房间ID' },
  { name: 'auto_cast_skills', type: 'BOOLEAN DEFAULT true', comment: '自动释放技能开关' },
  { name: 'auto_disassemble_enabled', type: 'BOOLEAN DEFAULT false', comment: '自动分解物品开关' },
  { name: 'auto_disassemble_max_quality_rank', type: 'INTEGER DEFAULT 1', comment: '自动分解最高品质（1黄/2玄/3地/4天）' },
  { name: 'auto_disassemble_rules', type: "JSONB DEFAULT '[]'::jsonb", comment: '自动分解高级规则JSON数组（规则间 OR）' },
];

const percentAttrColumns = [
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
] as const;

// 检查并添加缺失字段
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

const ensurePercentAttrsAsActualValue = async () => {
  for (const col of percentAttrColumns) {
    await query(`ALTER TABLE characters ALTER COLUMN ${col} TYPE DOUBLE PRECISION USING ${col}::DOUBLE PRECISION`);
  }

  const percentDefaultValues: Record<(typeof percentAttrColumns)[number], number> = {
    mingzhong: 0.9,
    shanbi: 0.05,
    zhaojia: 0.05,
    baoji: 0.1,
    baoshang: 1.5,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    shuxing_shuzhi: 0,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
  };
  for (const col of percentAttrColumns) {
    const defVal = percentDefaultValues[col];
    await query(`ALTER TABLE characters ALTER COLUMN ${col} SET DEFAULT ${defVal}`);
  }

  const legacyWhereClause = `
    mingzhong > 10
    OR shanbi > 10
    OR zhaojia > 10
    OR baoji > 10
    OR baoshang > 10
    OR kangbao > 10
    OR zengshang > 10
    OR zhiliao > 10
    OR jianliao > 10
    OR xixue > 10
    OR lengque > 10
    OR shuxing_shuzhi > 10
    OR kongzhi_kangxing > 10
    OR jin_kangxing > 10
    OR mu_kangxing > 10
    OR shui_kangxing > 10
    OR huo_kangxing > 10
    OR tu_kangxing > 10
  `;

  const legacyCheck = await query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM characters
        WHERE ${legacyWhereClause}
      ) AS has_legacy
    `
  );

  const hasLegacy = Boolean(legacyCheck.rows[0]?.has_legacy);
  if (!hasLegacy) return;

  const updateParts = percentAttrColumns.map((col) => {
    if (col === 'baoshang') {
      return `${col} = CASE
        WHEN ${col} > 1000 THEN ROUND((${col} / 10000.0)::numeric, 6)::DOUBLE PRECISION
        WHEN ${col} > 10 THEN ROUND((${col} / 100.0)::numeric, 6)::DOUBLE PRECISION
        ELSE ${col}
      END`;
    }
    return `${col} = CASE
      WHEN ${col} > 1000 THEN ROUND((${col} / 10000.0)::numeric, 6)::DOUBLE PRECISION
      WHEN ${col} > 1 THEN ROUND((${col} / 100.0)::numeric, 6)::DOUBLE PRECISION
      ELSE ${col}
    END`;
  });
  updateParts.push('updated_at = CURRENT_TIMESTAMP');
  await query(`UPDATE characters SET ${updateParts.join(', ')} WHERE ${legacyWhereClause}`);
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

    // 将旧万分比/百分点历史数据迁移为比例值（1=100%），并确保字段支持小数。
    await runDbMigrationOnce({
      migrationKey: 'characters_percent_attr_actual_value_v1',
      description: '角色百分比属性统一为比例值（1=100%）',
      execute: ensurePercentAttrsAsActualValue,
    });
    
    // 创建触发器
    await query(createAttributeTriggerSQL);
    
    console.log('✓ 角色表检测完成');
    
  } catch (error) {
    console.error('✗ 角色表初始化失败:', error);
    throw error;
  }
};
