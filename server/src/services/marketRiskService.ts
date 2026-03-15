/**
 * 坊市行为风控服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：记录坊市列表访问行为，按 userId 聚合最近访问频次与签名重复度，并在购买前判断是否需要验证码。
 * 2. 做什么：统一管理坊市验证码生成/校验与短时购买放行凭证，避免路由层重复拼 Redis key 与规则。
 * 3. 不做什么：不处理 HTTP 响应，不直接执行坊市购买，也不引入 IP/UA 维度。
 *
 * 输入/输出：
 * - 输入：userId、characterId、查询签名、验证码载荷。
 * - 输出：风险评估结果、验证码挑战、验证码通过后的购买放行过期时间。
 *
 * 数据流/状态流：
 * - 列表路由记录查询事件 -> Redis 保存最近访问轨迹；
 * - 购买守卫读取 Redis 指标 -> 纯规则评分；
 * - 若命中风险则要求坊市验证码 -> 验证成功后写入短时放行凭证 -> 后续购买路由放行。
 *
 * 关键边界条件与坑点：
 * 1. 列表查询接口当前只要求登录，不强制角色上下文，因此行为轨迹按 userId 聚合；购买放行凭证再按 userId + characterId 限定范围。
 * 2. 放行凭证是短时复用而不是永久放行，避免验证码通过后长时间绕过风控；同时也避免一次验证后因上架已售罄而立刻再次弹验证码。
 */
import { createHash, randomUUID } from 'node:crypto';

import { redis } from '../config/redis.js';
import {
  createCaptcha,
  type CaptchaChallenge,
} from './captchaService.js';
import {
  assessMarketPurchaseRisk,
  type MarketPurchaseRiskAssessment,
} from './shared/marketRiskRules.js';
import { verifyCaptchaByProvider } from '../shared/verifyCaptchaByProvider.js';
import type {
  CaptchaVerifyPayloadLike,
  TencentCaptchaVerifyPayloadLike,
} from '../shared/captchaVerifyPayload.js';

const MARKET_RISK_QUERY_SHORT_WINDOW_MS = 60_000;
const MARKET_RISK_QUERY_LONG_WINDOW_MS = 300_000;
const MARKET_RISK_QUERY_TRACK_TTL_MS = 900_000;
const MARKET_RISK_RECENT_TIMESTAMP_COUNT = 12;
const MARKET_RISK_PURCHASE_PASS_TTL_MS = 300_000;

const buildScopeKey = (userId: number): string => {
  return `market:risk:user:${String(userId)}`;
};

const buildQueryEventsKey = (userId: number): string => {
  return `${buildScopeKey(userId)}:queries`;
};

const buildSignatureEventsKey = (
  userId: number,
  signatureHash: string,
): string => {
  return `${buildScopeKey(userId)}:signature:${signatureHash}`;
};

const buildLastSignatureKey = (userId: number): string => {
  return `${buildScopeKey(userId)}:last-signature`;
};

const buildPurchasePassKey = (userId: number, characterId: number): string => {
  return `market:risk:pass:${String(userId)}:${String(characterId)}`;
};

const hashSignature = (signature: string): string => {
  return createHash('sha1').update(signature).digest('hex');
};

const buildEventMember = (occurredAt: number): string => {
  return `${String(occurredAt)}:${randomUUID()}`;
};

const parseSortedSetScores = (values: string[]): number[] => {
  const scores: number[] = [];
  for (let index = 1; index < values.length; index += 2) {
    const score = Number(values[index]);
    if (Number.isFinite(score)) {
      scores.push(Math.floor(score));
    }
  }
  return scores;
};

export interface RecordMarketRiskQueryAccessInput {
  userId: number;
  signature: string;
  occurredAt?: number;
}

export interface VerifyMarketPurchaseCaptchaInput {
  userId: number;
  characterId: number;
  payload: CaptchaVerifyPayloadLike & TencentCaptchaVerifyPayloadLike;
  userIp: string;
}

export interface MarketPurchaseCaptchaVerifyResult {
  passExpiresAt: number;
}

export const recordMarketRiskQueryAccess = async (
  input: RecordMarketRiskQueryAccessInput,
): Promise<void> => {
  const occurredAt = Number.isFinite(input.occurredAt)
    ? Math.floor(input.occurredAt ?? 0)
    : Date.now();
  const signatureHash = hashSignature(input.signature);
  const eventMember = buildEventMember(occurredAt);
  const queryEventsKey = buildQueryEventsKey(input.userId);
  const signatureEventsKey = buildSignatureEventsKey(
    input.userId,
    signatureHash,
  );
  const minScoreToKeep = occurredAt - MARKET_RISK_QUERY_LONG_WINDOW_MS;
  const transaction = redis.multi();

  transaction.zadd(queryEventsKey, occurredAt, eventMember);
  transaction.zremrangebyscore(queryEventsKey, 0, minScoreToKeep);
  transaction.pexpire(queryEventsKey, MARKET_RISK_QUERY_TRACK_TTL_MS);
  transaction.zadd(signatureEventsKey, occurredAt, eventMember);
  transaction.zremrangebyscore(signatureEventsKey, 0, minScoreToKeep);
  transaction.pexpire(signatureEventsKey, MARKET_RISK_QUERY_TRACK_TTL_MS);
  transaction.set(
    buildLastSignatureKey(input.userId),
    signatureHash,
    'PX',
    MARKET_RISK_QUERY_TRACK_TTL_MS,
  );

  await transaction.exec();
};

export const getMarketPurchaseRiskAssessment = async (params: {
  userId: number;
  nowMs?: number;
}): Promise<MarketPurchaseRiskAssessment> => {
  const nowMs = Number.isFinite(params.nowMs)
    ? Math.floor(params.nowMs ?? 0)
    : Date.now();
  const queryEventsKey = buildQueryEventsKey(params.userId);
  const lastSignatureHash = await redis.get(buildLastSignatureKey(params.userId));
  const lastSignatureEventsKey = lastSignatureHash
    ? buildSignatureEventsKey(params.userId, lastSignatureHash)
    : null;

  const [
    queryCount60sRaw,
    queryCount5mRaw,
    latestSignatureCount60sRaw,
    recentQueryWithScores,
  ] = await Promise.all([
    redis.zcount(
      queryEventsKey,
      nowMs - MARKET_RISK_QUERY_SHORT_WINDOW_MS,
      nowMs,
    ),
    redis.zcount(
      queryEventsKey,
      nowMs - MARKET_RISK_QUERY_LONG_WINDOW_MS,
      nowMs,
    ),
    lastSignatureEventsKey
      ? redis.zcount(
        lastSignatureEventsKey,
        nowMs - MARKET_RISK_QUERY_SHORT_WINDOW_MS,
        nowMs,
      )
      : Promise.resolve(0),
    redis.zrange(
      queryEventsKey,
      -MARKET_RISK_RECENT_TIMESTAMP_COUNT,
      -1,
      'WITHSCORES',
    ),
  ]);

  return assessMarketPurchaseRisk({
    queryCount60s: Number(queryCount60sRaw),
    queryCount5m: Number(queryCount5mRaw),
    latestSignatureCount60s: Number(latestSignatureCount60sRaw),
    recentQueryTimestamps: parseSortedSetScores(recentQueryWithScores),
  });
};

export const hasValidMarketPurchaseCaptchaPass = async (params: {
  userId: number;
  characterId: number;
}): Promise<boolean> => {
  const exists = await redis.exists(
    buildPurchasePassKey(params.userId, params.characterId),
  );
  return exists > 0;
};

export const createMarketPurchaseCaptchaChallenge =
  async (): Promise<CaptchaChallenge> => {
    return createCaptcha('market-risk');
  };

export const verifyMarketPurchaseCaptcha = async (
  input: VerifyMarketPurchaseCaptchaInput,
): Promise<MarketPurchaseCaptchaVerifyResult> => {
  await verifyCaptchaByProvider({
    body: input.payload,
    userIp: input.userIp,
    scene: 'market-risk',
  });
  const passExpiresAt = Date.now() + MARKET_RISK_PURCHASE_PASS_TTL_MS;
  await redis.set(
    buildPurchasePassKey(input.userId, input.characterId),
    '1',
    'PX',
    MARKET_RISK_PURCHASE_PASS_TTL_MS,
  );
  return { passExpiresAt };
};
