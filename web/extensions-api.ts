import type {
  CodexPresetsSnapshot,
  CodexPresetInput,
} from "../api/codex-presets";
import { requestJson } from "./transport";

/**
 * Browser API for native Codex account and extension administration. Uses
 * `requestJson`, so it works over both the local and remote transports.
 */
function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function getCodexPresets(
  cwd: string | null,
): Promise<CodexPresetsSnapshot> {
  return requestJson(`/api/codex/presets${query({ cwd })}`);
}
export function saveCodexPreset(
  slot: string,
  preset: CodexPresetInput,
  options: { expectedVersion?: string | null; cwd?: string | null } = {},
): Promise<CodexPresetsSnapshot> {
  return requestJson(`/api/codex/presets/${encodeURIComponent(slot)}`, {
    method: "POST",
    body: JSON.stringify({ ...preset, ...options }),
  });
}
export function deleteCodexPreset(
  slot: string,
  options: { expectedVersion?: string | null; cwd?: string | null } = {},
): Promise<CodexPresetsSnapshot> {
  return requestJson(
    `/api/codex/presets/${encodeURIComponent(slot)}${query({
      expectedVersion: options.expectedVersion,
      cwd: options.cwd,
    })}`,
    { method: "DELETE" },
  );
}
