# 事务管理重构方案

## 问题总结

当前架构存在的问题：
1. 每个服务函数都有自己的 `withTransaction`，导致嵌套事务
2. 错误处理不一致，有的吞噬错误，有的传播错误
3. 空 `catch {}` 块完全吞噬错误，包括事务中止错误
4. 事务边界不清晰，难以追踪和调试

## 方案 1: 事务上下文传递（推荐）

### 核心思想
服务函数接受可选的 `PoolClient` 参数，如果提供则使用，否则创建新事务。

### 实现示例

```typescript
// 修改前
export const updateAchievementProgress = async (
  characterId: number,
  trackKey: string,
  increment = 1,
): Promise<void> => {
  return await withTransaction(async (client) => {
    // 业务逻辑
  });
};

// 修改后
export const updateAchievementProgress = async (
  characterId: number,
  trackKey: string,
  increment = 1,
  client?: PoolClient, // 可选的事务上下文
): Promise<void> => {
  const execute = async (tx: PoolClient) => {
    // 业务逻辑
  };

  // 如果提供了 client，直接使用（嵌套调用）
  if (client) {
    return await execute(client);
  }

  // 否则创建新事务（独立调用）
  return await withTransaction(execute);
};
```

### 调用示例

```typescript
// 独立调用（从路由）
await updateAchievementProgress(characterId, trackKey, 1);

// 嵌套调用（从其他服务）
await withTransaction(async (client) => {
  await distributeBattleRewards(...);
  await updateAchievementProgress(characterId, trackKey, 1, client); // 传递 client
});
```

### 优点
- ✅ 事务边界清晰
- ✅ 避免不必要的嵌套事务（SAVEPOINT）
- ✅ 错误自然传播，不需要特殊处理
- ✅ 向后兼容（client 参数可选）

### 缺点
- ⚠️ 需要修改所有服务函数签名
- ⚠️ 调用方需要显式传递 client

## 方案 2: 自动检测事务上下文

### 核心思想
使用 AsyncLocalStorage 自动检测当前是否在事务中。

### 实现示例

```typescript
// database.ts 中已有的实现
const transactionContextStorage = new AsyncLocalStorage<TransactionContext | null>();

export const getTransactionClient = (): PoolClient | null => {
  return getActiveTransactionContext()?.client ?? null;
};

// 服务函数修改
export const updateAchievementProgress = async (
  characterId: number,
  trackKey: string,
  increment = 1,
): Promise<void> => {
  const existingClient = getTransactionClient();

  const execute = async (client: PoolClient) => {
    // 业务逻辑
  };

  // 如果已在事务中，直接使用
  if (existingClient) {
    return await execute(existingClient);
  }

  // 否则创建新事务
  return await withTransaction(execute);
};
```

### 优点
- ✅ 不需要修改函数签名
- ✅ 自动检测，调用方无需关心
- ✅ 事务边界清晰

### 缺点
- ⚠️ 依赖 AsyncLocalStorage（Node.js 12.17+）
- ⚠️ 隐式行为，可能难以理解

## 方案 3: 严格的事务边界分离

### 核心思想
将服务函数分为两类：
1. **事务函数**（`*Tx`）：接受 `PoolClient`，不创建事务
2. **入口函数**：创建事务并调用事务函数

### 实现示例

```typescript
// 事务函数（内部使用）
export const updateAchievementProgressTx = async (
  client: PoolClient,
  characterId: number,
  trackKey: string,
  increment = 1,
): Promise<void> => {
  // 业务逻辑，直接使用 client
};

// 入口函数（路由使用）
export const updateAchievementProgress = async (
  characterId: number,
  trackKey: string,
  increment = 1,
): Promise<void> => {
  return await withTransaction(async (client) => {
    return await updateAchievementProgressTx(client, characterId, trackKey, increment);
  });
};
```

### 调用示例

```typescript
// 从路由调用
await updateAchievementProgress(characterId, trackKey, 1);

// 从其他服务调用（在事务中）
await withTransaction(async (client) => {
  await distributeBattleRewardsTx(client, ...);
  await updateAchievementProgressTx(client, characterId, trackKey, 1);
});
```

### 优点
- ✅ 事务边界非常清晰
- ✅ 强制正确使用（类型检查）
- ✅ 易于理解和维护

### 缺点
- ⚠️ 需要为每个函数创建两个版本
- ⚠️ 代码量增加

## 方案 4: 使用装饰器/高阶函数

### 核心思想
使用装饰器自动处理事务逻辑。

### 实现示例

```typescript
// 事务装饰器
function transactional<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: { propagation?: 'required' | 'requires_new' | 'supports' }
): T {
  return (async (...args: any[]) => {
    const existingClient = getTransactionClient();
    const propagation = options?.propagation ?? 'required';

    if (existingClient && propagation !== 'requires_new') {
      // 使用现有事务
      return await fn(...args, existingClient);
    }

    // 创建新事务
    return await withTransaction(async (client) => {
      return await fn(...args, client);
    });
  }) as T;
}

// 使用装饰器
const updateAchievementProgressImpl = async (
  characterId: number,
  trackKey: string,
  increment: number,
  client: PoolClient,
): Promise<void> => {
  // 业务逻辑
};

export const updateAchievementProgress = transactional(updateAchievementProgressImpl);
```

### 优点
- ✅ 声明式，易于理解
- ✅ 可配置传播行为
- ✅ 减少样板代码

### 缺点
- ⚠️ TypeScript 装饰器支持有限
- ⚠️ 需要额外的抽象层

## 错误处理最佳实践

无论选择哪种方案，都应遵循以下原则：

### 1. 永远不要使用空 catch 块

```typescript
// ❌ 错误
try {
  await someOperation();
} catch {}

// ✅ 正确
try {
  await someOperation();
} catch (error) {
  // 至少记录错误
  console.error('操作失败:', error);
  // 或者重新抛出
  throw error;
}
```

### 2. 事务中止错误必须传播

```typescript
try {
  await someOperation();
} catch (error) {
  // 检查是否是事务中止错误
  if (error && typeof error === 'object' && 'code' in error && error.code === '25P02') {
    throw error; // 必须重新抛出
  }
  // 其他错误可以处理
  console.error('操作失败:', error);
}
```

### 3. 在最外层统一处理错误

```typescript
// 路由层
app.post('/api/battle/finish', async (req, res) => {
  try {
    const result = await finishBattle(...);
    res.json(result);
  } catch (error) {
    console.error('战斗结束失败:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});
```

### 4. 使用类型化的错误

```typescript
class TransactionAbortedError extends Error {
  code = '25P02';
  constructor(message: string) {
    super(message);
    this.name = 'TransactionAbortedError';
  }
}

// 在 withTransaction 中
catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === '25P02') {
    throw new TransactionAbortedError(error.message);
  }
  throw error;
}
```

## 推荐实施步骤

### 阶段 1: 立即修复（已完成）
- ✅ 修复空 catch 块
- ✅ 修复关键函数的错误吞噬

### 阶段 2: 短期改进（1-2 周）
1. 实施方案 2（自动检测事务上下文）
2. 为所有服务函数添加事务检测逻辑
3. 添加集成测试验证嵌套事务场景

### 阶段 3: 长期重构（1-2 个月）
1. 逐步迁移到方案 3（严格的事务边界分离）
2. 为每个服务函数创建 `*Tx` 版本
3. 更新所有调用方使用正确的版本
4. 添加 ESLint 规则防止错误使用

### 阶段 4: 工具和监控
1. 添加事务追踪日志
2. 监控事务中止错误
3. 添加性能监控（事务持续时间、嵌套深度）

## 代码审查清单

在代码审查时，检查以下内容：

- [ ] 没有空 `catch {}` 块
- [ ] 所有 catch 块都处理或重新抛出事务中止错误
- [ ] 事务边界清晰（不要在循环中创建事务）
- [ ] 嵌套事务使用正确（传递 client 或使用 `*Tx` 函数）
- [ ] 错误消息有意义（不要只记录 "操作失败"）
- [ ] 长事务被拆分（避免锁等待）

## 参考资料

- PostgreSQL 事务隔离级别：https://www.postgresql.org/docs/current/transaction-iso.html
- Node.js AsyncLocalStorage：https://nodejs.org/api/async_context.html
- 事务传播行为（Spring 参考）：https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html
