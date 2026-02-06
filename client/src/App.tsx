import { lazy, Suspense, useEffect, useState } from 'react';
import { ConfigProvider, App as AntdApp, Modal, Spin, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Auth from './pages/Auth';
import { verifySession, checkCharacter } from './services/api';
import { gameSocket } from './services/gameSocket';
import './App.css';

// 懒加载 Game 组件，减少首屏加载体积
const Game = lazy(() => import('./pages/Game'));

const THEME_STORAGE_KEY = 'ui_theme_v1';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' ? 'dark' : 'light';
  });

  // 持久登录检查
  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        setIsLoading(false);
        return;
      }

      try {
        const result = await verifySession();
        if (result.success) {
          // 检查是否有角色
          const charResult = await checkCharacter();
          if (charResult.success && charResult.data?.hasCharacter) {
            setIsLoggedIn(true);
          }
        } else {
          // 清除无效的登录信息
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          if (result.kicked) {
            Modal.warning({
              title: '登录已失效',
              content: '您的账号已在其他设备登录',
            });
          }
        }
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  useEffect(() => {
    const applyBodyClass = () => {
      document.body.classList.toggle('theme-dark', themeMode === 'dark');
    };
    applyBodyClass();

    const onThemeEvent = (e: Event) => {
      const ce = e as CustomEvent<{ mode?: 'light' | 'dark' }>;
      const mode = ce.detail?.mode;
      if (mode === 'dark' || mode === 'light') setThemeMode(mode);
    };

    window.addEventListener('app:theme', onThemeEvent as EventListener);
    return () => window.removeEventListener('app:theme', onThemeEvent as EventListener);
  }, [themeMode]);

  // 监听被踢出事件
  useEffect(() => {
    const handleKicked = (data: { message: string }) => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setIsLoggedIn(false);
      Modal.warning({
        title: '登录已失效',
        content: data.message || '您的账号已在其他设备登录',
      });
    };

    const unsubscribe = gameSocket.onKicked(handleKicked);
    return () => unsubscribe();
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    gameSocket.disconnect();
    setIsLoggedIn(false);
  };

  if (isLoading) {
    return (
      <ConfigProvider locale={zhCN}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100vh',
            background: 'var(--app-bg)',
            color: 'var(--text-color)',
          }}
        >
          加载中...
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: themeMode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: 'var(--primary-color)',
        },
      }}
    >
      <AntdApp>
        {isLoggedIn ? (
          <Suspense
            fallback={
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <Spin size="large" tip="加载游戏中...">
                  <div style={{ width: 140, height: 80 }} />
                </Spin>
              </div>
            }
          >
            <Game onLogout={handleLogout} />
          </Suspense>
        ) : (
          <Auth onLoginSuccess={() => setIsLoggedIn(true)} />
        )}
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
