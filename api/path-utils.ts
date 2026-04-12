import { isAbsolute, normalize, relative, resolve } from "node:path";

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

  return !rel.startsWith("..") && !isAbsolute(rel);
}
