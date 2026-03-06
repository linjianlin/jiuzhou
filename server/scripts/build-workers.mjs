#!/usr/bin/env node
/**
 * Worker 构建脚本 - 开发环境专用
 *
 * 作用：
 *   在开发环境启动前，快速编译 worker 文件到 dist 目录
 *   解决 tsx 在 worker_threads 中无法正确处理 TypeScript 的问题
 *
 * 为什么需要这个脚本：
 *   tsx 的 --import 加载器在 worker 线程中无法正确解析 .js 到 .ts 的映射
 *   预编译 worker 文件是最简单可靠的解决方案
 *
 * 使用场景：
 *   仅在开发环境使用，生产环境通过正常的 tsc 构建流程处理
 */

import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('[build-workers] 正在编译 worker 文件...');

try {
  // 编译 worker 及其依赖到 dist 目录
  execSync(
    'npx tsc ' +
    'src/workers/idleBattleWorker.ts ' +
    'src/workers/techniqueGenerationWorker.ts ' +
    'src/workers/techniqueGenerationWorkerShared.ts ' +
    'src/services/idle/idleBattleSimulationCore.ts ' +
    'src/services/idle/types.ts ' +
    'src/services/shared/techniqueGenerationExecution.ts ' +
    '--outDir dist ' +
    '--module esnext ' +
    '--target es2022 ' +
    '--moduleResolution node ' +
    '--esModuleInterop ' +
    '--skipLibCheck ' +
    '--noCheck',
    {
      cwd: dirname(__dirname),
      stdio: 'inherit'
    }
  );

  console.log('[build-workers] ✓ Worker 文件编译完成');
} catch (error) {
  console.error('[build-workers] ✗ 编译失败:', error.message);
  process.exit(1);
}
