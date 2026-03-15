import * as Dypnsapi20170525Models from '@alicloud/dypnsapi20170525';

/**
 * 阿里云短信验证码请求构造
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中构造阿里云短信发送与验证码核验请求，避免请求字段在服务层散落拼接。
 * 2. 做什么：把“验证码必须由阿里云生成并以 ##code## 占位”的规则收敛成单一入口，供服务实现与测试复用。
 * 3. 不做什么：不读取环境变量、不直接调用 SDK，也不处理阿里云响应。
 *
 * 输入/输出：
 * - 输入：规范化手机号、验证码，以及发送短信所需的签名/模板/时效配置。
 * - 输出：`SendSmsVerifyCodeRequest` 与 `CheckSmsVerifyCodeRequest` 实例。
 *
 * 数据流/状态流：
 * 绑定服务读取配置 -> 本模块构造请求对象 -> 短信服务调用阿里云 SDK -> 返回响应给绑定服务。
 *
 * 关键边界条件与坑点：
 * 1. `templateParam` 里的验证码占位必须固定为 `##code##`；如果把真实验证码直接传进去，阿里云发送成功后也无法再用核验接口校验。
 * 2. 发送与核验必须共用同一套国家码/验证码长度规则，避免一边生成 6 位数字、一边按其他口径核验。
 */

export type AliyunSmsVerificationRequestConfig = {
  signName: string;
  templateCode: string;
  codeExpireSeconds: number;
  sendCooldownSeconds: number;
};

export const ALIYUN_SMS_VERIFY_CODE_LENGTH = 6;
export const ALIYUN_SMS_VERIFY_CODE_TYPE = 1;
export const ALIYUN_SMS_COUNTRY_CODE = '86';
export const ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER = '##code##';

const resolveExpireMinutes = (codeExpireSeconds: number): string => {
  return String(Math.ceil(codeExpireSeconds / 60));
};

export const buildAliyunSmsVerifyTemplateParam = (codeExpireSeconds: number): string => {
  return JSON.stringify({
    code: ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER,
    min: resolveExpireMinutes(codeExpireSeconds),
  });
};

export const createAliyunSendSmsVerifyCodeRequest = (
  phoneNumber: string,
  config: AliyunSmsVerificationRequestConfig,
): Dypnsapi20170525Models.SendSmsVerifyCodeRequest => {
  return new Dypnsapi20170525Models.SendSmsVerifyCodeRequest({
    signName: config.signName,
    templateCode: config.templateCode,
    phoneNumber,
    countryCode: ALIYUN_SMS_COUNTRY_CODE,
    codeLength: ALIYUN_SMS_VERIFY_CODE_LENGTH,
    codeType: ALIYUN_SMS_VERIFY_CODE_TYPE,
    validTime: config.codeExpireSeconds,
    interval: config.sendCooldownSeconds,
    templateParam: buildAliyunSmsVerifyTemplateParam(config.codeExpireSeconds),
  });
};

export const createAliyunCheckSmsVerifyCodeRequest = (
  phoneNumber: string,
  verificationCode: string,
): Dypnsapi20170525Models.CheckSmsVerifyCodeRequest => {
  return new Dypnsapi20170525Models.CheckSmsVerifyCodeRequest({
    phoneNumber,
    verifyCode: verificationCode,
    countryCode: ALIYUN_SMS_COUNTRY_CODE,
  });
};
