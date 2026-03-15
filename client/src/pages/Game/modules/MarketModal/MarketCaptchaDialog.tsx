/**
 * 坊市购买验证码弹窗
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在坊市购买命中行为风控时，统一拉起图片验证码弹窗，完成验证码刷新、输入与提交。
 * 2. 做什么：复用通用验证码 Hook，确保坊市验证码与登录验证码拥有一致的图片拉取与并发淘汰语义。
 * 3. 不做什么：不决定具体购买哪条挂单；验证通过后的购买重试由父组件处理。
 *
 * 输入/输出：
 * - 输入：弹窗开关、取消回调、验证通过回调。
 * - 输出：标准 Ant Design Modal，验证成功后通知父组件继续购买。
 *
 * 数据流/状态流：
 * - 弹窗打开 -> 拉取坊市验证码 -> 用户输入验证码 -> 提交验证 -> 成功后交给父组件重试购买。
 *
 * 关键边界条件与坑点：
 * 1. 验证失败后必须刷新图片验证码，因为服务端验证码是一性消费，不能沿用旧 `captchaId` 重试。
 * 2. 关闭弹窗时要清空输入值和验证码状态，避免下次打开时残留上一次的输入内容。
 */
import { App, Modal } from 'antd';
import { useEffect, useState } from 'react';

import {
  getMarketPurchaseCaptcha,
  verifyMarketPurchaseCaptcha,
} from '../../../../services/api';
import { getUnifiedApiErrorMessage } from '../../../../services/api/error';
import CaptchaChallengeInput from '../../../shared/CaptchaChallengeInput';
import { useCaptchaChallenge } from '../../../shared/useCaptchaChallenge';

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
      onOk={() => {
        void handleSubmit();
      }}
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
          onRefresh={() => {
            void refreshCaptcha();
          }}
        />
      </div>
    </Modal>
  );
}
