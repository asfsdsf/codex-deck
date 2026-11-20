import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

function normalizeForComparison(inputPath: string): string {
  const normalized = normalize(resolve(inputPath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function splitPathSegments(inputPath: string): string[] {
  return inputPath.split(/[\\/]+/).filter(Boolean);
}

export function getPathBaseName(inputPath: string): string {
  const segments = splitPathSegments(inputPath);
  return segments[segments.length - 1] ?? inputPath;
}

export function isPathWithinDirectory(
  filePath: string,
  directoryPath: string,
): boolean {
  const normalizedFilePath = normalizeForComparison(filePath);
  const normalizedDirectoryPath = normalizeForComparison(directoryPath);
  const rel = relative(normalizedDirectoryPath, normalizedFilePath);

  if (!rel) {
    return true;
  }

  // Only a leading ".." segment escapes; a child named "..foo" is inside.
  const escapesDirectory = rel === ".." || rel.startsWith(`..${sep}`);
  return !escapesDirectory && !isAbsolute(rel);
}

/**
 * Mirrors upstream `/cd`: `~` expands to the backend host's home directory and
 * relative paths resolve against the conversation's current working directory.
 * Resolution always happens on the backend because the browser may be remote.
 */
export function resolveRequestedWorkingDirectory(
  requested: string,
  baseCwd: string,
  home: string = homedir(),
): string {
  const trimmed = requested.trim() || "~";
  let expanded = trimmed;
  if (trimmed === "~") {
    expanded = home;
  } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = resolve(home, trimmed.slice(2));
  }
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  if (!baseCwd.trim()) {
    throw new Error(
      "The current working directory is unknown; use an absolute path.",
    );
  }
  return resolve(baseCwd, expanded);
}
