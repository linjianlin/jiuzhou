/**
 * mailService 附件选项透传回归测试
 *
 * 作用：锁定邮件附件在读取时必须保留 metadata、quality、qualityRank，避免特殊物品补发后丢失展示信息。
 * 输入 / 输出：输入为 mail.attach_items 的原始 JSON 结构，输出为 `normalizeAttachItems` 规整后的附件数组。
 * 数据流：mail.attach_items -> normalizeAttachItems -> claimAttachments / 邮件列表消费。
 * 关键边界条件与坑点：生成功法书等特殊物品依赖 metadata 才能覆盖默认名称；quality/qualityRank 丢失后也会影响展示与堆叠语义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mailService, type MailAttachItem } from '../mailService.js';

test('normalizeAttachItems 应保留附件 options 里的 metadata 与品质字段', () => {
  const normalizeAttachItems = Reflect.get(
    mailService,
    'normalizeAttachItems',
  ) as (raw: ReadonlyArray<Record<string, object | string | number | null | undefined>>) => MailAttachItem[];

  const normalized = normalizeAttachItems([
    {
      item_def_id: 'book-generated-technique',
      qty: 1,
      options: {
        bindType: 'none',
        metadata: {
          generatedTechniqueId: 'tech-gen-mail-1',
          generatedTechniqueName: '太虚归元诀',
        },
        quality: '天',
        qualityRank: 4,
      },
    },
  ]);

  assert.deepEqual(normalized, [
    {
      item_def_id: 'book-generated-technique',
      item_name: undefined,
      qty: 1,
      options: {
        bindType: 'none',
        equipOptions: undefined,
        metadata: {
          generatedTechniqueId: 'tech-gen-mail-1',
          generatedTechniqueName: '太虚归元诀',
        },
        quality: '天',
        qualityRank: 4,
      },
    },
  ]);
});
