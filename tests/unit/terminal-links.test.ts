import assert from "node:assert/strict";
import test from "node:test";
import {
  findTerminalBufferLinks,
  findTerminalUrls,
  isOpenableTerminalUrl,
  type TerminalBufferLike,
} from "../../web/terminal-links";

// Builds a fake xterm buffer from rows of text. A row that starts with "\u0001"
// is a soft-wrapped continuation of the row above. "\u0002" marks the second
// (zero-width) half of a wide character.
function createBuffer(rows: string[]): TerminalBufferLike {
  return {
    getLine(y) {
      const raw = rows[y];
      if (raw === undefined) {
        return undefined;
      }
      const isWrapped = raw.startsWith("\u0001");
      const text = isWrapped ? raw.slice(1) : raw;
      const cells = Array.from(text);
      return {
        isWrapped,
        length: cells.length,
        getCell(x) {
          const value = cells[x];
          if (value === undefined) {
            return undefined;
          }
          const isTrailingHalf = value === "\u0002";
          const isWide = cells[x + 1] === "\u0002";
          return {
            getChars: () => (isTrailingHalf ? "" : value),
            getWidth: () => (isTrailingHalf ? 0 : isWide ? 2 : 1),
          };
        },
      };
    },
  };
}

test("findTerminalUrls trims sentence punctuation and unbalanced brackets", () => {
  assert.deepEqual(
    findTerminalUrls("see https://example.com/docs. or (http://a.dev/x)!"),
    [
      { start: 4, end: 28, url: "https://example.com/docs" },
      { start: 34, end: 48, url: "http://a.dev/x" },
    ],
  );
  assert.deepEqual(findTerminalUrls("https://en.wikipedia.org/wiki/A_(b)"), [
    {
      start: 0,
      end: 35,
      url: "https://en.wikipedia.org/wiki/A_(b)",
    },
  ]);
  assert.deepEqual(findTerminalUrls("bare https:// is not a link"), []);
});

test("isOpenableTerminalUrl only allows http and https", () => {
  assert.equal(isOpenableTerminalUrl("https://example.com"), true);
  assert.equal(isOpenableTerminalUrl("javascript:alert(1)"), false);
  assert.equal(isOpenableTerminalUrl("file:///etc/passwd"), false);
  assert.equal(isOpenableTerminalUrl("not a url"), false);
});

test("findTerminalBufferLinks returns 1-based cell ranges", () => {
  const buffer = createBuffer(["$ open https://example.com now"]);

  assert.deepEqual(findTerminalBufferLinks(buffer, 1), [
    {
      url: "https://example.com",
      range: { start: { x: 8, y: 1 }, end: { x: 26, y: 1 } },
    },
  ]);
  assert.deepEqual(findTerminalBufferLinks(buffer, 2), []);
});

test("findTerminalBufferLinks follows a URL across soft-wrapped rows", () => {
  const buffer = createBuffer([
    "prompt",
    "go https://exa",
    "\u0001mple.com/path ok",
  ]);
  const expected = [
    {
      url: "https://example.com/path",
      range: { start: { x: 4, y: 2 }, end: { x: 13, y: 3 } },
    },
  ];

  assert.deepEqual(findTerminalBufferLinks(buffer, 2), expected);
  assert.deepEqual(findTerminalBufferLinks(buffer, 3), expected);
  assert.deepEqual(findTerminalBufferLinks(buffer, 1), []);
});

test("findTerminalBufferLinks accounts for wide characters before the URL", () => {
  const buffer = createBuffer(["中\u0002 https://a.dev"]);

  assert.deepEqual(findTerminalBufferLinks(buffer, 1), [
    {
      url: "https://a.dev",
      range: { start: { x: 4, y: 1 }, end: { x: 16, y: 1 } },
    },
  ]);
});
