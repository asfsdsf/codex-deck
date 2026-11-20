import assert from "node:assert/strict";
import test from "node:test";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { translateMarkdown } from "../../web/markdown-translation";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "../../web/translation-cache";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function structure(text: string): unknown {
  // Ignore translated text and source positions, retaining formatting, table
  // alignment, link destinations, code, math, and all other node properties.
  return JSON.parse(
    JSON.stringify(parser.parse(text), (key, value) => {
      if (key === "position") return undefined;
      if (value?.type === "text") return { type: "text" };
      return value;
    }),
  );
}

test("translated and streaming tables keep the original Markdown structure", async () => {
  const source = [
    "## Results",
    "",
    "| **Feature** | Status |",
    "| :--- | ---: |",
    "| [Launch](https://example.com/launch) | Ready |",
    "| `a\\|b` | Waiting |",
    "",
    "- Read the *notes* before running `pnpm test`.",
  ].join("\n");
  const requests: string[] = [];
  const updates: string[] = [];
  const result = await translateMarkdown(
    source,
    async (text, progress) => {
      requests.push(text);
      progress?.("部分 | **文字**\n# 标题 [链接](另一个地址)");
      return `译文：${text} | [text] & <tag> $x$`;
    },
    (text) => updates.push(text),
  );

  assert.deepEqual(requests, [
    "Results",
    "Feature",
    "Status",
    "Launch",
    "Ready",
    "Waiting",
    "Read the ",
    "notes",
    " before running ",
    ".",
  ]);
  assert.ok(result.includes("| :--- | ---: |"));
  assert.ok(result.includes("`a\\|b`"));
  assert.ok(result.includes("](https://example.com/launch)"));
  assert.equal(updates.at(-1), result);
  for (const translated of [...updates, result]) {
    assert.deepEqual(structure(translated), structure(source));
  }
});

for (const source of [
  "Name | State\n:--- | ---:\nLaunch | Ready\nDocs | Pending\n",
  "> | Name | State |\r\n> | --- | --- |\r\n> | Launch | Ready |\r\n",
  "- | Name | State |\n  | --- | --- |\n  | Launch | Ready |\n",
]) {
  test(`table formatting survives without rewriting delimiters: ${JSON.stringify(source.slice(0, 25))}`, async () => {
    const result = await translateMarkdown(
      source,
      async (text) => `中文：${text}`,
    );
    assert.deepEqual(structure(result), structure(source));
    assert.equal(result.split("\n")[1], source.split("\n")[1]);
  });
}

test("code, math, images, autolinks, and link destinations stay unchanged", async () => {
  const source = [
    "# Notes",
    "",
    "**Read** [the guide][guide] and <https://example.com>.",
    "",
    "![diagram](https://example.com/diagram.png)",
    "",
    "`const value = 1` and $E = mc^2$",
    "",
    "```md",
    "| literal | table |",
    "| --- | --- |",
    "```",
    "",
    '[guide]: https://example.com/guide "Guide"',
  ].join("\n");
  const requests: string[] = [];
  const result = await translateMarkdown(source, async (text) => {
    requests.push(text);
    return `译文：${text}`;
  });
  assert.deepEqual(structure(result), structure(source));
  assert.deepEqual(requests, ["Notes", "Read", "the guide", " and ", "."]);
});

test("identity translations preserve source escapes, entities, whitespace, and repeated labels", async () => {
  const source =
    "| Name | Value |\n| --- | --- |\n| A\\|B | &amp; |\n| Name | **Value** |\n\n  Tail  \n";
  const requests: string[] = [];
  const result = await translateMarkdown(source, async (text) => {
    requests.push(text);
    return text;
  });
  assert.equal(result, source);
  assert.equal(requests.filter((text) => text === "Name").length, 1);
});

test("non-translatable Markdown does not invoke the backend", async () => {
  const source = "```ts\nconst value = true;\n```\n\n$x^2$\n";
  assert.equal(
    await translateMarkdown(source, async () => {
      assert.fail("Code and math must not be translated");
    }),
    source,
  );
});

test("translation failures and empty cells reject the whole translation", async () => {
  for (const empty of [true, false]) {
    let calls = 0;
    await assert.rejects(
      translateMarkdown("| A | B |\n| --- | --- |", async () => {
        if (++calls === 1) return "甲";
        if (empty) return "  ";
        throw new Error("backend failed");
      }),
      empty ? /Translation is empty/ : /backend failed/,
    );
    assert.equal(calls, 2);
  }
});

test("plain text and Markdown translations have separate cache entries", () => {
  const source = "format-aware-cache-test";
  setCachedTranslation(source, "en", "zh", "plain");
  assert.equal(getCachedTranslation(source, "en", "zh", "markdown"), undefined);
  setCachedTranslation(source, "en", "zh", "formatted", "markdown");
  assert.equal(getCachedTranslation(source, "en", "zh"), "plain");
  assert.equal(
    getCachedTranslation(source, "en", "zh", "markdown"),
    "formatted",
  );
});
