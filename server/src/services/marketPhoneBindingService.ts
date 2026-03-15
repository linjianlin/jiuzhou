import { redis } from '../config/redis.js';
import { query } from '../config/database.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  sendAliyunSmsVerificationCode,
  verifyAliyunSmsVerificationCode,
} from './aliyunSmsVerificationService.js';
import { MARKET_PHONE_BINDING_CONFIG } from './marketPhoneBindingConfig.js';
import { maskPhoneNumber, normalizeMainlandPhoneNumber } from './shared/phoneNumber.js';

/**
 * 坊市手机号绑定服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理手机号绑定状态读取、验证码发送、验证码校验和最终写库逻辑。
 * 2. 做什么：把 `users.phone_number` 的账号级绑定口径与 Redis 发送冷却统一收敛，供账号接口和坊市守卫复用。
 * 3. 不做什么：不处理 HTTP 响应，不直接挂载路由，也不负责前端倒计时展示。
 *
 * 输入/输出：
 * - 输入：用户 ID、手机号、验证码。
 * - 输出：绑定状态 DTO、发送成功结果、绑定成功后的脱敏手机号。
 *
 * 数据流/状态流：
 * 账号接口/坊市守卫 -> 本服务 -> 读配置/Redis/数据库 -> 返回状态或抛业务异常。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `users.phone_number` 是最终真值来源；验证码真值由阿里云生成并核验，服务端本地只保留发送冷却，不保留验证码明文。
 * 2. 同一规则会被账号页和坊市守卫复用，因此“是否开启”“是否已绑定”“手机号唯一性”必须集中在本服务，不能在路由层重复判断。
 */

type UserPhoneBindingRow = {
  phone_number: string | null;
};

export type PhoneBindingStatusDto = {
  enabled: boolean;
  isBound: boolean;
  maskedPhoneNumber: string | null;
};

type SendPhoneBindingCodeResult = {
  cooldownSeconds: number;
};

type BindPhoneNumberResult = {
  maskedPhoneNumber: string;
};

const buildCooldownKey = (userId: number): string => `market:phone-binding:cooldown:${userId}`;

const assertFeatureEnabled = (): void => {
  if (!MARKET_PHONE_BINDING_CONFIG.enabled) {
    throw new BusinessError('坊市手机号绑定功能未开启');
  }
};

const getUserPhoneBindingRow = async (userId: number): Promise<UserPhoneBindingRow | null> => {
  const result = await query(
    'SELECT phone_number FROM users WHERE id = $1 LIMIT 1',
    [userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as UserPhoneBindingRow;
};

const assertUserExists = async (userId: number): Promise<UserPhoneBindingRow> => {
  const row = await getUserPhoneBindingRow(userId);
  if (!row) {
    throw new BusinessError('账号不存在', 404);
  }
  return row;
};

const assertPhoneNotBoundByOtherUser = async (userId: number, phoneNumber: string): Promise<void> => {
  const result = await query(
    'SELECT id FROM users WHERE phone_number = $1 AND id <> $2 LIMIT 1',
    [phoneNumber, userId],
  );
  if (result.rows.length > 0) {
    throw new BusinessError('该手机号已绑定其他账号');
  }
};

const assertPhoneBindingWritable = async (userId: number, phoneNumber: string): Promise<void> => {
  const user = await assertUserExists(userId);
  const currentPhone = user.phone_number;

  if (currentPhone && currentPhone !== phoneNumber) {
    throw new BusinessError('当前账号已绑定其他手机号，暂不支持换绑');
  }

  await assertPhoneNotBoundByOtherUser(userId, phoneNumber);
};

export const getPhoneBindingStatus = async (userId: number): Promise<PhoneBindingStatusDto> => {
  const user = await assertUserExists(userId);
  const phoneNumber = user.phone_number;

  return {
    enabled: MARKET_PHONE_BINDING_CONFIG.enabled,
    isBound: typeof phoneNumber === 'string' && phoneNumber.length > 0,
    maskedPhoneNumber: phoneNumber ? maskPhoneNumber(phoneNumber) : null,
  };
};

export const sendPhoneBindingCode = async (
  userId: number,
  rawPhoneNumber: string,
): Promise<SendPhoneBindingCodeResult> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeMainlandPhoneNumber(rawPhoneNumber);
  await assertPhoneBindingWritable(userId, phoneNumber);

  const cooldownKey = buildCooldownKey(userId);
  const cooldownTtl = await redis.ttl(cooldownKey);
  if (cooldownTtl > 0) {
    throw new BusinessError(`验证码发送过于频繁，请${cooldownTtl}秒后重试`);
  }

  await sendAliyunSmsVerificationCode(phoneNumber);

  await redis.set(
    cooldownKey,
    phoneNumber,
    'EX',
    MARKET_PHONE_BINDING_CONFIG.sendCooldownSeconds,
  );

  return {
    cooldownSeconds: MARKET_PHONE_BINDING_CONFIG.sendCooldownSeconds,
  };
};

export const bindPhoneNumber = async (
  userId: number,
  rawPhoneNumber: string,
  verificationCode: string,
): Promise<BindPhoneNumberResult> => {
  assertFeatureEnabled();

  const phoneNumber = normalizeMainlandPhoneNumber(rawPhoneNumber);
  const normalizedCode = verificationCode.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new BusinessError('验证码格式错误');
  }

  await assertPhoneBindingWritable(userId, phoneNumber);

  const verified = await verifyAliyunSmsVerificationCode(phoneNumber, normalizedCode);
  if (!verified) {
    throw new BusinessError('验证码错误');
  }

  await query(
    'UPDATE users SET phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [phoneNumber, userId],
  );

  return {
    maskedPhoneNumber: maskPhoneNumber(phoneNumber),
  };
};

export const assertMarketPhoneBindingReady = async (userId: number): Promise<void> => {
  if (!MARKET_PHONE_BINDING_CONFIG.enabled) return;

  const user = await assertUserExists(userId);
  if (user.phone_number) {
    return;
  }

  throw new BusinessError('使用坊市功能前请先绑定手机号', 403);
};
