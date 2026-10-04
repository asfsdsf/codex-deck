import assert from "node:assert/strict";
import test from "node:test";
import { applyDiffGuideTheme } from "../../web/diff-guide-html";

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
