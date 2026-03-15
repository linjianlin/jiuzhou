import { App, Button, Input, Modal } from 'antd';
import { MobileOutlined, MessageOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import {
  bindPhoneNumber,
  getCaptcha,
  getUnifiedApiErrorMessage,
  sendPhoneBindingCode,
} from '../../../services/api';
import CaptchaChallengeInput from '../../shared/CaptchaChallengeInput';
import { useCaptchaChallenge } from '../../shared/useCaptchaChallenge';
import { invalidatePhoneBindingStatus } from './usePhoneBindingStatus';
import './PhoneBindingDialog.scss';

/**
 * 手机号绑定弹窗
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承接手机号输入、图片验证码校验、短信验证码发送和最终绑定交互，供玩家信息入口和坊市拦截复用。
 * 2. 做什么：绑定成功后统一失效手机号状态缓存，避免多个入口分别维护同步逻辑。
 * 3. 不做什么：不读取手机号绑定状态，也不决定哪个业务场景必须弹出本弹窗。
 *
 * 输入/输出：
 * - 输入：弹窗开关、关闭回调、成功回调，以及场景化文案。
 * - 输出：手机号绑定交互 UI；成功后触发 `onSuccess`。
 *
 * 数据流/状态流：
 * 打开弹窗 -> 拉取图片验证码 -> 输入手机号与图片验证码 -> 发送短信验证码 -> 输入短信验证码 -> 提交绑定 -> 失效共享状态缓存 -> 调用方刷新。
 *
 * 关键边界条件与坑点：
 * 1. 图片验证码只在“发送短信验证码”时校验，但它是服务端一次性消费资源，所以每次发送尝试后都必须刷新，不能复用旧 `captchaId`。
 * 2. 倒计时只表示当前前端会话的发送节流，真正的限制以后端 Redis 为准，不能因为本地重开弹窗就绕过服务端校验。
 */

const SILENT_REQUEST_CONFIG = { meta: { autoErrorToast: false } } as const;

interface PhoneBindingDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
  title?: string;
  description?: string;
}

const PhoneBindingDialog: React.FC<PhoneBindingDialogProps> = ({
  open,
  onClose,
  onSuccess,
  title = '绑定手机号',
  description = '绑定手机号后，可继续使用坊市相关功能。每个手机号只能绑定一个账号，请务必填写真实手机号，后续可能会进行随机安全验证。',
}) => {
  const { message } = App.useApp();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [binding, setBinding] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const { captcha, loading: captchaLoading, refreshCaptcha } = useCaptchaChallenge({
    enabled: open,
    refreshNonce: open ? 1 : 0,
    loadCaptcha: getCaptcha,
    fallbackMessage: '图片验证码加载失败',
    onLoadError: (errorMessage) => {
      message.error(errorMessage);
    },
  });

  useEffect(() => {
    if (!open) {
      setVerificationCode('');
      setCaptchaCode('');
      setSendingCode(false);
      setBinding(false);
      setCountdown(0);
    }
  }, [open]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setCountdown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const sendCodeDisabled = useMemo(() => {
    return (
      sendingCode
      || binding
      || countdown > 0
      || captchaLoading
      || !captcha
      || !phoneNumber.trim()
      || captchaCode.trim().length !== 4
    );
  }, [binding, captcha, captchaCode, captchaLoading, countdown, phoneNumber, sendingCode]);

  const confirmDisabled = useMemo(() => {
    return binding || sendingCode || !phoneNumber.trim() || !verificationCode.trim();
  }, [binding, phoneNumber, sendingCode, verificationCode]);

  const handleSendCode = async (): Promise<void> => {
    if (!phoneNumber.trim()) {
      message.warning('请输入手机号');
      return;
    }
    if (!captcha) {
      message.warning('图片验证码加载中，请稍后重试');
      return;
    }
    if (captchaCode.trim().length !== 4) {
      message.warning('请输入图片验证码');
      return;
    }

    setSendingCode(true);
    try {
      const response = await sendPhoneBindingCode(
        phoneNumber.trim(),
        {
          captchaId: captcha.captchaId,
          captchaCode,
        },
        SILENT_REQUEST_CONFIG,
      );
      const cooldownSeconds = response.data?.cooldownSeconds;
      if (typeof cooldownSeconds !== 'number') {
        throw new Error('发送验证码响应缺少冷却时间');
      }
      setCountdown(cooldownSeconds);
      message.success('验证码已发送');
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error, '发送验证码失败'));
    } finally {
      setCaptchaCode('');
      await refreshCaptcha();
      setSendingCode(false);
    }
  };

  const handleBindPhoneNumber = async (): Promise<void> => {
    if (!phoneNumber.trim()) {
      message.warning('请输入手机号');
      return;
    }
    if (!verificationCode.trim()) {
      message.warning('请输入验证码');
      return;
    }

    setBinding(true);
    try {
      await bindPhoneNumber(phoneNumber.trim(), verificationCode.trim(), SILENT_REQUEST_CONFIG);
      invalidatePhoneBindingStatus();
      message.success('手机号绑定成功');
      await onSuccess?.();
      onClose();
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error, '手机号绑定失败'));
    } finally {
      setBinding(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      closable
      destroyOnHidden
      centered
      width={420}
      className="phone-binding-dialog"
    >
      <div className="phone-binding">
        <div className="phone-binding__header">
          <h3 className="phone-binding__title">{title}</h3>
          <div className="phone-binding__hint">{description}</div>
        </div>

        <div className="phone-binding__form">
          <div className="phone-binding__field">
            <span className="phone-binding__label">手机号</span>
            <Input
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="请输入大陆手机号"
              prefix={<MobileOutlined />}
              inputMode="numeric"
              maxLength={20}
              disabled={binding}
            />
          </div>

          <div className="phone-binding__field">
            <span className="phone-binding__label">图片验证码</span>
            <CaptchaChallengeInput
              value={captchaCode}
              captcha={captcha}
              loading={captchaLoading}
              disabled={binding || sendingCode}
              inputPlaceholder="请输入图片验证码"
              imageAlt="手机号绑定图片验证码"
              refreshAriaLabel="刷新手机号绑定图片验证码"
              onChange={setCaptchaCode}
              onRefresh={() => {
                void refreshCaptcha();
              }}
            />
          </div>

          <div className="phone-binding__field">
            <span className="phone-binding__label">短信验证码</span>
            <div className="phone-binding__code-row">
              <Input
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value)}
                placeholder="请输入 6 位验证码"
                prefix={<MessageOutlined />}
                inputMode="numeric"
                maxLength={6}
                disabled={binding}
              />
              <Button
                className="phone-binding__send-btn"
                onClick={() => {
                  void handleSendCode();
                }}
                loading={sendingCode}
                disabled={sendCodeDisabled}
              >
                {countdown > 0 ? `${countdown}s` : '发送验证码'}
              </Button>
            </div>
          </div>
        </div>

        <div className="phone-binding__actions">
          <Button
            disabled={binding || sendingCode}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="primary"
            loading={binding}
            disabled={confirmDisabled}
            onClick={() => {
              void handleBindPhoneNumber();
            }}
          >
            确认绑定
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default PhoneBindingDialog;
