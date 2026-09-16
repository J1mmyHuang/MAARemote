export const THEME_STORAGE_KEY = 'maaremote.theme-preference';
export const THEME_PREFERENCES = new Set(['system', 'light', 'dark']);

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.has(value) ? value : 'system';
}

export function resolveTheme(preference, systemDark = false) {
  const normalized = normalizeThemePreference(preference);
  if (normalized === 'system') return systemDark ? 'dark' : 'light';
  return normalized;
}

export function readThemePreference(storage = globalThis.localStorage) {
  try {
    return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeThemePreference(storage = globalThis.localStorage, preference) {
  const normalized = normalizeThemePreference(preference);
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // 隐私模式或策略禁用 localStorage 时仍允许本次会话切换主题。
  }
  return normalized;
}

export function applyTheme(preference, {
  documentElement = globalThis.document?.documentElement,
  mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)'),
} = {}) {
  const normalized = normalizeThemePreference(preference);
  const resolved = resolveTheme(normalized, Boolean(mediaQuery?.matches));
  if (documentElement) {
    documentElement.dataset.theme = resolved;
    documentElement.dataset.themePreference = normalized;
    documentElement.style.colorScheme = resolved;
  }
  return { preference: normalized, resolved };
}
