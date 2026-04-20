import { useLayoutEffect, useRef, useState } from 'react';
import { App, Button, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';

import CreateCharacter from '../../components/CreateCharacter';
import {
  checkCharacter,
  login as apiLogin,
  register as apiRegister,
  type UnifiedCaptchaPayload,
} from '../../services/api';
import {
  ACCOUNT_PASSWORD_MIN_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH_MESSAGE,
  createConfirmPasswordValidator,
} from '../shared/accountPasswordFormRules';
import { IMG_LOGO as logo } from '../Game/shared/imageAssets';
import AuthCaptchaField, { type AuthCaptchaFieldHandle } from './components/AuthCaptchaField';
import { buildAuthRequestPayload } from './authCaptchaSubmission';
import './index.scss';

interface AuthProps {
  onLoginSuccess: () => void;
}

type LoginFormValues = {
  username: string;
  password: string;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
};

type RegisterFormValues = {
  username: string;
  password: string;
  confirmPassword: string;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
};

const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const { message } = App.useApp();
  const [loginForm] = Form.useForm<LoginFormValues>();
  const [registerForm] = Form.useForm<RegisterFormValues>();
  const [isFlipped, setIsFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showCreateCharacter, setShowCreateCharacter] = useState(false);
  const [cardHeight, setCardHeight] = useState<number>();
  const [loginCaptchaRefreshNonce, setLoginCaptchaRefreshNonce] = useState(0);
  const [registerCaptchaRefreshNonce, setRegisterCaptchaRefreshNonce] = useState(0);
  const loginCardRef = useRef<HTMLDivElement>(null);
  const registerCardRef = useRef<HTMLDivElement>(null);
  const loginCaptchaRef = useRef<AuthCaptchaFieldHandle>(null);
  const registerCaptchaRef = useRef<AuthCaptchaFieldHandle>(null);

  useLayoutEffect(() => {
    const update = () => {
      const target = isFlipped ? registerCardRef.current : loginCardRef.current;
      const nextHeight = target?.getBoundingClientRect().height ?? 0;
      setCardHeight(nextHeight > 0 ? nextHeight : undefined);
    };

    update();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    if (ro) {
      if (loginCardRef.current) ro.observe(loginCardRef.current);
      if (registerCardRef.current) ro.observe(registerCardRef.current);
    }

    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [isFlipped]);

  const refreshLoginCaptcha = () => {
    setLoginCaptchaRefreshNonce((value) => value + 1);
  };

  const refreshRegisterCaptcha = () => {
    setRegisterCaptchaRefreshNonce((value) => value + 1);
  };

  const syncLoginCaptcha = (values: UnifiedCaptchaPayload) => {
    loginForm.setFieldsValue(values);
  };

  const syncRegisterCaptcha = (values: UnifiedCaptchaPayload) => {
    registerForm.setFieldsValue(values);
  };

  const flipToRegister = () => {
    setIsFlipped(true);
    refreshRegisterCaptcha();
  };

  const flipToLogin = () => {
    setIsFlipped(false);
    refreshLoginCaptcha();
  };

  const handleLogin = async (values: LoginFormValues) => {
    // beforeSubmit: tencent 模式返回 { ticket, randstr }，local 模式返回 null（用表单已有值）
    const captchaOverride = await loginCaptchaRef.current?.beforeSubmit();
    const isTencent = loginCaptchaRef.current?.isTencent ?? false;
    // tencent 模式下 null 表示用户取消
    if (isTencent && !captchaOverride) return;
    const latestLoginValues = loginForm.getFieldsValue([
      'username',
      'password',
      'captchaId',
      'captchaCode',
    ]);

    const { blockedMessage, payload } = buildAuthRequestPayload({
      credentials: {
        username: latestLoginValues.username ?? values.username,
        password: latestLoginValues.password ?? values.password,
      },
      latestLocalCaptchaValues: latestLoginValues,
      captchaOverride,
      isTencent,
    });
    if (!payload) {
      if (blockedMessage) {
        message.warning(blockedMessage);
      }
      return;
    }

    setLoading(true);
    try {
      const result = await apiLogin(payload);

      if (!result.data) {
        throw new Error('登录响应缺少账号数据');
      }

      localStorage.setItem('token', result.data.token);
      localStorage.setItem('user', JSON.stringify(result.data.user));
      message.success('登录成功');

      try {
        const charResult = await checkCharacter();
        if (charResult.success && charResult.data?.hasCharacter) {
          onLoginSuccess();
        } else {
          setShowCreateCharacter(true);
        }
      } catch {
        void 0;
      }
    } catch {
      refreshLoginCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (values: RegisterFormValues) => {
    const captchaOverride = await registerCaptchaRef.current?.beforeSubmit();
    const isTencent = registerCaptchaRef.current?.isTencent ?? false;
    if (isTencent && !captchaOverride) return;
    const latestRegisterValues = registerForm.getFieldsValue([
      'username',
      'password',
      'captchaId',
      'captchaCode',
    ]);

    const { blockedMessage, payload } = buildAuthRequestPayload({
      credentials: {
        username: latestRegisterValues.username ?? values.username,
        password: latestRegisterValues.password ?? values.password,
      },
      latestLocalCaptchaValues: latestRegisterValues,
      captchaOverride,
      isTencent,
    });
    if (!payload) {
      if (blockedMessage) {
        message.warning(blockedMessage);
      }
      return;
    }

    setLoading(true);
    try {
      await apiRegister(payload);

      message.success('注册成功，请登录');
      refreshRegisterCaptcha();
      flipToLogin();
    } catch {
      refreshRegisterCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const handleCharacterCreated = () => {
    setShowCreateCharacter(false);
    onLoginSuccess();
  };

  return (
    <div className="auth-container">
      <div className="auth-background">
        <div className="cloud cloud-1" />
        <div className="cloud cloud-2" />
        <div className="cloud cloud-3" />
      </div>

      <div className={`auth-card ${isFlipped ? 'flipped' : ''}`} style={cardHeight ? { height: cardHeight } : undefined}>
        <div ref={loginCardRef} className="card-face card-front">
          <div className="card-header">
            <img src={logo} alt="九州修仙录" className="logo" />
          </div>

          <Form form={loginForm} name="login" onFinish={handleLogin} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入道号' }]}>
              <Input prefix={<UserOutlined />} placeholder="道号" />
            </Form.Item>

            <Form.Item name="password" rules={[{ required: true, message: '请输入口令' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="口令" />
            </Form.Item>

            <AuthCaptchaField
              ref={loginCaptchaRef}
              onChange={syncLoginCaptcha}
              refreshNonce={loginCaptchaRefreshNonce}
            />

            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                踏入仙途
              </Button>
            </Form.Item>
          </Form>

          <div className="card-footer">
            <span>初入修仙界？</span>
            <Button type="link" onClick={flipToRegister}>
              开辟道途
            </Button>
          </div>
        </div>

        <div ref={registerCardRef} className="card-face card-back">
          <div className="card-header">
            <img src={logo} alt="九州修仙录" className="logo" />
            <p>注册成为修仙者</p>
          </div>

          <Form form={registerForm} name="register" onFinish={handleRegister} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入道号' }]}>
              <Input prefix={<UserOutlined />} placeholder="道号" />
            </Form.Item>

            <Form.Item
              name="password"
              rules={[
                { required: true, message: '请输入口令' },
                { min: ACCOUNT_PASSWORD_MIN_LENGTH, message: ACCOUNT_PASSWORD_MIN_LENGTH_MESSAGE },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="口令" />
            </Form.Item>

            <Form.Item
              name="confirmPassword"
              dependencies={['password']}
              rules={[
                { required: true, message: '请确认口令' },
                ({ getFieldValue }) => ({
                  validator: createConfirmPasswordValidator(getFieldValue, 'password', '两次口令不一致'),
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="确认口令" />
            </Form.Item>

            <AuthCaptchaField
              ref={registerCaptchaRef}
              onChange={syncRegisterCaptcha}
              refreshNonce={registerCaptchaRefreshNonce}
            />

            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                立下道心
              </Button>
            </Form.Item>
          </Form>

          <div className="card-footer">
            <span>已有道途？</span>
            <Button type="link" onClick={flipToLogin}>
              返回登录
            </Button>
          </div>
        </div>
      </div>

      <CreateCharacter
        open={showCreateCharacter}
        onSuccess={handleCharacterCreated}
      />
    </div>
  );
};

export default Auth;
