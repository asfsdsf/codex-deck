import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CodexHomeDescriptor } from "./storage";
import {
  loadCodexDeckHomeConfig,
  resolveCodexDeckRuntimeConfig,
  type CodexDeckConfig,
} from "./config";

export const MAIN_CODEX_HOME_ID = "main";

export interface ResolvedCodexHome extends CodexHomeDescriptor {
  path: string;
  translationCommand?: string;
}

function canonicalPath(path: string): string {
  const normalized = resolve(path);
  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

function resolveAdditionalHomeAvailability(path: string): {
  available: boolean;
  unavailableReason: string | null;
} {
  if (!existsSync(path)) {
    return {
      available: false,
      unavailableReason: "Directory does not exist",
    };
  }
  try {
    if (!statSync(path).isDirectory()) {
      return {
        available: false,
        unavailableReason: "Path is not a directory",
      };
    }
  } catch (error) {
    return {
      available: false,
      unavailableReason:
        error instanceof Error ? error.message : "Directory is unavailable",
    };
  }
  return { available: true, unavailableReason: null };
}

export function buildCodexHomeRegistry(input: {
  mainCodexHome: string;
  mainConfig: CodexDeckConfig;
}): ResolvedCodexHome[] {
  const mainPath = canonicalPath(input.mainCodexHome);
  const homes: ResolvedCodexHome[] = [
    {
      id: MAIN_CODEX_HOME_ID,
      label: "Main",
      path: mainPath,
      isMain: true,
      available: true,
      unavailableReason: null,
      translationCommand: input.mainConfig.translationCommand,
    },
  ];
  const claimedPaths = new Set([mainPath]);

  for (const [id, configured] of Object.entries(
    input.mainConfig.codexHomes ?? {},
  )) {
    const configuredPath = configured.path?.trim() ?? "";
    const label = configured.label?.trim() || id || "Codex home";
    let path = configuredPath ? canonicalPath(configuredPath) : "";
    let availability = configuredPath
      ? resolveAdditionalHomeAvailability(path)
      : { available: false, unavailableReason: "Path is required" };

    if (id === MAIN_CODEX_HOME_ID) {
      availability = {
        available: false,
        unavailableReason: `The id "${MAIN_CODEX_HOME_ID}" is reserved`,
      };
    } else if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      availability = {
        available: false,
        unavailableReason: "Home id may contain only letters, numbers, _ and -",
      };
    } else if (path && claimedPaths.has(path)) {
      availability = {
        available: false,
        unavailableReason: "Another Codex home uses this directory",
      };
    }

    if (path && !claimedPaths.has(path)) {
      claimedPaths.add(path);
    }

    const homeConfig = path ? loadCodexDeckHomeConfig(path) : {};
    const runtimeConfig = resolveCodexDeckRuntimeConfig(
      input.mainConfig,
      homeConfig,
    );
    homes.push({
      id,
      label: label || basename(path) || id,
      path,
      isMain: false,
      available: availability.available,
      unavailableReason: availability.unavailableReason,
      translationCommand: runtimeConfig.translationCommand,
    });
  }

  return homes;
}

export function toCodexHomeDescriptor(
  home: ResolvedCodexHome,
): CodexHomeDescriptor {
  return {
    id: home.id,
    label: home.label,
    isMain: home.isMain,
    available: home.available,
    unavailableReason: home.unavailableReason,
  };
}
