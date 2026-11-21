import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DocumentMarkdown from "../../web/components/document-markdown";
(globalThis as { React?: typeof React }).React = React;
const render = (content: string) =>
  renderToStaticMarkup(React.createElement(DocumentMarkdown, { content }));

test("file Markdown renders semantic headings, tables, task lists, math, and fenced code", () => {
  const html = render(
    "# Preview\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Ready\n\n$x^2$\n\n```ts\nconst answer = 42;\n```\n",
  );
  assert.match(html, /<h1>Preview<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /katex/);
  assert.match(html, /const answer = 42/);
  assert.match(html, /aria-label="Wrap lines"/);
  assert.match(html, /aria-label="Copy"/);
});

test("README HTML pictures render while executable HTML is removed", () => {
  const html = render(
    '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"/><img src="light.png" alt="Logo" width="55%" onerror="alert(1)" /></picture>\n\n<script>alert(2)</script>\n\n[bad](javascript:alert%283%29)',
  );
  assert.match(html, /<picture>/);
  assert.match(html, /srcSet="dark.png"/);
  assert.match(html, /alt="Logo"/);
  assert.doesNotMatch(html, /onerror|<script|javascript:/i);
});

test("frontmatter stays metadata instead of turning into document headings", () => {
  const html = render("---\ntitle: Example\nkind: guide\n---\n# Body");
  assert.match(html, /right-pane-document__frontmatter/);
  assert.match(html, /<h1>Body<\/h1>/);
  assert.doesNotMatch(html, /<h2>title:/);
});
