/**
 * 手机号共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护大陆手机号的归一化、合法性校验与脱敏展示规则，供绑定服务、路由参数校验和展示 DTO 复用。
 * 2. 做什么：把 `+86`、空格、短横线处理收敛到单一入口，避免多个模块各写一套清洗逻辑。
 * 3. 不做什么：不读写数据库、不发送短信，也不决定具体业务提示文案。
 *
 * 输入/输出：
 * - 输入：原始手机号字符串。
 * - 输出：规范化后的 11 位大陆手机号，或用于 UI 展示的脱敏手机号。
 *
 * 数据流/状态流：
 * 路由/服务接收原始手机号 -> 本模块归一化 -> 绑定服务写库 / 返回脱敏展示值。
 *
 * 关键边界条件与坑点：
 * 1. 归一化后只接受 11 位大陆手机号，避免把国际号码或不完整号码误存入账号主表。
 * 2. 脱敏逻辑必须只依赖规范化手机号，不能对原始输入直接截断，否则 `+86` 等前缀会导致展示错位。
 */

const MAINLAND_PHONE_PATTERN = /^1[3-9]\d{9}$/;

const stripPhoneSeparators = (raw: string): string => {
  return raw.replace(/[\s-]+/g, '');
};

export const normalizeMainlandPhoneNumber = (raw: string): string => {
  const trimmed = raw.trim();
  const withoutSeparators = stripPhoneSeparators(trimmed);
  const normalized = withoutSeparators.startsWith('+86')
    ? withoutSeparators.slice(3)
    : withoutSeparators.startsWith('86') && withoutSeparators.length === 13
      ? withoutSeparators.slice(2)
      : withoutSeparators;

  if (!MAINLAND_PHONE_PATTERN.test(normalized)) {
    throw new Error('手机号格式错误，请输入正确的大陆手机号');
  }

  return normalized;
};

export const maskPhoneNumber = (phoneNumber: string): string => {
  return `${phoneNumber.slice(0, 3)}****${phoneNumber.slice(7)}`;
};
