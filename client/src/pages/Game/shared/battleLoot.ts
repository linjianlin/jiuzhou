/**
 * 战利分配文本工具。
 * 作用：统一“战利分配”日志的物品合并、文本格式化与文本解析，避免 BattleArea 与 ChatPanel 各自实现同一规则。
 * 不做什么：不负责战斗结算，不负责 UI 展示，仅处理纯文本与纯数据转换。
 * 输入/输出：
 * - 输入：掉落条目数组（物品名 + 数量）或单行战利分配文案。
 * - 输出：合并后的掉落条目数组、标准化战利分配文案、解析后的结构化数据。
 * 数据流：
 * - 战斗日志生成：结算条目 -> `buildBattleLootLine` -> 战况文本。
 * - 战斗日志统计：战况文本 -> `parseBattleLootLine` -> 统计维度聚合。
 * 关键边界条件与坑点：
 * 1) 同名物品要按首次出现顺序合并，避免“净灵石×1”连续重复刷屏。
 * 2) 解析时按最后一个“×数字”切分，兼容同一行多个物品（`、`分隔）。
 * 3) 非法数量或空名称条目会被忽略，防止脏日志污染统计。
 */

export interface BattleLootItemEntry {
  itemName: string;
  quantity: number;
}

export interface ParsedBattleLootLine {
  receiverName: string;
  items: BattleLootItemEntry[];
}

const BATTLE_LOOT_LINE_REGEXP = /^【战利分配】(.+?)\s+取走\s+(.+)$/;

const toPositiveInt = (value: number | string | null | undefined): number => {
  return Math.max(1, Math.floor(Number(value) || 1));
};

/**
 * 合并同名掉落并保持首次出现顺序。
 */
export const mergeBattleLootItems = (
  items: readonly BattleLootItemEntry[],
): BattleLootItemEntry[] => {
  const merged = new Map<string, BattleLootItemEntry>();
  for (const item of items) {
    const itemName = String(item.itemName || '').trim();
    if (!itemName) continue;
    const quantity = toPositiveInt(item.quantity);
    const prev = merged.get(itemName);
    if (prev) {
      prev.quantity += quantity;
      continue;
    }
    merged.set(itemName, { itemName, quantity });
  }
  return Array.from(merged.values());
};

/**
 * 将掉落条目格式化为 `物品×数量` 列表文本。
 */
export const formatBattleLootItemsText = (
  items: readonly BattleLootItemEntry[],
): string => {
  return mergeBattleLootItems(items)
    .map((item) => `${item.itemName}×${item.quantity}`)
    .join('、');
};

/**
 * 生成标准战利分配文案。
 */
export const buildBattleLootLine = (
  receiverName: string,
  items: readonly BattleLootItemEntry[],
): string => {
  const safeReceiverName = String(receiverName || '').trim() || '未知';
  return `【战利分配】${safeReceiverName} 取走 ${formatBattleLootItemsText(items)}`;
};

/**
 * 解析 `物品×数量、物品×数量` 文本。
 */
export const parseBattleLootItemsText = (
  rawItemText: string,
): BattleLootItemEntry[] => {
  const segments = String(rawItemText || '')
    .split('、')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const parsed: BattleLootItemEntry[] = [];
  for (const segment of segments) {
    const multiplyIndex = segment.lastIndexOf('×');
    if (multiplyIndex <= 0 || multiplyIndex >= segment.length - 1) continue;
    const itemName = segment.slice(0, multiplyIndex).trim();
    const qtyText = segment.slice(multiplyIndex + 1).trim();
    if (!itemName || !/^\d+$/.test(qtyText)) continue;
    parsed.push({ itemName, quantity: toPositiveInt(qtyText) });
  }
  return mergeBattleLootItems(parsed);
};

/**
 * 解析 `【战利分配】张三 取走 灵石×2、净灵石×1`。
 */
export const parseBattleLootLine = (
  line: string,
): ParsedBattleLootLine | null => {
  const match = BATTLE_LOOT_LINE_REGEXP.exec(String(line || '').trim());
  if (!match) return null;
  const receiverName = String(match[1] || '').trim() || '未知';
  const items = parseBattleLootItemsText(String(match[2] || '').trim());
  if (items.length <= 0) return null;
  return { receiverName, items };
};
