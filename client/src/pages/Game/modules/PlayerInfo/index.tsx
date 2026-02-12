import { App, Button, Progress, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { UserOutlined, LoadingOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import { SERVER_BASE, getRealmOverview, uploadAvatar, addAttributePoint, removeAttributePoint, type RealmOverviewDto } from '../../../../services/api';
import './index.scss';

const staminaMaxFromEnv = Number(import.meta.env.VITE_STAMINA_MAX);
const STAMINA_DISPLAY_MAX = Number.isFinite(staminaMaxFromEnv) && staminaMaxFromEnv > 0 ? Math.floor(staminaMaxFromEnv) : 100;
const CHARACTER_REFRESH_INTERVAL_MS = 30_000;

const PlayerInfo: React.FC = () => {
  const { message } = App.useApp();
  const messageRef = useRef(message);
  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [realmOverview, setRealmOverview] = useState<RealmOverviewDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processingPoint, setProcessingPoint] = useState<string | null>(null);

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  // 连接游戏服务器并订阅角色数据
  useEffect(() => {
    gameSocket.connect();
    gameSocket.refreshCharacter();

    const refreshTimer = window.setInterval(() => {
      if (document.hidden) return;
      gameSocket.refreshCharacter();
    }, CHARACTER_REFRESH_INTERVAL_MS);

    const unsubscribe = gameSocket.onCharacterUpdate((data) => {
      setCharacter(data);
    });

    const unsubError = gameSocket.onError((error) => {
      messageRef.current.error(error.message);
    });

    return () => {
      window.clearInterval(refreshTimer);
      unsubscribe();
      unsubError();
    };
  }, []);

  useEffect(() => {
    if (!character?.realm) return;
    let cancelled = false;
    getRealmOverview()
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.data) {
          setRealmOverview(res.data);
          return;
        }
        setRealmOverview(null);
      })
      .catch(() => {
        if (cancelled) return;
        setRealmOverview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [character?.realm]);

  const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

  const formatPercent = useCallback((value: number) => {
    // 万分比转百分比
    const percent = value / 100;
    const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
    const trimmed = fixed.replace(/\.?0+$/, '') || '0';
    return `${trimmed}%`;
  }, []);

  const formatRecovery = useCallback((value: number) => {
    const v = value / 100;
    const fixed = Math.abs(v - Math.round(v)) < 1e-9 ? v.toFixed(0) : v.toFixed(2);
    return fixed.replace(/\.?0+$/, '') || '0';
  }, []);

  const expCost = useMemo(() => {
    const costs = realmOverview?.costs ?? [];
    const found = costs.find((c) => c.type === 'exp' && Number.isFinite(Number(c.amount)) && Number(c.amount) > 0);
    return found ? Number(found.amount) : null;
  }, [realmOverview?.costs]);

  const expNeed = useMemo(() => {
    const reqs = realmOverview?.requirements ?? [];
    for (const r of reqs) {
      const detail = String(r?.detail ?? '').trim();
      const m = /经验\s*([>≥]=?)\s*([\d,]+)/.exec(detail);
      if (!m) continue;
      const op = m[1] || '';
      const raw = (m[2] || '').replace(/,/g, '');
      const min = Math.max(0, Math.floor(Number(raw) || 0));
      if (min <= 0) continue;
      return op.includes('>') && !op.includes('=') ? min + 1 : min;
    }
    return expCost;
  }, [expCost, realmOverview?.requirements]);

  // 计算派生属性
  const derivedStats = useMemo(() => {
    if (!character) return null;
    return {
      maxQixue: character.maxQixue,
      maxLingqi: character.maxLingqi,
      wufang: character.wufang,
      fafang: character.fafang,
      mingzhong: character.mingzhong,
      baoji: character.baoji,
    };
  }, [character]);

  // 头像上传处理
  const handleAvatarUpload: UploadProps['customRequest'] = async (options) => {
    const file = options.file as File;
    setUploading(true);

    try {
      const result = await uploadAvatar(file);
      if (result.success) {
        message.success('头像上传成功');
        // 刷新角色数据
        gameSocket.refreshCharacter();
      } else {
        message.error(result.message || '上传失败');
      }
    } catch {
      message.error('上传失败');
    } finally {
      setUploading(false);
    }
  };

  // 加点处理
  const handleAddPoint = async (attribute: 'jing' | 'qi' | 'shen') => {
    if (!character || character.attributePoints <= 0) return;

    setProcessingPoint(`add-${attribute}`);
    try {
      const result = await addAttributePoint(attribute, 1);
      if (result.success) {
        gameSocket.refreshCharacter();
      } else {
        message.error(result.message || '加点失败');
      }
    } catch {
      message.error('加点失败');
    } finally {
      setProcessingPoint(null);
    }
  };

  // 减点处理
  const handleRemovePoint = async (attribute: 'jing' | 'qi' | 'shen') => {
    if (!character || character[attribute] <= 0) return;

    setProcessingPoint(`remove-${attribute}`);
    try {
      const result = await removeAttributePoint(attribute, 1);
      if (result.success) {
        gameSocket.refreshCharacter();
      } else {
        message.error(result.message || '减点失败');
      }
    } catch {
      message.error('减点失败');
    } finally {
      setProcessingPoint(null);
    }
  };

  // 未加载角色时显示占位
  if (!character) {
    return (
      <div className="player-info player-info-loading">
        <LoadingOutlined style={{ fontSize: 24 }} />
        <span>加载中...</span>
      </div>
    );
  }

  const avatarUrl = character.avatar ? `${SERVER_BASE}${character.avatar}` : null;
  const qixueCurrent = Math.min(character.qixue, character.maxQixue);
  const lingqiCurrent = Math.min(character.lingqi, character.maxLingqi);
  const staminaMax = STAMINA_DISPLAY_MAX;
  const staminaCurrent = Math.min(staminaMax, Math.max(0, Number(character.stamina) || 0));
  const qixuePercent = clampPercent(character.maxQixue > 0 ? (qixueCurrent / character.maxQixue) * 100 : 0);
  const lingqiPercent = clampPercent(character.maxLingqi > 0 ? (lingqiCurrent / character.maxLingqi) * 100 : 0);
  const staminaPercent = clampPercent(staminaMax > 0 ? (staminaCurrent / staminaMax) * 100 : 0);
  const expCurrent = Math.max(0, Number(character.exp) || 0);
  const expPercent = clampPercent(
    expNeed && expNeed > 0 ? (expCurrent / expNeed) * 100 : realmOverview?.nextRealm ? 0 : 100,
  );
  const expText = `${expPercent.toFixed(2).replace(/\.?0+$/, '')}%`;
  const expDetailText = expNeed && expNeed > 0 ? `${expCurrent.toLocaleString()}/${expNeed.toLocaleString()}` : expCurrent.toLocaleString();

  const attackTypeText = character.attributeType === 'physical' ? '物理' : '法术';
  const elementMap: Record<string, string> = {
    none: '无', jin: '金', mu: '木', shui: '水', huo: '火', tu: '土'
  };
  const elementText = elementMap[character.attributeElement] || '无';

  const combatAttributes = [
    { label: '属性', value: `${attackTypeText}（${elementText}）` },
    { label: '属性数值', value: formatPercent(character.shuxingShuzhi) },
    { label: '物攻', value: character.wugong },
    { label: '法攻', value: character.fagong },
    { label: '物防', value: derivedStats?.wufang || 0 },
    { label: '法防', value: derivedStats?.fafang || 0 },
    { label: '命中', value: formatPercent(derivedStats?.mingzhong || 0) },
    { label: '闪避', value: formatPercent(character.shanbi) },
    { label: '招架', value: formatPercent(character.zhaojia) },
    { label: '暴击', value: formatPercent(derivedStats?.baoji || 0) },
    { label: '爆伤', value: formatPercent(character.baoshang) },
    { label: '抗暴', value: formatPercent(character.kangbao) },
    { label: '增伤', value: formatPercent(character.zengshang) },
    { label: '治疗', value: formatPercent(character.zhiliao) },
    { label: '减疗', value: formatPercent(character.jianliao) },
    { label: '吸血', value: formatPercent(character.xixue) },
    { label: '冷却', value: formatPercent(character.lengque) },
    { label: '控制抗性', value: formatPercent(character.kongzhiKangxing) },
    { label: '速度', value: character.sudu },
  ];

  const assistAttributes = [
    { label: '金属性抗性', value: formatPercent(character.jinKangxing) },
    { label: '木属性抗性', value: formatPercent(character.muKangxing) },
    { label: '水属性抗性', value: formatPercent(character.shuiKangxing) },
    { label: '火属性抗性', value: formatPercent(character.huoKangxing) },
    { label: '土属性抗性', value: formatPercent(character.tuKangxing) },
    { label: '气血恢复', value: formatRecovery(character.qixueHuifu) },
    { label: '灵气恢复', value: formatRecovery(character.lingqiHuifu) },
    { label: '福源', value: character.fuyuan },
  ];

  return (
    <div className="player-info">
      <div className="player-top">
        <Upload
          accept="image/*"
          showUploadList={false}
          customRequest={handleAvatarUpload}
          disabled={uploading}
        >
          <div className="player-avatar-card" role="button" tabIndex={0}>
            {uploading ? (
              <div className="player-avatar-placeholder">
                <LoadingOutlined />
                <div className="player-avatar-text">上传中...</div>
              </div>
            ) : avatarUrl ? (
              <img className="player-avatar-img" src={avatarUrl} alt="头像" />
            ) : (
              <div className="player-avatar-placeholder">
                <UserOutlined />
                <div className="player-avatar-text">上传头像</div>
              </div>
            )}
          </div>
        </Upload>

        <div className="player-top-right">
          <div className="player-name-row">
            <div className="player-name">
              <span className="player-title">{character.title}</span>
              <span className="player-name-text">{character.nickname}</span>
            </div>
          </div>
          <div className="player-meta-row">
            <span className="player-meta-tag">ID: {character.id}</span>
            <span className="player-meta-tag">
              {character.realm}{character.subRealm ? ` · ${character.subRealm}` : ''}
            </span>
          </div>

          <div className="player-bars">
            <div className="bar-item">
              <span className="bar-label">血</span>
              <div className="bar-progress">
                <Progress
                  percent={qixuePercent}
                  strokeColor="var(--danger-color)"
                  railColor="var(--progress-rail-color)"
                  showInfo={false}
                  size={{ height: 12 }}
                />
                <div className="bar-progress-text">
                  {qixueCurrent}/{character.maxQixue}
                </div>
              </div>
            </div>
            <div className="bar-item">
              <span className="bar-label">灵</span>
              <div className="bar-progress">
                <Progress
                  percent={lingqiPercent}
                  strokeColor="var(--primary-color)"
                  railColor="var(--progress-rail-color)"
                  showInfo={false}
                  size={{ height: 12 }}
                />
                <div className="bar-progress-text">
                  {lingqiCurrent}/{character.maxLingqi}
                </div>
              </div>
            </div>
            <div className="bar-item">
              <span className="bar-label">体</span>
              <div className="bar-progress">
                <Progress
                  percent={staminaPercent}
                  strokeColor="var(--success-color)"
                  railColor="var(--progress-rail-color)"
                  showInfo={false}
                  size={{ height: 12 }}
                />
                <div className="bar-progress-text">
                  {staminaCurrent}/{staminaMax}
                </div>
              </div>
            </div>
            <div className="bar-item">
              <span className="bar-label">修</span>
              <div className="bar-exp">
                <div className="bar-progress">
                  <Progress
                    percent={expPercent}
                    strokeColor="var(--warning-color)"
                    railColor="var(--progress-rail-color)"
                    showInfo={false}
                    size={{ height: 10 }}
                  />
                  <div className="bar-progress-text">{expText}</div>
                </div>
                <div className="bar-exp-label">经验: {expDetailText}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="attr-section">
        <div className="attr-section-header">
          <div className="attr-section-title">基础属性</div>
          <div className="attr-section-sub">
            剩余属性点: <span className="attr-section-sub-value">{character.attributePoints}</span>
          </div>
        </div>

        <div className="base-rows">
          {([
            { key: 'jing' as const, label: '精' },
            { key: 'qi' as const, label: '气' },
            { key: 'shen' as const, label: '神' },
          ]).map((row) => (
            <div key={row.key} className="base-row">
              <div className="base-left">
                <span className="base-label">{row.label}</span>
                <span className="base-value">{character[row.key]}</span>
              </div>
              <div className="base-actions">
                <Button
                  size="small"
                  onClick={() => handleRemovePoint(row.key)}
                  disabled={character[row.key] <= 0 || processingPoint === `remove-${row.key}`}
                  loading={processingPoint === `remove-${row.key}`}
                >
                  -
                </Button>
                <Button
                  size="small"
                  onClick={() => handleAddPoint(row.key)}
                  disabled={character.attributePoints <= 0 || processingPoint === `add-${row.key}`}
                  loading={processingPoint === `add-${row.key}`}
                >
                  +
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="attr-section">
        <div className="attr-section-title">战斗属性</div>
        <div className="player-attrs">
          {combatAttributes.map((attr) => (
            <div key={attr.label} className="attr-item">
              <span className="attr-label">{attr.label}</span>
              <span className="attr-value">{attr.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="attr-section">
        <div className="attr-section-title">辅助属性</div>
        <div className="player-attrs">
          {assistAttributes.map((attr) => (
            <div key={attr.label} className="attr-item">
              <span className="attr-label">{attr.label}</span>
              <span className="attr-value">{attr.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PlayerInfo;
