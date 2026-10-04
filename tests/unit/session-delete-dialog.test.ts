import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionDeleteDialog from "../../web/components/session-delete-dialog";

(globalThis as { React?: typeof React }).React = React;

test("diff session deletion offers keeping or removing guide files", () => {
  const html = renderToStaticMarkup(
    createElement(SessionDeleteDialog, {
      sessionLabel: "My diff tour",
      hasDiffGuide: true,
      deleteMode: null,
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );
  assert.match(html, /Delete this diff guide session\?/);
  assert.match(html, /keep its generated diff guide files/);
  assert.match(html, /Delete session only/);
  assert.match(html, /Delete session \+ diff guide/);
  assert.match(html, /flex-wrap/);
});

test("ordinary session deletion keeps the standard confirmation", () => {
  const html = renderToStaticMarkup(
    createElement(SessionDeleteDialog, {
      sessionLabel: "Ordinary session",
      hasDiffGuide: false,
      deleteMode: null,
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );
  assert.match(html, /Delete this session\?/);
  assert.match(html, />Delete<\/button>/);
  assert.doesNotMatch(html, /diff guide/);
});

test("an in-progress deletion disables both choices and cancellation", () => {
  const html = renderToStaticMarkup(
    createElement(SessionDeleteDialog, {
      sessionLabel: "My diff tour",
      hasDiffGuide: true,
      deleteMode: "session-and-diff-guide",
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.equal((html.match(/Deleting\.\.\./g) ?? []).length, 1);
  assert.match(html, /Delete session only/);
});
