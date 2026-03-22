/**
 * WorkerPool — Worker 线程池管理
 *
 * 作用：
 *   管理多个 IdleBattleWorker 实例，提供任务分发、负载均衡、错误恢复能力。
 *   避免主线程直接管理 Worker 生命周期，集中处理 Worker 崩溃重启逻辑。
 *
 * 输入/输出：
 *   - initialize(workerCount, workerData) → Promise<void>（启动 Worker 池）
 *   - executeTask<T>(task) → Promise<T>（分发任务到空闲 Worker）
 *   - shutdown() → Promise<void>（优雅关闭所有 Worker）
 *
 * 数据流：
 *   主线程 → WorkerPool.executeTask → 选择空闲 Worker → Worker 执行 → 返回结果
 *   Worker 崩溃 → WorkerPool 自动重启 → 任务重试（可选）
 *
 * 关键边界条件：
 *   1. Worker 数量默认为 CPU 核心数 - 1（保留一个核心给主线程）
 *   2. 任务队列：当所有 Worker 忙碌时，新任务进入等待队列
 *   3. Worker 崩溃时自动重启，正在执行的任务返回错误（由调用方决定是否重试）
 *   4. shutdown 时等待所有正在执行的任务完成，超时后强制终止
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

// ============================================
// 类型定义
// ============================================

type WorkerTask<T = unknown> = {
  id: string;
  message: unknown;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  /** 任务创建时间（用于超时计算） */
  createdAt: number;
  /** 超时定时器句柄 */
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type WorkerState = {
  worker: Worker;
  busy: boolean;
  currentTask: WorkerTask | null;
  taskCount: number; // 累计处理任务数（用于负载均衡）
};

type WorkerPoolOptions = {
  /** Worker 数量（默认：CPU 核心数 - 1，最小 1）*/
  workerCount?: number;
  /** Worker 脚本路径（默认：./idleBattleWorker.js）*/
  workerScript?: string;
  /** 传递给 Worker 的初始化数据 */
  workerData?: unknown;
  /** 任务超时时间（毫秒，默认 30 秒）*/
  taskTimeout?: number;
  /** Worker 崩溃后是否自动重启（默认 true）*/
  autoRestart?: boolean;
};

/** Worker 池优雅关闭默认等待时间。 */
const DEFAULT_WORKER_POOL_SHUTDOWN_TIMEOUT_MS = 10_000;

// ============================================
// WorkerPool 类
// ============================================

export class WorkerPool {
  private workers: WorkerState[] = [];
  private taskQueue: WorkerTask[] = [];
  private options: Required<WorkerPoolOptions>;
  private isShuttingDown = false;
  private nextTaskId = 0;

  constructor(options: WorkerPoolOptions = {}) {
    const cpuCount = cpus().length;
    this.options = {
      workerCount: options.workerCount ?? Math.max(1, cpuCount - 1),
      workerScript: options.workerScript ?? this.resolveWorkerScript(),
      workerData: options.workerData ?? {},
      taskTimeout: options.taskTimeout ?? 30_000,
      autoRestart: options.autoRestart ?? true,
    };
  }

  /**
   * 解析 Worker 脚本路径（支持 ESM 和 CommonJS）
   */
  private resolveWorkerScript(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // 开发环境：使用预编译的文件（位于 dist/workers/）
    if (process.env.NODE_ENV !== 'production') {
      // 从 src/workers/ 跳转到 dist/workers/
      return path.join(__dirname, '../../dist/workers/idleBattleWorker.js');
    }
    // 生产环境：使用编译后的 .js 文件（同目录）
    return path.join(__dirname, 'idleBattleWorker.js');
  }

  /**
   * 初始化 Worker 池
   */
  async initialize(): Promise<void> {
    console.log(`[WorkerPool] 正在启动 ${this.options.workerCount} 个 Worker...`);

    const initPromises = Array.from({ length: this.options.workerCount }, (_, i) =>
      this.createWorker(i)
    );

    await Promise.all(initPromises);
    console.log(`[WorkerPool] ${this.workers.length} 个 Worker 已就绪`);
  }

  /**
   * 创建单个 Worker 实例
   */
  private async createWorker(index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.options.workerScript, {
        workerData: this.options.workerData,
        // 开发环境使用包装器脚本，不需要 execArgv
        // 生产环境直接运行编译后的 JS
      });

      const state: WorkerState = {
        worker,
        busy: false,
        currentTask: null,
        taskCount: 0,
      };

      // Worker 就绪消息
      const onReady = (msg: { type: string }) => {
        if (msg.type === 'ready') {
          worker.off('message', onReady);
          this.workers.push(state);
          console.log(`[WorkerPool] Worker #${index} 已就绪`);
          resolve();
        }
      };

      // Worker 消息处理
      worker.on('message', onReady);
      worker.on('message', (msg) => this.handleWorkerMessage(state, msg));

      // Worker 错误处理
      worker.on('error', (err: Error) => {
        console.error(`[WorkerPool] Worker #${index} 错误:`, err);
        this.handleWorkerCrash(state, err);
      });

      // Worker 退出处理
      worker.on('exit', (code) => {
        if (code !== 0 && !this.isShuttingDown) {
          console.warn(`[WorkerPool] Worker #${index} 异常退出，代码: ${code}`);
          this.handleWorkerCrash(state, new Error(`Worker 退出，代码: ${code}`));
        }
      });

      // 启动超时保护
      setTimeout(() => {
        if (!this.workers.includes(state)) {
          reject(new Error(`Worker #${index} 启动超时`));
        }
      }, 10_000);
    });
  }

  /**
   * 处理 Worker 返回的消息
   */
  private handleWorkerMessage(state: WorkerState, msg: unknown): void {
    if (!state.currentTask) return;

    const task = state.currentTask;
    state.currentTask = null;
    state.busy = false;

    // 清理超时定时器，避免内存泄漏
    clearTimeout(task.timeoutHandle);

    // 解析消息类型
    const response = msg as { type: string; result?: unknown; error?: string; stack?: string };

    if (response.type === 'batchResult') {
      task.resolve(response.result as never);
    } else if (response.type === 'error') {
      const message = response.error ?? '未知错误';
      const detail = response.stack ? `${message}\n${response.stack}` : message;
      task.reject(new Error(detail));
    }

    // 处理队列中的下一个任务
    this.processNextTask();
  }

  /**
   * 处理 Worker 崩溃
   */
  private handleWorkerCrash(state: WorkerState, error: Error): void {
    // 拒绝当前任务并清理资源
    if (state.currentTask) {
      clearTimeout(state.currentTask.timeoutHandle);
      state.currentTask.reject(new Error(`Worker 崩溃: ${error.message}`));
      state.currentTask = null;
    }

    // 从池中移除崩溃的 Worker
    const index = this.workers.indexOf(state);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }

    // 自动重启
    if (this.options.autoRestart && !this.isShuttingDown) {
      console.log(`[WorkerPool] 正在重启 Worker #${index}...`);
      void this.createWorker(index).catch((err) => {
        console.error(`[WorkerPool] Worker #${index} 重启失败:`, err);
      });
    }
  }

  /**
   * 执行任务（分发到空闲 Worker）
   * 支持队列等待和统一的超时机制
   */
  executeTask<T = unknown>(message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const createdAt = Date.now();
      const timeoutMs = this.options.taskTimeout;

      // 创建超时处理器（统一处理执行中和队列中的任务）
      const timeoutHandle = setTimeout(() => {
        const elapsed = Date.now() - createdAt;
        this.handleTaskTimeout(task, elapsed);
      }, timeoutMs);

      const task: WorkerTask = {
        id: `task-${this.nextTaskId++}`,
        message,
        resolve: resolve as (value: unknown) => void,
        reject,
        createdAt,
        timeoutHandle,
      };

      // 查找空闲 Worker
      const idleWorker = this.workers.find((w) => !w.busy);

      if (idleWorker) {
        this.assignTask(idleWorker, task);
      } else {
        // 所有 Worker 忙碌，加入队列
        this.taskQueue.push(task);
      }
    });
  }

  /**
   * 处理任务超时（统一处理执行中和队列中的任务）
   */
  private handleTaskTimeout(task: WorkerTask, elapsed: number): void {
    // 1. 检查是否在队列中（尚未执行）
    const queueIndex = this.taskQueue.indexOf(task);
    if (queueIndex !== -1) {
      // 从队列中移除并拒绝
      this.taskQueue.splice(queueIndex, 1);
      task.reject(new Error(`任务在队列中等待超时（${elapsed}ms）`));
      return;
    }

    // 2. 检查是否正在某个 Worker 中执行
    const workerState = this.workers.find((w) => w.currentTask === task);
    if (workerState) {
      // 标记 Worker 状态为空闲（任务已超时）
      workerState.currentTask = null;
      workerState.busy = false;
      task.reject(new Error(`任务执行超时（${elapsed}ms）`));
      this.processNextTask();
      return;
    }

    // 3. 任务已完成或已被处理，无需操作
  }

  /**
   * 分配任务到 Worker
   */
  private assignTask(state: WorkerState, task: WorkerTask): void {
    state.busy = true;
    state.currentTask = task;
    state.taskCount++;
    state.worker.postMessage(task.message);
  }

  /**
   * 处理队列中的下一个任务
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;

    // 选择负载最低的空闲 Worker（负载均衡）
    const idleWorker = this.workers
      .filter((w) => !w.busy)
      .sort((a, b) => a.taskCount - b.taskCount)[0];

    if (idleWorker) {
      const task = this.taskQueue.shift();
      if (task) {
        this.assignTask(idleWorker, task);
      }
    }
  }

  /**
   * 优雅关闭 Worker 池
   */
  async shutdown(timeoutMs = DEFAULT_WORKER_POOL_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.isShuttingDown = true;
    console.log(`[WorkerPool] 正在关闭 ${this.workers.length} 个 Worker...`);

    // 拒绝队列中的所有任务并清理资源
    for (const task of this.taskQueue) {
      clearTimeout(task.timeoutHandle);
      task.reject(new Error('WorkerPool 正在关闭'));
    }
    this.taskQueue = [];

    // 等待所有正在执行的任务完成
    const startTime = Date.now();
    while (this.workers.some((w) => w.busy)) {
      if (Date.now() - startTime > timeoutMs) {
        console.warn('[WorkerPool] 等待任务完成超时，强制终止');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 发送关闭消息并终止所有 Worker
    const terminatePromises = this.workers.map(async (state) => {
      try {
        state.worker.postMessage({ type: 'shutdown' });
        await state.worker.terminate();
      } catch (err) {
        console.error('[WorkerPool] Worker 终止失败:', err);
      }
    });

    await Promise.all(terminatePromises);
    this.workers = [];
    console.log('[WorkerPool] 所有 Worker 已关闭');
  }

  /**
   * 获取池状态（用于监控）
   */
  getStatus(): {
    totalWorkers: number;
    busyWorkers: number;
    queuedTasks: number;
    totalTasksProcessed: number;
  } {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.workers.filter((w) => w.busy).length,
      queuedTasks: this.taskQueue.length,
      totalTasksProcessed: this.workers.reduce((sum, w) => sum + w.taskCount, 0),
    };
  }
}

// ============================================
// 单例导出（供全局使用）
// ============================================

let globalWorkerPool: WorkerPool | null = null;

/**
 * 获取全局 WorkerPool 实例（懒加载）
 */
export function getWorkerPool(): WorkerPool {
  if (!globalWorkerPool) {
    throw new Error('[WorkerPool] 未初始化，请先调用 initializeWorkerPool()');
  }
  return globalWorkerPool;
}

/**
 * 初始化全局 WorkerPool
 */
export async function initializeWorkerPool(options?: WorkerPoolOptions): Promise<void> {
  if (globalWorkerPool) {
    console.warn('[WorkerPool] 已初始化，跳过重复初始化');
    return;
  }

  globalWorkerPool = new WorkerPool(options);
  await globalWorkerPool.initialize();
}

/**
 * 关闭全局 WorkerPool
 */
export async function shutdownWorkerPool(options?: {
  timeoutMs?: number;
}): Promise<void> {
  if (globalWorkerPool) {
    await globalWorkerPool.shutdown(options?.timeoutMs);
    globalWorkerPool = null;
  }
}
