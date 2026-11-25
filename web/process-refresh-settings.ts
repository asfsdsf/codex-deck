export type ProcessConnectionMode = "local" | "remote";

export interface ProcessRefreshSettings {
  local: number;
  remote: number;
}

export const PROCESS_REFRESH_STORAGE_KEY = "codex-deck:process-refresh";
export const DEFAULT_PROCESS_REFRESH_SETTINGS: ProcessRefreshSettings = {
  local: 500,
  remote: 2000,
};
export const MIN_PROCESS_REFRESH_MS = 100;
export const MAX_PROCESS_REFRESH_MS = 60_000;

export function isProcessRefreshInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PROCESS_REFRESH_MS &&
    value <= MAX_PROCESS_REFRESH_MS
  );
}

export function parseProcessRefreshSettings(
  raw: string | null,
): ProcessRefreshSettings {
  let value: Partial<ProcessRefreshSettings> | null = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    // Invalid or older browser preferences fall back to the defaults.
  }
  return {
    local: isProcessRefreshInterval(value?.local)
      ? value.local
      : DEFAULT_PROCESS_REFRESH_SETTINGS.local,
    remote: isProcessRefreshInterval(value?.remote)
      ? value.remote
      : DEFAULT_PROCESS_REFRESH_SETTINGS.remote,
  };
}
