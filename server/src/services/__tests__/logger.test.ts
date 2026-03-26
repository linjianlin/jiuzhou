/**
 * 统一日志工具测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 logger 会输出彩色、可读的文本日志，并自动携带 scope/bindings，避免后续调用方又回退成纯 JSON 或散乱字符串日志。
 * 2. 做什么：锁定非法日志级别会回落到 info，保证环境变量配置错误时仍能稳定输出。
 * 3. 不做什么：不覆盖 pino 第三方库本身的全部行为，只验证本项目 logger 封装的契约。
 *
 * 输入/输出：
 * - 输入：自定义 writable destination、scope、bindings、日志调用。
 * - 输出：写入 destination 的彩色可读日志内容。
 *
 * 数据流/状态流：
 * createLogger -> pino-pretty 渲染
 * -> 写入内存流
 * -> 断言 scope、业务绑定、消息文本与 ANSI 颜色码是否齐全。
 *
 * 关键边界条件与坑点：
 * 1. 若 scope/bindings 没有被统一挂上，模块日志后续就无法按来源筛选。
 * 2. 若输出重新退回纯 JSON，终端慢日志排查时的可读性会明显下降，这个封装价值就丢了。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';

import { createLogger, createPinoConsole } from '../../utils/logger.js';

class MemoryWritable extends Writable {
  public readonly lines: string[] = [];

  _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    callback(null);
  }
}

test('createLogger: 应输出带 scope 与 bindings 的结构化日志', () => {
  const destination = new MemoryWritable();
  const battleLogger = createLogger({
    scope: 'battle.action',
    bindings: {
      battleId: 'battle-1',
      userId: 1,
    },
    level: 'info',
    destination,
  });

  battleLogger.info({ skillId: 'skill-normal-attack' }, '行动已提交');

  assert.equal(destination.lines.length, 1);
  const logLine = destination.lines[0] ?? '';
  assert.match(logLine, /\u001b\[[0-9;]*m/);
  assert.match(logLine, /\[battle\.action\] 行动已提交/);
  assert.match(logLine, /battleId:\s*"battle-1"/);
  assert.match(logLine, /userId:\s*1/);
  assert.match(logLine, /skillId:\s*"skill-normal-attack"/);
});

test('createLogger: 非法日志级别应回退到 info', () => {
  const destination = new MemoryWritable();
  const fallbackLogger = createLogger({
    scope: 'logger.test',
    level: 'invalid-level',
    destination,
  });

  fallbackLogger.info('fallback works');

  assert.equal(destination.lines.length, 1);
  const logLine = destination.lines[0] ?? '';
  assert.match(logLine, /\[logger\.test\] fallback works/);
  assert.doesNotMatch(logLine, /"level":/);
});

test('createPinoConsole: 应把 console 风格输出桥接到同一条 pretty 日志链路', () => {
  const destination = new MemoryWritable();
  const bridge = createPinoConsole({
    scope: 'console.test',
    destination,
    level: 'info',
  });

  bridge.info('[UserConnectionSlots] 用户进入排队', {
    activeCount: 1,
    queuedCount: 1,
    userId: 7007,
  });

  bridge.error('服务启动失败:', new Error('boom'));

  assert.equal(destination.lines.length, 2);

  const infoLine = destination.lines[0] ?? '';
  assert.match(infoLine, /\[console\.test\] \[UserConnectionSlots\] 用户进入排队/);
  assert.match(infoLine, /activeCount:\s*1/);
  assert.match(infoLine, /queuedCount:\s*1/);
  assert.match(infoLine, /userId:\s*7007/);

  const errorLine = destination.lines[1] ?? '';
  assert.match(errorLine, /\[console\.test\] 服务启动失败:/);
  assert.match(errorLine, /Error: boom/);
});
