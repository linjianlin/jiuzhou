import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessError } from '../../middleware/BusinessError.js';
import { resolveAliyunSmsVerificationBusinessError } from '../shared/aliyunSmsVerificationError.js';

/**
 * 阿里云短信验证码错误映射测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住阿里云验证码已知错误码到业务错误文案的映射，避免前端再次退回“服务器错误”。
 * 2. 做什么：验证顶层 `code` 和 `data.Code` 两种错误码来源都能识别。
 * 3. 不做什么：不请求真实阿里云接口，也不验证短信发送成功链路。
 *
 * 输入/输出：
 * - 输入：模拟的阿里云 SDK 错误对象。
 * - 输出：业务错误对象或 `null`。
 *
 * 数据流/状态流：
 * 测试构造阿里云错误对象 -> 调用错误映射函数 -> 断言返回的业务错误文案。
 *
 * 关键边界条件与坑点：
 * 1. 阿里云错误码并不总在同一个字段上，测试必须覆盖 `code` 和 `data.Code` 两条路径。
 * 2. 未识别错误不能被误映射成验证码错误，否则会掩盖真实系统异常。
 */

test('resolveAliyunSmsVerificationBusinessError: 顶层 code 为 isv.ValidateFail 时应返回验证码业务错误', () => {
  const error = Object.assign(new Error('验证失败'), {
    code: 'isv.ValidateFail',
  });

  const result = resolveAliyunSmsVerificationBusinessError(error);

  assert.ok(result instanceof BusinessError);
  assert.equal(result?.message, '验证码错误或已失效，请重新获取');
  assert.equal(result?.statusCode, 400);
});

test('resolveAliyunSmsVerificationBusinessError: data.Code 为 isv.ValidateFail 时也应返回验证码业务错误', () => {
  const error = Object.assign(new Error('验证失败'), {
    data: {
      Code: 'isv.ValidateFail',
      Message: '验证失败',
    },
  });

  const result = resolveAliyunSmsVerificationBusinessError(error);

  assert.ok(result instanceof BusinessError);
  assert.equal(result?.message, '验证码错误或已失效，请重新获取');
});

test('resolveAliyunSmsVerificationBusinessError: 未识别错误码时应返回 null', () => {
  const error = Object.assign(new Error('短信服务异常'), {
    code: 'isv.Unknown',
  });

  const result = resolveAliyunSmsVerificationBusinessError(error);

  assert.equal(result, null);
});
