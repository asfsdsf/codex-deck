import assert from "node:assert/strict";
import test from "node:test";
import { parseRgOutputLine } from "../../web/components/tool-renderers/rg-parser";

test("parseRgOutputLine parses windows path lines with column", () => {
  const line = "C:\\repo\\src\\app.ts:42:7:const x = 1";
  const parsed = parseRgOutputLine(line);

  assert.deepEqual(parsed, {
    kind: "match_with_column",
    filePath: "C:\\repo\\src\\app.ts",
    lineNumber: "42",
    columnNumber: "7",
    text: "const x = 1",
  });
});

test("parseRgOutputLine parses unix path lines with line number", () => {
  const line = "/repo/src/app.ts:42:const x = 1";
  const parsed = parseRgOutputLine(line);

  assert.deepEqual(parsed, {
    kind: "match_with_line",
    filePath: "/repo/src/app.ts",
    lineNumber: "42",
    text: "const x = 1",
  });
});

test("parseRgOutputLine recognizes path-only lines", () => {
  const parsed = parseRgOutputLine("C:\\repo\\src\\app.ts");

  assert.deepEqual(parsed, {
    kind: "path_only",
    text: "C:\\repo\\src\\app.ts",
  });
});

test("parseRgOutputLine keeps plain lines as plain text", () => {
  const parsed = parseRgOutputLine("3 matches found");

  assert.deepEqual(parsed, {
    kind: "plain",
    text: "3 matches found",
  });
});
