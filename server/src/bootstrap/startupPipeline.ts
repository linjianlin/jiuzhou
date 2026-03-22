import type { Server as HttpServer } from "http";
import { cpus } from "os";
import { testConnection, pool } from "../config/database.js";
import { closeRedis, testRedisConnection } from "../config/redis.js";
import { initTables } from "../models/initTables.js";
import {
  initGameTimeService,
  stopGameTimeService,
} from "../services/gameTimeService.js";
import { recoverBattlesFromRedis } from "../domains/battle/index.js";
import { itemDataCleanupService } from "../services/itemDataCleanupService.js";
import { clearAllAvatarsOnce } from "./clearAvatars.js";
import {
  recoverActiveIdleSessions,
  flushAllBuffers,
  stopAllExecutionLoops,
} from "../services/idle/idleBattleExecutorWorker.js";
import {
  initArenaWeeklySettlementService,
  stopArenaWeeklySettlementService,
} from "../services/arenaWeeklySettlementService.js";
import { stopBattleService } from "../services/battle/index.js";
import {
  startCleanupWorker,
  stopCleanupWorker,
} from "../workers/cleanupWorker.js";
import {
  initializeWorkerPool,
  shutdownWorkerPool,
} from "../workers/workerPool.js";
import {
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
} from "../services/staticConfigLoader.js";
import {
  initializeTechniqueGenerationJobRunner,
  shutdownTechniqueGenerationJobRunner,
} from "../services/techniqueGenerationJobRunner.js";
import {
  initializePartnerRecruitJobRunner,
  shutdownPartnerRecruitJobRunner,
} from "../services/partnerRecruitJobRunner.js";
import {
  initializePartnerFusionJobRunner,
  shutdownPartnerFusionJobRunner,
} from "../services/partnerFusionJobRunner.js";
import {
  initializeWanderJobRunner,
  shutdownWanderJobRunner,
} from "../services/wanderJobRunner.js";
import { getGameServer } from "../game/gameServer.js";
import {
  initializeAfdianMessageRetryService,
  stopAfdianMessageRetryService,
} from "../services/afdianMessageRetryService.js";
import {
  clearPlayerWritebackCacheOnStartup,
  flushAllPlayerWriteback,
  startPlayerWritebackFlushLoop,
  stopPlayerWritebackFlushLoop,
} from "../services/playerWritebackCacheService.js";

export interface StartServerOptions {
  httpServer: HttpServer;
  host: string;
  port: number;
}

/**
 * 关闭期 Worker 池等待预算。
 *
 * 作用：
 * 1. 做什么：把 dev/tsx 的 5 秒强杀窗口内可接受的 Worker drain 时间收敛到单一常量，避免关闭路径被内部默认 10 秒拖住。
 * 2. 不做什么：不改变 WorkerPool 的通用默认值；只有优雅关闭入口显式覆盖预算。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：优雅关闭阶段传给 `shutdownWorkerPool` 的毫秒预算。
 *
 * 数据流/状态流：
 * registerGracefulShutdown -> shutdownWorkerPool({ timeoutMs }) -> WorkerPool.shutdown。
 *
 * 关键边界条件与坑点：
 * 1. 这里只收紧“关服预算”，不代表正常业务任务超时；业务执行仍走 WorkerPool 自己的 task timeout。
 * 2. 预算过长会让 tsx 在本地开发时先把进程强杀，预算过短则会更早终止仍在执行的 Worker，因此需要留出少量 drain 时间但不能沿用 10 秒默认值。
 */
const GRACEFUL_SHUTDOWN_WORKER_POOL_TIMEOUT_MS = 1_500;

/**
 * 服务启动流水线（连接检查 -> 数据准备 -> 启动恢复 -> 监听端口）
 */
export const startServerWithPipeline = async (
  options: StartServerOptions,
): Promise<void> => {
  console.log("\n🎮 九州修仙录 服务启动中...\n");

  const dbConnected = await testConnection();
  if (!dbConnected) {
    throw new Error("数据库连接失败，服务启动终止");
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    console.warn("⚠ Redis 连接失败，战斗状态将不会持久化");
  } else {
    // const clearedPlayerStateKeyCount = await clearPlayerWritebackCacheOnStartup();
    // console.log(
    //   `✓ 启动时已清理玩家写回缓存（${clearedPlayerStateKeyCount} 个 Redis key）\n`,
    // );
  }

  await initTables();
  await refreshGeneratedTechniqueSnapshots();
  await refreshGeneratedPartnerSnapshots();
  await clearAllAvatarsOnce();
  await itemDataCleanupService.cleanupUndefinedItemDataOnStartup();

  // 初始化 Worker 池
  console.log("正在初始化 Worker 池...");
  const cpuCount = cpus().length;
  const workerCount = process.env.IDLE_WORKER_COUNT
    ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
    : Math.max(1, cpuCount - 1);

  console.log(`  - CPU 核心数: ${cpuCount}，启动 ${workerCount} 个 Worker`);
  console.log("  - 挂机战斗怪物解析复用普通战斗服务配置");

  await initializeWorkerPool({
    workerCount,
  });
  console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）\n`);
  await initializeTechniqueGenerationJobRunner();
  console.log("✓ 洞府研修 worker 协调器已就绪\n");
  await initializePartnerRecruitJobRunner();
  console.log("✓ AI 伙伴招募 worker 协调器已就绪\n");
  await initializePartnerFusionJobRunner();
  console.log("✓ 三魂归契 worker 协调器已就绪\n");
  await initializeWanderJobRunner();
  console.log("✓ 云游奇遇 worker 协调器已就绪\n");
  await initializeAfdianMessageRetryService();
  console.log("✓ 爱发电私信重试调度器已就绪\n");
  startPlayerWritebackFlushLoop();
  console.log("✓ 玩家写回缓存调度器已就绪\n");

  await initGameTimeService();
  await initArenaWeeklySettlementService();
  await startCleanupWorker();

  if (redisConnected) {
    console.log("正在恢复战斗状态...");
    await recoverBattlesFromRedis();
  }

  await recoverActiveIdleSessions();

  await new Promise<void>((resolve, reject) => {
    options.httpServer.listen(options.port, options.host, () => {
      console.log(
        `🚀 服务已启动: http://${options.host}:${options.port} (或 http://localhost:${options.port})\n`,
      );
      resolve();
    });
    options.httpServer.once("error", reject);
  });
};

/**
 * 注册优雅关闭信号处理。
 */
export const registerGracefulShutdown = (httpServer: HttpServer): void => {
  let shutdownPromise: Promise<void> | null = null;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

      // 1. 停止接受新请求
      httpServer.close(() => {
        console.log("✓ HTTP 服务已关闭");
      });

      await getGameServer().shutdown();
      console.log("✓ 游戏 Socket 服务已关闭");
      await flushAllPlayerWriteback();
      stopPlayerWritebackFlushLoop();
      console.log("✓ 玩家写回缓存已刷写");

      // 2. 停止所有后台任务和定时器
      console.log("正在停止后台服务...");

      await stopGameTimeService();
      console.log("✓ 游戏时间服务已停止");

      stopArenaWeeklySettlementService();
      console.log("✓ 竞技场结算服务已停止");

      stopCleanupWorker();
      console.log("✓ 清理 Worker 已停止");

      stopBattleService();
      console.log("✓ 战斗服务已停止");

      stopAllExecutionLoops();
      console.log("✓ 挂机执行循环已停止");

      // 3. 关闭 Worker 池
      await shutdownTechniqueGenerationJobRunner();
      console.log("✓ 洞府研修 worker 协调器已关闭");

      await shutdownPartnerRecruitJobRunner();
      console.log("✓ AI 伙伴招募 worker 协调器已关闭");

      await shutdownPartnerFusionJobRunner();
      console.log("✓ 三魂归契 worker 协调器已关闭");

      await shutdownWanderJobRunner();
      console.log("✓ 云游奇遇 worker 协调器已关闭");

      stopAfdianMessageRetryService();
      console.log("✓ 爱发电私信重试调度器已关闭");

      await shutdownWorkerPool({
        timeoutMs: GRACEFUL_SHUTDOWN_WORKER_POOL_TIMEOUT_MS,
      });
      console.log("✓ Worker 池已关闭");

      // 4. 刷新所有缓冲区
      await flushAllBuffers();
      console.log("✓ 挂机缓冲区已刷写");

      // 5. 关闭外部连接
      await closeRedis();
      console.log("✓ Redis 连接已关闭");

      await pool.end();
      console.log("✓ 数据库连接池已关闭");

      console.log("✓ 服务已完全关闭");
      process.exit(0);
    })();

    await shutdownPromise;
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
};
