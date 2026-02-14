/**
 * 九州修仙录 - 怪物数据表
 */

export const initMonsterTables = async (): Promise<void> => {
  try {
    console.log('✓ 怪物定义/刷新规则/掉落池改为静态JSON加载，跳过建表');
  } catch (error) {
    console.error('✗ 怪物系统表初始化失败:', error);
    throw error;
  }
};

