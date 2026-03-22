/**
 * 宗门经济服务
 *
 * 作用：处理宗门捐献相关功能
 * 不做：不处理路由层参数校验
 *
 * 数据流：
 * - 捐献：扣除角色灵石 → 增加宗门资金 → 增加个人贡献 → 记录任务进度 → 记录日志
 *
 * 边界条件：
 * 1) 捐献操作使用 @Transactional 保证原子性
 */
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { assertMember, toNumber } from './db.js';
import { invalidateSectInfoCache } from './cache.js';
import { recordSectDonateEventTx } from './quests.js';
import {
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
} from '../playerWritebackCacheService.js';
import type { DonateResult } from './types.js';

const SPIRIT_STONE_TO_CONTRIBUTION_RATIO = 10;

const loadSectEconomySpiritStones = async (characterId: number): Promise<number | null> => {
  const characterRow = await loadCharacterWritebackRowByCharacterId(characterId, { forUpdate: true });
  if (!characterRow) return null;
  return Math.max(0, Math.floor(toNumber(characterRow.spirit_stones)));
};

const spendSectEconomySpiritStones = async (
  characterId: number,
  currentSpiritStones: number,
  donatedSpiritStones: number,
): Promise<number> => {
  const nextSpiritStones = currentSpiritStones - donatedSpiritStones;
  await queueCharacterWritebackSnapshot(characterId, {
    spirit_stones: nextSpiritStones,
  });
  return nextSpiritStones;
};

/**
 * 宗门经济服务类
 *
 * 复用点：所有宗门捐献操作统一通过此服务类调用
 * 被调用位置：sectService.ts、sectRoutes.ts
 */
class SectEconomyService {
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
   * 捐献灵石
   */
  @Transactional
  async donate(characterId: number, spiritStones?: number): Promise<DonateResult> {
    const donatedSpiritStones = Number.isFinite(Number(spiritStones)) ? Math.max(0, Math.floor(Number(spiritStones))) : 0;
    if (donatedSpiritStones <= 0) return { success: false, message: '捐献数量不能为空' };

    const member = await assertMember(characterId);

    const curSpiritStones = await loadSectEconomySpiritStones(characterId);
    if (curSpiritStones === null) {
      return { success: false, message: '角色不存在' };
    }
    if (curSpiritStones < donatedSpiritStones) {
      return { success: false, message: '灵石不足' };
    }

    await spendSectEconomySpiritStones(characterId, curSpiritStones, donatedSpiritStones);

    const addedContribution = donatedSpiritStones * SPIRIT_STONE_TO_CONTRIBUTION_RATIO;
    const addedFunds = addedContribution;

    await query(
      `UPDATE sect_def SET funds = funds + $2, updated_at = NOW() WHERE id = $1`,
      [member.sectId, addedFunds]
    );
    await query(
      `UPDATE sect_member SET contribution = contribution + $2, weekly_contribution = weekly_contribution + $2 WHERE character_id = $1`,
      [characterId, addedContribution]
    );
    await recordSectDonateEventTx(characterId, donatedSpiritStones);

    const content = `捐献：灵石${donatedSpiritStones}（宗门资金+${addedFunds}，贡献+${addedContribution}）`;
    await this.addLog(member.sectId, 'donate', characterId, null, content);
    await invalidateSectInfoCache(member.sectId);
    return { success: true, message: '捐献成功', addedFunds, addedContribution };
  }
}

export const sectEconomyService = new SectEconomyService();

// 向后兼容的命名导出
export const donate = sectEconomyService.donate.bind(sectEconomyService);
