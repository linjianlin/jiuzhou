import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter, getOptionalUserId } from '../middleware/auth.js';
import { getEnabledMaps, getMapDefById, getRoomInMap, getRoomsInMap, getWorldMap, isMapEnabled } from '../services/mapService.js';
import { roomObjectService } from '../services/roomObjectService.js';
import { getMonsterDefinitions } from '../services/staticConfigLoader.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { getSingleParam } from '../services/shared/httpParam.js';
import { sendSuccess, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';

const router = Router();

router.get('/world', asyncHandler(async (_req, res) => {
  const data = await getWorldMap();
  sendSuccess(res, data);
}));

router.get('/maps', asyncHandler(async (_req, res) => {
  const maps = await getEnabledMaps();
  sendSuccess(res, { maps });
}));

router.get('/:mapId', asyncHandler(async (req, res) => {
  const mapId = getSingleParam(req.params.mapId);
  const map = await getMapDefById(mapId);
  if (!isMapEnabled(map)) {
    throw new BusinessError('地图不存在', 404);
  }
  const rooms = await getRoomsInMap(mapId);

  // 注入怪物中文名：构建 id→name 映射，给每个 room.monsters 条目追加 name 字段
  const monsterDefs = getMonsterDefinitions();
  const monsterNameMap = new Map(monsterDefs.map((m) => [m.id, m.name]));
  const enrichedRooms = rooms.map((r) => ({
    ...r,
    monsters: r.monsters?.map((m) => ({
      ...m,
      name: monsterNameMap.get(m.monster_def_id) ?? m.monster_def_id,
    })),
  }));

  sendSuccess(res, { map, rooms: enrichedRooms });
}));

router.get('/:mapId/rooms/:roomId', asyncHandler(async (req, res) => {
  const mapId = getSingleParam(req.params.mapId);
  const roomId = getSingleParam(req.params.roomId);
  const room = await getRoomInMap(mapId, roomId);
  if (!room) {
    throw new BusinessError('房间不存在', 404);
  }
  sendSuccess(res, { mapId, room });
}));

router.get('/:mapId/rooms/:roomId/objects', asyncHandler(async (req, res) => {
  const mapId = getSingleParam(req.params.mapId);
  const roomId = getSingleParam(req.params.roomId);
  const userId = getOptionalUserId(req);
  const objects = await roomObjectService.getRoomObjects(mapId, roomId, userId);
  sendSuccess(res, { mapId, roomId, objects });
}));

router.post('/:mapId/rooms/:roomId/resources/:resourceId/gather', requireCharacter, asyncHandler(async (req, res) => {
  const mapId = getSingleParam(req.params.mapId);
  const roomId = getSingleParam(req.params.roomId);
  const resourceId = getSingleParam(req.params.resourceId);
  const userId = req.userId!;
  const characterId = req.characterId!;

  const result = await roomObjectService.gatherRoomResource({ mapId, roomId, resourceId, userId, characterId });

  const didGain = Boolean(result.success && result.data && typeof result.data.qty === 'number' && result.data.qty > 0);
  if (didGain) {
    await safePushCharacterUpdate(userId);
  }

  return sendResult(res, result);
}));

router.post('/:mapId/rooms/:roomId/items/:itemDefId/pickup', requireCharacter, asyncHandler(async (req, res) => {
  const mapId = getSingleParam(req.params.mapId);
  const roomId = getSingleParam(req.params.roomId);
  const itemDefId = getSingleParam(req.params.itemDefId);
  const userId = req.userId!;
  const characterId = req.characterId!;

  const result = await roomObjectService.pickupRoomItem({ mapId, roomId, itemDefId, userId, characterId });

  const didGain = Boolean(result.success && result.data && typeof result.data.qty === 'number' && result.data.qty > 0);
  if (didGain) {
    await safePushCharacterUpdate(userId);
  }

  return sendResult(res, result);
}));

export default router;
