export const THEME_STORAGE_KEY = "codex-deck:theme:v1";
export const THEME_ATTRIBUTE = "data-theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

interface ThemePreferenceReader {
  getItem(key: string): string | null;
}

interface ThemePreferenceWriter {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isThemePreference(
  value: string | null | undefined,
): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

export function readStoredThemePreference(
  storage: ThemePreferenceReader | null | undefined,
): ThemePreference {
  if (!storage) {
    return "system";
  }

  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function persistThemePreference(
  storage: ThemePreferenceWriter | null | undefined,
  preference: ThemePreference,
): void {
  if (!storage) {
    return;
  }

  try {
    if (preference === "system") {
      storage.removeItem(THEME_STORAGE_KEY);
      return;
    }
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore storage failures; theme state still updates for this tab.
  }
}

export function getSystemPrefersDark(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getNextThemePreference(
  currentPreference: ThemePreference,
  systemPrefersDark: boolean,
): ThemePreference {
  return resolveThemePreference(currentPreference, systemPrefersDark) === "dark"
    ? "light"
    : "dark";
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: HTMLElement | null | undefined = typeof document !== "undefined"
    ? document.documentElement
    : null,
): void {
  if (!root) {
    return;
  }

  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.style.colorScheme = theme;
  root.classList.toggle("dark", theme === "dark");
}
