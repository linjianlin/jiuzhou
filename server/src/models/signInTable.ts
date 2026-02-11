import { query } from '../config/database.js';

const signInTableSQL = `
CREATE TABLE IF NOT EXISTS sign_in_records (
  id SERIAL PRIMARY KEY,                               -- 签到记录ID，自增主键
  user_id INTEGER NOT NULL REFERENCES users(id),       -- 关联用户ID
  sign_date DATE NOT NULL,                             -- 签到日期（自然日）
  reward INTEGER NOT NULL,                             -- 获得灵石数量
  is_holiday BOOLEAN DEFAULT FALSE,                    -- 是否节假日签到
  holiday_name VARCHAR(50) DEFAULT NULL,               -- 节假日名称
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 创建时间
  UNIQUE(user_id, sign_date)                           -- 同一用户同一天只能签到一次
);

COMMENT ON TABLE sign_in_records IS '玩家签到记录表';
COMMENT ON COLUMN sign_in_records.id IS '签到记录ID，自增主键';
COMMENT ON COLUMN sign_in_records.user_id IS '关联用户ID';
COMMENT ON COLUMN sign_in_records.sign_date IS '签到日期（自然日）';
COMMENT ON COLUMN sign_in_records.reward IS '获得灵石数量';
COMMENT ON COLUMN sign_in_records.is_holiday IS '是否节假日签到';
COMMENT ON COLUMN sign_in_records.holiday_name IS '节假日名称';
COMMENT ON COLUMN sign_in_records.created_at IS '创建时间';
`;

const columnsToCheck = [
  { name: 'is_holiday', type: 'BOOLEAN DEFAULT FALSE', comment: '是否节假日签到' },
  { name: 'holiday_name', type: 'VARCHAR(50) DEFAULT NULL', comment: '节假日名称' },
  { name: 'created_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', comment: '创建时间' },
];

const checkAndAddColumns = async () => {
  const addedFields: string[] = [];
  for (const col of columnsToCheck) {
    try {
      const checkSQL = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'sign_in_records' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);

      if (result.rows.length === 0) {
        const addSQL = `ALTER TABLE sign_in_records ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);

        const commentSQL = `COMMENT ON COLUMN sign_in_records.${col.name} IS '${col.comment}'`;
        await query(commentSQL);

        addedFields.push(col.name);
      }
    } catch (error) {
      console.error(`  ✗ 检查字段 ${col.name} 时出错:`, error);
    }
  }
  if (addedFields.length > 0) {
    console.log(`  → 签到表已添加字段: ${addedFields.join(', ')}`);
  }
};

export const initSignInTable = async (): Promise<void> => {
  try {
    await query(signInTableSQL);
    await checkAndAddColumns();
    console.log('✓ 签到表检测完成');
  } catch (error) {
    console.error('✗ 签到表初始化失败:', error);
    throw error;
  }
};

