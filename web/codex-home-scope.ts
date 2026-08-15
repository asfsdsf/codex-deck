export const MAIN_CODEX_HOME_ID = "main";

let activeCodexHomeId = MAIN_CODEX_HOME_ID;

export function getActiveCodexHomeId(): string {
  return activeCodexHomeId;
}

export function setActiveCodexHomeId(homeId: string): void {
  const normalized = homeId.trim();
  activeCodexHomeId = normalized || MAIN_CODEX_HOME_ID;
}

export function addCodexHomeToApiUrl(
  url: string,
  homeId = activeCodexHomeId,
): string {
  if (!url.startsWith("/api/") || url.startsWith("/api/codex-homes")) {
    return url;
  }
  const normalizedHomeId = homeId.trim() || MAIN_CODEX_HOME_ID;
  if (normalizedHomeId === MAIN_CODEX_HOME_ID) {
    return url;
  }
  const parsed = new URL(url, "http://codex-deck.local");
  parsed.searchParams.set("codexHome", normalizedHomeId);
  return `${parsed.pathname}${parsed.search}`;
}
