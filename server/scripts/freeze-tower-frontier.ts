#!/usr/bin/env tsx

/**
 * 推进千层塔冻结前沿。
 *
 * 用法：
 * pnpm --filter ./server exec tsx scripts/freeze-tower-frontier.ts --frozen-floor-max=80
 * pnpm --filter ./server exec tsx scripts/freeze-tower-frontier.ts 80
 */

import '../src/bootstrap/installConsoleLogger.js';
import { freezeTowerFrontier } from '../src/services/tower/freezeService.js';

const parseFrozenFloorMax = (argv: string[]): number => {
  for (const arg of argv) {
    if (arg.startsWith('--frozen-floor-max=')) {
      const parsed = Math.floor(Number(arg.slice('--frozen-floor-max='.length)));
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }

  const first = argv[0];
  const parsed = Math.floor(Number(first));
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  throw new Error('请提供合法的冻结前沿楼层，例如 --frozen-floor-max=80');
};

const main = async (): Promise<void> => {
  const frozenFloorMax = parseFrozenFloorMax(process.argv.slice(2));
  const result = await freezeTowerFrontier(frozenFloorMax);
  console.log(
    `千层塔冻结前沿已推进到 ${result.frozenFloorMax}，写入 ${result.snapshotCount} 条冻结怪物成员快照`,
  );
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : '推进千层塔冻结前沿失败');
  process.exitCode = 1;
});
