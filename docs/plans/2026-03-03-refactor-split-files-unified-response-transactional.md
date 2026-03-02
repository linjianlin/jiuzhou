# 大文件拆分 + 统一标准返回 + 事务装饰器化 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 拆分 4 个大文件（inventory/battle/dungeon/mainQuest），统一路由层标准返回，将所有事务改为 @Transactional 装饰器 + query() 自动上下文。

**Architecture:** 按业务子域拆分大文件，每个模块 100-600 行。Service 类使用 @Transactional 装饰器管理事务，内部函数统一用 query() 替代手动传递 client 参数。路由层用 sendSuccess/sendOk + throw BusinessError 替代手写 res.json。

**Tech Stack:** TypeScript, Express, pg (PostgreSQL), AsyncLocalStorage 事务上下文

---

## Phase 1: 新增全局工具（零破坏）

### Task 1.1: 创建响应工具函数

**Files:**
- Create: `server/src/middleware/response.ts`

**Step 1: 创建 response.ts**

```typescript
/**
 * 路由层标准响应工具
 *
 * 作用：统一 HTTP 响应格式，消除路由中重复的 res.json / res.status 样板代码。
 * 输入：Express Response 对象 + 数据。
 * 输出：标准 JSON 响应 { success, data?, message? }。
 *
 * 数据流：路由处理函数 -> sendSuccess/sendOk/sendResult -> res.json
 *
 * 边界条件：
 * 1) sendResult 根据 result.success 决定 HTTP 状态码（200 或 400），适用于 service 返回 { success, ... } 的场景。
 * 2) 错误场景不在此处理 —— 统一 throw BusinessError，由 errorHandler 中间件兜底。
 */
import type { Response } from 'express';

/** 成功响应：{ success: true, data } */
export const sendSuccess = <T>(res: Response, data: T): void => {
  res.json({ success: true, data });
};

/** 成功响应（无 data）：{ success: true } */
export const sendOk = (res: Response): void => {
  res.json({ success: true });
};

/** 透传 service 结果：根据 success 字段决定状态码 */
export const sendResult = (res: Response, result: { success: boolean }): void => {
  res.status((result as { success: boolean }).success ? 200 : 400).json(result);
};
```

**Step 2: tsc -b 校验**

Run: `cd /home/faith/projects/jiuzhou/server && npx tsc -b`
Expected: 成功，无新增错误

**Step 3: Commit**

```bash
git add server/src/middleware/response.ts
git commit -m "feat: 新增路由层标准响应工具函数 sendSuccess/sendOk/sendResult"
```

---

### Task 1.2: 提取全局类型转换工具

**Files:**
- Create: `server/src/services/shared/typeCoercion.ts`

**Step 1: 创建 typeCoercion.ts**

从 dungeon/index.ts 和 mainQuest/index.ts 中提取重复的类型转换函数：

```typescript
/**
 * 通用类型强制转换工具
 *
 * 作用：将 unknown 类型安全地转换为具体类型，用于解析 JSON 配置、数据库返回值等场景。
 * 输入：unknown 值 + 可选默认值。
 * 输出：类型安全的目标值。
 *
 * 复用点：dungeon、mainQuest、以及任何需要安全解析动态数据的模块。
 *
 * 边界条件：
 * 1) 所有函数都是纯函数，无副作用。
 * 2) 转换失败时返回默认值而非抛异常，调用方需自行校验业务合法性。
 */

/** unknown → string（默认空字符串） */
export const asString = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback;

/** unknown → number（带 fallback） */
export const asNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** unknown → T[]（若非数组返回空数组） */
export const asArray = <T = unknown>(v: unknown): T[] =>
  Array.isArray(v) ? (v as T[]) : [];

/** unknown → object（排除 null 和数组） */
export const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** unknown → string[]（去重、trim、过滤空串） */
export const asStringArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (s && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
};
```

**Step 2: tsc -b 校验**

Run: `cd /home/faith/projects/jiuzhou/server && npx tsc -b`
Expected: 成功

**Step 3: Commit**

```bash
git add server/src/services/shared/typeCoercion.ts
git commit -m "feat: 提取全局类型转换工具 asString/asNumber/asArray/asObject"
```

---

## Phase 2: 统一路由层返回（28 个 route 文件）

### Task 2.1: 迁移所有路由文件

**Files:**
- Modify: `server/src/routes/*.ts`（全部 28 个文件）

**改造规则：**

1. 手动成功响应 → `sendSuccess(res, data)` 或 `sendOk(res)`
```typescript
// 前: res.json({ success: true, data: info });
// 后: sendSuccess(res, info);

// 前: res.json({ success: true });
// 后: sendOk(res);
```

2. 手动错误响应（参数校验 / 业务检查）→ `throw new BusinessError(message)`
```typescript
// 前: return res.status(400).json({ success: false, message: '参数错误' });
// 后: throw new BusinessError('参数错误');
```

3. 透传 service 结果 → `sendResult(res, result)`
```typescript
// 前: return res.status(result.success ? 200 : 400).json(result);
// 后: sendResult(res, result);

// 前: res.json(result);  （service 已返回 { success, ... }）
// 后: sendResult(res, result);  或保持 res.json(result) 若不需要状态码区分
```

4. 每个路由文件顶部新增 import：
```typescript
import { sendSuccess, sendOk, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';
```

**执行顺序**（按文件复杂度从低到高）：
- 先做简单文件（timeRoutes, idleRoutes, infoRoutes, titleRoutes, signInRoutes, rankRoutes, realmRoutes, techniqueRoutes）
- 再做中等文件（authRoutes, characterRoutes, battleRoutes, bountyRoutes, arenaRoutes, attributeRoutes, mailRoutes, mapRoutes, monthCardRoutes, battlePassRoutes, achievementRoutes, teamRoutes, taskRoutes, marketRoutes, dungeonRoutes, mainQuestRoutes, characterTechniqueRoutes, sectRoutes）
- 最后做最复杂的（inventoryRoutes, uploadRoutes）

**Step 1: 逐批迁移路由文件**

每批 5-8 个文件，改完一批跑一次 tsc -b。

**Step 2: tsc -b 校验**

Run: `cd /home/faith/projects/jiuzhou/server && npx tsc -b`
Expected: 成功

**Step 3: Commit**

```bash
git add server/src/routes/
git commit -m "refactor: 统一路由层标准返回，使用 sendSuccess/sendOk/sendResult + throw BusinessError"
```

---

## Phase 3: 拆分 mainQuest/index.ts（1699 行）

### Task 3.1: 创建 shared/ 工具文件

**Files:**
- Create: `server/src/services/mainQuest/shared/questConfig.ts`
- Create: `server/src/services/mainQuest/shared/roomResolver.ts`
- Create: `server/src/services/mainQuest/shared/rewardDecorator.ts`

从 index.ts 中提取以下函数（去掉 client 参数，内部统一用 query()）：

- `questConfig.ts`: isMainQuestChapterEnabled, isSectionEnabled, getEnabledSectionById, getEnabledChapterById, getEnabledSectionsSorted
- `roomResolver.ts`: resolveNpcRoomId, resolveCurrentSectionRoomId
- `rewardDecorator.ts`: decorateSectionRewards

**Step 1: 逐个创建文件，把函数从 index.ts 移入**
**Step 2: 更新 index.ts 的 import，从新文件引入**
**Step 3: tsc -b 校验**
**Step 4: Commit**

```bash
git commit -m "refactor(mainQuest): 提取 shared/ 工具函数（questConfig/roomResolver/rewardDecorator）"
```

### Task 3.2: 拆分查询文件

**Files:**
- Create: `server/src/services/mainQuest/progress.ts` — getMainQuestProgress（含初始化）
- Create: `server/src/services/mainQuest/chapterList.ts` — getChapterList, getSectionList

从 index.ts 移入对应函数，内部 import 改为从 shared/ 引入。

**Step 1: 逐个创建文件**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(mainQuest): 拆分查询文件（progress/chapterList）"
```

### Task 3.3: 拆分命令文件

**Files:**
- Create: `server/src/services/mainQuest/dialogue.ts` — startDialogue, advanceDialogue, selectDialogueChoice
- Create: `server/src/services/mainQuest/objectiveProgress.ts` — updateSectionProgress, syncCurrentSectionStaticProgress
- Create: `server/src/services/mainQuest/sectionComplete.ts` — completeCurrentSection, ensureProgressForNewChapters
- Create: `server/src/services/mainQuest/grantRewards.ts` — grantSectionRewards

所有使用 @Transactional 的方法保持装饰器。去掉 `client` / `dbClient` 参数，内部改用 `query()`。

**Step 1: 逐个创建文件，移入函数并去掉 client 参数**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(mainQuest): 拆分命令文件，去掉 client 参数改用 query()"
```

### Task 3.4: 重写 service.ts 和 index.ts

**Files:**
- Create: `server/src/services/mainQuest/service.ts` — MainQuestService 类
- Modify: `server/src/services/mainQuest/index.ts` — 仅保留导出聚合
- Delete: `server/src/services/mainQuest/commands/`（旧转发文件）
- Delete: `server/src/services/mainQuest/queries/`（旧转发文件）

MainQuestService 类的方法委托到拆分后的各文件函数。index.ts 只做 re-export。

**Step 1: 创建 service.ts**
**Step 2: 重写 index.ts 为纯导出**
**Step 3: 删除旧的 commands/ 和 queries/ 转发文件**
**Step 4: 更新 domains/mainQuest/index.ts 的 import（如有变化）**
**Step 5: tsc -b 校验**
**Step 6: Commit**

```bash
git commit -m "refactor(mainQuest): 完成拆分，index.ts 从 1699 行精简为导出聚合"
```

---

## Phase 4: 拆分 dungeon/index.ts（1962 行）

### Task 4.1: 创建 shared/ 工具文件

**Files:**
- Create: `server/src/services/dungeon/shared/configLoader.ts`
- Create: `server/src/services/dungeon/shared/entryCount.ts`
- Create: `server/src/services/dungeon/shared/participants.ts`
- Create: `server/src/services/dungeon/shared/stageData.ts`
- Create: `server/src/services/dungeon/shared/rewards.ts`
- Create: `server/src/services/dungeon/shared/typeUtils.ts`（改为引用全局 typeCoercion）

**Step 1: 逐个创建文件，移入函数，去掉 client 参数**
**Step 2: typeUtils.ts 中 asString/asNumber/asArray/asObject 改为从全局 shared/typeCoercion.ts 重导出**
**Step 3: tsc -b 校验**
**Step 4: Commit**

```bash
git commit -m "refactor(dungeon): 提取 shared/ 工具函数"
```

### Task 4.2: 拆分业务文件

**Files:**
- Create: `server/src/services/dungeon/definitions.ts` — getDungeonCategories, getDungeonList, getDungeonPreview
- Create: `server/src/services/dungeon/instance.ts` — createDungeonInstance, joinDungeonInstance, getDungeonInstance
- Create: `server/src/services/dungeon/combat.ts` — startDungeonInstance(@Transactional), nextDungeonInstance(@Transactional)

**Step 1: 逐个创建文件，移入函数**
**Step 2: combat.ts 中两个 @Transactional 方法去掉 client 参数，内部用 query()**
**Step 3: tsc -b 校验**
**Step 4: Commit**

```bash
git commit -m "refactor(dungeon): 拆分业务文件（definitions/instance/combat）"
```

### Task 4.3: 重写 service.ts 和 index.ts

**Files:**
- Create: `server/src/services/dungeon/service.ts` — DungeonService 类
- Modify: `server/src/services/dungeon/index.ts` — 仅保留导出聚合
- Delete: `server/src/services/dungeon/commands/`（旧转发文件）
- Delete: `server/src/services/dungeon/queries/`（旧转发文件）
- Delete: `server/src/services/dungeon/shared/startFlow.ts`（逻辑合并到 combat.ts）

**Step 1: 创建 service.ts**
**Step 2: 重写 index.ts**
**Step 3: 删除旧文件**
**Step 4: 更新 domains/dungeon/index.ts**
**Step 5: tsc -b 校验**
**Step 6: Commit**

```bash
git commit -m "refactor(dungeon): 完成拆分，index.ts 从 1962 行精简为导出聚合"
```

---

## Phase 5: 拆分 battle/index.ts（3171 行）

### Task 5.1: 创建 shared/ 工具文件

**Files:**
- Create: `server/src/services/battle/shared/monsters.ts` — resolveMonsterRuntime, resolveOrderedMonsters, parsePhaseEffects, extractMonsterAttrs, normalizeBaseAttrs
- Create: `server/src/services/battle/shared/skills.ts` — getCharacterBattleSkillData, parseSkillUpgradeRules, applySkillUpgradeChanges, toBattleSkill*, clone*, normalize*
- Create: `server/src/services/battle/shared/effects.ts` — getCharacterBattleSetBonusEffects, getCharacterBattleAffixEffects, attachSetBonusEffectsToCharacterData
- Create: `server/src/services/battle/shared/preparation.ts` — rejectIfIdling, getTeamMembersData, prepareTeamBattleParticipants, withBattleStartResources, sync/restoreBattleStartResources

**Step 1: 逐个创建文件**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(battle): 提取 shared/ 工具函数（monsters/skills/effects/preparation）"
```

### Task 5.2: 拆分 runtime/ 文件

**Files:**
- Create: `server/src/services/battle/runtime/ticker.ts` — tickBattle, startBattleTicker, stopBattleTicker, emitBattleUpdate, 自动推进辅助
- Create: `server/src/services/battle/runtime/state.ts` — activeBattles Map, findActiveBattle, registerStartedBattle, buildCharacterInBattleResult, listActiveBattleIds, collect*
- Create: `server/src/services/battle/runtime/persistence.ts` — saveBattleToRedis, removeBattleFromRedis, resolveRecoveredBattleParticipants

**Step 1: 逐个创建文件**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(battle): 拆分 runtime/（ticker/state/persistence）"
```

### Task 5.3: 拆分业务文件

**Files:**
- Create: `server/src/services/battle/pve.ts` — startPVEBattle, startDungeonPVEBattle
- Create: `server/src/services/battle/pvp.ts` — startPVPBattle, settleArenaBattleIfNeeded
- Create: `server/src/services/battle/action.ts` — playerAction, abandonBattle
- Create: `server/src/services/battle/settlement.ts` — finishBattle, finishBattleCore（需加 @Transactional）
- Create: `server/src/services/battle/lifecycle.ts` — recoverBattlesFromRedis, cleanupExpiredBattles, stopBattleService
- Create: `server/src/services/battle/teamHooks.ts` — onUserJoinTeam, onUserLeaveTeam, syncBattleStateOnReconnect
- Create: `server/src/services/battle/snapshot.ts` — buildCharacterBattleSnapshot

**Step 1: 逐个创建文件**
**Step 2: settlement.ts 中 finishBattleCore 的 DB 写操作改用 query() + @Transactional**
**Step 3: tsc -b 校验**
**Step 4: Commit**

```bash
git commit -m "refactor(battle): 拆分业务文件（pve/pvp/action/settlement/lifecycle/teamHooks/snapshot）"
```

### Task 5.4: 重写 service.ts 和 index.ts

**Files:**
- Create: `server/src/services/battle/service.ts` — BattleService 类
- Modify: `server/src/services/battle/index.ts` — 仅保留导出聚合
- Delete: `server/src/services/battle/orchestration/`（旧转发文件）

**Step 1: 创建 service.ts**
**Step 2: 重写 index.ts**
**Step 3: 删除旧文件**
**Step 4: 更新 domains/battle/index.ts**
**Step 5: tsc -b 校验**
**Step 6: Commit**

```bash
git commit -m "refactor(battle): 完成拆分，index.ts 从 3171 行精简为导出聚合"
```

---

## Phase 6: 拆分 inventory/index.ts（4036 行，事务改造最重）

### Task 6.1: 创建 shared/ 工具文件（去掉 client 参数）

**Files:**
- Create: `server/src/services/inventory/shared/attrDelta.ts`
- Create: `server/src/services/inventory/shared/consume.ts`
- Create: `server/src/services/inventory/shared/validation.ts`

**核心改造**：所有函数去掉 `client: PoolClient` 参数和 `Tx` 后缀，内部 `client.query(...)` → `query(...)`。

示例（consume.ts）：
```typescript
// 改造前
async function consumeMaterialByDefIdTx(
  client: PoolClient, characterId: number, defId: string, amount: number
) {
  const { rows } = await client.query('SELECT ... FOR UPDATE', [characterId, defId]);
  await client.query('UPDATE ...', [...]);
}

// 改造后
import { query } from '../../../config/database.js';

async function consumeMaterialByDefId(
  characterId: number, defId: string, amount: number
) {
  const { rows } = await query('SELECT ... FOR UPDATE', [characterId, defId]);
  await query('UPDATE ...', [...]);
}
```

**Step 1: 逐个创建文件，移入函数并改造**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(inventory): 提取 shared/（attrDelta/consume/validation），去掉 client 参数改用 query()"
```

### Task 6.2: 拆分镶嵌模块

**Files:**
- Create: `server/src/services/inventory/socket.ts`

移入所有镶嵌相关函数（normalizeGemSlotTypes, normalizeSocketedGemEntries, toSocketedGemsJson, findSocketEntryBySlot, getNextAvailableSocketSlot, upsertSocketEntry, removeSocketEntryBySlot, readEquipmentSocketState, loadGemItemForSocket, socketEquipment）。

去掉 client 参数，改用 query()。

**Step 1: 创建文件，移入函数**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(inventory): 拆分镶嵌模块 socket.ts，去掉 client 参数"
```

### Task 6.3: 拆分装备操作模块

**Files:**
- Create: `server/src/services/inventory/equipment.ts`

移入：equipItem, unequipItem, enhanceEquipment, refineEquipment, rerollEquipmentAffixes, getRerollCostPreview。

去掉 client 参数，改用 query()。引用 shared/attrDelta、shared/consume、shared/validation。

**Step 1: 创建文件，移入函数**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(inventory): 拆分装备操作模块 equipment.ts，去掉 client 参数"
```

### Task 6.4: 拆分背包 CRUD 模块

**Files:**
- Create: `server/src/services/inventory/bag.ts`

移入：addItemToInventory（含内部 addItemToInventoryImpl），removeItemFromInventory, moveItem, setItemLocked, removeItemsBatch, getInventoryInfo, getInventoryItems, findEmptySlots, expandInventory, sortInventory。

去掉 client 参数，改用 query()。

**Step 1: 创建文件，移入函数**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(inventory): 拆分背包 CRUD 模块 bag.ts，去掉 client 参数"
```

### Task 6.5: 拆分拆解和查询模块

**Files:**
- Create: `server/src/services/inventory/disassemble.ts` — disassembleEquipment, disassembleEquipmentBatch
- Create: `server/src/services/inventory/itemQuery.ts` — getInventoryItemsWithDefs, getEquippedItemDefIds

去掉 client 参数，改用 query()。

**Step 1: 创建文件**
**Step 2: tsc -b 校验**
**Step 3: Commit**

```bash
git commit -m "refactor(inventory): 拆分拆解和查询模块（disassemble/itemQuery）"
```

### Task 6.6: 重写 service.ts 和 index.ts

**Files:**
- Create: `server/src/services/inventory/service.ts` — InventoryService 类（所有写方法 @Transactional）
- Modify: `server/src/services/inventory/index.ts` — 仅保留导出聚合
- Delete: `server/src/services/inventory/commands/`（旧转发文件）
- Delete: `server/src/services/inventory/queries.ts`（旧转发文件）

InventoryService 类示例：
```typescript
import { Transactional } from '../../decorators/transactional.js';
import { equipItem, unequipItem, ... } from './equipment.js';
import { addItemToInventory, ... } from './bag.js';
// ...

class InventoryService {
  // 读操作：直接委托
  getInventoryInfo = getInventoryInfo;
  getInventoryItems = getInventoryItems;
  getInventoryItemsWithDefs = getInventoryItemsWithDefs;
  getEquippedItemDefIds = getEquippedItemDefIds;
  getRerollCostPreview = getRerollCostPreview;
  findEmptySlots = findEmptySlots;

  // 写操作：@Transactional 确保事务
  @Transactional
  async addItemToInventory(...args) { return addItemToInventory(...args); }

  @Transactional
  async equipItem(...args) { return equipItem(...args); }

  // ... 其余写方法同理
}
```

**Step 1: 创建 service.ts**
**Step 2: 重写 index.ts 为纯导出**
**Step 3: 删除旧文件**
**Step 4: 更新 domains/inventory/index.ts**
**Step 5: tsc -b 校验**
**Step 6: Commit**

```bash
git commit -m "refactor(inventory): 完成拆分，index.ts 从 4036 行精简为导出聚合"
```

---

## Phase 7: 清理与最终校验

### Task 7.1: 全局搜索残留

**Step 1: 搜索残留的 withTransaction 直接调用**

```bash
grep -r "withTransaction\(" server/src/services/ --include="*.ts" | grep -v node_modules | grep -v "config/database" | grep -v "decorators/"
```

Expected: 仅剩 database.ts 和 transactional.ts 中的定义，业务代码中不再直接调用。

**Step 2: 搜索残留的 client: PoolClient 参数**

```bash
grep -r "client: PoolClient" server/src/services/ --include="*.ts" | grep -v node_modules | grep -v "config/database"
```

Expected: 无结果（除了极少数确实需要 raw client 的底层场景）。

**Step 3: 搜索残留的手动 res.status().json()**

```bash
grep -rn "res\.status.*\.json" server/src/routes/ --include="*.ts"
```

Expected: 无结果（所有路由已迁移到 sendSuccess/sendResult/throw BusinessError）。

**Step 4: 最终 tsc -b 校验**

Run: `cd /home/faith/projects/jiuzhou/server && npx tsc -b`
Expected: 成功

**Step 5: Commit**

```bash
git commit -m "refactor: 大文件拆分+统一标准返回+事务装饰器化 完成清理"
```

---

## 注意事项

1. **lockCharacterInventoryMutex**：inventory 中的互斥锁函数同样需要去掉 client 参数，改用 query()（因为 `SELECT ... FOR UPDATE` 通过 query() 在事务上下文中会自动走事务连接）。

2. **跨 service 调用**：某些函数（如 grantSectionRewards 调用 itemService.createItem）需要确认被调用方也已改造为无 client 模式。若 itemService 尚未改造，需同步处理。

3. **domains/ 门面文件**：每个 Phase 完成后需同步更新对应的 `domains/xxx/index.ts` 导入路径。

4. **外部调用方**：拆分后的函数签名变化（去掉 client 参数）会影响所有调用方。通过 tsc -b 可以发现所有断裂点。

5. **addItemToInventory 特殊性**：此函数被其他 service 大量调用（battleDropService、mailService、craftService 等），需确保签名变化后所有调用方同步更新。
