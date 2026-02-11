export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ui_theme_v1';
export const THEME_EVENT_NAME = 'app:theme';

export const parseThemeMode = (raw: string | null | undefined): ThemeMode => {
  return raw === 'dark' ? 'dark' : 'light';
};

export const getStoredThemeMode = (): ThemeMode => {
  return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
};

export const persistThemeMode = (mode: ThemeMode): void => {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
};

export const emitThemeModeChange = (mode: ThemeMode): void => {
  window.dispatchEvent(new CustomEvent(THEME_EVENT_NAME, { detail: { mode } }));
};
