import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';
import { createItem } from '../itemService.js';
import { getItemDefinitionById } from '../staticConfigLoader.js';
import { assertMember, getCharacterUserId, toNumber } from './db.js';
import { recordSectShopBuyEventTx } from './quests.js';
import type { BuyResult, ShopItem } from './types.js';

const BAG_EXPAND_SHOP_ITEM_ID = 'sect-shop-007';
const BAG_EXPAND_DAILY_LIMIT = 1;
const REROLL_SCROLL_SHOP_ITEM_ID = 'sect-shop-008';
const REROLL_SCROLL_DAILY_LIMIT = 50;
type BaseShopItem = Omit<ShopItem, 'itemIcon'>;

/**
 * 统一商店日志展示名：
 * 若商品名末尾已带“×N”（且 N 等于单次发放数量），入库时移除该后缀，
 * 避免后续再拼接总数量时出现“×1×1”。
 */
const normalizeShopItemLogName = (name: string, unitQty: number): string => {
  const trimmed = String(name).trim();
  const qtyText = String(Math.max(1, Math.floor(unitQty)));
  const suffixPattern = new RegExp(`\\s*[xX×]\\s*${qtyText}$`);
  const cleaned = trimmed.replace(suffixPattern, '').trim();
  return cleaned || trimmed;
};

const escapeRegexLiteral = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const buildShopBuyLogContent = (itemName: string, totalQty: number): string => {
  return `购买：${itemName}×${totalQty}`;
};

const extractShopBuyItemQtyFromLogContent = (content: string, itemName: string): number => {
  const pattern = new RegExp(`^购买：\\s*${escapeRegexLiteral(itemName)}\\s*[xX×]\\s*(\\d+)\\s*$`);
  const matched = pattern.exec(String(content).trim());
  if (!matched) return 0;
  const qty = Number.parseInt(matched[1] ?? '0', 10);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return qty;
};

const resolveShopItemIcon = (itemDefId: string): string | null => {
  const rawIcon = getItemDefinitionById(itemDefId)?.icon;
  if (typeof rawIcon !== 'string') return null;
  const icon = rawIcon.trim();
  return icon.length > 0 ? icon : null;
};

const SHOP_BASE: BaseShopItem[] = [
  { id: 'sect-shop-001', name: '淬灵石×10', costContribution: 100, itemDefId: 'enhance-001', qty: 10 },
  { id: 'sect-shop-004', name: '《纯阳功》×1', costContribution: 2200, itemDefId: 'book-chunyang-gong', qty: 1 },
  { id: 'sect-shop-005', name: '功法残页×12', costContribution: 480, itemDefId: 'mat-gongfa-canye', qty: 12 },
  { id: 'sect-shop-006', name: '灵墨×5', costContribution: 1800, itemDefId: 'mat-lingmo', qty: 5 },
  {
    id: REROLL_SCROLL_SHOP_ITEM_ID,
    name: '洗炼符×1',
    costContribution: 1000,
    itemDefId: 'scroll-003',
    qty: 1,
    limitDaily: REROLL_SCROLL_DAILY_LIMIT,
  },
  {
    id: BAG_EXPAND_SHOP_ITEM_ID,
    name: '背包扩容符×1',
    costContribution: 10000,
    itemDefId: 'func-001',
    qty: 1,
    limitDaily: BAG_EXPAND_DAILY_LIMIT,
  },
];

const SHOP: ShopItem[] = SHOP_BASE.map((item) => ({
  ...item,
  // 统一按 itemDefId 补齐图标，前端无需再额外查表。
  itemIcon: resolveShopItemIcon(item.itemDefId),
}));

export const getSectShop = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: ShopItem[] }> => {
  try {
    await assertMember(characterId);
    return { success: true, message: 'ok', data: SHOP };
  } catch (error) {
    console.error('获取宗门商店失败:', error);
    return { success: false, message: '获取宗门商店失败' };
  }
};

const addLogTx = async (
  client: PoolClient,
  sectId: string,
  logType: string,
  operatorId: number | null,
  targetId: number | null,
  content: string
) => {
  await client.query(
    `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
    [sectId, logType, operatorId, targetId, content]
  );
};

export const buyFromSectShop = async (characterId: number, itemId: string, quantity: number): Promise<BuyResult> => {
  const q = Number.isFinite(quantity) && quantity > 0 ? Math.min(99, Math.floor(quantity)) : 1;
  const shopItem = SHOP.find((x) => x.id === itemId);
  if (!shopItem) return { success: false, message: '商品不存在' };
  const shopItemUnitQty = Math.max(1, Math.floor(shopItem.qty));
  const shopItemLogName = normalizeShopItemLogName(shopItem.name, shopItemUnitQty);
  const isBagExpandItem = shopItem.id === BAG_EXPAND_SHOP_ITEM_ID;
  const dailyLimitRaw = shopItem.limitDaily;
  const dailyLimit =
    typeof dailyLimitRaw === 'number' && Number.isInteger(dailyLimitRaw)
      ? Math.max(0, dailyLimitRaw)
      : 0;
  if (isBagExpandItem && q !== 1) return { success: false, message: '该商品每次仅可兑换1个' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const member = await assertMember(characterId, client);

    const userId = await getCharacterUserId(characterId, client);
    if (!userId) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }

    const memberRes = await client.query(
      `SELECT contribution FROM sect_member WHERE character_id = $1 FOR UPDATE`,
      [characterId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '未加入宗门' };
    }

    if (dailyLimit > 0) {
      const limitResult = await client.query(
        `
          SELECT content
          FROM sect_log
          WHERE sect_id = $1
            AND log_type = 'shop_buy'
            AND operator_id = $2
            AND created_at::date = CURRENT_DATE
        `,
        [member.sectId, characterId]
      );
      const usedToday = (limitResult.rows as Array<{ content: string | null }>).reduce((sum, row) => {
        const content = typeof row.content === 'string' ? row.content : '';
        const totalQty = extractShopBuyItemQtyFromLogContent(content, shopItemLogName);
        if (totalQty <= 0) return sum;
        return sum + Math.ceil(totalQty / shopItemUnitQty);
      }, 0);
      if (usedToday + q > dailyLimit) {
        await client.query('ROLLBACK');
        if (dailyLimit <= 1) {
          return { success: false, message: '该商品今日已兑换' };
        }
        const remain = Math.max(0, dailyLimit - usedToday);
        return { success: false, message: `该商品今日最多兑换${dailyLimit}个（剩余${remain}个）` };
      }
    }

    const contribution = toNumber(memberRes.rows[0].contribution);
    const cost = shopItem.costContribution * q;
    if (contribution < cost) {
      await client.query('ROLLBACK');
      return { success: false, message: '贡献不足' };
    }

    await client.query(`UPDATE sect_member SET contribution = contribution - $2 WHERE character_id = $1`, [characterId, cost]);

    const giveQty = shopItemUnitQty * q;
    const createRes = await createItem(userId, characterId, shopItem.itemDefId, giveQty, {
      location: 'bag',
      obtainedFrom: 'sect_shop',
      dbClient: client,
    });
    if (!createRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: createRes.message };
    }

    await recordSectShopBuyEventTx(client, characterId, q);

    const content = buildShopBuyLogContent(shopItemLogName, giveQty);
    await addLogTx(client, member.sectId, 'shop_buy', characterId, null, content);
    await client.query('COMMIT');
    return { success: true, message: '购买成功', itemDefId: shopItem.itemDefId, qty: giveQty, itemIds: createRes.itemIds };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('宗门商店购买失败:', error);
    return { success: false, message: '宗门商店购买失败' };
  } finally {
    client.release();
  }
};
