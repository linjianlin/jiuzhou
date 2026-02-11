import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';
import { createItem } from '../itemService.js';
import { assertMember, getCharacterUserId, toNumber } from './db.js';
import type { BuyResult, Result, ShopItem } from './types.js';

const SHOP: ShopItem[] = [
  { id: 'sect-shop-001', name: '淬灵石×10', costContribution: 100, itemDefId: 'enhance-001', qty: 10 },
  { id: 'sect-shop-002', name: '强化符·黄×1', costContribution: 120, itemDefId: 'enhance-003', qty: 1 },
  { id: 'sect-shop-003', name: '保护符×1', costContribution: 300, itemDefId: 'enhance-005', qty: 1 },
  { id: 'sect-shop-004', name: '《纯阳功》×1', costContribution: 2200, itemDefId: 'book-chunyang-gong', qty: 1 },
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

    await addLogTx(client, member.sectId, 'shop_buy', characterId, null, `购买：${shopItem.name}×${q}`);
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
