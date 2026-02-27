import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/database.js';
import { assertMember, toNumber } from './db.js';
import { recordSectDonateEventTx } from './quests.js';
import type { DonateResult } from './types.js';

const SPIRIT_STONE_TO_CONTRIBUTION_RATIO = 10;

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

export const donate = async (characterId: number, spiritStones?: number): Promise<DonateResult> => {
  const donatedSpiritStones = Number.isFinite(Number(spiritStones)) ? Math.max(0, Math.floor(Number(spiritStones))) : 0;
  if (donatedSpiritStones <= 0) return { success: false, message: '捐献数量不能为空' };

  try {
    return await withTransaction(async (client) => {
  const member = await assertMember(characterId, client);
  
      const charRes = await client.query(`SELECT spirit_stones FROM characters WHERE id = $1 FOR UPDATE`, [characterId]);
      if (charRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '角色不存在' };
      }
      const curSpiritStones = toNumber(charRes.rows[0].spirit_stones);
      if (curSpiritStones < donatedSpiritStones) {
        await client.query('ROLLBACK');
        return { success: false, message: '灵石不足' };
      }
  
      await client.query(`UPDATE characters SET spirit_stones = spirit_stones - $2, updated_at = NOW() WHERE id = $1`, [
        characterId,
        donatedSpiritStones,
      ]);
  
      const addedContribution = donatedSpiritStones * SPIRIT_STONE_TO_CONTRIBUTION_RATIO;
      const addedFunds = addedContribution;
  
      await client.query(
        `UPDATE sect_def SET funds = funds + $2, updated_at = NOW() WHERE id = $1`,
        [member.sectId, addedFunds]
      );
      await client.query(
        `UPDATE sect_member SET contribution = contribution + $2, weekly_contribution = weekly_contribution + $2 WHERE character_id = $1`,
        [characterId, addedContribution]
      );
      await recordSectDonateEventTx(client, characterId, donatedSpiritStones);
  
      const content = `捐献：灵石${donatedSpiritStones}（宗门资金+${addedFunds}，贡献+${addedContribution}）`;
      await addLogTx(client, member.sectId, 'donate', characterId, null, content);
  return { success: true, message: '捐献成功', addedFunds, addedContribution };
    });
  } catch (error) {
console.error('捐献失败:', error);
    return { success: false, message: '捐献失败' };
  }
};
