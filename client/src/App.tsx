import { lazy, Suspense, useEffect, useState } from 'react';
import { ConfigProvider, App as AntdApp, Modal, Spin, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Auth from './pages/Auth';
import { verifySession, checkCharacter } from './services/api';
import { gameSocket } from './services/gameSocket';
import { THEME_EVENT_NAME, getStoredThemeMode, persistThemeMode, type ThemeMode } from './constants/theme';
import './App.css';

// 懒加载 Game 组件，减少首屏加载体积
const Game = lazy(() => import('./pages/Game'));

const TOKEN_STORAGE_KEY = 'token';
const USER_STORAGE_KEY = 'user';
const centeredViewportStyle = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: '100dvh',
  height: '100%',
} as const;
const modalThemeCompat: Record<string, number> = { contentPadding: 8 };

const clearAuthStorage = () => {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
};

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());

  // 持久登录检查
  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
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
          clearAuthStorage();
          if (result.kicked) {
            Modal.warning({
              title: '登录已失效',
              content: '您的账号已在其他设备登录',
            });
          }
        }
      } catch {
        clearAuthStorage();
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('theme-dark', themeMode === 'dark');
  }, [themeMode]);

  useEffect(() => {
    const onThemeEvent = (e: Event) => {
      const ce = e as CustomEvent<{ mode?: ThemeMode }>;
      const mode = ce.detail?.mode;
      if (mode === 'dark' || mode === 'light') {
        persistThemeMode(mode);
        setThemeMode(mode);
      }
    };

    window.addEventListener(THEME_EVENT_NAME, onThemeEvent);
    return () => window.removeEventListener(THEME_EVENT_NAME, onThemeEvent);
  }, []);

  // 监听被踢出事件
  useEffect(() => {
    const handleKicked = (data: { message: string }) => {
      clearAuthStorage();
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
    clearAuthStorage();
    gameSocket.disconnect();
    setIsLoggedIn(false);
  };

  if (isLoading) {
    return (
      <ConfigProvider locale={zhCN}>
        <div
          style={{
            ...centeredViewportStyle,
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
        components: {
          Modal: {
            contentBg: 'var(--panel-bg)',
            ...modalThemeCompat,
          },
        },
      }}
    >
      <AntdApp>
        {isLoggedIn ? (
          <Suspense
            fallback={
              <div
                style={{
                  ...centeredViewportStyle,
                }}
              >
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
