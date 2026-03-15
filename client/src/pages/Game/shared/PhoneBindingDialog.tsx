import { App, Button, Input, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  bindPhoneNumber,
  getUnifiedApiErrorMessage,
  sendPhoneBindingCode,
} from '../../../services/api';
import { invalidatePhoneBindingStatus } from './usePhoneBindingStatus';

/**
 * 手机号绑定弹窗
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承接手机号输入、验证码发送和验证码提交绑定交互，供玩家信息入口和坊市拦截复用。
 * 2. 做什么：绑定成功后统一失效手机号状态缓存，避免多个入口分别维护同步逻辑。
 * 3. 不做什么：不读取手机号绑定状态，也不决定哪个业务场景必须弹出本弹窗。
 *
 * 输入/输出：
 * - 输入：弹窗开关、关闭回调、成功回调，以及场景化文案。
 * - 输出：手机号绑定交互 UI；成功后触发 `onSuccess`。
 *
 * 数据流/状态流：
 * 打开弹窗 -> 输入手机号 -> 发送验证码 -> 输入验证码 -> 提交绑定 -> 失效共享状态缓存 -> 调用方刷新。
 *
 * 关键边界条件与坑点：
 * 1. 发送验证码和提交绑定都必须走同一手机号输入值，不能让调用方在外层再拼一套表单状态。
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
  description = '绑定手机号后，可继续使用坊市相关功能。',
}) => {
  const { message } = App.useApp();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [binding, setBinding] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!open) {
      setVerificationCode('');
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
    return sendingCode || binding || countdown > 0 || !phoneNumber.trim();
  }, [binding, countdown, phoneNumber, sendingCode]);

  const confirmDisabled = useMemo(() => {
    return binding || sendingCode || !phoneNumber.trim() || !verificationCode.trim();
  }, [binding, phoneNumber, sendingCode, verificationCode]);

  const handleSendCode = async (): Promise<void> => {
    if (!phoneNumber.trim()) {
      message.warning('请输入手机号');
      return;
    }

    setSendingCode(true);
    try {
      const response = await sendPhoneBindingCode(phoneNumber.trim(), SILENT_REQUEST_CONFIG);
      const cooldownSeconds = response.data?.cooldownSeconds ?? 60;
      setCountdown(cooldownSeconds);
      message.success('验证码已发送');
    } catch (error) {
      message.error(getUnifiedApiErrorMessage(error, '发送验证码失败'));
    } finally {
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
      title={title}
      onCancel={onClose}
      onOk={() => {
        void handleBindPhoneNumber();
      }}
      okText="确认绑定"
      cancelText="取消"
      okButtonProps={{
        loading: binding,
        disabled: confirmDisabled,
      }}
      cancelButtonProps={{
        disabled: binding || sendingCode,
      }}
      destroyOnHidden
      centered
      width={420}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ color: 'var(--text-secondary)' }}>{description}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-color)' }}>手机号</div>
          <Input
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="请输入大陆手机号"
            inputMode="numeric"
            maxLength={20}
            disabled={binding}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-color)' }}>验证码</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
              placeholder="请输入 6 位验证码"
              inputMode="numeric"
              maxLength={6}
              disabled={binding}
            />
            <Button
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
    </Modal>
  );
};

export default PhoneBindingDialog;
