import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireCharacter, getOptionalUserId } from '../middleware/auth.js';
import { getEnabledMaps, getMapDefById, getRoomInMap, getRoomsInMap, getWorldMap } from '../services/mapService.js';
import { roomObjectService } from '../services/roomObjectService.js';
import { getMonsterDefinitions } from '../services/staticConfigLoader.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { getSingleParam } from '../services/shared/httpParam.js';

const router = Router();

router.get('/world', async (_req: Request, res: Response) => {
  try {
    const data = await getWorldMap();
    res.json({ success: true, data });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/area/:area/objects', async (req: Request, res: Response) => {
  try {
    const area = getSingleParam(req.params.area) as Parameters<typeof roomObjectService.getAreaObjects>[0];
    const objects = await roomObjectService.getAreaObjects(area);
    res.json({ success: true, data: { area, objects } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/maps', async (_req: Request, res: Response) => {
  try {
    const maps = await getEnabledMaps();
    res.json({ success: true, data: { maps } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId', async (req: Request, res: Response) => {
  try {
    const mapId = getSingleParam(req.params.mapId);
    const map = await getMapDefById(mapId);
    if (!map || map.enabled !== true) {
      res.status(404).json({ success: false, message: '地图不存在' });
      return;
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

    res.json({ success: true, data: { map, rooms: enrichedRooms } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    const mapId = getSingleParam(req.params.mapId);
    const roomId = getSingleParam(req.params.roomId);
    const room = await getRoomInMap(mapId, roomId);
    if (!room) {
      res.status(404).json({ success: false, message: '房间不存在' });
      return;
    }
    res.json({ success: true, data: { mapId, room } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.get('/:mapId/rooms/:roomId/objects', async (req: Request, res: Response) => {
  try {
    const mapId = getSingleParam(req.params.mapId);
    const roomId = getSingleParam(req.params.roomId);
    const userId = getOptionalUserId(req);
    const objects = await roomObjectService.getRoomObjects(mapId, roomId, userId);
    res.json({ success: true, data: { mapId, roomId, objects } });
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.post('/:mapId/rooms/:roomId/resources/:resourceId/gather', requireCharacter, async (req: Request, res: Response) => {
  try {
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

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

router.post('/:mapId/rooms/:roomId/items/:itemDefId/pickup', requireCharacter, async (req: Request, res: Response) => {
  try {
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

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'mapRoutes 路由异常', error);
  }
});

export default router;
