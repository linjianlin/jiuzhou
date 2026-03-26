#!/usr/bin/env tsx
/**
 * 给角色发放所有功法书脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1) 读取 item_def.json 中所有 sub_category=technique_book 的功法书
 * 2) 将这些功法书发放到指定角色的背包中
 *
 * 输入/输出：
 * - 输入：CLI 参数 characterId（默认 1）
 * - 输出：打印成功/失败信息
 *
 * 数据流/状态流：
 * 解析参数 -> 加载 item_def.json -> 过滤功法书 -> 逐个发放 -> 汇总结果
 */
import '../src/bootstrap/installConsoleLogger.js';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// 加载环境变量
dotenv.config();

// 加载静态配置
const seedPath = resolve(process.cwd(), 'src/data/seeds/item_def.json');
const itemDefData = JSON.parse(readFileSync(seedPath, 'utf-8'));
const techniqueBooks = itemDefData.items.filter(
  (item: any) => item.sub_category === 'technique_book' && item.enabled !== false
);

// 目标角色 ID（默认 1）
const targetCharacterId = parseInt(process.argv[2] || '1', 10);

console.log(`=== 发放所有功法书给角色 ${targetCharacterId} ===`);
console.log(`共找到 ${techniqueBooks.length} 本功法书\n`);

// 使用 inventoryService（带 @Transactional 事务支持）
const { inventoryService } = await import('../src/services/inventory/service.js');
const { query } = await import('../src/config/database.js');

// 需要获取 userId（从 character 表查询）
const charResult = await query(
  'SELECT user_id FROM characters WHERE id = $1',
  [targetCharacterId]
);

if (charResult.rows.length === 0) {
  console.error(`错误：角色 ${targetCharacterId} 不存在`);
  process.exit(1);
}

const userId = charResult.rows[0].user_id;
console.log(`角色 ${targetCharacterId} 的 userId: ${userId}\n`);

let successCount = 0;
let failCount = 0;

for (const book of techniqueBooks) {
  const result = await inventoryService.addItemToInventory(targetCharacterId, userId, book.id, 1, {
    location: 'bag',
    bindType: book.bind_type || 'none',
    obtainedFrom: 'script:give-all-technique-books',
  });

  if (result.success) {
    console.log(`✓ ${book.name} (${book.id})`);
    successCount++;
  } else {
    console.log(`✗ ${book.name} (${book.id}) - ${result.message}`);
    failCount++;
  }
}

console.log(`\n=== 完成 ===`);
console.log(`成功: ${successCount}, 失败: ${failCount}`);
