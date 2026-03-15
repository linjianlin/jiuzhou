import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIYUN_SMS_COUNTRY_CODE,
  ALIYUN_SMS_VERIFY_CODE_LENGTH,
  ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER,
  ALIYUN_SMS_VERIFY_CODE_TYPE,
  buildAliyunSmsVerifyTemplateParam,
  createAliyunCheckSmsVerifyCodeRequest,
  createAliyunSendSmsVerifyCodeRequest,
} from '../shared/aliyunSmsVerificationRequest.js';

/**
 * 阿里云短信验证码请求回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住手机号绑定依赖的阿里云请求构造规则，避免服务层把验证码再次错误地直接塞进模板参数。
 * 2. 做什么：覆盖发送与核验两条请求链路共用的关键字段，确保国家码、验证码长度和模板占位都只有一套口径。
 * 3. 不做什么：不请求真实阿里云接口，也不验证账号绑定数据库写入。
 *
 * 输入/输出：
 * - 输入：最小化的短信发送配置、手机号和验证码。
 * - 输出：阿里云请求对象上的关键字段断言结果。
 *
 * 数据流/状态流：
 * 测试构造纯函数输入 -> 生成阿里云请求对象 -> 断言模板参数与核验参数。
 *
 * 关键边界条件与坑点：
 * 1. `templateParam` 里的 `code` 必须固定为 `##code##`；只要换成真实验证码，阿里云就无法再用 `CheckSmsVerifyCode` 完成校验。
 * 2. 短信文案仍然依赖模板里的 `min` 变量，因此有效期秒数需要在这里统一换算成分钟，避免服务层各自算一遍。
 */

test('buildAliyunSmsVerifyTemplateParam: 应固定使用阿里云验证码占位并按分钟写入有效期', () => {
  const templateParam = buildAliyunSmsVerifyTemplateParam(300);
  const parsedTemplateParam = JSON.parse(templateParam) as { code: string; min: string };

  assert.deepEqual(parsedTemplateParam, {
    code: ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER,
    min: '5',
  });
});

test('createAliyunSendSmsVerifyCodeRequest: 应按阿里云托管验证码规则构造发送请求', () => {
  const request = createAliyunSendSmsVerifyCodeRequest('13800138000', {
    signName: '速通互联验证码',
    templateCode: '100001',
    codeExpireSeconds: 300,
    sendCooldownSeconds: 60,
  });

  assert.equal(request.phoneNumber, '13800138000');
  assert.equal(request.signName, '速通互联验证码');
  assert.equal(request.templateCode, '100001');
  assert.equal(request.countryCode, ALIYUN_SMS_COUNTRY_CODE);
  assert.equal(request.codeLength, ALIYUN_SMS_VERIFY_CODE_LENGTH);
  assert.equal(request.codeType, ALIYUN_SMS_VERIFY_CODE_TYPE);
  assert.equal(request.validTime, 300);
  assert.equal(request.interval, 60);

  const parsedTemplateParam = JSON.parse(request.templateParam ?? '{}') as { code?: string; min?: string };
  assert.deepEqual(parsedTemplateParam, {
    code: ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER,
    min: '5',
  });
});

test('createAliyunCheckSmsVerifyCodeRequest: 应复用同一国家码并透传用户输入验证码', () => {
  const request = createAliyunCheckSmsVerifyCodeRequest('13800138000', '123456');

  assert.equal(request.phoneNumber, '13800138000');
  assert.equal(request.verifyCode, '123456');
  assert.equal(request.countryCode, ALIYUN_SMS_COUNTRY_CODE);
});
