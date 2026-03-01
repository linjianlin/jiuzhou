# @Transactional 装饰器设计方案

## 目标

消除业务层所有手动事务代码（`withTransaction`、`client.query`、`rollbackAndReturn`），用 `@Transactional` 装饰器 + 统一 `query` 替代。

## 核心设计

### 装饰器实现

文件：`server/src/decorators/transactional.ts`

```typescript
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

- TC39 Stage 3 原生装饰器，不需要 `experimentalDecorators`
- 已在事务中：直接执行（复用上下文，不嵌套 SAVEPOINT）
- 不在事务中：自动开启新事务
- 成功 return → COMMIT，抛异常 → ROLLBACK

### Service 改造模式

改造前：

```typescript
import { withTransaction } from '../config/database.js';
import { rollbackAndReturn } from './shared/transaction.js';

export const doSignIn = async (userId: number): Promise<DoSignInResult> => {
  return await withTransaction(async (client) => {
    const check = await client.query('SELECT ... FOR UPDATE', [userId]);
    if (check.rows.length === 0) {
      return rollbackAndReturn(client, { success: false, message: '角色不存在' });
    }
    await client.query('INSERT INTO ...', [...]);
    await client.query('UPDATE ...', [...]);
    return { success: true, message: '签到成功', data: { ... } };
  });
};
```

改造后：

```typescript
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';

class SignInService {
  @Transactional
  async doSignIn(userId: number): Promise<DoSignInResult> {
    const check = await query('SELECT ... FOR UPDATE', [userId]);
    if (check.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }
    await query('INSERT INTO ...', [...]);
    await query('UPDATE ...', [...]);
    return { success: true, message: '签到成功', data: { ... } };
  }
}

export const signInService = new SignInService();
```

变化点：
- `withTransaction` → `@Transactional`
- `client.query(...)` → `query(...)`
- `rollbackAndReturn(client, result)` → 直接 `return result`
- 独立函数 → class 方法 + 单例导出
- 纯读方法不加 `@Transactional`

### 路由层对接

```typescript
// 改造前
import { doSignIn } from '../services/signInService.js';
await doSignIn(userId);

// 改造后
import { signInService } from '../services/signInService.js';
await signInService.doSignIn(userId);
```

## 边界情况

### rollbackAndReturn 直接删除

现有用法都是在写入之前做校验失败返回。此时事务里只有 SELECT，COMMIT 和 ROLLBACK 效果一样。改造后直接 `return { success: false }` 即可。

### 服务间嵌套调用

`@Transactional` 自动检测 `isInTransaction()`，内层方法复用外层事务上下文，不创建 SAVEPOINT。

```typescript
class AchievementService {
  @Transactional
  async claim(userId: number, characterId: number, achievementId: string) {
    // ...
    await inventoryService.addItem(characterId, itemId, qty); // 内层复用事务
  }
}
```

### *Tx 后缀函数

改造后变成普通 class 方法，不再接收 `client` 参数，内部用 `query` 自动走事务上下文。

### 主动回滚

极少见场景。如果在写入后需要回滚，抛异常即可，装饰器自动 ROLLBACK。

### getTransactionClient / advisory lock

`@Transactional` 底层仍是 `withTransaction`，AsyncLocalStorage 上下文照常设置，`getTransactionClient()` 正常可用。

## 迁移策略

1. 创建 `server/src/decorators/transactional.ts`
2. 逐个 service 文件改造：
   - 独立函数 → class + 单例导出
   - `withTransaction` → `@Transactional`
   - `client.query` → `query`
   - 删除 `rollbackAndReturn` / `safeRollback` 调用
3. 同步更新路由层 import
4. 每改一个文件跑 `tsc -b` 确认
5. 老的 `withTransaction` 直接调用和新的 `@Transactional` 可以共存，不冲突
6. 全部迁移完成后，清理 `shared/transaction.ts` 中不再使用的工具函数
