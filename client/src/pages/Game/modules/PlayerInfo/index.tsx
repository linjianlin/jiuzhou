import { App, Button, Progress, Tooltip, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { UserOutlined, LoadingOutlined, MinusOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gameSocket, type CharacterData } from '../../../../services/gameSocket';
import {
  resolveAvatarUrl,
  getRealmOverview,
  uploadAvatar,
  addAttributePoint,
  removeAttributePoint,
  type RealmOverviewDto,
  type UploadResponse,
} from '../../../../services/api';
import { CHARACTER_PRIMARY_ATTR_META_LIST } from '../../shared/characterPrimaryAttrMeta';
import { formatPercent, formatRecovery } from '../../shared/formatAttr';
import PhoneBindingDialog from '../../shared/PhoneBindingDialog';
import PlayerName from '../../shared/PlayerName';
import { usePhoneBindingStatus } from '../../shared/usePhoneBindingStatus';
import './index.scss';

const CHARACTER_REFRESH_INTERVAL_MS = 30_000;
const SILENT_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;

const PlayerInfo: React.FC = () => {
  const { message } = App.useApp();
  const messageRef = useRef(message);
  const [character, setCharacter] = useState<CharacterData | null>(null);
  const [realmOverview, setRealmOverview] = useState<RealmOverviewDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processingPoint, setProcessingPoint] = useState<string | null>(null);
  const [phoneBindingDialogOpen, setPhoneBindingDialogOpen] = useState(false);
  const {
    status: phoneBindingStatus,
    loading: phoneBindingStatusLoading,
    errorMessage: phoneBindingStatusErrorMessage,
    refresh: refreshPhoneBindingStatus,
  } = usePhoneBindingStatus(true);

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
    getRealmOverview(SILENT_REQUEST_CONFIG)
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
  const handleAvatarUpload: UploadProps<UploadResponse>['customRequest'] = async (options) => {
    const file = options.file as File;
    setUploading(true);

    try {
      const result = await uploadAvatar(file, {
        onProgress: (percent) => {
          options.onProgress?.({ percent });
        },
      });
      if (result.success) {
        options.onSuccess?.(result);
        if (result.avatarUrl) {
          gameSocket.updateCharacterLocal({ avatar: result.avatarUrl });
        }
        message.success('头像上传成功');
        // 刷新角色数据
        gameSocket.refreshCharacter();
      } else {
        const uploadError = new Error(result.message || '头像上传失败');
        options.onError?.(uploadError);
      }
    } catch (error) {
      const uploadError = error instanceof Error ? error : new Error('头像上传失败');
      options.onError?.(uploadError);
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
        void 0;
      }
    } catch {
      void 0;
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
        void 0;
      }
    } catch {
      void 0;
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

  const avatarUrl = resolveAvatarUrl(character.avatar);
  const qixueCurrent = Math.min(character.qixue, character.maxQixue);
  const lingqiCurrent = Math.min(character.lingqi, character.maxLingqi);
  const staminaMax = Math.max(1, Math.floor(Number(character.staminaMax) || 1));
  const staminaCurrent = Math.min(staminaMax, Math.max(0, Number(character.stamina) || 0));
  const qixuePercent = clampPercent(character.maxQixue > 0 ? (qixueCurrent / character.maxQixue) * 100 : 0);
  const lingqiPercent = clampPercent(character.maxLingqi > 0 ? (lingqiCurrent / character.maxLingqi) * 100 : 0);
  const staminaPercent = clampPercent(staminaMax > 0 ? (staminaCurrent / staminaMax) * 100 : 0);
  const expCurrent = Math.max(0, Number(character.exp) || 0);
  const expPercent = clampPercent(
    expNeed && expNeed > 0 ? (expCurrent / expNeed) * 100 : realmOverview?.nextRealm ? 0 : 100,
  );
  const expText = `${expPercent.toFixed(2).replace(/(\.\d*[1-9])0+$|\.0+$/, '$1')}%`;
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
  const phoneBindingEnabled = phoneBindingStatus?.enabled === true;
  const phoneBindingBound = phoneBindingStatus?.isBound === true;
  const shouldShowPhoneBindingSection = phoneBindingStatusLoading
    || Boolean(phoneBindingStatusErrorMessage)
    || !phoneBindingEnabled
    || !phoneBindingBound;

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
              </div>
            ) : avatarUrl ? (
              <img className="player-avatar-img" src={avatarUrl} alt="头像" />
            ) : (
              <div className="player-avatar-placeholder">
                <UserOutlined />
              </div>
            )}
          </div>
        </Upload>

        <div className="player-top-right">
          <div className="player-name">
            <span className="player-title">{character.title}</span>
            <PlayerName
              name={character.nickname}
              monthCardActive={character.monthCardActive}
              ellipsis
              className="player-name-text"
            />
          </div>
          <div className="player-meta-row">
            <span className="player-meta-tag">ID: {character.id}</span>
            <span className="player-meta-tag">
              {character.realm}{character.subRealm ? ` · ${character.subRealm}` : ''}
            </span>
          </div>
        </div>
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
              size={{ height: 10 }}
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
              size={{ height: 10 }}
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
              size={{ height: 10 }}
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

      {shouldShowPhoneBindingSection ? (
        <div className="attr-section">
          <div className="attr-section-header">
            <div className="attr-section-title">账号安全</div>
          </div>
          {phoneBindingStatusLoading ? (
            <div className="player-phone-binding-tip">手机号状态读取中...</div>
          ) : phoneBindingStatusErrorMessage ? (
            <div className="player-phone-binding-row">
              <div className="player-phone-binding-tip player-phone-binding-tip--error">{phoneBindingStatusErrorMessage}</div>
              <Button
                size="small"
                onClick={() => {
                  void refreshPhoneBindingStatus();
                }}
              >
                重新加载
              </Button>
            </div>
          ) : phoneBindingEnabled ? (
            <div className="player-phone-binding-row">
              <div className="player-phone-binding-tip">绑定手机号后可使用物品坊市与伙伴坊市。</div>
              <Button
                type="primary"
                size="small"
                onClick={() => setPhoneBindingDialogOpen(true)}
              >
                立即绑定
              </Button>
            </div>
          ) : (
            <div className="player-phone-binding-tip">当前服务器未开启坊市手机号绑定。</div>
          )}
        </div>
      ) : null}

      <div className="attr-section">
        <div className="attr-section-header">
          <div className="attr-section-title">基础属性</div>
          <div className="attr-section-sub">
            剩余属性点: <span className="attr-section-sub-value">{character.attributePoints}</span>
          </div>
        </div>

        <div className="base-rows">
          {CHARACTER_PRIMARY_ATTR_META_LIST.map((row) => (
            <div key={row.key} className="base-row">
              <Tooltip
                placement="topLeft"
                title={(
                  <div className="primary-attr-tooltip">
                    <div className="primary-attr-tooltip-title">{row.label}</div>
                    <div className="primary-attr-tooltip-summary">{row.summary}</div>
                    <div className="primary-attr-tooltip-effects">
                      {row.effects.map((effect) => (
                        <div key={effect} className="primary-attr-tooltip-effect">
                          {effect}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              >
                <div className="base-left base-left--tooltip">
                  <span className="base-label">{row.label}</span>
                  <span className="base-value">{character[row.key]}</span>
                </div>
              </Tooltip>
              <div className="base-actions">
                <Button
                  size="small"
                  aria-label={`减少${row.label}`}
                  icon={<MinusOutlined />}
                  onClick={() => handleRemovePoint(row.key)}
                  disabled={character[row.key] <= 0 || processingPoint === `remove-${row.key}`}
                  loading={processingPoint === `remove-${row.key}`}
                />
                <Button
                  size="small"
                  aria-label={`增加${row.label}`}
                  icon={<PlusOutlined />}
                  onClick={() => handleAddPoint(row.key)}
                  disabled={character.attributePoints <= 0 || processingPoint === `add-${row.key}`}
                  loading={processingPoint === `add-${row.key}`}
                />
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

      <PhoneBindingDialog
        open={phoneBindingDialogOpen}
        onClose={() => setPhoneBindingDialogOpen(false)}
        onSuccess={async () => {
          await refreshPhoneBindingStatus();
        }}
        description="绑定手机号后，可使用物品坊市与伙伴坊市。"
      />
    </div>
  );
};

export default PlayerInfo;
