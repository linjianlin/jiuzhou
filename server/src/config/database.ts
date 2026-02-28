/**
 * 数据库统一入口（连接池 + 自动事务上下文）
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：
 *   1) 提供统一 `query` 查询入口；
 *   2) 提供 `withTransaction` 自动事务封装；
 *   3) 支持嵌套事务自动 SAVEPOINT；
 *   4) 启用严格模式：写语句必须在事务上下文执行。
 * - 不做什么：
 *   1) 不承载业务规则；
 *   2) 不做“失败后吞错并继续执行”的容错兜底；
 *   3) 不吞掉业务异常。
 *
 * 输入/输出：
 * - 输入：SQL 文本、参数数组、事务回调函数。
 * - 输出：数据库查询结果、事务回调返回值。
 *
 * 数据流/状态流：
 * - 根事务：`withTransaction` 创建连接并 `BEGIN`，回调成功 `COMMIT`，异常 `ROLLBACK`，最终释放连接。
 * - 嵌套事务：在同一连接上自动创建 `SAVEPOINT`，局部失败仅回滚到当前保存点。
 * - 普通查询：`query` 自动复用当前事务上下文连接；无事务时走连接池直连查询。
 *
 * 关键边界条件与坑点：
 * 1) 统一 `query` 入口上的事务外写语句会自动进入事务；原始 `client.query` 仍要求显式事务语义。
 * 2) 嵌套事务名必须可预测且无注入风险，因此仅使用内部生成的 ASCII 安全标识符。
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';

dotenv.config();

const { Pool } = pg;

// 是否启用查询日志（生产环境关闭）
const ENABLE_QUERY_LOG = process.env.DB_LOG === 'true';

/**
 * 严格写入事务模式：
 * - true：事务外写语句自动封装为事务执行（统一 `query` + 原始 `client.query` 都生效）。
 * - false：关闭自动写事务与拦截。
 */
const STRICT_WRITE_TRANSACTION = true;

// 数据库连接池
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '6060'),
  database: process.env.DB_NAME || 'jiuzshou_s',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'zlf981216',
  max: 100,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000, // 单条语句超时 30 秒，防止锁等待过久
});

type TransactionContext = {
  client: PoolClient;
};

type QueryCallable = (...queryArgs: unknown[]) => unknown;

const transactionContextStorage = new AsyncLocalStorage<TransactionContext | null>();

type ClientTransactionState = {
  depth: number;
  released: boolean;
  savepointCounter: number;
  savepointStack: string[];
  clientId: number;
};

type DecoratedPoolClient = PoolClient & {
  __txState?: ClientTransactionState;
  __txRawQuery?: QueryCallable;
  __txRawRelease?: (err?: Error | boolean) => void;
};

let decoratedClientIdCounter = 0;

const getActiveTransactionContext = (): TransactionContext | null => {
  return transactionContextStorage.getStore() ?? null;
};

const stripLeadingSqlComments = (sql: string): string => {
  let text = sql.trim();

  while (text.length > 0) {
    if (text.startsWith('--')) {
      const lineBreakIndex = text.indexOf('\n');
      text = lineBreakIndex >= 0 ? text.slice(lineBreakIndex + 1).trimStart() : '';
      continue;
    }

    if (text.startsWith('/*')) {
      const endIndex = text.indexOf('*/');
      text = endIndex >= 0 ? text.slice(endIndex + 2).trimStart() : '';
      continue;
    }

    break;
  }

  return text;
};

const isWriteSql = (sql: string): boolean => {
  const normalized = stripLeadingSqlComments(sql).toUpperCase();
  if (!normalized) return false;

  if (
    normalized.startsWith('INSERT') ||
    normalized.startsWith('UPDATE') ||
    normalized.startsWith('DELETE') ||
    normalized.startsWith('MERGE') ||
    normalized.startsWith('REPLACE') ||
    normalized.startsWith('TRUNCATE')
  ) {
    return true;
  }

  if (normalized.startsWith('SELECT') && /\bFOR\s+UPDATE\b/.test(normalized)) {
    return true;
  }

  if (normalized.startsWith('WITH')) {
    return /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(normalized);
  }

  return false;
};

const normalizeCommandSql = (sql: string): string => {
  return stripLeadingSqlComments(sql)
    .replace(/;\s*$/g, '')
    .trim()
    .toUpperCase();
};

const extractSqlTextFromQueryArgs = (queryArgs: unknown[]): string => {
  const firstArg = queryArgs[0];
  if (typeof firstArg === 'string') {
    return firstArg;
  }

  if (firstArg && typeof firstArg === 'object' && 'text' in (firstArg as Record<string, unknown>)) {
    return String((firstArg as { text?: unknown }).text || '');
  }

  return '';
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
};

const executeRawQueryAsPromise = (
  rawQuery: QueryCallable,
  sql: string,
): Promise<QueryResult<QueryResultRow>> => {
  const result = rawQuery(sql);
  if (!isPromiseLike(result)) {
    throw new Error(`数据库查询返回值异常：期望 Promise，实际为 ${typeof result}`);
  }
  return result as Promise<QueryResult<QueryResultRow>>;
};

const resetClientTransactionState = (state: ClientTransactionState): void => {
  state.depth = 0;
  state.savepointStack = [];
  // 注意：不在这里清除 AsyncLocalStorage
  // AsyncLocalStorage 应该由 transactionContextStorage.run() 自动管理
  // 在这里清除可能会影响其他异步上下文
};

const createNoopQueryResult = <T extends QueryResultRow>(
  command: string,
): QueryResult<T> => {
  return {
    command,
    rowCount: 0,
    oid: 0,
    rows: [],
    fields: [],
  } as QueryResult<T>;
};

const nextSavepointName = (state: ClientTransactionState): string => {
  state.savepointCounter += 1;
  return `sp_auto_client_${state.clientId}_${state.savepointCounter}`;
};

const safeReleaseClient = (client: PoolClient): void => {
  try {
    client.release();
  } catch {
    // 释放失败通常是重复释放，不应覆盖主流程异常。
  }
};

const decoratePoolClient = (client: PoolClient): PoolClient => {
  const decoratedClient = client as DecoratedPoolClient;
  if (decoratedClient.__txState && decoratedClient.__txRawQuery && decoratedClient.__txRawRelease) {
    return decoratedClient;
  }

  const rawQuery = client.query.bind(client) as QueryCallable;
  const rawRelease = client.release.bind(client) as (err?: Error | boolean) => void;
  const state: ClientTransactionState = {
    depth: 0,
    released: false,
    savepointCounter: 0,
    savepointStack: [],
    clientId: ++decoratedClientIdCounter,
  };

  decoratedClient.__txState = state;
  decoratedClient.__txRawQuery = rawQuery;
  decoratedClient.__txRawRelease = rawRelease;

  client.query = ((...queryArgs: unknown[]) => {
    const sql = extractSqlTextFromQueryArgs(queryArgs);
    const normalizedCommand = normalizeCommandSql(sql);

    if (normalizedCommand === 'BEGIN' || normalizedCommand === 'START TRANSACTION') {
      if (state.depth <= 0) {
        return executeRawQueryAsPromise(rawQuery, 'BEGIN').then((result) => {
          state.depth = 1;
          transactionContextStorage.enterWith({ client });
          return result;
        });
      }

      // 嵌套事务：创建 SAVEPOINT
      console.log('创建 SAVEPOINT', {
        clientId: state.clientId,
        depth: state.depth,
        savepointStack: state.savepointStack
      });
      const savepointName = nextSavepointName(state);
      return executeRawQueryAsPromise(rawQuery, `SAVEPOINT ${savepointName}`).then(() => {
        state.savepointStack.push(savepointName);
        state.depth += 1;
        return createNoopQueryResult<QueryResultRow>('BEGIN');
      });
    }

    if (normalizedCommand === 'COMMIT' || normalizedCommand === 'END') {
      if (state.depth <= 0) {
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('COMMIT'));
      }

      if (state.depth === 1) {
        return executeRawQueryAsPromise(rawQuery, 'COMMIT').then((result) => {
          resetClientTransactionState(state);
          return result;
        });
      }

      const savepointName = state.savepointStack[state.savepointStack.length - 1];
      if (!savepointName) {
        state.depth = Math.max(0, state.depth - 1);
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('COMMIT'));
      }

      return executeRawQueryAsPromise(rawQuery, `RELEASE SAVEPOINT ${savepointName}`).then(() => {
        state.savepointStack.pop();
        state.depth -= 1;
        return createNoopQueryResult<QueryResultRow>('COMMIT');
      });
    }

    if (normalizedCommand === 'ROLLBACK') {
      if (state.depth <= 0) {
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('ROLLBACK'));
      }

      if (state.depth === 1) {
        return executeRawQueryAsPromise(rawQuery, 'ROLLBACK').then((result) => {
          resetClientTransactionState(state);
          return result;
        });
      }

      const savepointName = state.savepointStack[state.savepointStack.length - 1];
      if (!savepointName) {
        state.depth = Math.max(0, state.depth - 1);
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('ROLLBACK'));
      }

      return executeRawQueryAsPromise(rawQuery, `ROLLBACK TO SAVEPOINT ${savepointName}`)
        .then(() => executeRawQueryAsPromise(rawQuery, `RELEASE SAVEPOINT ${savepointName}`))
        .then(() => {
          state.savepointStack.pop();
          state.depth -= 1;
          return createNoopQueryResult<QueryResultRow>('ROLLBACK');
        });
    }

    if (STRICT_WRITE_TRANSACTION && isWriteSql(sql) && state.depth <= 0) {
      return executeRawQueryAsPromise(rawQuery, 'BEGIN')
        .then(() => {
          state.depth = 1;
          transactionContextStorage.enterWith({ client });
          const writeResult = rawQuery(...queryArgs);
          if (!isPromiseLike(writeResult)) {
            throw new Error('自动写事务仅支持 Promise 风格调用');
          }
          return writeResult as Promise<QueryResult<QueryResultRow>>;
        })
        .then((result) =>
          executeRawQueryAsPromise(rawQuery, 'COMMIT').then(() => {
            resetClientTransactionState(state);
            return result;
          }),
        )
        .catch((error) =>
          executeRawQueryAsPromise(rawQuery, 'ROLLBACK')
            .catch(() => undefined)
            .then(() => {
              resetClientTransactionState(state);
              throw error;
            }),
        );
    }

    return rawQuery(...queryArgs);
  }) as PoolClient['query'];

  client.release = ((err?: Error | boolean) => {
    if (state.released) {
      console.warn('警告：尝试重复释放连接', { clientId: state.clientId, depth: state.depth });
      return;
    }

    // 标记为即将释放，防止并发调用
    state.released = true;

    if (state.depth > 0) {
      // 如果事务还在进行中就被释放，这是一个错误
      console.error('错误：事务未结束就释放连接', {
        clientId: state.clientId,
        depth: state.depth,
        savepointStack: state.savepointStack
      });
      // 重置状态并释放（不尝试 ROLLBACK，因为 release 必须是同步的）
      resetClientTransactionState(state);
    }

    rawRelease(err);
  }) as PoolClient['release'];

  return client;
};

const rawPoolConnect = pool.connect.bind(pool) as PgPool['connect'];

const connectDecoratedClient = async (): Promise<PoolClient> => {
  const client = await (rawPoolConnect as () => Promise<PoolClient>)();
  return decoratePoolClient(client);
};

pool.connect = ((callback?: unknown) => {
  if (typeof callback === 'function') {
    const done = callback as (
      err: Error | undefined,
      client: PoolClient | undefined,
      release: (releaseArg?: unknown) => void,
    ) => void;

    void connectDecoratedClient()
      .then((client) => {
        done(
          undefined,
          client,
          (releaseArg?: unknown) => client.release(releaseArg as Error | boolean | undefined),
        );
      })
      .catch((error: unknown) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        done(normalizedError, undefined, () => undefined);
      });
    return;
  }

  return connectDecoratedClient();
}) as PgPool['connect'];

const executeQueryWithLogging = (
  runner: QueryCallable,
  queryArgs: unknown[],
  sql: string,
): unknown => {
  const rawResult = runner(...queryArgs);
  if (!ENABLE_QUERY_LOG || !sql || !isPromiseLike(rawResult)) {
    return rawResult;
  }

  return (rawResult as Promise<QueryResult<QueryResultRow>>).then((result) => {
    console.log('执行查询:', { text: sql.substring(0, 50), rows: result.rowCount });
    return result;
  });
};

/**
 * 对“统一 query 入口上的事务外写语句”执行自动事务封装。
 *
 * 设计说明：
 * - 该逻辑只处理统一 `query` 入口；
 * - 原始 `client.query` 保持强约束，要求调用方显式事务语义（BEGIN/withTransaction）。
 */
const executeWriteWithAutoTransaction = (
  queryArgs: unknown[],
  sql: string,
): Promise<unknown> => {
  return withTransaction(async () => {
    const context = getActiveTransactionContext();
    if (!context) {
      throw new Error('自动写事务初始化失败：缺少事务上下文');
    }
    const txRunner = context.client.query.bind(context.client) as QueryCallable;
    const txResult = executeQueryWithLogging(txRunner, queryArgs, sql);
    if (!isPromiseLike(txResult)) {
      throw new Error('自动写事务仅支持 Promise 风格调用');
    }
    return txResult;
  });
};

/**
 * 获取当前事务上下文连接。
 *
 * 设计说明：
 * - 仅供少量底层场景使用（如显式锁粒度控制）。
 * - 普通业务应优先调用 `query`，避免与事务生命周期耦合。
 */
export const getTransactionClient = (): PoolClient | null => {
  return getActiveTransactionContext()?.client ?? null;
};

/**
 * 当前调用链是否处于事务上下文中。
 */
export const isInTransaction = (): boolean => {
  return Boolean(getActiveTransactionContext());
};

/**
 * 统一 SQL 查询入口。
 *
 * 设计说明：
 * - 在事务上下文内自动复用同一连接；
 * - 在事务外执行写语句时，会自动提升到事务执行。
 */
export const query = ((...queryArgs: unknown[]) => {
  const sql = extractSqlTextFromQueryArgs(queryArgs);
  const context = getActiveTransactionContext();

  if (!context && STRICT_WRITE_TRANSACTION && sql && isWriteSql(sql)) {
    return executeWriteWithAutoTransaction(queryArgs, sql);
  }

  const runner = context
    ? (context.client.query.bind(context.client) as QueryCallable)
    : (pool.query.bind(pool) as QueryCallable);

  return executeQueryWithLogging(runner, queryArgs, sql);
}) as PgPool['query'];

/**
 * 自动事务执行器。
 *
 * 语义：
 * - 根调用：开启真实事务；
 * - 嵌套调用：自动 SAVEPOINT；
 * - 失败时只回滚当前层级并继续抛错。
 */
export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const parentContext = getActiveTransactionContext();

  if (parentContext) {
    const decoratedClient = parentContext.client as DecoratedPoolClient;
    const state = decoratedClient.__txState;

    // 检测僵尸上下文：如果客户端已释放或 depth <= 0，说明上下文已失效
    if (!state || state.released || state.depth <= 0) {
      // 忽略僵尸上下文，创建新的根事务
      // 不记录日志，因为这是正常的异步边界情况
    } else {
      // 父上下文有效，执行嵌套事务
      await parentContext.client.query('BEGIN');
      try {
        const result = await callback(parentContext.client);
        await parentContext.client.query('COMMIT');
        return result;
      } catch (error) {
        await parentContext.client.query('ROLLBACK');
        throw error;
      }
    }
  }

  const client = await pool.connect();
  const rootContext: TransactionContext = { client };

  try {
    await client.query('BEGIN');
    const result = await transactionContextStorage.run(rootContext, async () => callback(client));
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    throw error;
  }
};

/**
 * 智能事务执行器（自动检测事务上下文）
 *
 * 作用：
 * - 如果已在事务中，直接使用现有连接（避免嵌套 SAVEPOINT）
 * - 如果不在事务中，创建新事务
 *
 * 使用场景：
 * - 服务函数既可能被独立调用（从路由），也可能被嵌套调用（从其他服务）
 * - 避免不必要的 SAVEPOINT 开销
 *
 * 示例：
 * ```typescript
 * export const updateAchievementProgress = async (...) => {
 *   return await withTransactionAuto(async (client) => {
 *     // 业务逻辑
 *   });
 * };
 * ```
 */
export const withTransactionAuto = async <T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const existingClient = getTransactionClient();

  // 如果已在事务中，直接使用现有连接
  if (existingClient) {
    return await callback(existingClient);
  }

  // 否则创建新事务
  return await withTransaction(callback);
};

// 延迟函数
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 测试数据库连接（带重试）
export const testConnection = async (
  maxRetries = 10,
  initialDelay = 1000,
): Promise<boolean> => {
  let retries = 0;
  let delay = initialDelay;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      console.log('✓ 数据库连接成功');
      safeReleaseClient(client);
      return true;
    } catch (error) {
      retries++;
      if (retries >= maxRetries) {
        console.error('✗ 数据库连接失败，已达最大重试次数:', error);
        return false;
      }
      console.log(`✗ 数据库连接失败，${delay / 1000}秒后重试 (${retries}/${maxRetries})...`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000); // 指数退避，最大 10 秒
    }
  }
  return false;
};
