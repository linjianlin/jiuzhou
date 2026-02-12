import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';
import { assertMember, hasPermission, toNumber } from './db.js';
import type { Result, SectBuildingRow } from './types.js';

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

const HALL_BUILDING_TYPE = 'hall';
const ONLY_HALL_UPGRADE_MESSAGE = '当前仅开放宗门大殿升级';

export const getBuildings = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: SectBuildingRow[] }> => {
  try {
    const member = await assertMember(characterId);
    const res = await pool.query('SELECT * FROM sect_building WHERE sect_id = $1 ORDER BY building_type', [member.sectId]);
    return { success: true, message: 'ok', data: res.rows as any };
  } catch (error) {
    console.error('获取建筑失败:', error);
    return { success: false, message: '获取建筑失败' };
  }
};

const buildingMaxLevel = 10;

const calcHallUpgradeCost = (currentLevel: number): { funds: number; buildPoints: number } => {
  const nextLevel = currentLevel + 1;
  return {
    funds: Math.floor(1000 * 1.2 * nextLevel * nextLevel),
    buildPoints: Math.floor(10 * nextLevel),
  };
};

const applyHallMemberCapTx = async (client: PoolClient, sectId: string): Promise<void> => {
  const hallRes = await client.query(
    `SELECT level FROM sect_building WHERE sect_id = $1 AND building_type = $2`,
    [sectId, HALL_BUILDING_TYPE]
  );
  const hallLevel = hallRes.rows.length > 0 ? toNumber(hallRes.rows[0].level) : 1;
  const cap = 20 + Math.max(0, hallLevel - 1) * 5;
  await client.query('UPDATE sect_def SET max_members = $2, updated_at = NOW() WHERE id = $1', [sectId, cap]);
};

export const upgradeBuilding = async (characterId: number, buildingType: string): Promise<Result> => {
  if (buildingType !== HALL_BUILDING_TYPE) {
    return { success: false, message: ONLY_HALL_UPGRADE_MESSAGE };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const member = await assertMember(characterId, client);
    if (!hasPermission(member.position, 'building')) {
      await client.query('ROLLBACK');
      return { success: false, message: '无权限升级建筑' };
    }

    const buildingRes = await client.query(
      `SELECT * FROM sect_building WHERE sect_id = $1 AND building_type = $2 FOR UPDATE`,
      [member.sectId, HALL_BUILDING_TYPE]
    );
    if (buildingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '建筑不存在' };
    }

    const building = buildingRes.rows[0] as SectBuildingRow;
    if (building.level >= buildingMaxLevel) {
      await client.query('ROLLBACK');
      return { success: false, message: '建筑已满级' };
    }

    const cost = calcHallUpgradeCost(building.level);
    const sectRes = await client.query(`SELECT funds, build_points FROM sect_def WHERE id = $1 FOR UPDATE`, [member.sectId]);
    if (sectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门不存在' };
    }
    const funds = toNumber(sectRes.rows[0].funds);
    const buildPoints = toNumber(sectRes.rows[0].build_points);
    if (funds < cost.funds) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门资金不足' };
    }
    if (buildPoints < cost.buildPoints) {
      await client.query('ROLLBACK');
      return { success: false, message: '建设点不足' };
    }

    await client.query(
      `UPDATE sect_def SET funds = funds - $2, build_points = build_points - $3, updated_at = NOW() WHERE id = $1`,
      [member.sectId, cost.funds, cost.buildPoints]
    );
    await client.query(
      `UPDATE sect_building SET level = level + 1, updated_at = NOW() WHERE id = $1`,
      [building.id]
    );

    await applyHallMemberCapTx(client, member.sectId);
    await addLogTx(client, member.sectId, 'upgrade_building', characterId, null, `升级建筑：${HALL_BUILDING_TYPE}`);

    await client.query('COMMIT');
    return { success: true, message: '升级成功' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('升级建筑失败:', error);
    return { success: false, message: '升级建筑失败' };
  } finally {
    client.release();
  }
};
