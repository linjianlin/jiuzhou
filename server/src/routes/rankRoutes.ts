import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { getArenaRanks, getPartnerRanks, getRankOverview, getRealmRanks, getSectRanks, getWealthRanks } from '../services/rankService.js';
import { getSingleQueryValue, parsePositiveInt } from '../services/shared/httpParam.js';
import { sendResult } from '../middleware/response.js';

const router = Router();


router.use(requireAuth);

router.get('/overview', asyncHandler(async (req, res) => {
  const limitPlayers = parsePositiveInt(getSingleQueryValue(req.query.limitPlayers)) ?? undefined;
  const limitSects = parsePositiveInt(getSingleQueryValue(req.query.limitSects)) ?? undefined;
  const result = await getRankOverview(limitPlayers, limitSects);
  return sendResult(res, result);
}));

router.get('/realm', asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  const result = await getRealmRanks(limit);
  return sendResult(res, result);
}));

router.get('/sect', asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  const result = await getSectRanks(limit);
  return sendResult(res, result);
}));

router.get('/wealth', asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  const result = await getWealthRanks(limit);
  return sendResult(res, result);
}));

router.get('/arena', asyncHandler(async (req, res) => {
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  const result = await getArenaRanks(limit);
  return sendResult(res, result);
}));

router.get('/partner', asyncHandler(async (req, res) => {
  const metric = getSingleQueryValue(req.query.metric);
  const limit = parsePositiveInt(getSingleQueryValue(req.query.limit)) ?? undefined;
  const result = await getPartnerRanks(metric, limit);
  return sendResult(res, result);
}));

export default router;
