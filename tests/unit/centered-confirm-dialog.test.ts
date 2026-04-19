import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CenteredConfirmDialog from "../../web/components/centered-confirm-dialog";

(globalThis as { React?: typeof React }).React = React;

test("CenteredConfirmDialog renders a centered modal overlay instead of a bottom-right prompt", () => {
  const html = renderToStaticMarkup(
    createElement(CenteredConfirmDialog, {
      tone: "danger",
      title: "Delete this session?",
      message: "This will delete the session rollout file.",
      children: createElement("button", { type: "button" }, "Delete"),
    }),
  );

  assert.match(
    html,
    /class="fixed inset-0 z-50 flex items-center justify-center bg-black\/55 p-4"/,
  );
  assert.match(html, /class="w-full max-w-md rounded-xl border/);
  assert.match(html, /Delete this session\?/);
  assert.doesNotMatch(html, /right-4 bottom-4/);
});

test("CenteredConfirmDialog applies warning styling for non-destructive prompts", () => {
  const html = renderToStaticMarkup(
    createElement(CenteredConfirmDialog, {
      tone: "warning",
      title: "Fix dangling turns?",
      message: "This will append synthetic ended-turn events.",
      children: createElement("button", { type: "button" }, "Proceed"),
    }),
  );

  assert.match(html, /border-amber-700\/60/);
  assert.match(html, /text-amber-200/);
});
