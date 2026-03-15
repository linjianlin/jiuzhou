/**
 * 鉴权页验证码字段（支持 local 图片验证码和天御验证码双模式）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理登录/注册共用的验证码交互，根据 captchaConfig.provider 自动切换图片验证码或天御弹窗模式。
 * 2. 做什么：统一维护验证码字段的表单写入规则，让服务端验证码契约只在一个前端组件里落地。
 * 3. 不做什么：不负责登录注册提交，不处理账号密码校验，也不决定表单成功后的跳转。
 *
 * 输入/输出：
 * - 输入：`refreshNonce` 刷新信号、`onChange` 字段同步回调。
 * - 输出：通过 `onChange` 回写最新的验证码载荷（local: captchaId/captchaCode，tencent: ticket/randstr）。
 *
 * 数据流/状态流：
 * - local 模式：页面挂载 -> 请求 /api/auth/captcha -> 更新图片 -> 同步 captchaId/captchaCode -> 用户填写后提交
 * - tencent 模式：不渲染可见 UI，父组件通过 ref.beforeSubmit() 在提交前触发天御弹窗 -> 验证成功后自动写入 ticket/randstr -> 返回 true 允许提交
 *
 * 关键边界条件与坑点：
 * 1. tencent 模式下 beforeSubmit 是异步的，父组件必须 await 其返回值再决定是否继续提交。
 * 2. captchaConfig 加载期间显示 local 模式（默认），配置到达后如果是 tencent 则切换，避免闪烁。
 *
 * 复用说明：
 * - AuthCaptchaFieldHandle 接口被 Auth/index.tsx 的登录和注册两个表单复用，统一了"提交前获取验证码"的命令式调用。
 */
import { forwardRef, useImperativeHandle } from 'react';
import { App, Form, Input } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';

import {
  getCaptcha,
  type UnifiedCaptchaPayload,
} from '../../../services/api/auth-character';
import { useCaptchaChallenge } from '../../shared/useCaptchaChallenge';
import { useCaptchaConfig } from '../../shared/useCaptchaConfig';
import { useTencentCaptcha } from '../../shared/useTencentCaptcha';

/**
 * 父组件通过 ref 调用的命令式接口。
 * beforeSubmit 返回验证码载荷或 null（取消/失败），父组件直接用返回值发请求，
 * 不依赖 Ant Design Form 字段存储——因为 tencent 模式下不渲染 Form.Item，
 * setFieldsValue/getFieldsValue 对未注册字段无效。
 */
export interface AuthCaptchaFieldHandle {
  /**
   * 提交前调用：
   * - local 模式：返回 null（表示"不需要额外操作，直接用表单里已有的 captchaId/captchaCode"）
   * - tencent 模式：触发天御弹窗，成功返回 { ticket, randstr }，取消/失败返回 null
   */
  beforeSubmit: () => Promise<UnifiedCaptchaPayload | null>;
  /** 是否为天御模式 */
  isTencent: boolean;
}

interface AuthCaptchaFieldProps {
  onChange: (values: UnifiedCaptchaPayload) => void;
  refreshNonce: number;
}

const AuthCaptchaField = forwardRef<AuthCaptchaFieldHandle, AuthCaptchaFieldProps>(
  function AuthCaptchaField({ onChange, refreshNonce }, ref) {
    const { config, isTencent, loading: configLoading } = useCaptchaConfig();

    if (isTencent) {
      return (
        <AuthCaptchaFieldTencent
          ref={ref}
          appId={config.tencentAppId ?? 0}
          onChange={onChange}
        />
      );
    }

    return (
      <AuthCaptchaFieldLocal
        ref={ref}
        refreshNonce={refreshNonce}
        onChange={onChange}
        configLoading={configLoading}
      />
    );
  },
);

export default AuthCaptchaField;

/** local 模式：图片验证码输入 + 图片刷新，beforeSubmit 直接返回 null */
const AuthCaptchaFieldLocal = forwardRef<
  AuthCaptchaFieldHandle,
  {
    refreshNonce: number;
    onChange: (values: UnifiedCaptchaPayload) => void;
    /** captchaConfig 是否仍在加载，为 true 时不发起图片验证码请求，避免 tencent 模式下误请求 */
    configLoading: boolean;
  }
>(function AuthCaptchaFieldLocal({ refreshNonce, onChange, configLoading }, ref) {
  const { message } = App.useApp();

  const { captcha, loading, refreshCaptcha } = useCaptchaChallenge({
    enabled: !configLoading,
    refreshNonce,
    loadCaptcha: getCaptcha,
    fallbackMessage: '图片验证码加载失败',
    onLoaded: (nextCaptcha) => {
      onChange({ captchaId: nextCaptcha.captchaId, captchaCode: '' });
    },
    onCleared: () => {
      onChange({ captchaId: '', captchaCode: '' });
    },
    onLoadError: (msg) => { message.error(msg); },
  });

  useImperativeHandle(ref, () => ({
    beforeSubmit: () => Promise.resolve(null),
    isTencent: false,
  }));

  return (
    <div className="auth-captcha">
      <Form.Item name="captchaId" hidden>
        <Input />
      </Form.Item>

      <div className="auth-captcha__row">
        <Form.Item
          className="auth-captcha__input"
          name="captchaCode"
          rules={[
            { required: true, message: '请输入图片验证码' },
            {
              validator: (_rule, value: string | undefined) => {
                if (!value || value.length === 4) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error(''));
              },
            },
          ]}
        >
          <Input
            autoComplete="off"
            maxLength={4}
            prefix={<SafetyCertificateOutlined />}
            placeholder="图片验证码"
          />
        </Form.Item>

        <div className="auth-captcha__visual">
          <button
            type="button"
            className="auth-captcha__image-button"
            onClick={() => { void refreshCaptcha(); }}
            disabled={loading}
            aria-label="刷新图片验证码"
          >
            {captcha ? (
              <img
                className="auth-captcha__image"
                src={captcha.imageData}
                alt="图片验证码"
              />
            ) : (
              <span className="auth-captcha__placeholder">
                {loading ? '加载中...' : '点击重试'}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
});

/**
 * tencent 模式：不渲染可见 UI，通过 beforeSubmit 命令式触发天御弹窗。
 * 验证成功返回 { ticket, randstr } 载荷；用户取消/失败返回 null。
 * 不依赖 Form.Item 注册字段，因为 tencent 模式下不渲染任何表单元素。
 */
const AuthCaptchaFieldTencent = forwardRef<
  AuthCaptchaFieldHandle,
  {
    appId: number;
    onChange: (values: UnifiedCaptchaPayload) => void;
  }
>(function AuthCaptchaFieldTencent({ appId }, ref) {
  const { message } = App.useApp();
  const { triggerCaptcha } = useTencentCaptcha(appId);

  useImperativeHandle(ref, () => ({
    beforeSubmit: async () => {
      try {
        const result = await triggerCaptcha();
        return { ticket: result.ticket, randstr: result.randstr };
      } catch (error) {
        const err = error as Error;
        if (err.message !== '用户取消验证') {
          message.error(err.message);
        }
        return null;
      }
    },
    isTencent: true,
  }));

  // tencent 模式不渲染可见 UI，天御弹窗由 SDK 自行管理
  return null;
});
