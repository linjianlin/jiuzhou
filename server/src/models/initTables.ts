import { query } from '../config/database.js';
import { initCharacterTable } from './characterTable.js';
import { initItemTables } from './itemTables.js';
import { initInventoryTable } from './inventoryTable.js';
import { initSignInTable } from './signInTable.js';
import { initMailTable } from './mailTable.js';
import { initNpcTable } from './npcTable.js';
import { initMonsterTables } from './monsterTable.js';
import { initMapTable } from './mapTable.js';
import { initTechniqueTables } from './techniqueTable.js';
import { initTeamTables } from './teamTable.js';
import { initMarketTable } from './marketTable.js';
import { initDungeonTables } from './dungeonTable.js';
import { initMonthCardTables } from './monthCardTable.js';
import { initSectTables } from './sectTable.js';
import { initBattlePassTables } from './battlePassTable.js';
import { initTaskTables } from './taskTable.js';
import { initBountyTables } from './bountyTable.js';
import { initGameTimeTable } from './gameTimeTable.js';
import { initMainQuestTables } from './mainQuestTable.js';
import { initArenaTables } from './arenaTable.js';
import { initAchievementTables } from './achievementTable.js';
import { loadAllSeeds } from '../services/seedService.js';

// 用户表结构定义
const userTableSQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,                              -- 用户ID，自增主键
  username VARCHAR(50) UNIQUE NOT NULL,               -- 用户名，唯一且不能为空
  password VARCHAR(255) NOT NULL,                     -- 密码，加密存储
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 创建时间
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 更新时间
  last_login TIMESTAMP,                               -- 最后登录时间
  status SMALLINT DEFAULT 1                           -- 账号状态：1正常 0禁用
);

-- 添加字段注释
COMMENT ON TABLE users IS '用户账号表';
COMMENT ON COLUMN users.id IS '用户ID，自增主键';
COMMENT ON COLUMN users.username IS '用户名，唯一且不能为空';
COMMENT ON COLUMN users.password IS '密码，加密存储';
COMMENT ON COLUMN users.created_at IS '创建时间';
COMMENT ON COLUMN users.updated_at IS '更新时间';
COMMENT ON COLUMN users.last_login IS '最后登录时间';
COMMENT ON COLUMN users.status IS '账号状态：1正常 0禁用';
`;

// 检查并添加缺失字段
const checkAndAddColumns = async () => {
  const columnsToCheck = [
    { name: 'status', type: 'SMALLINT DEFAULT 1', comment: '账号状态：1正常 0禁用' },
    { name: 'last_login', type: 'TIMESTAMP', comment: '最后登录时间' },
    { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', comment: '更新时间' },
    { name: 'session_token', type: 'VARCHAR(255)', comment: '当前会话token，用于单点登录' },
  ];

  for (const col of columnsToCheck) {
    try {
      // 检查字段是否存在
      const checkSQL = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);
      
      if (result.rows.length === 0) {
        // 字段不存在，添加字段
        const addSQL = `ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);
        
        // 添加注释
        const commentSQL = `COMMENT ON COLUMN users.${col.name} IS '${col.comment}'`;
        await query(commentSQL);
        
        console.log(`已添加缺失字段: ${col.name}`);
      }
    } catch (error) {
      console.error(`检查字段 ${col.name} 时出错:`, error);
    }
  }
};

// 初始化所有表
export const initTables = async (): Promise<void> => {
  try {
    console.log('\n========== 数据库初始化 ==========');
    
    // 创建用户表
    await query(userTableSQL);
    console.log('✓ 用户表检测完成');
    
    // 检查并补齐缺失字段
    await checkAndAddColumns();
    
    // 初始化角色表
    await initCharacterTable();
    
    // 初始化签到表
    await initSignInTable();
    
    // 初始化物品系统表
    await initItemTables();
    
    // 初始化背包系统表
    await initInventoryTable();
    
    // 初始化邮件系统表
    await initMailTable();
    
    // 初始化NPC表
    await initNpcTable();
    
    // 初始化怪物系统表（怪物定义、刷新规则、掉落池）
    await initMonsterTables();
    
    // 初始化地图表
    await initMapTable();
    
    // 初始化功法系统表
    await initTechniqueTables();
    
    // 初始化组队系统表
    await initTeamTables();

    // 初始化坊市系统表
    await initMarketTable();

    // 初始化副本秘境系统表
    await initDungeonTables();

    // 初始化月卡系统表
    await initMonthCardTables();

    // 初始化宗门系统表
    await initSectTables();

    // 初始化战令系统表
    await initBattlePassTables();

    // 初始化任务系统表
    await initTaskTables();

    // 初始化悬赏系统表
    await initBountyTables();

    // 初始化游戏时间表
    await initGameTimeTable();

    // 初始化主线任务系统表
    await initMainQuestTables();

    // 初始化竞技场系统表
    await initArenaTables();

    // 初始化成就与称号系统表
    await initAchievementTables();
    
    // 加载种子数据
    await loadAllSeeds();
    
    console.log('========== 初始化完成 ==========\n');
  } catch (error) {
    console.error('✗ 数据库表初始化失败:', error);
    throw error;
  }
};

