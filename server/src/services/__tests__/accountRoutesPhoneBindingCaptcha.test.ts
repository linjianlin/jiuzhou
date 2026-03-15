/**
 * 账号手机号绑定发送验证码图片校验测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定手机号绑定“发送短信验证码”入口必须先提交图片验证码，避免前端加了表单后服务端入口仍可被绕过。
 * 2. 做什么：验证缺少图片验证码时会在路由层直接拦截，不会继续进入短信发送服务。
 * 3. 不做什么：不验证真实短信发送、数据库写入或手机号最终绑定流程。
 *
 * 输入/输出：
 * - 输入：挂载了 `accountRoutes` 的最小 Express 应用、带登录态的请求头，以及缺少图片验证码字段的发送请求体。
 * - 输出：标准 JSON 业务错误响应。
 *
 * 数据流/状态流：
 * - 测试先挂载账号路由与错误处理中间件；
 * - 再 mock 手机号绑定发送服务，确保若路由未拦截就会落到假服务；
 * - 最后发送缺少图片验证码字段的请求并断言返回 400。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“发送短信验证码入口必须校验图片验证码”，不是短信服务实现本身，所以不需要连真实数据库或阿里云。
 * 2. 只收紧发送验证码入口，确认绑定接口不在本测试范围内，避免把本次需求扩大成双重验证码。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';

import { redis } from '../../config/redis.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import accountRoutes from '../../routes/accountRoutes.js';

type JsonResponse = {
  status: number;
  body: {
    success: boolean;
    message: string;
  };
};

const TEST_AUTH_TOKEN = jwt.sign(
  { id: 7, username: 'tester', sessionToken: 'phone-binding-test-session' },
  process.env.JWT_SECRET || 'jiuzhou-xiuxian-secret-key',
);

const createAccountTestApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/account', accountRoutes);
  app.use(errorHandler);
  return app;
};

const startServer = async (app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};

const postJson = async (
  baseUrl: string,
  path: string,
  payload: Record<string, string>,
): Promise<JsonResponse> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as JsonResponse['body'];
  return {
    status: response.status,
    body,
  };
};

test.after(() => {
  redis.disconnect();
});

test('手机号绑定发送验证码缺少图片验证码参数时应在路由层直接拦截', async () => {
  const app = createAccountTestApp();
  const server = await startServer(app);

  try {
    const response = await postJson(server.baseUrl, '/api/account/phone-binding/send-code', {
      phoneNumber: '13800138000',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.message, '图片验证码不能为空');
  } finally {
    await server.close();
  }
});
