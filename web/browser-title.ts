export type BrowserTitleMode = "app" | "session" | "project";

export const BROWSER_TITLE_MODE_STORAGE_KEY =
  "codex-deck:browser-title-mode:v1";

export function normalizeBrowserTitleMode(
  value: string | null | undefined,
): BrowserTitleMode {
  if (value === "session" || value === "project") {
    return value;
  }
  return "app";
}

export function readBrowserTitleMode(
  storage: Pick<Storage, "getItem">,
): BrowserTitleMode {
  try {
    return normalizeBrowserTitleMode(
      storage.getItem(BROWSER_TITLE_MODE_STORAGE_KEY),
    );
  } catch {
    return "app";
  }
}

export function persistBrowserTitleMode(
  storage: Pick<Storage, "setItem">,
  mode: BrowserTitleMode,
): void {
  storage.setItem(BROWSER_TITLE_MODE_STORAGE_KEY, mode);
}

export function buildBrowserTitle(input: {
  mode: BrowserTitleMode;
  sessionDisplay?: string | null;
  projectPath?: string | null;
  projectName?: string | null;
}): string {
  const appName = "Codex Deck";
  if (input.mode === "app") {
    return appName;
  }

  const sessionDisplay = input.sessionDisplay?.trim();
  if (input.mode === "session" && sessionDisplay) {
    return `${sessionDisplay} - ${appName}`;
  }

  const projectName =
    input.projectName?.trim() || basename(input.projectPath?.trim() ?? "");
  if (projectName) {
    return `${projectName} - ${appName}`;
  }

  return appName;
}

function basename(path: string): string {
  const normalized = path.replace(/[/\\]+$/u, "");
  if (!normalized) {
    return "";
  }
  return normalized.split(/[/\\]/u).pop()?.trim() ?? "";
}
