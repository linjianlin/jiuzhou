/**
 * 数据库统一入口（连接池 + 自动事务上下文）
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：
 *   1) 提供统一 `query` 查询入口；
 *   2) 提供 `withTransaction` 自动事务封装；
 *   3) 复用当前事务上下文，不创建嵌套事务；
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
 * - 内层调用：复用根事务连接，不创建 SAVEPOINT；任一失败将标记根事务必须回滚。
 * - 普通查询：`query` 自动复用当前事务上下文连接；无事务时走连接池直连查询。
 *
 * 关键边界条件与坑点：
 * 1) 统一 `query` 入口上的事务外写语句会自动进入事务；原始 `client.query` 仍要求显式事务语义。
 * 2) 同一调用链内一旦出现事务失败，事务会被标记为 rollback-only，禁止后续误提交。
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { resolveDatabaseConnectionString } from './databaseConnection.js';
import { resolveDatabasePoolConfig } from './databasePoolConfig.js';
import { isTransientPgError } from './databaseRuntimeError.js';

dotenv.config();

const { Pool } = pg;

// 是否启用查询日志（生产环境关闭）
const ENABLE_QUERY_LOG = process.env.DB_LOG === 'true';
const DATABASE_CONNECTION_STRING = resolveDatabaseConnectionString(process.env);
const DATABASE_POOL_CONFIG = resolveDatabasePoolConfig(process.env);

/**
 * 严格写入事务模式：
 * - true：事务外写语句自动封装为事务执行（统一 `query` + 原始 `client.query` 都生效）。
 * - false：关闭自动写事务与拦截。
 */
const STRICT_WRITE_TRANSACTION = true;

// 数据库连接池
export const pool = new Pool({
  connectionString: DATABASE_CONNECTION_STRING,
  ...DATABASE_POOL_CONFIG,
});

pool.on('error', (error) => {
  if (isTransientPgError(error)) {
    console.error('数据库连接池检测到可恢复异常，后续查询将按需重建连接:', error);
    return;
  }

  console.error('数据库连接池检测到非预期异常:', error);
});

type TransactionContext = {
  client: PoolClient;
  afterCommitCallbacks: TransactionAfterCommitCallback[];
};

type QueryCallable = (...queryArgs: unknown[]) => unknown;

type TransactionAfterCommitCallback = () => Promise<void> | void;

const transactionContextStorage = new AsyncLocalStorage<TransactionContext | null>();
type DatabaseAccessRule = {
  label: string;
};

const databaseAccessRuleStorage = new AsyncLocalStorage<DatabaseAccessRule | null>();

type ClientTransactionState = {
  depth: number;
  released: boolean;
  rollbackOnly: boolean;
  rollbackCause: unknown | null;
  clientId: number;
};

type DecoratedPoolClient = PoolClient & {
  __txState?: ClientTransactionState;
  __txRawQuery?: QueryCallable;
  __txCheckoutErrorListener?: (error: Error) => void;
};

type ErrorChainEntry = {
  name: string;
  message: string;
  stack?: string;
};

export class TransactionRollbackOnlyError extends Error {
  readonly causeDetail: unknown;

  constructor(message: string, causeDetail: unknown) {
    super(message);
    this.name = 'TransactionRollbackOnlyError';
    this.causeDetail = causeDetail;
  }
}

export const isTransactionRollbackOnlyError = (
  error: unknown,
): error is TransactionRollbackOnlyError => {
  return error instanceof TransactionRollbackOnlyError;
};

let decoratedClientIdCounter = 0;

const getActiveTransactionContext = (): TransactionContext | null => {
  return transactionContextStorage.getStore() ?? null;
};

const getActiveDatabaseAccessRule = (): DatabaseAccessRule | null => {
  return databaseAccessRuleStorage.getStore() ?? null;
};

const buildDatabaseAccessForbiddenMessage = (
  rule: DatabaseAccessRule,
  operation: 'query' | 'transaction',
  sql?: string,
): string => {
  const normalizedSql = stripLeadingSqlComments(sql ?? '').replace(/\s+/g, ' ').trim();
  const sqlPreview = normalizedSql ? `，SQL=${normalizedSql.slice(0, 120)}` : '';
  return `当前调用链禁止直接访问数据库: ${rule.label}（operation=${operation}${sqlPreview}）`;
};

const assertDatabaseAccessAllowed = (
  operation: 'query' | 'transaction',
  sql?: string,
): void => {
  const rule = getActiveDatabaseAccessRule();
  if (!rule) return;
  throw new Error(buildDatabaseAccessForbiddenMessage(rule, operation, sql));
};

const isUsableTransactionState = (
  state: ClientTransactionState | undefined,
): state is ClientTransactionState => {
  return state !== undefined && !state.released && state.depth > 0;
};

const getUsableTransactionContext = (): TransactionContext | null => {
  const context = getActiveTransactionContext();
  if (!context) return null;

  const decoratedClient = context.client as DecoratedPoolClient;
  const state = decoratedClient.__txState;
  if (!isUsableTransactionState(state)) {
    return null;
  }

  return context;
};

export const hasUsableTransactionContext = (): boolean => {
  return getUsableTransactionContext() !== null;
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

const buildErrorChain = (error: unknown, maxDepth = 8): ErrorChainEntry[] => {
  const chain: ErrorChainEntry[] = [];
  let current: unknown = error;
  let depth = 0;

  while (depth < maxDepth) {
    if (!(current instanceof Error)) {
      chain.push({
        name: 'NonError',
        message: String(current),
      });
      break;
    }

    chain.push({
      name: current.name || 'Error',
      message: current.message,
      stack: current.stack,
    });

    const cause = current.cause;
    if (!cause || cause === current) {
      break;
    }

    current = cause;
    depth += 1;
  }

  return chain;
};

const captureCallStack = (label: string): string | undefined => {
  return new Error(label).stack;
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
  state.rollbackOnly = false;
  state.rollbackCause = null;
  // 注意：不在这里清除 AsyncLocalStorage
  // AsyncLocalStorage 应该由 transactionContextStorage.run() 自动管理
  // 在这里清除可能会影响其他异步上下文
};

const normalizeClientStateOnCheckout = (state: ClientTransactionState): void => {
  if (state.depth > 0 || state.rollbackOnly) {
    console.error('错误：连接借出时检测到未完成事务状态，已强制重置', {
      clientId: state.clientId,
      depth: state.depth,
      rollbackOnly: state.rollbackOnly,
      checkoutCallStack: captureCallStack('连接借出时检测到未完成事务状态'),
    });
    resetClientTransactionState(state);
  }

  state.released = false;
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

const isPoolDoubleReleaseError = (error: unknown): error is Error => {
  return error instanceof Error && error.message.includes('already been released to the pool');
};

const safeInvokeRawRelease = (
  rawRelease: (err?: Error | boolean) => void,
  err: Error | boolean | undefined,
  clientId: number,
  releaseCallStack: string | undefined,
): void => {
  try {
    rawRelease(err);
  } catch (releaseError) {
    if (isPoolDoubleReleaseError(releaseError)) {
      console.warn('警告：检测到连接重复释放，已忽略本次释放异常', {
        clientId,
        releaseCallStack,
        releaseErrorMessage: releaseError.message,
      });
      return;
    }

    console.error('错误：底层连接释放失败，已阻止异常继续冒泡', {
      clientId,
      releaseCallStack,
      errorChain: buildErrorChain(releaseError),
    });
  }
};

const safeReleaseClient = (client: PoolClient): void => {
  try {
    client.release();
  } catch {
    // 释放失败通常是重复释放，不应覆盖主流程异常。
  }
};

const buildCheckedOutClientErrorLogLabel = (error: Error): string => {
  if (isTransientPgError(error)) {
    return '数据库连接在借出期间意外中断，当前查询将失败并由上层决定是否重试';
  }

  return '数据库连接在借出期间发生非预期异常';
};

const detachCheckedOutClientErrorListener = (client: DecoratedPoolClient): void => {
  const listener = client.__txCheckoutErrorListener;
  if (!listener) {
    return;
  }

  client.removeListener('error', listener);
  delete client.__txCheckoutErrorListener;
};

const attachCheckedOutClientErrorListener = (
  client: DecoratedPoolClient,
  state: ClientTransactionState,
): void => {
  detachCheckedOutClientErrorListener(client);

  const listener = (error: Error): void => {
    console.error(buildCheckedOutClientErrorLogLabel(error), {
      clientId: state.clientId,
      transactionDepth: state.depth,
      released: state.released,
      errorChain: buildErrorChain(error),
    });
  };

  client.__txCheckoutErrorListener = listener;
  client.on('error', listener);
};

const decoratePoolClient = (client: PoolClient): PoolClient => {
  const decoratedClient = client as DecoratedPoolClient;
  const rawQuery = (decoratedClient.__txRawQuery ?? client.query.bind(client)) as QueryCallable;
  // release 回调由 pg-pool 在每次 checkout 时重新绑定，不能跨 checkout 复用旧闭包。
  const rawRelease = client.release.bind(client) as (err?: Error | boolean) => void;
  const state: ClientTransactionState = decoratedClient.__txState ?? {
    depth: 0,
    released: false,
    rollbackOnly: false,
    rollbackCause: null,
    clientId: ++decoratedClientIdCounter,
  };

  decoratedClient.__txState = state;
  decoratedClient.__txRawQuery = rawQuery;
  normalizeClientStateOnCheckout(state);
  attachCheckedOutClientErrorListener(decoratedClient, state);

  client.query = ((...queryArgs: unknown[]) => {
    const sql = extractSqlTextFromQueryArgs(queryArgs);
    const normalizedCommand = normalizeCommandSql(sql);

    if (normalizedCommand === 'BEGIN' || normalizedCommand === 'START TRANSACTION') {
      if (state.depth <= 0) {
        return executeRawQueryAsPromise(rawQuery, 'BEGIN').then((result) => {
          state.depth = 1;
          state.rollbackOnly = false;
          state.rollbackCause = null;
          // 不在这里设置 AsyncLocalStorage
          // AsyncLocalStorage 应该只在 withTransaction 的 transactionContextStorage.run() 中管理
          return result;
        });
      }

      // 已在事务中：不再创建嵌套事务，直接视为 no-op。
      return Promise.resolve(createNoopQueryResult<QueryResultRow>('BEGIN'));
    }

    if (normalizedCommand === 'COMMIT' || normalizedCommand === 'END') {
      if (state.depth <= 0) {
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('COMMIT'));
      }

      return executeRawQueryAsPromise(rawQuery, 'COMMIT').then((result) => {
        resetClientTransactionState(state);
        return result;
      });
    }

    if (normalizedCommand === 'ROLLBACK') {
      if (state.depth <= 0) {
        return Promise.resolve(createNoopQueryResult<QueryResultRow>('ROLLBACK'));
      }

      return executeRawQueryAsPromise(rawQuery, 'ROLLBACK').then((result) => {
        resetClientTransactionState(state);
        return result;
      });
    }

    if (STRICT_WRITE_TRANSACTION && isWriteSql(sql) && state.depth <= 0) {
      return executeRawQueryAsPromise(rawQuery, 'BEGIN')
        .then(() => {
          state.depth = 1;
          // 不在这里设置 AsyncLocalStorage
          // AsyncLocalStorage 应该只在 withTransaction 的 transactionContextStorage.run() 中管理
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
    const releaseCallStack = captureCallStack('数据库连接 release 调用栈');

    if (state.released) {
      console.warn('警告：尝试重复释放连接', {
        clientId: state.clientId,
        depth: state.depth,
        releaseCallStack,
      });
      return;
    }

    // 标记为即将释放，防止并发调用
    state.released = true;
    detachCheckedOutClientErrorListener(decoratedClient);

    if (state.depth > 0) {
      // 如果事务还在进行中就被释放，这是一个错误
      console.error('错误：事务未结束就释放连接', {
        clientId: state.clientId,
        depth: state.depth,
        rollbackOnly: state.rollbackOnly,
        releaseCallStack,
      });
      // 尽力先回滚再释放，避免直接断连影响同调用链后续逻辑。
      void executeRawQueryAsPromise(rawQuery, 'ROLLBACK')
        .catch((rollbackError) => {
          console.error('错误：释放连接时回滚失败', {
            clientId: state.clientId,
            releaseCallStack,
            errorChain: buildErrorChain(rollbackError),
          });
        })
        .finally(() => {
          resetClientTransactionState(state);
          safeInvokeRawRelease(rawRelease, err, state.clientId, releaseCallStack);
        });
      return;
    }

    safeInvokeRawRelease(rawRelease, err, state.clientId, releaseCallStack);
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
    const context = getUsableTransactionContext();
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
  return getUsableTransactionContext()?.client ?? null;
};

/**
 * 当前调用链是否处于事务上下文中。
 */
export const isInTransaction = (): boolean => {
  return Boolean(getUsableTransactionContext());
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
  assertDatabaseAccessAllowed('query', sql);
  const context = getUsableTransactionContext();

  if (!context && STRICT_WRITE_TRANSACTION && sql && isWriteSql(sql)) {
    return executeWriteWithAutoTransaction(queryArgs, sql);
  }

  const runner = context
    ? (context.client.query.bind(context.client) as QueryCallable)
    : (pool.query.bind(pool) as QueryCallable);

  return executeQueryWithLogging(runner, queryArgs, sql);
}) as PgPool['query'];

const markRollbackOnlyIfNeeded = (client: PoolClient, cause: unknown): void => {
  const state = (client as DecoratedPoolClient).__txState;
  if (!state || state.rollbackOnly) {
    return;
  }
  state.rollbackOnly = true;
  state.rollbackCause = cause;
};

const throwIfRollbackOnly = (client: PoolClient): void => {
  const state = (client as DecoratedPoolClient).__txState;
  if (!state?.rollbackOnly) {
    return;
  }

  const causeMessage =
    state.rollbackCause instanceof Error
      ? `${state.rollbackCause.name}: ${state.rollbackCause.message}`
      : '未知错误';
  throw new TransactionRollbackOnlyError(
    `事务已标记为回滚：调用链中存在失败操作（${causeMessage}）`,
    state.rollbackCause,
  );
};

const runAfterCommitCallbacks = async (
  callbacks: TransactionAfterCommitCallback[],
): Promise<void> => {
  for (const callback of callbacks) {
    await callback();
  }
};

export const afterTransactionCommit = async (
  callback: TransactionAfterCommitCallback,
): Promise<void> => {
  const context = getUsableTransactionContext();
  if (!context) {
    await callback();
    return;
  }

  context.afterCommitCallbacks.push(callback);
};

/**
 * 自动事务执行器。
 *
 * 语义：
 * - 根调用：开启真实事务；
 * - 内层调用：复用当前事务，不创建子事务；
 * - 任一层失败都会将根事务标记为 rollback-only，最终统一回滚。
 */
export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  assertDatabaseAccessAllowed('transaction');
  const parentContext = getUsableTransactionContext();

  if (parentContext) {
    // 父上下文有效：直接复用同一事务连接，不创建嵌套事务。
    try {
      return await callback(parentContext.client);
    } catch (error) {
      // 内层一旦失败，即使上层捕获，也必须阻止根事务提交。
      markRollbackOnlyIfNeeded(parentContext.client, error);
      throw error;
    }
  }

  const client = await pool.connect();
  const rootContext: TransactionContext = {
    client,
    afterCommitCallbacks: [],
  };
  let committed = false;

  try {
    await client.query('BEGIN');
    const result = await transactionContextStorage.run(rootContext, async () => callback(client));
    throwIfRollbackOnly(client);
    await client.query('COMMIT');
    committed = true;
    await runAfterCommitCallbacks(rootContext.afterCommitCallbacks);
    return result;
  } catch (error) {
    console.error(`错误：根事务执行失败，准备${committed ? '释放连接' : '回滚并释放连接'}`, {
      errorChain: buildErrorChain(error),
      callStack: captureCallStack('withTransaction 根事务异常调用栈'),
    });
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('错误：根事务回滚失败', {
          errorChain: buildErrorChain(rollbackError),
          callStack: captureCallStack('withTransaction 根事务回滚失败调用栈'),
        });
        // 根事务回滚失败不覆盖主异常，主异常继续上抛。
      }
    }
    throw error;
  } finally {
    safeReleaseClient(client);
  }
};

/**
 * 智能事务执行器（自动检测事务上下文）
 *
 * 作用：
 * - 如果已在事务中，直接使用现有连接
 * - 如果不在事务中，创建新事务
 *
 * 使用场景：
 * - 服务函数既可能被独立调用（从路由），也可能被嵌套调用（从其他服务）
 * - 避免重复开启事务
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
  assertDatabaseAccessAllowed('transaction');
  const existingClient = getTransactionClient();

  // 如果已在事务中，直接使用现有连接
  if (existingClient) {
    return await callback(existingClient);
  }

  // 否则创建新事务
  return await withTransaction(callback);
};

export const runWithDatabaseAccessForbidden = async <T>(
  label: string,
  callback: () => T | Promise<T>,
): Promise<T> => {
  return await databaseAccessRuleStorage.run(
    { label },
    async () => await callback(),
  );
};

/**
 * 在当前异步子树中显式清除“禁止访问数据库”规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为后台微任务、定时器、延迟结算等真正需要落库的异步分支提供单一出口，避免上游禁 DB 规则继续污染子链路。
 * 2. 做什么：仅重置 `databaseAccessRuleStorage`，让后续 `query/withTransaction` 能按正常事务语义执行。
 * 3. 不做什么：不绕过事务约束，不替代权限校验，也不吞掉回调内部异常。
 *
 * 输入/输出：
 * - 输入：一个同步或异步回调。
 * - 输出：原样返回回调结果；若回调抛错，则继续向上抛出。
 *
 * 数据流/状态流：
 * - 外层请求链路可能先通过 `runWithDatabaseAccessForbidden` 打上禁 DB 标记。
 * - 需要落库的后台子任务调用本函数后，会在独立 AsyncLocalStorage 子树中把该标记重置为 `null`。
 * - 子任务内部继续创建的 Promise / timer 会继承“允许访问数据库”的上下文，避免再次命中禁 DB 拦截。
 *
 * 关键边界条件与坑点：
 * 1. 只能用于已经确认需要访问数据库的后台分支，不能拿来规避同步首包链路的禁 DB 约束。
 * 2. 该函数只清除数据库访问规则，不会创建事务；需要原子性时仍必须显式使用 `withTransaction` / `@Transactional`。
 */
export const runWithDatabaseAccessAllowed = async <T>(
  callback: () => T | Promise<T>,
): Promise<T> => {
  return await databaseAccessRuleStorage.run(
    null,
    async () => await callback(),
  );
};

export const isDatabaseAccessForbidden = (): boolean => {
  return getActiveDatabaseAccessRule() !== null;
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (retries >= maxRetries) {
        console.error('✗ 数据库连接失败，已达最大重试次数:', errorMessage);
        return false;
      }
      console.log(`✗ 数据库连接失败 (${errorMessage})，${delay / 1000}秒后重试 (${retries}/${maxRetries})...`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000); // 指数退避，最大 10 秒
    }
  }
  return false;
};
