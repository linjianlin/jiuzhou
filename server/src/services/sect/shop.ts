import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';
import { createItem } from '../itemService.js';
import { assertMember, getCharacterUserId, toNumber } from './db.js';
import type { BuyResult, ShopItem } from './types.js';

const BAG_EXPAND_SHOP_ITEM_ID = 'sect-shop-007';
const BAG_EXPAND_DAILY_LIMIT = 1;

const buildShopLogMarker = (shopItemId: string): string => `[shop_item:${shopItemId}]`;

const SHOP: ShopItem[] = [
  { id: 'sect-shop-001', name: '淬灵石×10', costContribution: 100, itemDefId: 'enhance-001', qty: 10 },
  { id: 'sect-shop-002', name: '强化符·黄×1', costContribution: 120, itemDefId: 'enhance-003', qty: 1 },
  { id: 'sect-shop-003', name: '保护符×1', costContribution: 300, itemDefId: 'enhance-005', qty: 1 },
  { id: 'sect-shop-004', name: '《纯阳功》×1', costContribution: 2200, itemDefId: 'book-chunyang-gong', qty: 1 },
  { id: 'sect-shop-005', name: '功法残页×20', costContribution: 480, itemDefId: 'mat-gongfa-canye', qty: 20 },
  { id: 'sect-shop-006', name: '灵墨×5', costContribution: 1800, itemDefId: 'mat-lingmo', qty: 5 },
  {
    id: BAG_EXPAND_SHOP_ITEM_ID,
    name: '背包扩容符×1',
    costContribution: 10000,
    itemDefId: 'func-001',
    qty: 1,
    limitDaily: BAG_EXPAND_DAILY_LIMIT,
  },
];

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
  const isBagExpandItem = shopItem.id === BAG_EXPAND_SHOP_ITEM_ID;
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

    if (isBagExpandItem) {
      const marker = buildShopLogMarker(BAG_EXPAND_SHOP_ITEM_ID);
      const limitResult = await client.query(
        `
          SELECT COUNT(*)::int AS count
          FROM sect_log
          WHERE sect_id = $1
            AND log_type = 'shop_buy'
            AND operator_id = $2
            AND content LIKE $3
            AND created_at::date = CURRENT_DATE
        `,
        [member.sectId, characterId, `%${marker}%`]
      );
      const usedToday = toNumber(limitResult.rows[0]?.count);
      if (usedToday >= BAG_EXPAND_DAILY_LIMIT) {
        await client.query('ROLLBACK');
        return { success: false, message: '该商品今日已兑换' };
      }
    }

    const contribution = toNumber(memberRes.rows[0].contribution);
    const cost = shopItem.costContribution * q;
    if (contribution < cost) {
      await client.query('ROLLBACK');
      return { success: false, message: '贡献不足' };
    }

    await client.query(`UPDATE sect_member SET contribution = contribution - $2 WHERE character_id = $1`, [characterId, cost]);

    const giveQty = shopItem.qty * q;
    const createRes = await createItem(userId, characterId, shopItem.itemDefId, giveQty, {
      location: 'bag',
      obtainedFrom: 'sect_shop',
      dbClient: client,
    });
    if (!createRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: createRes.message };
    }

    const logMarker = buildShopLogMarker(shopItem.id);
    await addLogTx(client, member.sectId, 'shop_buy', characterId, null, `购买：${shopItem.name}×${q} ${logMarker}`);
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
