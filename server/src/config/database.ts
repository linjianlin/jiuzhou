import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// 是否启用查询日志（生产环境关闭）
const ENABLE_QUERY_LOG = process.env.DB_LOG === 'true';

// 数据库连接池
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '6060'),
  database: process.env.DB_NAME || 'jiuzshou_s',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'zlf981216',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 延迟函数
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 测试数据库连接（带重试）
export const testConnection = async (
  maxRetries = 10,
  initialDelay = 1000
): Promise<boolean> => {
  let retries = 0;
  let delay = initialDelay;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      console.log('✓ 数据库连接成功');
      client.release();
      return true;
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        console.error('✗ 数据库连接失败，已达最大重试次数:', error);
        return false;
      }
      console.log(`✗ 数据库连接失败，${delay / 1000}秒后重试 (${retries}/${maxRetries})...`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000); // 指数退避，最大 10 秒
    }
  }
  return false;
};

// 执行SQL查询（默认不输出日志）
export const query = async (text: string, params?: unknown[]) => {
  const result = await pool.query(text, params);
  if (ENABLE_QUERY_LOG) {
    console.log('执行查询:', { text: text.substring(0, 50), rows: result.rowCount });
  }
  return result;
};

export default pool;
