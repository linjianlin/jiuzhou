import { BusinessError } from '../../middleware/BusinessError.js';

/**
 * 阿里云短信验证码错误映射
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中把阿里云短信验证码 SDK 的已知错误码转换成可直接返回前端的业务错误。
 * 2. 做什么：把验证码校验失败这类可预期错误从 500 系统异常收口成 400 业务异常，避免前端只能看到“服务器错误”。
 * 3. 不做什么：不负责调用阿里云 SDK，也不决定短信发送或绑定写库流程。
 *
 * 输入/输出：
 * - 输入：阿里云 SDK 抛出的错误对象。
 * - 输出：命中的已知错误时返回 `BusinessError`，否则返回 `null`。
 *
 * 数据流/状态流：
 * 阿里云 SDK 抛错 -> 本模块识别错误码 -> 服务层决定抛出业务错误或继续上抛原始异常。
 *
 * 关键边界条件与坑点：
 * 1. `ClientError` 的错误码既可能挂在顶层 `code`，也可能挂在 `data.Code`，识别时必须统一覆盖两条路径。
 * 2. 这里只映射已经确认的业务错误码；未识别的异常保持原样上抛，避免把真实系统故障误报成验证码错误。
 */

type AliyunSdkErrorData = {
  Code?: string;
  Message?: string;
};

type AliyunSmsVerificationSdkError = Error & {
  code?: string;
  data?: AliyunSdkErrorData;
};

const ALIYUN_VALIDATE_FAIL_CODE = 'isv.ValidateFail';

const resolveAliyunErrorCode = (error: AliyunSmsVerificationSdkError): string => {
  if (typeof error.code === 'string' && error.code.trim()) {
    return error.code.trim();
  }

  if (typeof error.data?.Code === 'string' && error.data.Code.trim()) {
    return error.data.Code.trim();
  }

  return '';
};

export const resolveAliyunSmsVerificationBusinessError = (
  error: AliyunSmsVerificationSdkError,
): BusinessError | null => {
  const code = resolveAliyunErrorCode(error);
  if (code === ALIYUN_VALIDATE_FAIL_CODE) {
    return new BusinessError('验证码错误或已失效，请重新获取');
  }

  return null;
};
