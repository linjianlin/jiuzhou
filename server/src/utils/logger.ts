/**
 * 服务端统一日志工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于 pino + pino-pretty 提供统一日志入口，收敛 `console.*` 的散落调用，保证 battle、dungeon、worker 等模块都能输出彩色、可读的日志。
 * 2. 做什么：支持按 scope 创建子 logger，让模块日志天然带上来源，便于后续筛选和聚合。
 * 3. 不做什么：不做日志持久化策略配置，也不引入“开发环境一种格式、生产环境另一种格式”的双轨分支；当前只提供统一的标准输出日志。
 *
 * 输入/输出：
 * - 输入：可选的 `scope`、额外 bindings、日志级别、以及测试时可注入的 destination。
 * - 输出：pino logger 实例；调用方可直接使用 `info/warn/error/debug` 等方法。
 *
 * 数据流/状态流：
 * 调用方 import root logger / createLogger
 * -> logger.child 叠加 scope 与上下文绑定
 * -> pino 产生日志对象
 * -> pino-pretty 统一渲染为彩色、可读文本
 * -> 输出到 stdout 或测试注入的 writable stream。
 *
 * 关键边界条件与坑点：
 * 1. 所有模块都必须走同一个 logger 工具，否则日志格式会重新分裂成 JSON、console 文本、pretty 文本混杂的状态。
 * 2. scope 需要同时保留“可筛选字段”和“可读前缀”两种价值，因此这里把它放进 messageFormat，而不是让调用方自己手拼字符串。
 */

import pino, {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from 'pino';
import pretty from 'pino-pretty';

type LogBindingValue = boolean | number | string | null | undefined;

export type LogBindings = Record<string, LogBindingValue>;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

type CreateLoggerOptions = {
  scope?: string;
  bindings?: LogBindings;
  level?: string;
  destination?: DestinationStream | NodeJS.WritableStream;
};

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

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
