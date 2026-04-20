import { describe, expect, it } from 'vitest';

import {
  buildAuthRequestPayload,
  CAPTCHA_NOT_READY_MESSAGE,
} from '../authCaptchaSubmission';

describe('buildAuthRequestPayload', () => {
  it('local 模式下应读取最新图片验证码字段，而不是旧快照', () => {
    const result = buildAuthRequestPayload({
      credentials: { username: '青玄', password: 'secret123' },
      latestLocalCaptchaValues: { captchaId: 'captcha-new', captchaCode: 'ABCD' },
      captchaOverride: null,
      isTencent: false,
    });

    expect(result.blockedMessage).toBeUndefined();
    expect(result.payload).toEqual({
      username: '青玄',
      password: 'secret123',
      captchaId: 'captcha-new',
      captchaCode: 'ABCD',
    });
  });

  it('local 模式下验证码未就绪时应阻止提交', () => {
    const result = buildAuthRequestPayload({
      credentials: { username: '青玄', password: 'secret123' },
      latestLocalCaptchaValues: { captchaId: '   ', captchaCode: 'ABCD' },
      captchaOverride: null,
      isTencent: false,
    });

    expect(result.payload).toBeUndefined();
    expect(result.blockedMessage).toBe(CAPTCHA_NOT_READY_MESSAGE);
  });

  it('tencent 模式下应优先提交票据载荷', () => {
    const result = buildAuthRequestPayload({
      credentials: { username: '青玄', password: 'secret123' },
      latestLocalCaptchaValues: { captchaId: 'captcha-local', captchaCode: 'ABCD' },
      captchaOverride: { ticket: 'ticket-1', randstr: 'rand-1' },
      isTencent: true,
    });

    expect(result.blockedMessage).toBeUndefined();
    expect(result.payload).toEqual({
      username: '青玄',
      password: 'secret123',
      ticket: 'ticket-1',
      randstr: 'rand-1',
    });
  });
});
