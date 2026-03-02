import { useLayoutEffect, useRef, useState } from 'react';
import { Form, Input, Button, App } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { login as apiLogin, register as apiRegister, checkCharacter } from '../../services/api';
import CreateCharacter from '../../components/CreateCharacter';
import { IMG_LOGO as logo } from '../Game/shared/imageAssets';
import './index.scss';

interface AuthProps {
  onLoginSuccess: () => void;
}

const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const { message } = App.useApp();
  const [isFlipped, setIsFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showCreateCharacter, setShowCreateCharacter] = useState(false);
  const [cardHeight, setCardHeight] = useState<number>();
  const loginCardRef = useRef<HTMLDivElement>(null);
  const registerCardRef = useRef<HTMLDivElement>(null);

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

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const result = await apiLogin(values.username, values.password);
      if (result.success && result.data) {
        localStorage.setItem('token', result.data.token);
        localStorage.setItem('user', JSON.stringify(result.data.user));
        message.success('登录成功');
        
        // 检查是否有角色
        const charResult = await checkCharacter();
        if (charResult.success && charResult.data?.hasCharacter) {
          // 有角色，直接进入游戏
          onLoginSuccess();
        } else {
          // 没有角色，显示创建角色弹窗
          setShowCreateCharacter(true);
        }
      } else {
        void 0;
      }
    } catch (error: unknown) {
      void 0;
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const result = await apiRegister(values.username, values.password);
      if (result.success) {
        message.success('注册成功，请登录');
        setIsFlipped(false);
      } else {
        void 0;
      }
    } catch (error: unknown) {
      void 0;
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
            <p>踏入仙途，逆天改命</p>
          </div>
          
          <Form name="login" onFinish={handleLogin} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入道号' }]}>
              <Input prefix={<UserOutlined />} placeholder="道号" />
            </Form.Item>
            
            <Form.Item name="password" rules={[{ required: true, message: '请输入口令' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="口令" />
            </Form.Item>
            
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                踏入仙途
              </Button>
            </Form.Item>
          </Form>
          
          <div className="card-footer">
            <span>初入修仙界？</span>
            <Button type="link" onClick={() => setIsFlipped(true)}>
              开辟道途
            </Button>
          </div>
        </div>

        <div ref={registerCardRef} className="card-face card-back">
          <div className="card-header">
            <img src={logo} alt="九州修仙录" className="logo" />
            <p>注册成为修仙者</p>
          </div>
          
          <Form name="register" onFinish={handleRegister} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入道号' }]}>
              <Input prefix={<UserOutlined />} placeholder="道号" />
            </Form.Item>
            
            <Form.Item name="password" rules={[{ required: true, min: 6, message: '口令至少6位' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="口令" />
            </Form.Item>
            
            <Form.Item name="confirmPassword" dependencies={['password']} rules={[
              { required: true, message: '请确认口令' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) return Promise.resolve();
                  return Promise.reject(new Error('两次口令不一致'));
                },
              }),
            ]}>
              <Input.Password prefix={<LockOutlined />} placeholder="确认口令" />
            </Form.Item>
            
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                立下道心
              </Button>
            </Form.Item>
          </Form>
          
          <div className="card-footer">
            <span>已有道途？</span>
            <Button type="link" onClick={() => setIsFlipped(false)}>
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
