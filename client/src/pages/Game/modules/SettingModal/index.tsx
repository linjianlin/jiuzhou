import { App, Button, Input, Menu, Modal, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { getCharacterInfo, updateCharacterAutoDisassemble } from '../../../../services/api';
import { emitThemeModeChange, getStoredThemeMode, persistThemeMode, type ThemeMode } from '../../../../constants/theme';
import './index.scss';

type SettingKey = 'base' | 'battle' | 'cdk';

interface SettingModalProps {
  open: boolean;
  onClose: () => void;
}

const CDK_STORAGE_KEY = 'cdk_redeemed_v1';
const MOBILE_BREAKPOINT = 768;

const loadRedeemedCdks = () => {
  const raw = localStorage.getItem(CDK_STORAGE_KEY);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((x) => typeof x === 'string'));
  } catch {
    return new Set<string>();
  }
};

const saveRedeemedCdks = (set: Set<string>) => {
  localStorage.setItem(CDK_STORAGE_KEY, JSON.stringify(Array.from(set)));
};

const clampQualityRank = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(4, n));
};

const SettingModal: React.FC<SettingModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [activeKey, setActiveKey] = useState<SettingKey>('base');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [autoBattle, setAutoBattle] = useState(false);
  const [fastBattle, setFastBattle] = useState(false);
  const [autoDisassembleEnabled, setAutoDisassembleEnabled] = useState(false);
  const [autoDisassembleMaxQualityRank, setAutoDisassembleMaxQualityRank] = useState(1);
  const [autoDisassembleSaving, setAutoDisassembleSaving] = useState(false);
  const [autoDisassembleLoading, setAutoDisassembleLoading] = useState(false);
  const [cdk, setCdk] = useState('');
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const menuItems = useMemo(
    () => [
      { key: 'base', label: '基础设置' },
      { key: 'battle', label: '战斗设置' },
      { key: 'cdk', label: 'CDK兑换' },
    ],
    []
  );

  const redeemCdk = () => {
    const code = cdk.trim();
    if (!code) {
      message.warning('请输入CDK');
      return;
    }
    const redeemed = loadRedeemedCdks();
    if (redeemed.has(code)) {
      message.info('该CDK已兑换过');
      return;
    }
    redeemed.add(code);
    saveRedeemedCdks(redeemed);
    setCdk('');
    message.success('兑换成功');
  };

  const toggleDarkTheme = (enabled: boolean) => {
    const nextMode: ThemeMode = enabled ? 'dark' : 'light';
    setThemeMode(nextMode);
    persistThemeMode(nextMode);
    emitThemeModeChange(nextMode);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAutoDisassembleLoading(true);
    void (async () => {
      try {
        const res = await getCharacterInfo();
        if (!res.success || !res.data?.character || cancelled) return;
        const character = res.data.character;
        setAutoDisassembleEnabled(Boolean(character.auto_disassemble_enabled));
        setAutoDisassembleMaxQualityRank(clampQualityRank(character.auto_disassemble_max_quality_rank));
      } catch {
      } finally {
        if (!cancelled) {
          setAutoDisassembleLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveAutoDisassemble = async (
    nextEnabled: boolean,
    nextMaxQualityRank: number,
    rollback: () => void,
  ) => {
    setAutoDisassembleSaving(true);
    try {
      const res = await updateCharacterAutoDisassemble(nextEnabled, nextMaxQualityRank);
      if (!res.success) throw new Error(res.message || '设置保存失败');
    } catch (error) {
      rollback();
      const e = error as { message?: string };
      message.error(e.message || '设置保存失败');
    } finally {
      setAutoDisassembleSaving(false);
    }
  };

  const handleAutoDisassembleEnabledChange = (next: boolean) => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const prevEnabled = autoDisassembleEnabled;
    setAutoDisassembleEnabled(next);
    void saveAutoDisassemble(next, autoDisassembleMaxQualityRank, () => setAutoDisassembleEnabled(prevEnabled));
  };

  const handleAutoDisassembleQualityChange = (next: number) => {
    if (autoDisassembleLoading || autoDisassembleSaving) return;
    const clamped = clampQualityRank(next);
    const prevRank = autoDisassembleMaxQualityRank;
    setAutoDisassembleMaxQualityRank(clamped);
    void saveAutoDisassemble(autoDisassembleEnabled, clamped, () => setAutoDisassembleMaxQualityRank(prevRank));
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width="min(860px, calc(100vw - 16px))"
      className="setting-modal"
      destroyOnHidden
    >
      <div className={`setting-modal-body ${isMobile ? 'is-mobile' : ''}`}>
        <aside className="setting-left">
          <Typography.Title level={5} className="setting-left-title">
            设置
          </Typography.Title>
          <Menu
            mode={isMobile ? 'horizontal' : 'inline'}
            items={menuItems}
            selectedKeys={[activeKey]}
            onClick={(e) => setActiveKey(e.key as SettingKey)}
          />
        </aside>

        <section className="setting-right">
          {activeKey === 'base' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                基础设置
              </Typography.Title>
              <div className="setting-row">
                <Typography.Text>暗黑主题</Typography.Text>
                <Switch checked={themeMode === 'dark'} onChange={toggleDarkTheme} />
              </div>
            </Space>
          ) : null}

          {activeKey === 'battle' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                战斗设置
              </Typography.Title>
              <div className="setting-row">
                <Typography.Text>自动战斗</Typography.Text>
                <Switch checked={autoBattle} onChange={setAutoBattle} />
              </div>
              <div className="setting-row">
                <Typography.Text>快速战斗</Typography.Text>
                <Switch checked={fastBattle} onChange={setFastBattle} />
              </div>
              <div className="setting-row">
                <Typography.Text>自动分解装备</Typography.Text>
                <Switch
                  checked={autoDisassembleEnabled}
                  loading={autoDisassembleLoading || autoDisassembleSaving}
                  onChange={handleAutoDisassembleEnabledChange}
                />
              </div>
              <div className="setting-row">
                <Typography.Text>自动分解最高品质</Typography.Text>
                <Select
                  style={{ minWidth: 180 }}
                  value={autoDisassembleMaxQualityRank}
                  disabled={autoDisassembleLoading || autoDisassembleSaving}
                  options={[
                    { label: '黄品', value: 1 },
                    { label: '玄品', value: 2 },
                    { label: '地品', value: 3 },
                    { label: '天品', value: 4 },
                  ]}
                  onChange={handleAutoDisassembleQualityChange}
                />
              </div>
            </Space>
          ) : null}

          {activeKey === 'cdk' ? (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                CDK兑换
              </Typography.Title>
              {isMobile ? (
                <Space direction="vertical" size={8} className="setting-cdk-mobile">
                  <Input value={cdk} onChange={(e) => setCdk(e.target.value)} placeholder="请输入CDK" />
                  <Button type="primary" onClick={redeemCdk} block>
                    兑换
                  </Button>
                </Space>
              ) : (
                <Space.Compact style={{ width: '100%' }}>
                  <Input value={cdk} onChange={(e) => setCdk(e.target.value)} placeholder="请输入CDK" />
                  <Button type="primary" onClick={redeemCdk}>
                    兑换
                  </Button>
                </Space.Compact>
              )}
            </Space>
          ) : null}
        </section>
      </div>
    </Modal>
  );
};

export default SettingModal;
