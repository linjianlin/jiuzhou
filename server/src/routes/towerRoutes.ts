import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { parsePositiveInt, getSingleQueryValue } from '../services/shared/httpParam.js';
import { sendResult } from '../middleware/response.js';
import {
  getTowerOverview,
  getTowerRankList,
  startTowerChallenge,
} from '../services/tower/service.js';

const router = Router();

router.use(requireAuth);

router.get('/overview', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  return sendResult(res, await getTowerOverview(userId));
}));

router.post('/challenge/start', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  return sendResult(res, await startTowerChallenge(userId));
}));

router.get('/rank', asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  return sendResult(res, await getTowerRankList(limit));
}));

export default router;
