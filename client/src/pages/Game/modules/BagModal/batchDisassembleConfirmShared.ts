import type { BagItem } from './bagShared';

/**
 * 背包批量分解确认共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把批量分解候选物品聚合成确认弹窗可直接消费的标题、摘要和名称列表。
 * 2. 做什么：集中维护“同名物品按总数量合并展示”的规则，避免桌面端与移动端各自遍历、各自拼文案。
 * 3. 不做什么：不筛选候选物品，不发起分解请求，也不处理弹窗开关状态。
 *
 * 输入 / 输出：
 * - 输入：已经通过批量分解筛选规则的 `BagItem[]`。
 * - 输出：确认弹窗标题、摘要，以及按首个出现顺序聚合后的名称条目列表。
 *
 * 数据流 / 状态流：
 * BagModal / MobileBagModal 已筛出的 batchCandidates -> 本模块聚合名称与数量 -> 确认弹窗内容组件渲染。
 *
 * 复用设计说明：
 * - 批量分解已经存在桌面端和移动端两个入口，名称聚合与确认文案属于同一条业务规则，必须集中到单一纯函数入口维护。
 * - 后续若背包新增侧边栏确认、聊天播报预览等入口，也可以继续复用本模块，避免再次复制 `Map` 聚合逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 同名物品可能来自不同实例或堆叠，确认列表必须先按名称聚合后再展示，否则批量分解候选一多就会出现重复刷屏。
 * 2. 名称列表顺序必须保持候选物品的首个命中顺序，不能二次排序，否则玩家看到的确认顺序会和当前筛选结果脱节。
 */

export interface BatchDisassembleConfirmEntry {
  name: string;
  qty: number;
  label: string;
}

export interface BatchDisassembleConfirmViewModel {
  title: string;
  summaryText: string;
  entries: BatchDisassembleConfirmEntry[];
}

export const buildBatchDisassembleConfirmViewModel = (
  items: BagItem[],
): BatchDisassembleConfirmViewModel => {
  const qtyByName = new Map<string, number>();
  let totalQty = 0;

  for (const item of items) {
    const itemName = item.name.trim();
    const itemQty = Math.max(1, Math.floor(item.qty));

    totalQty += itemQty;
    qtyByName.set(itemName, (qtyByName.get(itemName) ?? 0) + itemQty);
  }

  const entries = Array.from(qtyByName.entries(), ([name, qty]) => ({
    name,
    qty,
    label: qty > 1 ? `${name}×${qty}` : name,
  }));
  const itemKindCount = entries.length;

  return {
    title: '确认分解以下物品？',
    summaryText: `本次将分解 ${itemKindCount} 种物品，共 ${totalQty} 件。`,
    entries,
  };
};
