/**
 * 服务端 console 日志安装器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在 Node 入口文件最早阶段把全局 `console.*` 桥接到统一的 pino + pino-pretty 输出链路。
 * 2. 做什么：让服务主入口、worker 入口、可直接运行的脚本共用同一套日志格式，而不是各自散落格式化规则。
 * 3. 不做什么：不负责定义业务 scope，不替换已经显式使用 `createScopedLogger` 的调用方。
 *
 * 输入/输出：
 * - 输入：无；复用 `utils/logger.ts` 中已经构建好的根 logger。
 * - 输出：全局 `console.log/info/warn/error/debug/trace` 被统一转发到 pino-pretty。
 *
 * 数据流/状态流：
 * 入口文件 import 本模块 -> installPinoConsole(logger)
 * -> 后续模块触发的 `console.*` 统一进入 root logger
 * -> pino-pretty 渲染后输出到 stdout。
 *
 * 关键边界条件与坑点：
 * 1. 该模块必须放在入口文件最前面的 import 位置，否则更早执行的模块初始化日志仍会绕过统一链路。
 * 2. 安装动作必须幂等，因为主入口与子脚本可能重复 import；重复安装不能重置 console 实现。
 */

import { installPinoConsole, logger } from '../utils/logger.js';

installPinoConsole({ logger });
