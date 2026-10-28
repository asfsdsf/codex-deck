import { useCallback } from "react";
import type { ProjectsSnapshot } from "@codex-deck/api";
import { getCodexProjects } from "../codex-organization-api";
import { EMPTY_PROJECTS } from "../codex-projects-view";
import { useNativeSnapshot } from "./use-native-snapshot";

/**
 * Shared named-project/section assignments for session-list badges. Reloads on
 * `native_state_changed` (`projects`), visibility, and Codex home switches.
 */
export function useCodexProjects(
  enabled: boolean,
  scopeKey: string,
): ProjectsSnapshot {
  const load = useCallback(
    () =>
      enabled && scopeKey
        ? getCodexProjects().catch(() => EMPTY_PROJECTS)
        : Promise.resolve(EMPTY_PROJECTS),
    [enabled, scopeKey],
  );
  return useNativeSnapshot("projects", null, load).data ?? EMPTY_PROJECTS;
}
