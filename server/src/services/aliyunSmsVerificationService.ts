import Dypnsapi20170525Package, * as Dypnsapi20170525Models from '@alicloud/dypnsapi20170525';
import * as OpenApi from '@alicloud/openapi-client';
import * as Util from '@alicloud/tea-util';
import CredentialPackage from '@alicloud/credentials';
import { BusinessError } from '../middleware/BusinessError.js';
import { MARKET_PHONE_BINDING_CONFIG } from './marketPhoneBindingConfig.js';
import { resolveAliyunSmsVerificationBusinessError } from './shared/aliyunSmsVerificationError.js';
import {
  createAliyunCheckSmsVerifyCodeRequest,
  createAliyunSendSmsVerifyCodeRequest,
} from './shared/aliyunSmsVerificationRequest.js';

/**
 * 阿里云短信验证码服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：封装阿里云 Dypnsapi 的验证码短信发送与验证码核验入口，供手机号绑定服务复用。
 * 2. 做什么：集中拼接模板参数和阿里云响应判定规则，避免业务服务重复感知 SDK 请求结构。
 * 3. 不做什么：不生成账号绑定状态、不写数据库，也不决定手机号是否允许绑定。
 *
 * 输入/输出：
 * - 输入：手机号、验证码。
 * - 输出：短信发送成功时无返回值；验证码核验成功时返回 `true`。
 *
 * 数据流/状态流：
 * 绑定服务请求发送短信 -> 本模块构造阿里云请求 -> 阿里云生成并发送验证码 -> 绑定服务继续写入 Redis 冷却状态。
 * 绑定服务提交验证码 -> 本模块调用阿里云核验 -> 返回 PASS/UNKNOWN -> 绑定服务决定是否写库。
 *
 * 关键边界条件与坑点：
 * 1. 只有在功能启用时才允许发送短信，避免关闭状态下误调用外部服务。
 * 2. 验证码必须由阿里云侧生成并校验，请求构造必须复用共享构造器，不能在上层把真实验证码直接塞进模板参数。
 */

const DYPNSAPI_ENDPOINT = 'dypnsapi.aliyuncs.com';

type AliyunCredentialInstance = {
  getCredential: () => Promise<object>;
};

type AliyunCredentialConstructor = new () => AliyunCredentialInstance;

type DypnsapiClientInstance = {
  sendSmsVerifyCodeWithOptions: (
    request: InstanceType<typeof Dypnsapi20170525Models.SendSmsVerifyCodeRequest>,
    runtime: InstanceType<typeof Util.RuntimeOptions>,
  ) => Promise<Dypnsapi20170525Models.SendSmsVerifyCodeResponse>;
  checkSmsVerifyCodeWithOptions: (
    request: InstanceType<typeof Dypnsapi20170525Models.CheckSmsVerifyCodeRequest>,
    runtime: InstanceType<typeof Util.RuntimeOptions>,
  ) => Promise<Dypnsapi20170525Models.CheckSmsVerifyCodeResponse>;
};

type DypnsapiClientConstructor = new (
  config: InstanceType<typeof OpenApi.Config>,
) => DypnsapiClientInstance;

type AliyunCredentialModuleShape = {
  default?: AliyunCredentialConstructor;
};

type DypnsapiModuleShape = {
  default?: DypnsapiClientConstructor;
};

let cachedClient: DypnsapiClientInstance | null = null;

const resolveAliyunCredentialConstructor = (): AliyunCredentialConstructor => {
  const nestedDefault = (CredentialPackage as AliyunCredentialModuleShape).default;
  if (typeof nestedDefault !== 'function') {
    throw new Error('阿里云凭据 SDK 导出异常，无法解析 Credential 构造器');
  }
  return nestedDefault;
};

const resolveDypnsapiClientConstructor = (): DypnsapiClientConstructor => {
  const nestedDefault = (Dypnsapi20170525Package as DypnsapiModuleShape).default;
  if (typeof nestedDefault !== 'function') {
    throw new Error('阿里云 Dypnsapi SDK 导出异常，无法解析 Client 构造器');
  }
  return nestedDefault;
};

const createClient = (): DypnsapiClientInstance => {
  const CredentialConstructor = resolveAliyunCredentialConstructor();
  const DypnsapiClientConstructor = resolveDypnsapiClientConstructor();
  const credential = new CredentialConstructor();
  const config = new OpenApi.Config({
    credential,
  });
  config.endpoint = DYPNSAPI_ENDPOINT;
  return new DypnsapiClientConstructor(config);
};

const getClient = (): DypnsapiClientInstance => {
  if (cachedClient) return cachedClient;
  cachedClient = createClient();
  return cachedClient;
};

const assertAliyunSuccess = (
  code: string | undefined,
  success: boolean | undefined,
  message: string | undefined,
  actionLabel: string,
): void => {
  if (success === true && code === 'OK') {
    return;
  }

  throw new BusinessError(message?.trim() || `${actionLabel}失败`);
};

export const sendAliyunSmsVerificationCode = async (
  phoneNumber: string,
): Promise<void> => {
  if (!MARKET_PHONE_BINDING_CONFIG.enabled) {
    throw new Error('手机号绑定功能未开启，禁止发送短信验证码');
  }

  const client = getClient();
  const request = createAliyunSendSmsVerifyCodeRequest(phoneNumber, {
    signName: MARKET_PHONE_BINDING_CONFIG.signName,
    templateCode: MARKET_PHONE_BINDING_CONFIG.templateCode,
    codeExpireSeconds: MARKET_PHONE_BINDING_CONFIG.codeExpireSeconds,
    sendCooldownSeconds: MARKET_PHONE_BINDING_CONFIG.sendCooldownSeconds,
  });
  const runtime = new Util.RuntimeOptions({});

  const response = await client.sendSmsVerifyCodeWithOptions(request, runtime);
  assertAliyunSuccess(
    response.body?.code,
    response.body?.success,
    response.body?.message,
    '短信验证码发送',
  );
};

export const verifyAliyunSmsVerificationCode = async (
  phoneNumber: string,
  verificationCode: string,
): Promise<boolean> => {
  if (!MARKET_PHONE_BINDING_CONFIG.enabled) {
    throw new Error('手机号绑定功能未开启，禁止核验短信验证码');
  }

  const client = getClient();
  const request = createAliyunCheckSmsVerifyCodeRequest(phoneNumber, verificationCode);
  const runtime = new Util.RuntimeOptions({});
  try {
    const response = await client.checkSmsVerifyCodeWithOptions(request, runtime);

    assertAliyunSuccess(
      response.body?.code,
      response.body?.success,
      response.body?.message,
      '短信验证码校验',
    );

    return response.body?.model?.verifyResult === 'PASS';
  } catch (error) {
    const businessError = resolveAliyunSmsVerificationBusinessError(
      error as Error & { code?: string; data?: { Code?: string; Message?: string } },
    );
    if (businessError) {
      throw businessError;
    }
    throw error;
  }
};
