export interface SkillSelectorOption {
  name: string;
  displayName?: string | null;
  description?: string | null;
}

export interface ActiveSkillSelectorToken {
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

const DEFAULT_SKILL_SELECTOR_LIMIT = 24;

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

function normalizeSkillQuery(query: string): string {
  return query
    .trim()
    .replace(/^["']+/, "")
    .toLowerCase();
}

function normalizeSkillLabel(option: SkillSelectorOption): string {
  return option.displayName?.trim().toLowerCase() ?? "";
}

function scoreSkillOption(
  option: SkillSelectorOption,
  query: string,
): [number, number] | null {
  const normalizedName = option.name.toLowerCase();
  const normalizedLabel = normalizeSkillLabel(option);

  if (normalizedName === query) {
    return [0, 0];
  }

  if (normalizedName.startsWith(query)) {
    return [1, normalizedName.length];
  }

  if (normalizedLabel === query) {
    return [2, 0];
  }

  if (normalizedLabel.startsWith(query)) {
    return [3, normalizedLabel.length];
  }

  const nameContainsIndex = normalizedName.indexOf(query);
  if (nameContainsIndex >= 0) {
    return [4, nameContainsIndex];
  }

  const labelContainsIndex = normalizedLabel.indexOf(query);
  if (labelContainsIndex >= 0) {
    return [5, labelContainsIndex];
  }

  return null;
}

export function findActiveSkillSelectorToken(
  text: string,
  cursor: number,
): ActiveSkillSelectorToken | null {
  const token = currentPrefixedToken(text, cursor, "$", true);
  if (!token) {
    return null;
  }

  return {
    query: token.query,
    start: token.start,
    end: token.end,
  };
}

export function getSkillSelectorSuggestions(
  query: string,
  skills: SkillSelectorOption[],
  limit: number = DEFAULT_SKILL_SELECTOR_LIMIT,
): SkillSelectorOption[] {
  const max = Math.max(0, limit);
  if (max === 0 || skills.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeSkillQuery(query);
  if (!normalizedQuery) {
    return skills.slice(0, max);
  }

  return skills
    .map((option) => ({
      option,
      score: scoreSkillOption(option, normalizedQuery),
    }))
    .filter(
      (
        entry,
      ): entry is { option: SkillSelectorOption; score: [number, number] } =>
        entry.score !== null,
    )
    .sort((a, b) => {
      if (a.score[0] !== b.score[0]) {
        return a.score[0] - b.score[0];
      }
      if (a.score[1] !== b.score[1]) {
        return a.score[1] - b.score[1];
      }
      return a.option.name.localeCompare(b.option.name);
    })
    .slice(0, max)
    .map((entry) => entry.option);
}
