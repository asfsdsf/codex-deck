import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import type { SystemContextResponse } from "./storage";

let cachedSystemContext: SystemContextResponse | null = null;

function parseOsReleaseFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readLinuxRelease(): {
  osName: string;
  osRelease: string;
  osVersion: string | null;
} {
  try {
    const parsed = parseOsReleaseFile(readFileSync("/etc/os-release", "utf-8"));
    const osName = parsed["NAME"]?.trim() || "Linux";
    const prettyName = parsed["PRETTY_NAME"]?.trim();
    const versionId = parsed["VERSION_ID"]?.trim() || null;
    return {
      osName,
      osRelease: prettyName || versionId || `${osName} ${release()}`,
      osVersion: versionId,
    };
  } catch {
    return {
      osName: "Linux",
      osRelease: `Linux ${release()}`,
      osVersion: release(),
    };
  }
}

function readDarwinRelease(): {
  osName: string;
  osRelease: string;
  osVersion: string | null;
} {
  const nameResult = spawnSync("sw_vers", ["-productName"], {
    encoding: "utf-8",
  });
  const versionResult = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf-8",
  });
  const osName = nameResult.status === 0 ? nameResult.stdout.trim() : "macOS";
  const osVersion =
    versionResult.status === 0 ? versionResult.stdout.trim() : null;
  return {
    osName,
    osRelease: osVersion ? `${osName} ${osVersion}` : `${osName} ${release()}`,
    osVersion,
  };
}

function readWindowsRelease(): {
  osName: string;
  osRelease: string;
  osVersion: string | null;
} {
  const osVersion = release();
  return {
    osName: "Windows",
    osRelease: `Windows ${osVersion}`,
    osVersion,
  };
}

function detectOsRelease(): {
  osName: string;
  osRelease: string;
  osVersion: string | null;
} {
  switch (platform()) {
    case "darwin":
      return readDarwinRelease();
    case "linux":
      return readLinuxRelease();
    case "win32":
      return readWindowsRelease();
    default: {
      const currentPlatform = platform();
      const osVersion = release();
      return {
        osName: currentPlatform,
        osRelease: `${currentPlatform} ${osVersion}`,
        osVersion,
      };
    }
  }
}

function detectDefaultShell(): string | null {
  const value =
    process.platform === "win32"
      ? process.env["ComSpec"]?.trim()
      : process.env["SHELL"]?.trim();
  return value || null;
}

export function getSystemContextSnapshot(
  options: { forceRefresh?: boolean } = {},
): SystemContextResponse {
  if (cachedSystemContext && options.forceRefresh !== true) {
    return cachedSystemContext;
  }

  const osInfo = detectOsRelease();
  cachedSystemContext = {
    osName: osInfo.osName,
    osRelease: osInfo.osRelease,
    osVersion: osInfo.osVersion,
    architecture: arch(),
    platform: platform(),
    hostname: hostname(),
    defaultShell: detectDefaultShell(),
  };
  return cachedSystemContext;
}

export const __TEST_ONLY__ = {
  parseOsReleaseFile,
};
