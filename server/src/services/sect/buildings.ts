import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/database.js';
import { assertMember, hasPermission, toNumber } from './db.js';
import type { Result, SectBuildingRequirement, SectBuildingRow, SectBuildingView } from './types.js';

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

const FULLY_UPGRADED_MESSAGE = '建筑已满级';
const UPGRADE_CLOSED_MESSAGE = '暂未开放';
const BUILDING_MAX_LEVEL = 10;

const HALL_BUILDING_TYPE = 'hall';
const HALL_BUILDING_NAME = '宗门大殿';
const ONLY_HALL_UPGRADE_MESSAGE = '当前仅开放宗门大殿升级';

export const getBuildings = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: SectBuildingView[] }> => {
  try {
    const member = await assertMember(characterId);
    const res = await pool.query('SELECT * FROM sect_building WHERE sect_id = $1 ORDER BY building_type', [member.sectId]);
    return {
      success: true,
      message: 'ok',
      data: res.rows.map((row) => withBuildingRequirement(row as SectBuildingRow)),
    };
  } catch (error) {
    console.error('获取建筑失败:', error);
    return { success: false, message: '获取建筑失败' };
  }
};

const calcHallUpgradeCost = (currentLevel: number): { funds: number; buildPoints: number } => {
  const nextLevel = currentLevel + 1;
  return {
    funds: Math.floor(1000 * 1.2 * nextLevel * nextLevel),
    buildPoints: Math.floor(10 * nextLevel),
  };
};

export const getBuildingUpgradeRequirement = (buildingType: string, currentLevel: number): SectBuildingRequirement => {
  if (buildingType !== HALL_BUILDING_TYPE) {
    return {
      upgradable: false,
      maxLevel: BUILDING_MAX_LEVEL,
      nextLevel: null,
      funds: null,
      buildPoints: null,
      reason: UPGRADE_CLOSED_MESSAGE,
    };
  }

  if (currentLevel >= BUILDING_MAX_LEVEL) {
    return {
      upgradable: false,
      maxLevel: BUILDING_MAX_LEVEL,
      nextLevel: null,
      funds: null,
      buildPoints: null,
      reason: FULLY_UPGRADED_MESSAGE,
    };
  }

  const cost = calcHallUpgradeCost(currentLevel);
  return {
    upgradable: true,
    maxLevel: BUILDING_MAX_LEVEL,
    nextLevel: currentLevel + 1,
    funds: cost.funds,
    buildPoints: cost.buildPoints,
    reason: null,
  };
};

export const withBuildingRequirement = (building: SectBuildingRow): SectBuildingView => {
  const level = toNumber(building.level);
  return {
    ...building,
    level,
    requirement: getBuildingUpgradeRequirement(building.building_type, level),
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

  try {
    return await withTransaction(async (client) => {
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
      const currentLevel = toNumber(building.level);
      if (currentLevel >= BUILDING_MAX_LEVEL) {
        await client.query('ROLLBACK');
        return { success: false, message: FULLY_UPGRADED_MESSAGE };
      }
  
      const cost = calcHallUpgradeCost(currentLevel);
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
      await addLogTx(client, member.sectId, 'upgrade_building', characterId, null, `升级建筑：${HALL_BUILDING_NAME}`);
  return { success: true, message: '升级成功' };
    });
  } catch (error) {
console.error('升级建筑失败:', error);
    return { success: false, message: '升级建筑失败' };
  }
};
