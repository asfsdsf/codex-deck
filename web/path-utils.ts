export function splitPathSegments(inputPath: string): string[] {
  return inputPath.split(/[\\/]+/).filter(Boolean);
}

export function getPathBaseName(inputPath: string): string {
  const segments = splitPathSegments(inputPath);
  return segments[segments.length - 1] ?? inputPath;
}

export function getPathTail(
  inputPath: string,
  segmentCount: number = 2,
): string {
  const segments = splitPathSegments(inputPath);
  if (segments.length === 0) {
    return inputPath;
  }
  return segments.slice(-segmentCount).join("/");
}

export function stripFileReferenceSuffix(inputPath: string): string {
  const lineFragmentMatch = inputPath.match(/^(.*)#L\d+(?:C\d+)?$/i);
  if (lineFragmentMatch) {
    return lineFragmentMatch[1] ?? inputPath;
  }

  const lineSuffixMatch = inputPath.match(/^(.*?)(?::\d+){1,2}$/);
  if (lineSuffixMatch) {
    return lineSuffixMatch[1] ?? inputPath;
  }

  return inputPath;
}

const MARKDOWN_FILE_EXTENSIONS = new Set([
  "md",
  "mdown",
  "mdx",
  "mkd",
  "mkdn",
  "markdown",
]);

export function getPathExtension(inputPath: string): string {
  const normalizedPath = stripFileReferenceSuffix(inputPath.trim());
  const baseName = getPathBaseName(normalizedPath).split(/[?#]/, 1)[0] ?? "";
  const dotIndex = baseName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    return "";
  }
  return baseName.slice(dotIndex + 1).toLowerCase();
}

export function isMarkdownPath(inputPath: string): boolean {
  return MARKDOWN_FILE_EXTENSIONS.has(getPathExtension(inputPath));
}

export interface ParsedFileReference {
  path: string;
  line: number | null;
  column: number | null;
}

export function parseFileReference(inputPath: string): ParsedFileReference {
  const fragmentMatch = inputPath.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (fragmentMatch) {
    return {
      path: fragmentMatch[1] ?? inputPath,
      line: Number.parseInt(fragmentMatch[2] ?? "", 10) || null,
      column: fragmentMatch[3]
        ? Number.parseInt(fragmentMatch[3], 10) || null
        : null,
    };
  }

  const lineColumnSuffixMatch = inputPath.match(/^(.*):(\d+):(\d+)$/);
  if (lineColumnSuffixMatch) {
    return {
      path: lineColumnSuffixMatch[1] ?? inputPath,
      line: Number.parseInt(lineColumnSuffixMatch[2] ?? "", 10) || null,
      column: Number.parseInt(lineColumnSuffixMatch[3] ?? "", 10) || null,
    };
  }

  const lineSuffixMatch = inputPath.match(/^(.*):(\d+)$/);
  if (lineSuffixMatch) {
    return {
      path: lineSuffixMatch[1] ?? inputPath,
      line: Number.parseInt(lineSuffixMatch[2] ?? "", 10) || null,
      column: null,
    };
  }

  return {
    path: inputPath,
    line: null,
    column: null,
  };
}

export interface ResolvedProjectFileLinkTarget {
  path: string;
  line: number | null;
  column: number | null;
}

export function resolveProjectFileLinkTargetFromHref(
  href: string,
  projectPath: string,
): ResolvedProjectFileLinkTarget | null {
  const trimmedHref = href.trim();
  const trimmedProject = projectPath.trim();
  if (!trimmedHref || !trimmedProject) {
    return null;
  }

  if (
    /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i.test(trimmedHref) &&
    !trimmedHref.toLowerCase().startsWith("file://")
  ) {
    return null;
  }

  let decodedHref = trimmedHref;
  try {
    decodedHref = decodeURIComponent(trimmedHref);
  } catch {
    // Keep original href if percent-decoding fails.
  }

  let candidatePath = decodedHref;
  if (candidatePath.toLowerCase().startsWith("file://")) {
    try {
      const parsed = new URL(candidatePath);
      candidatePath = parsed.pathname || "";
      if (/^\/[A-Za-z]:\//.test(candidatePath)) {
        candidatePath = candidatePath.slice(1);
      }
    } catch {
      return null;
    }
  }

  const parsedReference = parseFileReference(candidatePath.trim());
  candidatePath = parsedReference.path.trim();
  if (!candidatePath) {
    return null;
  }

  const normalizedProject = trimmedProject
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const normalizedCandidate = candidatePath.replace(/\\/g, "/");
  const compareCaseInsensitive = /^[A-Za-z]:\//.test(normalizedProject);
  const projectForCompare = compareCaseInsensitive
    ? normalizedProject.toLowerCase()
    : normalizedProject;
  const candidateForCompare = compareCaseInsensitive
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;

  if (
    candidateForCompare === projectForCompare ||
    candidateForCompare.startsWith(`${projectForCompare}/`)
  ) {
    const relative = normalizedCandidate
      .slice(normalizedProject.length)
      .replace(/^\/+/, "");
    if (!relative) {
      return null;
    }
    return {
      path: relative,
      line: parsedReference.line,
      column: parsedReference.column,
    };
  }

  if (/^\/|^[A-Za-z]:\//.test(normalizedCandidate)) {
    return null;
  }

  const normalizedRelative = normalizedCandidate.replace(/^\.\/+/, "");
  if (!normalizedRelative || normalizedRelative.startsWith("../")) {
    return null;
  }
  if (normalizedRelative.split("/").some((segment) => segment === "..")) {
    return null;
  }

  return {
    path: normalizedRelative,
    line: parsedReference.line,
    column: parsedReference.column,
  };
}

export function resolveProjectRelativePathFromHref(
  href: string,
  projectPath: string,
): string | null {
  return resolveProjectFileLinkTargetFromHref(href, projectPath)?.path ?? null;
}
