import { backfillCharacterRankSnapshots } from "../services/characterComputedService.js";
import { backfillMarketListingOriginalQty } from "../services/marketListingDataBackfillService.js";
import { loadAllSeeds } from "../services/seedService.js";

/**
 * 数据准备入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：承接服务启动时的“数据准备”职责，包括 seed 加载与一次性数据回填。
 * 2. 做什么：把数据库结构管理从运行时剥离出去，明确交给 Prisma `db push`。
 * 3. 不做什么：不再创建表、不再补列、不再执行结构迁移。
 *
 * 输入/输出：
 * - 输入：无，由启动流水线调用。
 * - 输出：种子数据已加载；需要的一次性数据迁移已执行。
 *
 * 数据流/状态流：
 * - 启动流程 -> `initTables()` -> 加载种子 -> 执行幂等数据回填。
 *
 * 关键边界条件与坑点：
 * 1. 数据库表结构必须先通过 Prisma schema 同步完成，否则这里不会再兜底建表。
 * 2. `backfillCharacterRankSnapshots` 必须保持幂等，因为现在启动期会直接执行，不再通过迁移历史表去重。
 */
export const initTables = async (): Promise<void> => {
  console.log("\n========== 数据准备 ==========");
  console.log("○ 数据库结构同步已切换为 Prisma schema，请先执行 `pnpm --filter ./server db:sync`");

  await loadAllSeeds();
  await backfillCharacterRankSnapshots();
  await backfillMarketListingOriginalQty();

  console.log("========== 数据准备完成 ==========\n");
};
