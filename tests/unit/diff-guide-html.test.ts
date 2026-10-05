import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDiffGuideTheme,
  prepareDiffGuideHtml,
} from "../../web/diff-guide-html";

test("embedded guide follows app theme while keeping responsive rules and quoted source intact", () => {
  const snapshot =
    '<script type="application/json">{"source":"@media (prefers-color-scheme: dark)"}</script>';
  const html =
    "<html><style>@media (prefers-color-scheme: dark) {body{background:#18181b}} @media (max-width:600px){body{padding:0}}</style>" +
    snapshot +
    "</html>";
  const dark = applyDiffGuideTheme(html, "dark");
  const light = applyDiffGuideTheme(html, "light");
  assert.ok(dark.includes("@media all {body"));
  assert.ok(light.includes("@media not all {body"));
  for (const output of [dark, light]) {
    assert.ok(output.includes("@media (max-width:600px)"));
    assert.ok(output.includes(snapshot));
  }
});

test("in-app translation enhancement preserves embedded guide data and source markup", () => {
  const data =
    '<script id="guide-data" type="application/json">{"title":"Original","sources":{"a.ts":["<button>code</button>"]}}</script>';
  const code =
    '<table id="diff-body"><tr><td class="code-cell">const original = true;</td></tr></table>';
  const html =
    "<html><head><style>@media (prefers-color-scheme: dark){body{color:white}}</style></head><body>" +
    data +
    code +
    "</body>\n</html>\n";
  const result = prepareDiffGuideHtml(html, "light", "frame-token");
  assert.ok(result.includes(data));
  assert.ok(result.includes(code));
  assert.ok(result.includes("@media not all{body"));
  assert.equal(
    (result.match(/id="deck-diff-translation-runtime"/g) ?? []).length,
    1,
  );
  assert.ok(result.includes(')("frame-token");</script>'));
  assert.ok(result.endsWith("</body>\n</html>\n"));
  assert.ok(!html.includes("deck-diff-translation-runtime"));
});

test("frame tokens cannot inject HTML and incomplete documents are left intact", () => {
  const output = prepareDiffGuideHtml(
    "<html><body></body></html>",
    "dark",
    "</script><script>bad()</script>",
  );
  assert.ok(!output.includes("<script>bad()"));
  assert.ok(output.includes("\\u003c/script\\u003e"));
  assert.equal(
    prepareDiffGuideHtml("incomplete", "light", "token"),
    "incomplete",
  );
});
