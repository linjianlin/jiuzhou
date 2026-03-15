/**
 * 通用图片验证码输入行
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染“验证码输入框 + 图片刷新按钮”的交互外观，供坊市弹窗和手机号绑定弹窗复用，避免同一套输入与刷新 UI 再复制一遍。
 * 2. 做什么：集中约束图片验证码输入格式为 4 位大写字母数字，让服务端统一的 `captchaId/captchaCode` 契约在多个弹窗里保持一致。
 * 3. 不做什么：不负责请求验证码图片，不保存 `captchaId`，也不决定点击确认后要触发哪段业务逻辑。
 *
 * 输入/输出：
 * - 输入：当前验证码图片、输入值、禁用态、刷新行为和场景文案。
 * - 输出：标准化后的验证码输入值，以及统一样式的图片验证码输入行。
 *
 * 数据流/状态流：
 * - 调用方拉取验证码并把 `captcha` 传入；
 * - 用户输入图片验证码 -> 组件统一做 trim + 大写归一化 -> 回传给调用方；
 * - 用户点击图片 -> 调用方刷新验证码并同步新的 `captchaId`。
 *
 * 关键边界条件与坑点：
 * 1. 图片验证码答案大小写不敏感，因此输入值必须在组件内统一归一化，避免不同弹窗各自处理造成口径漂移。
 * 2. 组件只处理输入展示，不兜底图片缺失场景；图片为空时只展示占位文案，由调用方决定何时重试与何时提示错误。
 */
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Input } from 'antd';

import type { CaptchaChallenge } from '../../services/api/auth-character';
import './CaptchaChallengeInput.scss';

interface CaptchaChallengeInputProps {
  value: string;
  captcha: CaptchaChallenge | null;
  loading: boolean;
  disabled?: boolean;
  className?: string;
  inputPlaceholder?: string;
  imageAlt?: string;
  refreshAriaLabel?: string;
  loadingLabel?: string;
  emptyLabel?: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
}

const normalizeCaptchaCode = (value: string): string => value.trim().toUpperCase();

const resolveRootClassName = (className?: string): string => {
  return className ? `captcha-challenge-input ${className}` : 'captcha-challenge-input';
};

export default function CaptchaChallengeInput({
  value,
  captcha,
  loading,
  disabled = false,
  className,
  inputPlaceholder = '输入图片验证码',
  imageAlt = '图片验证码',
  refreshAriaLabel = '刷新图片验证码',
  loadingLabel = '加载中...',
  emptyLabel = '点击重试',
  onChange,
  onRefresh,
}: CaptchaChallengeInputProps) {
  return (
    <div className={resolveRootClassName(className)}>
      <div className="captcha-challenge-input__row">
        <Input
          className="captcha-challenge-input__field"
          value={value}
          maxLength={4}
          autoComplete="off"
          prefix={<SafetyCertificateOutlined />}
          placeholder={inputPlaceholder}
          disabled={disabled}
          onChange={(event) => {
            onChange(normalizeCaptchaCode(event.target.value));
          }}
        />
        <button
          type="button"
          className="captcha-challenge-input__image-button"
          disabled={loading || disabled}
          onClick={onRefresh}
          aria-label={refreshAriaLabel}
        >
          {captcha ? (
            <img
              className="captcha-challenge-input__image"
              src={captcha.imageData}
              alt={imageAlt}
            />
          ) : (
            <span className="captcha-challenge-input__placeholder">
              {loading ? loadingLabel : emptyLabel}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
