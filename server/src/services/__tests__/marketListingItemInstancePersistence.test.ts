/**
 * 坊市挂单 item_instance 真实落库回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定挂单创建在写入 `market_listing` 前，必须先把被引用的 `item_instance` 快照真实 upsert 到数据库。
 * 2. 做什么：锁定 `item_instance` 的真实落库 SQL 由共享 helper 统一复用，避免坊市链路再次复制一份插入 SQL。
 * 3. 不做什么：不执行真实坊市上架，不校验 Redis mutation flush；这里只约束源码中的关键时序与复用入口。
 *
 * 输入 / 输出：
 * - 输入：`marketService` 与 `characterItemInstanceMutationService` 的源码文本。
 * - 输出：共享 upsert helper 的导出与 `createMarketListing` 在插入挂单前先调用该 helper 的断言结果。
 *
 * 数据流 / 状态流：
 * - 读取共享 mutation 服务源码，确认立即落库 helper 存在；
 * - 再读取坊市服务源码，确认挂单引用实例在 `INSERT INTO market_listing` 之前已执行真实 upsert；
 * - 最后断言仍保留 buffer mutation，避免投影态回退。
 *
 * 复用设计说明：
 * - 把立即落库能力集中在共享 mutation 服务里，避免坊市服务与 flush 循环各维护一套 item_instance upsert SQL。
 * - 本测试同时约束“共享 helper 存在”和“坊市链路确实复用 helper”，防止后续又把真实落库逻辑散回业务服务。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁定“先真实落库、再写挂单”的关键顺序，避免回归到仅依赖投影态的旧实现。
 * 2. 这里只验证源码结构，不覆盖数据库运行时行为；运行时正确性仍需依赖构建与后续集成验证。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
};

test("createMarketListing 应在插入挂单前真实落库被引用的 item_instance", () => {
  const marketSource = readSource("../marketService.ts");
  const mutationSource = readSource("../shared/characterItemInstanceMutationService.ts");

  assert.match(
    mutationSource,
    /export const upsertCharacterItemInstanceSnapshot = async/u,
  );
  assert.match(
    marketSource,
    /await upsertCharacterItemInstanceSnapshot\(listingItemSnapshot\);[\s\S]*?INSERT INTO market_listing/iu,
  );
  assert.match(
    marketSource,
    /await bufferCharacterItemInstanceMutations\(\[/u,
  );
});
