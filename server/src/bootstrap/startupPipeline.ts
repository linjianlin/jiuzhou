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
import {
  warmupOnlineBattleProjectionService,
} from "../services/onlineBattleProjectionService.js";
import { warmupFrozenTowerPoolCache } from "../services/tower/frozenPool.js";
import { dungeonExpiredInstanceCleanupService } from "../services/dungeonExpiredInstanceCleanupService.js";
import {
  initializeOnlineBattleSettlementRunner,
  shutdownOnlineBattleSettlementRunner,
} from "../services/onlineBattleSettlementRunner.js";
import { getGameServer } from "../game/gameServer.js";
import {
  initializeAfdianMessageRetryService,
  stopAfdianMessageRetryService,
} from "../services/afdianMessageRetryService.js";
import { ensurePerformanceIndexes } from "../services/shared/performanceIndexes.js";

export interface StartServerOptions {
  httpServer: HttpServer;
  host: string;
  port: number;
}

const formatStepDuration = (durationMs: number): string => {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(2)}s`;
};

const runStartupStep = async <T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> => {
  const startAt = Date.now();
  console.log(`→ ${label}`);
  const result = await task();
  console.log(`✓ ${label}（耗时 ${formatStepDuration(Date.now() - startAt)}）`);
  return result;
};

/**
 * 服务启动流水线（连接检查 -> 动态配置预热 -> 数据准备 -> 启动恢复 -> 监听端口）
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
  }

  await runStartupStep("生成功法快照刷新", refreshGeneratedTechniqueSnapshots);
  await runStartupStep("动态伙伴快照失效", refreshGeneratedPartnerSnapshots);
  await runStartupStep("数据准备", initTables);
  await runStartupStep("性能索引同步", ensurePerformanceIndexes);
  await runStartupStep("头像清理检查", clearAllAvatarsOnce);
  await runStartupStep("异常物品数据清理", () => itemDataCleanupService.cleanupUndefinedItemDataOnStartup());

  // 初始化 Worker 池
  console.log("正在初始化 Worker 池...");
  const cpuCount = cpus().length;
  const workerCount = process.env.IDLE_WORKER_COUNT
    ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
    : Math.max(1, cpuCount - 1);

  console.log(`  - CPU 核心数: ${cpuCount}，启动 ${workerCount} 个 Worker`);
  console.log("  - 挂机战斗怪物解析复用普通战斗服务配置");

  await runStartupStep("Worker 池初始化", () =>
    initializeWorkerPool({
      workerCount,
    }),
  );
  console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）\n`);
  await runStartupStep("洞府研修 worker 协调器初始化", initializeTechniqueGenerationJobRunner);
  console.log("✓ 洞府研修 worker 协调器已就绪\n");
  await runStartupStep("AI 伙伴招募 worker 协调器初始化", initializePartnerRecruitJobRunner);
  console.log("✓ AI 伙伴招募 worker 协调器已就绪\n");
  await runStartupStep("三魂归契 worker 协调器初始化", initializePartnerFusionJobRunner);
  console.log("✓ 三魂归契 worker 协调器已就绪\n");
  await runStartupStep("云游奇遇 worker 协调器初始化", initializeWanderJobRunner);
  console.log("✓ 云游奇遇 worker 协调器已就绪\n");
  const expiredDungeonCleanupSummary = await runStartupStep(
    "过期秘境实例收口",
    () => dungeonExpiredInstanceCleanupService.runCleanupOnce(),
  );
  console.log(
    `✓ 过期秘境实例已收口（preparing ${expiredDungeonCleanupSummary.abandonedPreparingCount} / running ${expiredDungeonCleanupSummary.abandonedRunningCount} / 结算保护 ${expiredDungeonCleanupSummary.protectedInstanceCount}）\n`,
  );
  const frozenTowerPoolSummary = await runStartupStep(
    "千层塔冻结怪物池预热",
    warmupFrozenTowerPoolCache,
  );
  console.log(
    `✓ 千层塔冻结怪物池已预热（冻结前沿 ${frozenTowerPoolSummary.frontier.frozenFloorMax}）\n`,
  );
  const onlineBattleWarmupSummary = await runStartupStep(
    "在线战斗投影预热",
    warmupOnlineBattleProjectionService,
  );
  console.log(
    `✓ 在线战斗投影已预热（活跃角色 ${onlineBattleWarmupSummary.characterCount} / 竞技场 ${onlineBattleWarmupSummary.arenaCount} / 秘境 ${onlineBattleWarmupSummary.dungeonCount} / 千层塔 ${onlineBattleWarmupSummary.towerCount}）\n`,
  );
  await runStartupStep("在线战斗延迟结算协调器初始化", initializeOnlineBattleSettlementRunner);
  console.log("✓ 在线战斗延迟结算协调器已就绪\n");
  await runStartupStep("爱发电私信重试调度器初始化", initializeAfdianMessageRetryService);
  console.log("✓ 爱发电私信重试调度器已就绪\n");

  await runStartupStep("游戏时间服务初始化", initGameTimeService);
  await runStartupStep("竞技场周结算服务初始化", async () => {
    initArenaWeeklySettlementService();
  });
  await runStartupStep("清理 Worker 启动", async () => {
    await startCleanupWorker();
  });

  if (redisConnected) {
    await runStartupStep("战斗状态恢复", async () => {
      console.log("正在恢复战斗状态...");
      await recoverBattlesFromRedis();
    });
  }

  await runStartupStep("挂机会话恢复", recoverActiveIdleSessions);

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

      await shutdownOnlineBattleSettlementRunner();
      console.log("✓ 在线战斗延迟结算协调器已关闭");

      stopAfdianMessageRetryService();
      console.log("✓ 爱发电私信重试调度器已关闭");

      await shutdownWorkerPool();
      console.log("✓ Worker 池已关闭");

      // 4. 等待现有操作完成（给一点时间让正在执行的操作完成）
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 5. 刷新所有缓冲区
      await flushAllBuffers();
      console.log("✓ 挂机缓冲区已刷写");

      // 6. 关闭外部连接
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
