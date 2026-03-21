/**
 * 作用：集中管理战斗显示偏好的本地持久化与事件广播；当前只负责“战斗单位头像背景是否显示”。
 * 不做什么：不直接参与战斗组件渲染，不决定具体展示哪些单位，也不处理服务端设置同步。
 *
 * 输入/输出：
 * - 输入：`localStorage` 里的持久化值，以及用户在设置面板里切换后的布尔值。
 * - 输出：供设置面板与 BattleArea 复用的读取、提交、广播能力。
 *
 * 数据流/状态流：
 * - SettingModal 读取当前偏好并在用户切换时调用统一提交入口。
 * - 统一提交入口写入 `localStorage` 后广播事件。
 * - BattleArea 监听同一事件并刷新本地显示状态，避免多个组件各自维护一套偏好源。
 *
 * 关键边界条件与坑点：
 * 1. 未写入持久化记录时默认显示头像，这是当前战斗界面的既有行为，不能因为新增设置而静默改默认值。
 * 2. 持久化值只接受 `0/1`，非法值必须视为“未配置”，避免不同模块各自解释字符串导致口径不一致。
 */

export const BATTLE_AVATAR_VISIBILITY_STORAGE_KEY = 'battle_avatar_visibility_v1';
export const BATTLE_AVATAR_VISIBILITY_EVENT_NAME = 'app:battle-avatar-visibility';

export const parseBattleAvatarVisibility = (raw: string | null | undefined): boolean | null => {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
};

export const getPersistedBattleAvatarVisibility = (): boolean | null => {
  return parseBattleAvatarVisibility(localStorage.getItem(BATTLE_AVATAR_VISIBILITY_STORAGE_KEY));
};

export const getStoredBattleAvatarVisibility = (): boolean => {
  return getPersistedBattleAvatarVisibility() ?? true;
};

export const persistBattleAvatarVisibility = (visible: boolean): void => {
  localStorage.setItem(BATTLE_AVATAR_VISIBILITY_STORAGE_KEY, visible ? '1' : '0');
};

export const emitBattleAvatarVisibilityChange = (visible: boolean): void => {
  window.dispatchEvent(
    new CustomEvent(BATTLE_AVATAR_VISIBILITY_EVENT_NAME, {
      detail: { visible },
    }),
  );
};

export const commitBattleAvatarVisibilitySelection = (visible: boolean): void => {
  persistBattleAvatarVisibility(visible);
  emitBattleAvatarVisibilityChange(visible);
};
