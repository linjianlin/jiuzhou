/**
 * characterItemGrantDeltaService 奖励透传回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证异步奖励 Delta 在写入 Redis 后，仍能把 metadata、quality、qualityRank 原样还原给待入包视图。
 * 2. 做什么：锁住“生成功法书依赖 metadata 覆盖默认名称”的链路，避免再次退化成《无名功法秘卷》。
 * 3. 不做什么：不连接真实 Redis、不执行真实 flush 入库，也不覆盖邮件领取等其他奖励入口。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、用户 ID，以及带 metadata/quality/qualityRank 的 buffered item grants。
 * - 输出：`loadCharacterPendingItemGrants` 返回的待入包奖励快照。
 *
 * 数据流 / 状态流：
 * grant -> bufferSimpleCharacterItemGrants -> Redis hash field(JSON payload) -> loadCharacterPendingItemGrants -> 断言字段是否完整。
 *
 * 复用设计说明：
 * 1. 用内存版 Redis mock 统一承接 `multi/hincrby/hgetall`，避免每个奖励回归测试各自拼一套散乱桩逻辑。
 * 2. 这里锁定的是高频变化点“奖励字段序列化协议”，后续所有依赖 pending grant overlay 的奖励展示都能复用这份保障。
 *
 * 关键边界条件与坑点：
 * 1. `afterTransactionCommit` 必须立即执行，否则测试会卡在“数据还没真正写入 Redis”这一层，无法稳定复现序列化问题。
 * 2. Redis hash field 本身就是 payload 序列化结果；只要 field 漏字段，读取阶段无法补救，因此断言必须直接覆盖 metadata 与品质字段。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { redis } from '../../config/redis.js';
import {
  bufferSimpleCharacterItemGrants,
  loadCharacterPendingItemGrants,
} from '../shared/characterItemGrantDeltaService.js';

test('bufferSimpleCharacterItemGrants 应保留 metadata 与品质字段到待入包奖励', async (t) => {
  const redisHashStore = new Map<string, Map<string, number>>();

  t.mock.method(redis, 'multi', () => {
    const operations: Array<() => void> = [];

    return {
      hincrby(key: string, field: string, qty: number) {
        operations.push(() => {
          const hash = redisHashStore.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + qty);
          redisHashStore.set(key, hash);
        });
        return this;
      },
      sadd() {
        return this;
      },
      async exec() {
        operations.forEach((operation) => operation());
        return [];
      },
    };
  });

  t.mock.method(redis, 'hgetall', async (key: string) => {
    const hash = redisHashStore.get(key);
    if (!hash) return {};
    return Object.fromEntries([...hash.entries()].map(([field, qty]) => [field, String(qty)]));
  });

  await bufferSimpleCharacterItemGrants(101, 202, [
    {
      itemDefId: 'book-generated-technique',
      qty: 1,
      obtainedFrom: 'technique_generate:gen-test-1',
      metadata: {
        generatedTechniqueId: 'tech-gen-test-1',
        generatedTechniqueName: '太虚归元诀',
      },
      quality: '天',
      qualityRank: 4,
    },
  ]);

  const pendingGrants = await loadCharacterPendingItemGrants(101);

  assert.deepEqual(pendingGrants, [
    {
      itemDefId: 'book-generated-technique',
      qty: 1,
      bindType: 'none',
      obtainedFrom: 'technique_generate:gen-test-1',
      idleSessionId: null,
      metadata: {
        generatedTechniqueId: 'tech-gen-test-1',
        generatedTechniqueName: '太虚归元诀',
      },
      quality: '天',
      qualityRank: 4,
    },
  ]);
});
