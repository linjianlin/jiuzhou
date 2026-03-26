/**
 * Node 脚本 console 日志安装器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为直接由 `node` 执行的 `.mjs` 脚本提供与服务端一致的 pino-pretty console 输出。
 * 2. 做什么：把 `build-workers.mjs`、`prismaCli.mjs` 这类不经过 tsx/TS 入口的脚本也收敛到统一日志格式。
 * 3. 不做什么：不暴露业务 scope，不替换已经显式调用 pino 的脚本。
 *
 * 输入/输出：
 * - 输入：环境变量 `LOG_LEVEL`，以及脚本内已有的 `console.*` 调用。
 * - 输出：被桥接到 pino-pretty 的 `console.log/info/warn/error/debug/trace`。
 *
 * 数据流/状态流：
 * `.mjs` 入口 import 本模块 -> 安装全局 console 桥接
 * -> 脚本里的 `console.*` 统一进入 pino
 * -> pino-pretty 输出到 stdout。
 *
 * 关键边界条件与坑点：
 * 1. 该模块必须在 `.mjs` 入口最前面 import，否则更早执行的日志仍会绕过统一格式。
 * 2. 安装动作需要幂等，避免多个脚本共享子模块时重复覆盖 console。
 */

import dotenv from 'dotenv';
import pino from 'pino';
import pretty from 'pino-pretty';
import { formatWithOptions } from 'node:util';

dotenv.config();

const DEFAULT_LOG_LEVEL = 'info';
const CONSOLE_METHOD_NAMES = ['debug', 'error', 'info', 'log', 'trace', 'warn'];
const CONSOLE_METHOD_LEVEL_MAP = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  log: 'info',
  trace: 'trace',
  warn: 'warn',
};
const PINO_CONSOLE_INSTALLED_KEY = '__jiuzhouPinoConsoleInstalled__';

const normalizeLogLevel = (value) => {
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

const logger = pino(
  {
    level: normalizeLogLevel(process.env.LOG_LEVEL),
    base: undefined,
  },
  pretty({
    colorize: true,
    colorizeObjects: true,
    singleLine: true,
    sync: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname,scope',
    messageFormat: '{if scope}[{scope}] {end}{msg}',
  }),
);

const isStructuredLogObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
};

const formatConsoleArgs = (args) => {
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

const writeLog = (level, payload, message) => {
  switch (level) {
    case 'debug':
      logger.debug(payload, message);
      return;
    case 'error':
      logger.error(payload, message);
      return;
    case 'info':
      logger.info(payload, message);
      return;
    case 'trace':
      logger.trace(payload, message);
      return;
    case 'warn':
      logger.warn(payload, message);
      return;
    default:
      logger.info(payload, message);
  }
};

const logConsoleArgs = (level, args) => {
  if (args.length <= 0) {
    return;
  }

  if (args.length === 1 && args[0] instanceof Error) {
    writeLog(level, args[0], args[0].message);
    return;
  }

  if (args.length === 2 && typeof args[0] === 'string' && args[1] instanceof Error) {
    writeLog(level, args[1], args[0]);
    return;
  }

  if (args.length === 2 && typeof args[0] === 'string' && isStructuredLogObject(args[1])) {
    writeLog(level, args[1], args[0]);
    return;
  }

  if (args.length === 2 && isStructuredLogObject(args[0]) && typeof args[1] === 'string') {
    writeLog(level, args[0], args[1]);
    return;
  }

  writeLog(level, formatConsoleArgs(args));
};

if (!globalThis[PINO_CONSOLE_INSTALLED_KEY]) {
  for (const methodName of CONSOLE_METHOD_NAMES) {
    console[methodName] = (...args) => {
      logConsoleArgs(CONSOLE_METHOD_LEVEL_MAP[methodName], args);
    };
  }

  globalThis[PINO_CONSOLE_INSTALLED_KEY] = true;
}
