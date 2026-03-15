import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { sendSuccess } from '../middleware/response.js';
import {
  bindPhoneNumber,
  getPhoneBindingStatus,
  sendPhoneBindingCode,
} from '../services/marketPhoneBindingService.js';

const router = Router();

router.get('/phone-binding/status', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const status = await getPhoneBindingStatus(userId);
  return sendSuccess(res, status);
}));

router.post('/phone-binding/send-code', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { phoneNumber } = req.body as { phoneNumber?: string };

  if (!phoneNumber || !phoneNumber.trim()) {
    throw new BusinessError('手机号不能为空');
  }

  const result = await sendPhoneBindingCode(userId, phoneNumber);
  return sendSuccess(res, result);
}));

router.post('/phone-binding/bind', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { phoneNumber, code } = req.body as { phoneNumber?: string; code?: string };

  if (!phoneNumber || !phoneNumber.trim()) {
    throw new BusinessError('手机号不能为空');
  }

  if (!code || !code.trim()) {
    throw new BusinessError('验证码不能为空');
  }

  const result = await bindPhoneNumber(userId, phoneNumber, code);
  return sendSuccess(res, result);
}));

export default router;
