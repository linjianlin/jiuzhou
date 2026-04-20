import type { AuthRequestPayload, UnifiedCaptchaPayload } from '../../services/api/auth-character';

export interface AuthCredentialFields {
  username: string;
  password: string;
}

export interface AuthLocalCaptchaFields {
  captchaId?: string;
  captchaCode?: string;
}

interface BuildAuthRequestPayloadInput {
  credentials: AuthCredentialFields;
  latestLocalCaptchaValues: AuthLocalCaptchaFields;
  captchaOverride: UnifiedCaptchaPayload | null | undefined;
  isTencent: boolean;
}

interface BuildAuthRequestPayloadResult {
  blockedMessage?: string;
  payload?: AuthRequestPayload;
}

export const CAPTCHA_NOT_READY_MESSAGE = '图片验证码加载中，请稍后重试';

export const buildAuthRequestPayload = ({
  credentials,
  latestLocalCaptchaValues,
  captchaOverride,
  isTencent,
}: BuildAuthRequestPayloadInput): BuildAuthRequestPayloadResult => {
  if (isTencent) {
    if (!captchaOverride) {
      return {};
    }

    return {
      payload: {
        username: credentials.username,
        password: credentials.password,
        ...captchaOverride,
      },
    };
  }

  const captchaId = latestLocalCaptchaValues.captchaId?.trim() ?? '';
  if (!captchaId) {
    return { blockedMessage: CAPTCHA_NOT_READY_MESSAGE };
  }

  return {
    payload: {
      username: credentials.username,
      password: credentials.password,
      captchaId,
      captchaCode: latestLocalCaptchaValues.captchaCode,
    },
  };
};
