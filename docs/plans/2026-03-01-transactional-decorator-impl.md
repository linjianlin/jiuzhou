# @Transactional 装饰器全量改造实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将所有 service 从独立函数改造为 class + `@Transactional` 装饰器，消除业务层手动事务代码。

**Architecture:** 创建 TC39 Stage 3 装饰器 `@Transactional`，逐个 service 文件改造为 class 单例导出，`client.query` 全部换成统一 `query`，路由层同步更新 import。

**Tech Stack:** TypeScript 5.9.3 TC39 Stage 3 Decorators, AsyncLocalStorage, pg PoolClient

**设计文档:** `docs/plans/2026-03-01-transactional-decorator-design.md`

---

## 通用改造规则（所有 Task 共用）

### 改造模板

每个 service 文件的改造步骤一致：

1. **import 替换**
   - 删除 `withTransaction` / `withTransactionAuto` / `pool` 的导入（如果不再需要）
   - 删除 `rollbackAndReturn` / `safeRollback` / `safeRelease` 的导入
   - 确保有 `import { query } from '../config/database.js'`
   - 添加 `import { Transactional } from '../decorators/transactional.js'`（路径按文件深度调整）

2. **函数 → class 方法**
   - 所有 `export const fnName = async (...) => { ... }` 改为 class 方法
   - 文件内部的私有辅助函数保持为模块级函数（不进 class），除非它们也用了事务
   - 类型导出（`export type / export interface`）保持在 class 外部

3. **事务代码替换**
   - `withTransaction(async (client) => { ... })` → 方法加 `@Transactional`，去掉包裹
   - `withTransactionAuto(async (client) => { ... })` → 同上
   - `client.query(...)` → `query(...)`
   - `rollbackAndReturn(client, result)` → 直接 `return result`
   - `safeRollback(client)` → 删除（抛异常即可触发回滚）
   - 纯读方法不加 `@Transactional`

4. **导出方式**
   - class 底部：`export const xxxService = new XxxService()`
   - 类型仍用 `export type` / `export interface` 在 class 外部
   - 如果原来有 `export default { ... }` 聚合对象，改为 `export default xxxService`

5. **`*Tx` 后缀函数处理**
   - 如果是 service 内部的 `*Tx` 函数：变成 class 私有方法，去掉 `client` 参数，内部用 `query`
   - 如果是被其他 service 调用的 `*Tx` 函数：变成 class 公开方法，去掉 `client` 参数
   - 调用方同步更新：`xxxTx(client, ...)` → `xxxService.xxx(...)`

6. **路由层更新**
   - `import { fnA, fnB } from '../services/xxxService.js'` → `import { xxxService } from '../services/xxxService.js'`
   - `await fnA(...)` → `await xxxService.fnA(...)`
   - domain 门面文件同步更新

7. **校验**
   - 每个 service 改完后运行 `tsc -b` 确认无类型错误

### 需要特别注意的模式

- **`pool.connect()` 手动获取连接**：如果方法内有 `const client = await pool.connect()` + 手动 `BEGIN/COMMIT/ROLLBACK`，整段替换为 `@Transactional` + `query`
- **`getTransactionClient()`**：保持不变，装饰器底层仍设置 AsyncLocalStorage
- **advisory lock**：`SELECT pg_advisory_xact_lock(...)` 改用 `query('SELECT pg_advisory_xact_lock(...)', [...])`
- **service 间互调**：A 调 B 时，B 的 `@Transactional` 会检测到已在事务中，直接执行不嵌套

---

## Task 1: 创建 @Transactional 装饰器

**Files:**
- Create: `server/src/decorators/transactional.ts`

**Step 1: 创建装饰器文件**

```typescript
// server/src/decorators/transactional.ts
/**
 * 事务方法装饰器
 *
 * 作用：
 * - 标记 class 方法在数据库事务中执行
 * - 已在事务中时直接执行（复用上下文），不在事务中时自动开启新事务
 * - 成功 return → COMMIT，抛异常 → ROLLBACK
 *
 * 复用点：所有需要事务保证的 service 方法统一使用此装饰器
 *
 * 边界条件：
 * 1) 只能装饰返回 Promise 的异步方法
 * 2) 装饰器内部通过 isInTransaction() 判断嵌套，避免不必要的 SAVEPOINT
 */
import { withTransaction, isInTransaction } from '../config/database.js';

export function Transactional<A extends unknown[], R>(
  target: (this: unknown, ...args: A) => Promise<R>,
  _context: ClassMethodDecoratorContext,
): (this: unknown, ...args: A) => Promise<R> {
  return function (this: unknown, ...args: A): Promise<R> {
    if (isInTransaction()) {
      return target.call(this, ...args);
    }
    return withTransaction(() => target.call(this, ...args));
  };
}
```

**Step 2: 运行 tsc -b 确认**

```bash
cd server && npx tsc -b
```

Expected: 无错误

**Step 3: Commit**

```bash
git add server/src/decorators/transactional.ts
git commit -m "feat: 添加 @Transactional 方法装饰器"
```

---

## Task 2: 改造 signInService（参考样板）

**Files:**
- Modify: `server/src/services/signInService.ts`
- Modify: `server/src/routes/signInRoutes.ts`

**Step 1: 改造 signInService.ts**

改造要点：
- `getSignInOverview`：纯读，不加 `@Transactional`，已经用 `query`，只需移入 class
- `doSignIn`：有 `withTransaction` + `client.query` + `rollbackAndReturn`，全部替换
- 私有辅助函数（`pad2`, `buildDateKey`, `normalizeDateKey`, `parseMonth`, `addDays`, `getHolidayInfo`）保持模块级
- 删除 `pool` / `withTransaction` / `rollbackAndReturn` / `safeRollback` 的 import

**Step 2: 更新 signInRoutes.ts**

```typescript
// 改造前
import { doSignIn, getSignInOverview } from '../services/signInService.js';
await doSignIn(userId);
await getSignInOverview(userId, month);

// 改造后
import { signInService } from '../services/signInService.js';
await signInService.doSignIn(userId);
await signInService.getOverview(userId, month);
```

**Step 3: 运行 tsc -b 确认**

**Step 4: Commit**

```bash
git commit -m "refactor: signInService 改造为 class + @Transactional"
```

---

## Task 3: 改造 monthCardService

**Files:**
- Modify: `server/src/services/monthCardService.ts`
- Modify: `server/src/routes/monthCardRoutes.ts`

改造要点：
- `getMonthCardStatus`：纯读，不加装饰器
- `useMonthCardItem` / `buyMonthCard` / `claimMonthCardReward`：有 `withTransaction` + `rollbackAndReturn`，全部替换
- 大量 `rollbackAndReturn(client, { success: false, ... })` → 直接 `return { success: false, ... }`
- 路由：`import { buyMonthCard, ... } from` → `import { monthCardService } from`

---

## Task 4: 改造 bountyService

**Files:**
- Modify: `server/src/services/bountyService.ts`
- Modify: `server/src/routes/bountyRoutes.ts`

改造要点：
- `getBountyBoard` / `searchItemDefsForBounty`：纯读
- `ensureDailyBountyInstances` / `claimBounty` / `publishBounty` / `submitBountyMaterials`：有事务
- `rollbackAndReturn` 替换

---

## Task 5: 改造 marketService

**Files:**
- Modify: `server/src/services/marketService.ts`
- Modify: `server/src/routes/marketRoutes.ts`

改造要点：
- `getMarketListings` / `getMyMarketListings` / `getMarketTradeRecords`：纯读
- `createMarketListing` / `cancelMarketListing` / `buyMarketListing`：有事务

---

## Task 6: 改造 battlePassService

**Files:**
- Modify: `server/src/services/battlePassService.ts`
- Modify: `server/src/routes/battlePassRoutes.ts`

改造要点：
- `getBattlePassTasksOverview` / `getBattlePassStatus` / `getBattlePassRewards`：纯读
- `claimBattlePassReward` / `completeBattlePassTask`：有事务

---

## Task 7: 改造 realmService

**Files:**
- Modify: `server/src/services/realmService.ts`
- Modify: `server/src/routes/realmRoutes.ts`

改造要点：
- `getRealmOverview`：纯读
- `breakthroughToNextRealm` / `breakthroughToTargetRealm`：有事务
- 注意内部 `withClient` 包装函数，直接删除，用 `@Transactional` 替代

---

## Task 8: 改造 equipmentService

**Files:**
- Modify: `server/src/services/equipmentService.ts`
- Modify: 相关路由（通过 domain 门面导入）

---

## Task 9: 改造 characterTechniqueService

**Files:**
- Modify: `server/src/services/characterTechniqueService.ts`
- Modify: `server/src/domains/character/index.ts`（如需更新 re-export）

改造要点：
- 5 个 `withTransaction` 调用，全部替换
- 通过 domain 门面导出，需同步更新

---

## Task 10: 改造 itemService

**Files:**
- Modify: `server/src/services/itemService.ts`
- Modify: `server/src/domains/inventory/index.ts`

改造要点：
- `createItem`：有 `withTransactionAuto`
- `useItem`：有 `safeRollback`
- 已有 `export default { ... }` → 改为 `export default itemService`
- domain 门面 `export { default as itemService }` 保持不变

---

## Task 11: 改造 craftService

**Files:**
- Modify: `server/src/services/craftService.ts`
- Modify: `server/src/domains/inventory/index.ts`

改造要点：
- `getCraftRecipeList`：纯读
- `executeCraftRecipe`：有事务 + `safeRollback`
- 已有 `export default { ... }` → 改为 `export default craftService`

---

## Task 12: 改造 gemSynthesisService

**Files:**
- Modify: `server/src/services/gemSynthesisService.ts`
- Modify: `server/src/domains/inventory/index.ts`

改造要点：
- `getGemSynthesisRecipeList`：纯读
- `synthesizeGem` / `synthesizeGemBatch`：有事务
- 已有 `export default { ... }` → 改为 `export default gemSynthesisService`

---

## Task 13: 改造 inventory/index.ts

**Files:**
- Modify: `server/src/services/inventory/index.ts`
- Modify: `server/src/domains/inventory/index.ts`

改造要点：
- 最大的 service 文件，15+ 个 `withTransaction` 调用
- `runInventoryMutationTx` 内部事务执行器 → 删除，各方法直接用 `@Transactional`
- `lockCharacterInventoryMutexTx` 等锁函数 → 用 `query` + `getTransactionClient()` 替代
- 纯读方法（`getInventoryInfo`, `getInventoryItems`, `findEmptySlots`）不加装饰器
- domain 门面的 `inventoryService` 对象需要同步更新

---

## Task 14: 改造 mailService

**Files:**
- Modify: `server/src/services/mailService.ts`
- Modify: `server/src/routes/mailRoutes.ts`

改造要点：
- `getMailList` / `readMail` / `getUnreadCount`：纯读
- `claimAttachments` / `claimAllAttachments` / `deleteMail` / `deleteAllMails`：有 `withTransactionAuto`

---

## Task 15: 改造 taskService

**Files:**
- Modify: `server/src/services/taskService.ts`
- Modify: `server/src/domains/task/index.ts`

改造要点：
- `ensureMainQuestProgressForNewChapters` / `updateSectionProgress`：有 `withTransactionAuto`
- 通过 domain 门面导出

---

## Task 16: 改造 roomObjectService

**Files:**
- Modify: `server/src/services/roomObjectService.ts`
- Modify: `server/src/routes/mapRoutes.ts`

改造要点：
- `getAreaObjects` / `getRoomObjects`：纯读
- `gatherRoomResource` / `pickupRoomItem`：有事务

---

## Task 17: 改造 sect 模块（6 个文件）

**Files:**
- Modify: `server/src/services/sect/core.ts`（7 个 withTransaction）
- Modify: `server/src/services/sect/applications.ts`（3 个 withTransaction）
- Modify: `server/src/services/sect/economy.ts`（1 个 withTransaction）
- Modify: `server/src/services/sect/buildings.ts`（1 个 withTransaction）
- Modify: `server/src/services/sect/quests.ts`（4 个 withTransaction）
- Modify: `server/src/services/sect/shop.ts`（1 个 withTransaction）
- Modify: `server/src/services/sectService.ts`（门面文件，re-export）
- Modify: `server/src/routes/sectRoutes.ts`

改造要点：
- sect 模块已经按职责拆分为多个文件，每个文件独立改造为一个 class
- `sectService.ts` 门面文件需要更新 re-export 方式
- `addLogTx` 等内部 `*Tx` 函数 → class 私有方法，去掉 `client` 参数
- 路由层从 `sectService.js` 导入，门面文件需要聚合各子 class 的方法

---

## Task 18: 改造 achievement 模块（3 个文件）

**Files:**
- Modify: `server/src/services/achievement/claim.ts`（2 个 withTransaction）
- Modify: `server/src/services/achievement/progress.ts`（1 个 withTransactionAuto）
- Modify: `server/src/services/achievement/title.ts`（1 个 withTransaction）
- Modify: `server/src/routes/achievementRoutes.ts`
- Modify: `server/src/routes/titleRoutes.ts`

改造要点：
- `applyRewardsTx` / `grantTitleTx` 等内部 `*Tx` 函数 → class 私有方法
- `grantPermanentTitleTx`（从 `titleOwnership.ts` 导入）→ 需要同步检查

---

## Task 19: 改造 mainQuest/index.ts

**Files:**
- Modify: `server/src/services/mainQuest/index.ts`（6 个 withTransaction/withTransactionAuto）
- Modify: `server/src/domains/mainQuest/index.ts`

改造要点：
- 混合使用 `withTransaction` 和 `withTransactionAuto`，统一为 `@Transactional`
- 通过 domain 门面导出

---

## Task 20: 改造 idle/idleSessionService

**Files:**
- Modify: `server/src/services/idle/idleSessionService.ts`（2 个 withTransaction）
- Modify: `server/src/routes/idleRoutes.ts`

---

## Task 21: 改造 dungeon/index.ts

**Files:**
- Modify: `server/src/services/dungeon/index.ts`（2 个 withTransaction）
- Modify: `server/src/domains/dungeon/index.ts`

---

## Task 22: 改造 battleDropService

**Files:**
- Modify: `server/src/services/battleDropService.ts`（1 个 withTransactionAuto）

改造要点：
- 被其他 service 内部调用，不直接暴露给路由
- 改造后其他 service 调用方式更新

---

## Task 23: 改造 arenaWeeklySettlementService

**Files:**
- Modify: `server/src/services/arenaWeeklySettlementService.ts`（1 个 withTransaction）

---

## Task 24: 改造 itemDataCleanupService

**Files:**
- Modify: `server/src/services/itemDataCleanupService.ts`（1 个 withTransaction）

---

## Task 25: 改造 migrationHistoryTable

**Files:**
- Modify: `server/src/models/migrationHistoryTable.ts`（1 个 withTransaction）

改造要点：
- 这是 model 层不是 service 层，但也用了 `withTransaction`
- 改为 class + `@Transactional` 或保持 `withTransaction`（因为是基础设施代码）
- 建议：保持 `withTransaction`，因为这是数据库迁移基础设施，不属于业务层

---

## Task 26: 清理与收尾

**Files:**
- Modify: `server/src/services/shared/transaction.ts`
- Modify: `server/src/config/database.ts`（可选：清理不再需要的导出）

**Step 1: 检查 shared/transaction.ts 是否还有引用**

```bash
cd server && grep -r "from.*shared/transaction" src/ --include="*.ts"
```

如果无引用，删除 `server/src/services/shared/transaction.ts`。

**Step 2: 检查 withTransaction / withTransactionAuto 是否还有业务层引用**

```bash
cd server && grep -r "withTransaction\|withTransactionAuto" src/services/ src/routes/ --include="*.ts"
```

预期：只剩 `config/database.ts` 和 `decorators/transactional.ts` 中的引用。

**Step 3: 最终 tsc -b 全量校验**

```bash
cd server && npx tsc -b
```

**Step 4: Commit**

```bash
git commit -m "chore: 清理废弃的事务工具函数"
```

---

## 执行顺序建议

1. Task 1（装饰器）→ 必须先完成
2. Task 2（signInService）→ 作为参考样板
3. Task 3-16（独立 service）→ 可并行，互不依赖
4. Task 17-21（模块化 service）→ 需要同步更新门面文件
5. Task 22-25（内部/基础设施 service）→ 最后处理
6. Task 26（清理）→ 全部完成后执行
