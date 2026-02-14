/**
 * 九州修仙录 - NPC 数据表
 */

export const initNpcTable = async (): Promise<void> => {
  try {
    console.log('✓ NPC定义改为静态JSON加载，跳过建表');
  } catch (error) {
    console.error('✗ NPC表初始化失败:', error);
    throw error;
  }
};

