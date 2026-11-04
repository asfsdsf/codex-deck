// Detects http(s) URLs in the terminal buffer so they can be opened with a
// click. Lines that the terminal soft-wrapped are joined first, so a long URL
// that spans several rows is still one link.

export interface TerminalUrlMatch {
  start: number;
  // Exclusive.
  end: number;
  url: string;
}

export interface TerminalBufferPosition {
  // 1-based, as xterm's IBufferRange expects.
  x: number;
  y: number;
}

export interface TerminalBufferLink {
  url: string;
  range: {
    start: TerminalBufferPosition;
    end: TerminalBufferPosition;
  };
}

interface TerminalBufferCellLike {
  getChars: () => string;
  getWidth: () => number;
}

interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell: (x: number) => TerminalBufferCellLike | undefined;
}

export interface TerminalBufferLike {
  getLine: (y: number) => TerminalBufferLineLike | undefined;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/u;
// Soft-wrapped logical lines longer than this are not scanned in full.
const MAX_WRAPPED_ROWS = 64;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const value of text) {
    if (value === char) {
      count += 1;
    }
  }
  return count;
}

// Drop punctuation that usually ends a sentence rather than the URL, and
// closing brackets that have no opening partner inside the URL.
function trimUrlCandidate(candidate: string): string {
  let url = candidate;
  for (;;) {
    const withoutPunctuation = url.replace(TRAILING_PUNCTUATION, "");
    if (withoutPunctuation !== url) {
      url = withoutPunctuation;
      continue;
    }
    const last = url.at(-1);
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const opener = last ? pairs[last] : undefined;
    if (opener && countChar(url, last!) > countChar(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function findTerminalUrls(text: string): TerminalUrlMatch[] {
  const matches: TerminalUrlMatch[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrlCandidate(match[0]);
    // "https://" alone is not a link.
    if (!/^https?:\/\/[^/?#]/iu.test(url)) {
      continue;
    }
    matches.push({ start, end: start + url.length, url });
  }
  return matches;
}

export function isOpenableTerminalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function findTerminalBufferLinks(
  buffer: TerminalBufferLike,
  bufferLineNumber: number,
): TerminalBufferLink[] {
  const targetY = bufferLineNumber - 1;
  if (!buffer.getLine(targetY)) {
    return [];
  }

  let firstY = targetY;
  while (
    firstY > 0 &&
    targetY - firstY < MAX_WRAPPED_ROWS &&
    buffer.getLine(firstY)?.isWrapped
  ) {
    firstY -= 1;
  }

  let text = "";
  // For every UTF-16 unit of `text`: the cell it was read from.
  const cells: Array<{ x: number; y: number; width: number }> = [];
  for (let y = firstY; y - firstY <= MAX_WRAPPED_ROWS; y += 1) {
    const line = buffer.getLine(y);
    if (!line || (y > firstY && !line.isWrapped)) {
      break;
    }
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) {
        continue;
      }
      const width = cell.getWidth();
      // The second half of a wide character has width 0.
      if (width === 0) {
        continue;
      }
      const chars = cell.getChars() || " ";
      for (let index = 0; index < chars.length; index += 1) {
        cells.push({ x: x + 1, y: y + 1, width });
      }
      text += chars;
    }
  }

  const links: TerminalBufferLink[] = [];
  for (const match of findTerminalUrls(text)) {
    const first = cells[match.start];
    const last = cells[match.end - 1];
    if (!first || !last) {
      continue;
    }
    if (first.y > bufferLineNumber || last.y < bufferLineNumber) {
      continue;
    }
    links.push({
      url: match.url,
      range: {
        start: { x: first.x, y: first.y },
        end: { x: last.x + last.width - 1, y: last.y },
      },
    });
  }
  return links;
}
