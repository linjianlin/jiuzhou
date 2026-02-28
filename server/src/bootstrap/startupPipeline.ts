import type { Server as HttpServer } from 'http';
import { cpus } from 'os';
import { testConnection, pool } from '../config/database.js';
import { closeRedis, testRedisConnection } from '../config/redis.js';
import { initTables } from '../models/initTables.js';
import { initGameTimeService, stopGameTimeService } from '../services/gameTimeService.js';
import { recoverBattlesFromRedis } from '../domains/battle/index.js';
import { cleanupUndefinedItemDataOnStartup } from '../services/itemDataCleanupService.js';
import { recoverActiveIdleSessions, flushAllBuffers, stopAllExecutionLoops } from '../services/idle/idleBattleExecutorWorker.js';
import { initArenaWeeklySettlementService, stopArenaWeeklySettlementService } from '../services/arenaWeeklySettlementService.js';
import { stopBattleService } from '../services/battle/index.js';
import { initializeWorkerPool, shutdownWorkerPool } from '../workers/workerPool.js';

export interface StartServerOptions {
  httpServer: HttpServer;
  host: string;
  port: number;
}

/**
 * 服务启动流水线（连接检查 -> 表初始化 -> 启动恢复 -> 监听端口）
 */
export const startServerWithPipeline = async (options: StartServerOptions): Promise<void> => {
  console.log('\n🎮 九州修仙录 服务启动中...\n');

  const dbConnected = await testConnection();
  if (!dbConnected) {
    throw new Error('数据库连接失败，服务启动终止');
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    console.warn('⚠ Redis 连接失败，战斗状态将不会持久化');
  }

  await initTables();
  await cleanupUndefinedItemDataOnStartup();

  // 初始化 Worker 池
  console.log('正在初始化 Worker 池...');
  const cpuCount = cpus().length;
  const workerCount = process.env.IDLE_WORKER_COUNT
    ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
    : Math.max(1, cpuCount - 1);

  console.log(`  - CPU 核心数: ${cpuCount}，启动 ${workerCount} 个 Worker`);
  console.log('  - 挂机战斗怪物解析复用普通战斗服务配置');

  await initializeWorkerPool({
    workerCount,
  });
  console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）\n`);

  await initGameTimeService();
  await initArenaWeeklySettlementService();

  if (redisConnected) {
    console.log('正在恢复战斗状态...');
    await recoverBattlesFromRedis();
  }

  await recoverActiveIdleSessions();

  await new Promise<void>((resolve, reject) => {
    options.httpServer.listen(options.port, options.host, () => {
      console.log(`🚀 服务已启动: http://${options.host}:${options.port} (或 http://localhost:${options.port})\n`);
      resolve();
    });
    options.httpServer.once('error', reject);
  });
};

/**
 * 注册优雅关闭信号处理。
 */
export const registerGracefulShutdown = (httpServer: HttpServer): void => {
  const gracefulShutdown = async (signal: string): Promise<void> => {
    console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

    // 1. 停止接受新请求
    httpServer.close(() => {
      console.log('✓ HTTP 服务已关闭');
    });

    // 2. 停止所有后台任务和定时器
    console.log('正在停止后台服务...');

    await stopGameTimeService();
    console.log('✓ 游戏时间服务已停止');

    stopArenaWeeklySettlementService();
    console.log('✓ 竞技场结算服务已停止');

    stopBattleService();
    console.log('✓ 战斗服务已停止');

    stopAllExecutionLoops();
    console.log('✓ 挂机执行循环已停止');

    // 3. 关闭 Worker 池
    await shutdownWorkerPool();
    console.log('✓ Worker 池已关闭');

    // 4. 等待现有操作完成（给一点时间让正在执行的操作完成）
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 5. 刷新所有缓冲区
    await flushAllBuffers();
    console.log('✓ 挂机缓冲区已刷写');

    // 6. 关闭外部连接
    await closeRedis();
    console.log('✓ Redis 连接已关闭');

    await pool.end();
    console.log('✓ 数据库连接池已关闭');

    console.log('✓ 服务已完全关闭');
    process.exit(0);
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
};
