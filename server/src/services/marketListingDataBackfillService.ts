import { query } from '../config/database.js';

/**
 * 坊市挂单原始数量回填
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为历史 `market_listing` 数据补齐 `original_qty`，让部分购买后的退款比例有稳定基线。
 * 2. 做什么：保持启动期幂等回填，兼容新增列后已有挂单数据的平滑升级。
 * 3. 不做什么：不负责建表补列；数据库结构仍由 Prisma schema 同步。
 *
 * 输入/输出：
 * - 输入：无，由启动数据准备流程调用。
 * - 输出：把 `original_qty <= 0` 的挂单回填为当前 `qty`。
 *
 * 数据流/状态流：
 * - startupPipeline -> initTables -> 本回填函数 -> SQL UPDATE 幂等修正历史数据。
 *
 * 关键边界条件与坑点：
 * 1. 这里只能把历史行的 `original_qty` 回填为“当前 qty”，因为旧结构没有保留更早的原始挂单数量。
 * 2. 回填条件必须是 `original_qty <= 0`，避免覆盖新逻辑已写入的真实原始数量。
 */
export const backfillMarketListingOriginalQty = async (): Promise<void> => {
  const result = await query(
    `
      UPDATE market_listing
      SET original_qty = qty,
          updated_at = NOW()
      WHERE original_qty <= 0
    `,
  );

  const updatedCount = Number(result.rowCount ?? 0);
  if (updatedCount > 0) {
    console.log(`[market_listing] 已回填 original_qty: ${updatedCount} 条`);
  }
};
