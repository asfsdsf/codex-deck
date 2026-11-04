export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 20;

const TERMINAL_FONT_SIZE_STORAGE_KEY = "codex-deck:terminal-font-size";

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getDefaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)),
  );
}

export function readStoredTerminalFontSize(
  storage: StorageLike | null = getDefaultStorage(),
): number {
  try {
    const raw = storage?.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    return raw
      ? clampTerminalFontSize(Number(raw))
      : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function writeStoredTerminalFontSize(
  value: number,
  storage: StorageLike | null = getDefaultStorage(),
): void {
  try {
    storage?.setItem(
      TERMINAL_FONT_SIZE_STORAGE_KEY,
      String(clampTerminalFontSize(value)),
    );
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}
