/**
 * 主线任务房间解析工具
 *
 * 作用：根据地图 + NPC 或当前任务节目标状态动态解析目标房间 ID。
 * 输入：mapId、npcId、当前状态、目标列表等。
 * 输出：解析后的 roomId 或 null。
 *
 * 复用点：progress（getMainQuestProgressLegacy）查询当前任务节时需要动态解析房间。
 *
 * 边界条件：
 * 1) objectives 阶段优先使用 reach 目标的 room_id，其余阶段优先通过 NPC 反查房间。
 * 2) mapId 或 npcId 为空时直接返回 null，不做无效查询。
 */
import { getRoomsInMap } from '../../mapService.js';
import { asString } from '../../shared/typeCoercion.js';
import type { SectionStatus, SectionObjectiveDto } from '../types.js';

/** 根据 mapId + npcId 查询 NPC 所在的房间 ID */
export const resolveNpcRoomId = async (mapId: string | null, npcId: string | null): Promise<string | null> => {
  const mid = asString(mapId).trim();
  const nid = asString(npcId).trim();
  if (!mid || !nid) return null;

  const rooms = await getRoomsInMap(mid);
  for (const room of rooms) {
    if (!Array.isArray(room.npcs) || room.npcs.length === 0) continue;
    if (room.npcs.includes(nid)) return room.id;
  }

  return null;
};

/** 根据任务节状态动态解析目标房间 */
export const resolveCurrentSectionRoomId = async (params: {
  status: SectionStatus;
  mapId: string | null;
  npcId: string | null;
  roomId: string | null;
  objectives: SectionObjectiveDto[];
}): Promise<string | null> => {
  const { status, mapId, npcId, roomId, objectives } = params;
  let effectiveRoomId = roomId;

  if (status === 'objectives') {
    const reachObj = objectives.find((objective) => {
      if (objective.type !== 'reach') return false;
      if (objective.done >= objective.target) return false;
      const rid = typeof objective.params?.room_id === 'string' ? objective.params.room_id.trim() : '';
      return rid.length > 0;
    });
    if (reachObj) {
      const rid = typeof reachObj.params?.room_id === 'string' ? reachObj.params.room_id.trim() : '';
      if (rid) effectiveRoomId = rid;
    }
    return effectiveRoomId;
  }

  if (status === 'not_started' || status === 'dialogue' || status === 'turnin') {
    const npcRoomId = await resolveNpcRoomId(mapId, npcId);
    if (npcRoomId) return npcRoomId;
  }

  return effectiveRoomId;
};
