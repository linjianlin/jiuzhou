/**
 * 坊市购买验证码弹窗（支持 local 图片验证码和天御验证码双模式）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在坊市购买命中行为风控时，根据 captchaConfig.provider 拉起图片验证码弹窗或天御弹窗，完成验证后通知父组件重试购买。
 * 2. 做什么：复用 useCaptchaConfig / useCaptchaChallenge / useTencentCaptcha，确保坊市验证码与登录验证码拥有一致的模式切换语义。
 * 3. 不做什么：不决定具体购买哪条挂单；验证通过后的购买重试由父组件处理。
 *
 * 输入/输出：
 * - 输入：弹窗开关、取消回调、验证通过回调。
 * - 输出：标准 Ant Design Modal，验证成功后通知父组件继续购买。
 *
 * 数据流/状态流：
 * - local 模式：弹窗打开 -> 拉取坊市验证码 -> 用户输入 -> 提交验证 -> 成功后交给父组件
 * - tencent 模式：弹窗打开 -> 自动触发天御弹窗 -> 票据提交服务端 -> 成功后交给父组件；用户取消则关闭弹窗
 *
 * 关键边界条件与坑点：
 * 1. local 模式下验证失败后必须刷新图片验证码，因为服务端验证码是一次性消费。
 * 2. tencent 模式下 open 变为 true 时自动触发天御，不渲染额外按钮；用 ref 防止 StrictMode 双触发。
 */
import { App, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';

import {
  getMarketPurchaseCaptcha,
  verifyMarketPurchaseCaptcha,
} from '../../../../services/api';
import { getUnifiedApiErrorMessage } from '../../../../services/api/error';
import CaptchaChallengeInput from '../../../shared/CaptchaChallengeInput';
import { useCaptchaChallenge } from '../../../shared/useCaptchaChallenge';
import { useCaptchaConfig } from '../../../shared/useCaptchaConfig';
import { useTencentCaptcha } from '../../../shared/useTencentCaptcha';

interface MarketCaptchaDialogProps {
  open: boolean;
  onCancel: () => void;
  onVerified: () => Promise<void>;
}

export default function MarketCaptchaDialog({
  open,
  onCancel,
  onVerified,
}: MarketCaptchaDialogProps) {
  const { config, isTencent } = useCaptchaConfig();

  if (isTencent) {
    return (
      <MarketCaptchaDialogTencent
        open={open}
        appId={config.tencentAppId ?? 0}
        onCancel={onCancel}
        onVerified={onVerified}
      />
    );
  }

  return (
    <MarketCaptchaDialogLocal
      open={open}
      onCancel={onCancel}
      onVerified={onVerified}
    />
  );
}

/** local 模式：图片验证码输入弹窗 */
function MarketCaptchaDialogLocal({
  open,
  onCancel,
  onVerified,
}: MarketCaptchaDialogProps) {
  const { message } = App.useApp();
  const [captchaCode, setCaptchaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { captcha, loading, refreshCaptcha } = useCaptchaChallenge({
    enabled: open,
    refreshNonce: open ? 1 : 0,
    loadCaptcha: getMarketPurchaseCaptcha,
    fallbackMessage: '坊市验证码加载失败',
    onLoadError: (errorMessage) => {
      message.error(errorMessage);
    },
  });

  useEffect(() => {
    if (!open) {
      setCaptchaCode('');
    }
  }, [open]);

  const handleSubmit = async (): Promise<void> => {
    if (!captcha || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      await verifyMarketPurchaseCaptcha({
        captchaId: captcha.captchaId,
        captchaCode,
      });
      setCaptchaCode('');
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error, '坊市验证码校验失败'));
      setCaptchaCode('');
      await refreshCaptcha();
      setSubmitting(false);
      return;
    }

    try {
      await onVerified();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      onOk={() => { void handleSubmit(); }}
      okText="验证并继续购买"
      cancelText="取消"
      title="坊市验证"
      centered
      destroyOnHidden
      confirmLoading={submitting}
      okButtonProps={{
        disabled: loading || !captcha || captchaCode.trim().length !== 4,
      }}
      className="market-captcha-dialog"
    >
      <div className="market-captcha-dialog__body">
        <div className="market-captcha-dialog__tip">
          检测到坊市访问行为异常，请完成一次图片验证码验证后继续购买。
        </div>
        <CaptchaChallengeInput
          value={captchaCode}
          captcha={captcha}
          loading={loading}
          disabled={submitting}
          inputPlaceholder="输入图片验证码"
          imageAlt="坊市验证码"
          refreshAriaLabel="刷新坊市验证码"
          onChange={setCaptchaCode}
          onRefresh={() => { void refreshCaptcha(); }}
        />
      </div>
    </Modal>
  );
}

/** tencent 模式：弹窗打开时自动触发天御验证码，无需额外按钮 */
function MarketCaptchaDialogTencent({
  open,
  appId,
  onCancel,
  onVerified,
}: MarketCaptchaDialogProps & { appId: number }) {
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const { triggerCaptcha } = useTencentCaptcha(appId);
  // 防止 useEffect 重复触发
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (!open) {
      triggeredRef.current = false;
      return;
    }
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    const run = async (): Promise<void> => {
      setSubmitting(true);
      try {
        const ticket = await triggerCaptcha();
        await verifyMarketPurchaseCaptcha({
          ticket: ticket.ticket,
          randstr: ticket.randstr,
        });
      } catch (error) {
        const err = error as Error;
        if (err.message !== '用户取消验证') {
          message.error(getUnifiedApiErrorMessage(error, '坊市验证码校验失败'));
        }
        setSubmitting(false);
        onCancel();
        return;
      }

      try {
        await onVerified();
      } finally {
        setSubmitting(false);
      }
    };

    void run();
  }, [open, message, onCancel, onVerified, triggerCaptcha]);

  // tencent 模式下不渲染弹窗 UI，天御 SDK 自行管理弹窗
  if (!submitting) return null;

  return (
    <Modal
      open={open}
      footer={null}
      closable={false}
      centered
      width={280}
      className="market-captcha-dialog"
    >
      <div className="market-captcha-dialog__body" style={{ textAlign: 'center', padding: '24px 0' }}>
        验证中…
      </div>
    </Modal>
  );
}
