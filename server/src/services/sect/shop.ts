/**
 * 宗门商店服务
 *
 * 作用：处理宗门商店商品查询与购买功能
 * 不做：不处理路由层参数校验
 *
 * 数据流：
 * - 查询商店：返回商品列表（带图标）
 * - 购买商品：检查贡献 → 检查每日限购 → 扣除贡献 → 发放物品 → 记录任务进度 → 记录日志
 *
 * 边界条件：
 * 1) 购买操作使用 @Transactional 保证原子性
 * 2) 查询商店为纯读操作，不需要事务
 */
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { itemService } from '../itemService.js';
import { assertMember, getCharacterUserId, toNumber } from './db.js';
import { recordSectShopBuyEventTx } from './quests.js';
import { BAG_EXPAND_SHOP_ITEM_ID, SECT_SHOP_ITEMS } from './shopCatalog.js';
import type { BuyResult, ShopItem } from './types.js';

/**
 * 统一商店日志展示名：
 * 若商品名末尾已带"×N"（且 N 等于单次发放数量），入库时移除该后缀，
 * 避免后续再拼接总数量时出现"×1×1"。
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
const SHOP: ShopItem[] = SECT_SHOP_ITEMS;

/**
 * 宗门商店服务类
 *
 * 复用点：所有宗门商店操作统一通过此服务类调用
 * 被调用位置：sectService.ts、sectRoutes.ts
 */
class SectShopService {
  /**
   * 记录宗门日志（私有方法，仅在事务内调用）
   */
  private async addLog(
    sectId: string,
    logType: string,
    operatorId: number | null,
    targetId: number | null,
    content: string
  ): Promise<void> {
    await query(
      `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
      [sectId, logType, operatorId, targetId, content]
    );
  }

  /**
   * 获取宗门商店商品列表（纯读操作，不需要事务）
   */
  async getSectShop(
    characterId: number
  ): Promise<{ success: boolean; message: string; data?: ShopItem[] }> {
    await assertMember(characterId);
    return { success: true, message: 'ok', data: SHOP };
  }

  /**
   * 从宗门商店购买商品
   */
  @Transactional
  async buyFromSectShop(characterId: number, itemId: string, quantity: number): Promise<BuyResult> {
    const q = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
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

    const member = await assertMember(characterId);

    const userId = await getCharacterUserId(characterId);
    if (!userId) {
      return { success: false, message: '角色不存在' };
    }

    const memberRes = await query(
      `SELECT contribution FROM sect_member WHERE character_id = $1 FOR UPDATE`,
      [characterId]
    );
    if (memberRes.rows.length === 0) {
      return { success: false, message: '未加入宗门' };
    }

    if (dailyLimit > 0) {
      const limitResult = await query(
        `
          SELECT content
          FROM sect_log
          WHERE log_type = 'shop_buy'
            -- 限购按角色+日期统计，不按宗门隔离，避免通过退宗/换宗门重置次数。
            AND operator_id = $1
            AND created_at::date = CURRENT_DATE
        `,
        [characterId]
      );
      const usedToday = (limitResult.rows as Array<{ content: string | null }>).reduce((sum, row) => {
        const content = typeof row.content === 'string' ? row.content : '';
        const totalQty = extractShopBuyItemQtyFromLogContent(content, shopItemLogName);
        if (totalQty <= 0) return sum;
        return sum + Math.ceil(totalQty / shopItemUnitQty);
      }, 0);
      if (usedToday + q > dailyLimit) {
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
      return { success: false, message: '贡献不足' };
    }

    await query(`UPDATE sect_member SET contribution = contribution - $2 WHERE character_id = $1`, [characterId, cost]);

    const giveQty = shopItemUnitQty * q;
    const createRes = await itemService.createItem(userId, characterId, shopItem.itemDefId, giveQty, {
      location: 'bag',
      obtainedFrom: 'sect_shop',
    });
    if (!createRes.success) {
      return { success: false, message: createRes.message };
    }

    await recordSectShopBuyEventTx(characterId, q);

    const content = buildShopBuyLogContent(shopItemLogName, giveQty);
    await this.addLog(member.sectId, 'shop_buy', characterId, null, content);
    return { success: true, message: '购买成功', itemDefId: shopItem.itemDefId, qty: giveQty, itemIds: createRes.itemIds };
  }
}

export const sectShopService = new SectShopService();

// 向后兼容的命名导出
export const getSectShop = sectShopService.getSectShop.bind(sectShopService);
export const buyFromSectShop = sectShopService.buyFromSectShop.bind(sectShopService);
