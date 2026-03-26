/**
 * 服务端统一日志工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于 pino + pino-pretty 提供统一日志入口，收敛 `console.*` 的散落调用，保证 battle、dungeon、worker、脚本入口都能输出彩色、可读的日志。
 * 2. 做什么：支持按 scope 创建子 logger，并可把全局 `console.*` 安装成同一条 pino 输出链路，避免主入口、worker、脚本各写一套格式化逻辑。
 * 3. 不做什么：不做日志持久化策略配置，也不引入“开发环境一种格式、生产环境另一种格式”的双轨分支；当前只提供统一的标准输出日志。
 *
 * 输入/输出：
 * - 输入：可选的 `scope`、额外 bindings、日志级别、测试时可注入的 destination，以及可选的 console 安装动作。
 * - 输出：pino logger 实例，或已经桥接到 pino 的 console 方法集合；调用方可直接使用 `info/warn/error/debug` 等方法。
 *
 * 数据流/状态流：
 * 调用方 import root logger / createLogger
 * -> logger.child 叠加 scope 与上下文绑定
 * -> pino 产生日志对象
 * -> pino-pretty 统一渲染为彩色、可读文本
 * -> 输出到 stdout 或测试注入的 writable stream
 * -> 需要统一旧 `console.*` 时，再由安装器把 console 方法转发到同一 logger。
 *
 * 关键边界条件与坑点：
 * 1. 所有模块都必须走同一个 logger 工具，否则日志格式会重新分裂成 JSON、console 文本、pretty 文本混杂的状态。
 * 2. scope 需要同时保留“可筛选字段”和“可读前缀”两种价值，因此这里把它放进 messageFormat，而不是让调用方自己手拼字符串。
 * 3. console 桥接必须在入口文件最早安装，才能覆盖后续 import 链路里的 `console.*` 输出；因此这里同时提供纯函数桥接器和 side-effect 安装器。
 */

import dotenv from 'dotenv';
import pino, {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from 'pino';
import pretty from 'pino-pretty';
import { formatWithOptions } from 'node:util';

dotenv.config();

type LogBindingValue = boolean | number | string | null | undefined;

export type LogBindings = Record<string, LogBindingValue>;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
type PinoConsoleLevel = Exclude<LogLevel, 'fatal'>;
type ConsoleMethodName = 'debug' | 'error' | 'info' | 'log' | 'trace' | 'warn';
type ConsoleMethod = (...args: unknown[]) => void;
type ConsoleBridge = Record<ConsoleMethodName, ConsoleMethod>;

type CreateLoggerOptions = {
  scope?: string;
  bindings?: LogBindings;
  level?: string;
  destination?: DestinationStream | NodeJS.WritableStream;
};

type CreatePinoConsoleOptions = CreateLoggerOptions & {
  logger?: PinoLogger;
};

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const CONSOLE_METHOD_NAMES: readonly ConsoleMethodName[] = [
  'debug',
  'error',
  'info',
  'log',
  'trace',
  'warn',
] as const;
const CONSOLE_METHOD_LEVEL_MAP: Record<ConsoleMethodName, PinoConsoleLevel> = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  log: 'info',
  trace: 'trace',
  warn: 'warn',
};
const PINO_CONSOLE_INSTALLED_KEY = '__jiuzhouPinoConsoleInstalled__';

const normalizeLogLevel = (value: string | undefined): LogLevel => {
  switch (value) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
      return value;
    default:
      return DEFAULT_LOG_LEVEL;
  }
};

const buildLoggerOptions = (level: LogLevel): PinoLoggerOptions => ({
  level,
  base: undefined,
});

const buildPrettyStream = (
  destination?: DestinationStream | NodeJS.WritableStream,
): DestinationStream => {
  return pretty({
    colorize: true,
    colorizeObjects: true,
    singleLine: true,
    sync: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname,scope',
    messageFormat: '{if scope}[{scope}] {end}{msg}',
    destination,
  });
};

const attachBindings = (
  baseLogger: PinoLogger,
  scope?: string,
  bindings?: LogBindings,
): PinoLogger => {
  if (scope && bindings) {
    return baseLogger.child({ scope, ...bindings });
  }
  if (scope) {
    return baseLogger.child({ scope });
  }
  if (bindings) {
    return baseLogger.child(bindings);
  }
  return baseLogger;
};

const isStructuredLogObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
};

const formatConsoleArgs = (args: readonly unknown[]): string => {
  return formatWithOptions(
    {
      breakLength: Infinity,
      colors: false,
      compact: true,
      depth: 6,
    },
    ...args,
  );
};

const writeLog = (
  baseLogger: PinoLogger,
  level: PinoConsoleLevel,
  payload: object | string,
  message?: string,
): void => {
  switch (level) {
    case 'debug':
      baseLogger.debug(payload, message);
      return;
    case 'error':
      baseLogger.error(payload, message);
      return;
    case 'info':
      baseLogger.info(payload, message);
      return;
    case 'trace':
      baseLogger.trace(payload, message);
      return;
    case 'warn':
      baseLogger.warn(payload, message);
      return;
  }
};

const logConsoleArgs = (
  baseLogger: PinoLogger,
  level: PinoConsoleLevel,
  args: readonly unknown[],
): void => {
  if (args.length <= 0) {
    return;
  }

  if (args.length === 1 && args[0] instanceof Error) {
    writeLog(baseLogger, level, args[0], args[0].message);
    return;
  }

  if (args.length === 2 && typeof args[0] === 'string' && args[1] instanceof Error) {
    writeLog(baseLogger, level, args[1], args[0]);
    return;
  }

  if (args.length === 2 && typeof args[0] === 'string' && isStructuredLogObject(args[1])) {
    writeLog(baseLogger, level, args[1], args[0]);
    return;
  }

  if (args.length === 2 && isStructuredLogObject(args[0]) && typeof args[1] === 'string') {
    writeLog(baseLogger, level, args[0], args[1]);
    return;
  }

  writeLog(baseLogger, level, formatConsoleArgs(args));
};

export const createLogger = (options: CreateLoggerOptions = {}): PinoLogger => {
  const level = normalizeLogLevel(options.level);
  const baseLogger = pino(buildLoggerOptions(level), buildPrettyStream(options.destination));
  return attachBindings(baseLogger, options.scope, options.bindings);
};

export const logger = createLogger({
  level: process.env.LOG_LEVEL,
});

export const createScopedLogger = (
  scope: string,
  bindings?: LogBindings,
): PinoLogger => {
  return attachBindings(logger, scope, bindings);
};

export const createPinoConsole = (
  options: CreatePinoConsoleOptions = {},
): ConsoleBridge => {
  const baseLogger = options.logger ?? createLogger(options);

  return {
    debug: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.debug, args);
    },
    error: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.error, args);
    },
    info: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.info, args);
    },
    log: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.log, args);
    },
    trace: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.trace, args);
    },
    warn: (...args: unknown[]): void => {
      logConsoleArgs(baseLogger, CONSOLE_METHOD_LEVEL_MAP.warn, args);
    },
  };
};

export const installPinoConsole = (
  options: CreatePinoConsoleOptions = {},
): void => {
  const globalState = globalThis as typeof globalThis & {
    [PINO_CONSOLE_INSTALLED_KEY]?: boolean;
  };
  if (globalState[PINO_CONSOLE_INSTALLED_KEY]) {
    return;
  }

  const bridge = createPinoConsole(options);
  const targetConsole = globalThis.console as Console & ConsoleBridge;

  for (const methodName of CONSOLE_METHOD_NAMES) {
    targetConsole[methodName] = bridge[methodName];
  }

  globalState[PINO_CONSOLE_INSTALLED_KEY] = true;
};
