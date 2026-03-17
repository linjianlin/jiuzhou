# Worker 迁移方案 - 快速开始

## 文件清单

### 核心文件（已创建）
1. `server/src/workers/idleBattleWorker.ts` - Worker 线程实现
2. `server/src/workers/workerPool.ts` - Worker 池管理
3. `server/src/services/idle/idleBattleExecutorWorker.ts` - 主线程协调器（Worker 版本）
4. `server/src/bootstrap/workerIntegration.ts` - 启动集成示例
5. `docs/worker-migration-guide.md` - 完整迁移文档

### 需要修改的文件
1. `server/src/bootstrap/startupPipeline.ts` - 添加 Worker 池初始化
2. `server/src/services/idle/idleSessionService.ts` - 添加 Worker/主线程切换逻辑
3. `.env` - 添加配置开关

## 快速集成步骤

### 1. 添加环境变量

在 `.env` 文件中添加：

```bash
# 离线挂机使用 Worker（实验性功能）
IDLE_USE_WORKER=false

# Worker 数量（可选，默认为 CPU 核心数 - 1）
# IDLE_WORKER_COUNT=3
```

### 2. 修改启动流程

编辑 `server/src/bootstrap/startupPipeline.ts`：

```typescript
// 在文件顶部添加导入
import { cpus } from 'os';
import { initializeWorkerPool, shutdownWorkerPool } from '../workers/workerPool.js';
import { getMonsterDefinitions, getSkillDefinitions } from '../services/staticConfigLoader.js';

// 在 startServerWithPipeline 函数中，initTables() 之后添加：
export const startServerWithPipeline = async (options: StartServerOptions): Promise<void> => {
  // ... 现有代码 ...

  await initTables();
  await cleanupUndefinedItemDataOnStartup();

  // ===== 新增：初始化 Worker 池 =====
  const useWorker = process.env.IDLE_USE_WORKER === 'true';
  if (useWorker) {
    console.log('正在初始化 Worker 池...');
    const cpuCount = cpus().length;
    const workerCount = process.env.IDLE_WORKER_COUNT
      ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
      : Math.max(1, cpuCount - 1);

    const monsterDefs = new Map(getMonsterDefinitions().map((m) => [m.id, m]));
    const skillDefs = new Map(getSkillDefinitions().map((s) => [s.id, s]));

    await initializeWorkerPool({
      workerCount,
      workerData: { monsterDefs, skillDefs },
    });
    console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）`);
  }
  // ===== 新增结束 =====

  await initGameTimeService();
  // ... 其余代码 ...
};

// 在 gracefulShutdown 函数中，stopAllExecutionLoops() 之后添加：
const gracefulShutdown = async (signal: string): Promise<void> => {
  // ... 现有代码 ...

  stopAllExecutionLoops();
  console.log('✓ 挂机执行循环已停止');

  // ===== 新增：关闭 Worker 池 =====
  const useWorker = process.env.IDLE_USE_WORKER === 'true';
  if (useWorker) {
    await shutdownWorkerPool();
    console.log('✓ Worker 池已关闭');
  }
  // ===== 新增结束 =====

  await new Promise((resolve) => setTimeout(resolve, 2000));
  // ... 其余代码 ...
};
```

### 3. 添加执行器切换逻辑

编辑 `server/src/services/idle/idleSessionService.ts`：

```typescript
// 在文件顶部添加导入
import { startExecutionLoop as startExecutionLoopMain } from './idleBattleExecutor.js';
import { startExecutionLoop as startExecutionLoopWorker } from './idleBattleExecutorWorker.js';

// 在 startIdleSession 函数中，替换 startExecutionLoop 调用：
export async function startIdleSession(params: StartIdleSessionParams): Promise<StartIdleSessionResult> {
  // ... 现有代码 ...

  // 原代码：
  // startExecutionLoop(session, userId);

  // 新代码：
  const useWorker = process.env.IDLE_USE_WORKER === 'true';
  if (useWorker) {
    startExecutionLoopWorker(session, userId);
  } else {
    startExecutionLoopMain(session, userId);
  }

  return { success: true, sessionId };
}
```

### 4. 编译和测试

```bash
# 编译 TypeScript
cd server
pnpm build

# 检查编译产物
ls -lh dist/workers/

# 启动服务（主线程模式）
IDLE_USE_WORKER=false pnpm start

# 启动服务（Worker 模式）
IDLE_USE_WORKER=true pnpm start
```

### 5. 验证 Worker 启动

查看启动日志，应包含：

```
正在初始化 Worker 池...
  - 加载 XXX 个怪物定义，XXX 个技能定义
  - CPU 核心数: 8，启动 7 个 Worker
[WorkerPool] Worker #0 已就绪
[WorkerPool] Worker #1 已就绪
...
[WorkerPool] 7 个 Worker 已就绪
✓ Worker 池已就绪（7 个 Worker）
```

## 监控和调试

### 查看 Worker 状态

添加管理接口（可选）：

```typescript
// 在 server/src/routes/adminRoutes.ts 中添加
import { getWorkerPool } from '../workers/workerPool.js';

router.get('/worker-status', requireAdmin, (req, res) => {
  const useWorker = process.env.IDLE_USE_WORKER === 'true';
  if (!useWorker) {
    return res.json({ enabled: false });
  }

  const status = getWorkerPool().getStatus();
  res.json({
    enabled: true,
    ...status,
  });
});
```

访问 `http://localhost:6011/api/admin/worker-status` 查看状态：

```json
{
  "enabled": true,
  "totalWorkers": 7,
  "busyWorkers": 3,
  "queuedTasks": 0,
  "totalTasksProcessed": 1234
}
```

### 查看日志

```bash
# Docker 环境
docker logs -f jiuzhou_server | grep -E "Worker|IdleBattle"

# 本地开发
pnpm dev:server | grep -E "Worker|IdleBattle"
```

关键日志：
- `[WorkerPool] Worker #X 已就绪` - Worker 启动成功
- `[IdleBattleExecutor] 会话 XXX flush 完成` - 批量写入成功
- `[WorkerPool] Worker #X 错误` - Worker 异常（需排查）
- `[WorkerPool] 任务队列堆积` - 性能瓶颈（需增加 Worker）

## 性能对比测试

### 测试脚本

```bash
# 创建测试脚本 test-idle-performance.sh
#!/bin/bash

echo "=== 主线程模式测试 ==="
IDLE_USE_WORKER=false pnpm start &
SERVER_PID=$!
sleep 10

# 启动 50 个挂机会话
for i in {1..50}; do
  curl -X POST http://localhost:6011/api/idle/start \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"mapId":"map_001","roomId":"room_001","maxDurationMs":600000}' &
done

# 监控事件循环延迟
node -e "
  setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      console.log('EventLoop Lag:', lag, 'ms');
    });
  }, 5000);
" &
MONITOR_PID=$!

sleep 300
kill $SERVER_PID $MONITOR_PID

echo "=== Worker 模式测试 ==="
IDLE_USE_WORKER=true pnpm start &
# ... 重复上述测试 ...
```

### 预期结果

| 指标 | 主线程模式 | Worker 模式 | 改善 |
|------|-----------|------------|------|
| 事件循环延迟 | 200-500ms | 10-50ms | 80-90% |
| 挂机战斗吞吐量 | 10 场/秒 | 50-100 场/秒 | 5-10x |
| Socket 响应延迟 | 100-300ms | 10-30ms | 70-90% |
| CPU 利用率 | 单核 100% | 多核 60-80% | 充分利用 |

## 故障回滚

如果 Worker 模式出现问题，立即回滚：

```bash
# 1. 修改环境变量
echo "IDLE_USE_WORKER=false" >> .env

# 2. 重启服务
docker service update --force jiuzhou_server

# 或本地开发
pkill -f "node.*server" && pnpm dev:server
```

回滚后系统立即恢复到主线程模式，无数据丢失。

## 下一步

1. **小规模测试**：10-20 个挂机会话，观察 1 小时
2. **中等规模测试**：50-100 个挂机会话，观察 6 小时
3. **全量切换**：所有挂机会话使用 Worker 模式
4. **性能调优**：根据监控数据调整 Worker 数量和批量参数

详细文档请参考 `docs/worker-migration-guide.md`。
