export interface ActiveFileMentionToken {
  query: string;
  start: number;
  end: number;
}

interface ActivePrefixedToken {
  query: string;
  start: number;
  end: number;
  token: string;
}

const DEFAULT_FILE_MENTION_LIMIT = 40;

function isWhitespaceChar(char: string): boolean {
  return /\s/u.test(char);
}

function findTokenStart(text: string, cursor: number): number {
  let start = cursor;
  while (start > 0 && !isWhitespaceChar(text[start - 1] ?? "")) {
    start -= 1;
  }
  return start;
}

function findTokenEnd(text: string, cursor: number): number {
  let end = cursor;
  while (end < text.length && !isWhitespaceChar(text[end] ?? "")) {
    end += 1;
  }
  return end;
}

function toActivePrefixedToken(
  token: string | null,
  start: number,
  end: number,
  prefix: string,
): ActivePrefixedToken | null {
  if (!token || !token.startsWith(prefix)) {
    return null;
  }

  return {
    token,
    query: token.slice(prefix.length),
    start,
    end,
  };
}

function currentPrefixedToken(
  text: string,
  cursor: number,
  prefix: string,
  allowEmpty: boolean,
): ActivePrefixedToken | null {
  if (prefix.length === 0) {
    return null;
  }

  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const atWhitespace =
    safeCursor < text.length && isWhitespaceChar(text[safeCursor] ?? "");

  const startLeft = findTokenStart(text, safeCursor);
  const endLeft = findTokenEnd(text, safeCursor);
  const tokenLeft = startLeft < endLeft ? text.slice(startLeft, endLeft) : null;
  const leftPrefixed = toActivePrefixedToken(
    tokenLeft,
    startLeft,
    endLeft,
    prefix,
  );

  let startRight = safeCursor;
  while (startRight < text.length && isWhitespaceChar(text[startRight] ?? "")) {
    startRight += 1;
  }
  const endRight = findTokenEnd(text, startRight);
  const tokenRight =
    startRight < endRight ? text.slice(startRight, endRight) : null;
  const rightPrefixed = toActivePrefixedToken(
    tokenRight,
    startRight,
    endRight,
    prefix,
  );

  if (atWhitespace) {
    if (rightPrefixed) {
      return rightPrefixed;
    }
    if (tokenLeft === prefix) {
      return allowEmpty ? leftPrefixed : null;
    }
    return leftPrefixed;
  }

  if (text.slice(safeCursor).startsWith(prefix)) {
    const prefixStartsToken =
      safeCursor === 0 || isWhitespaceChar(text[safeCursor - 1] ?? "");
    if (prefixStartsToken) {
      return rightPrefixed ?? leftPrefixed;
    }
    return leftPrefixed;
  }

  return leftPrefixed ?? rightPrefixed;
}

function normalizeQuery(query: string): string {
  return query
    .trim()
    .replace(/^["']+/, "")
    .toLowerCase();
}

function basename(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  if (slashIndex === -1) {
    return path;
  }
  return path.slice(slashIndex + 1);
}

function scoreFilePath(path: string, query: string): [number, number] | null {
  const normalizedPath = path.toLowerCase();
  const normalizedBasename = basename(normalizedPath);

  if (normalizedPath === query) {
    return [0, 0];
  }

  if (normalizedPath.startsWith(query)) {
    return [1, normalizedPath.length];
  }

  if (normalizedBasename === query) {
    return [2, 0];
  }

  if (normalizedBasename.startsWith(query)) {
    return [3, normalizedBasename.length];
  }

  const segmentIndex = normalizedPath.indexOf(`/${query}`);
  if (segmentIndex >= 0) {
    return [4, segmentIndex];
  }

  const containsIndex = normalizedPath.indexOf(query);
  if (containsIndex >= 0) {
    return [5, containsIndex];
  }

  return null;
}

export function findActiveFileMentionToken(
  text: string,
  cursor: number,
): ActiveFileMentionToken | null {
  const token = currentPrefixedToken(text, cursor, "@", false);
  if (!token) {
    return null;
  }

  return {
    query: token.query,
    start: token.start,
    end: token.end,
  };
}

export function getFileMentionSuggestions(
  query: string,
  files: string[],
  limit: number = DEFAULT_FILE_MENTION_LIMIT,
): string[] {
  const max = Math.max(0, limit);
  if (max === 0 || files.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return files.slice(0, max);
  }

  return files
    .map((path) => ({
      path,
      score: scoreFilePath(path, normalizedQuery),
    }))
    .filter(
      (entry): entry is { path: string; score: [number, number] } =>
        entry.score !== null,
    )
    .sort((a, b) => {
      if (a.score[0] !== b.score[0]) {
        return a.score[0] - b.score[0];
      }
      if (a.score[1] !== b.score[1]) {
        return a.score[1] - b.score[1];
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, max)
    .map((entry) => entry.path);
}
