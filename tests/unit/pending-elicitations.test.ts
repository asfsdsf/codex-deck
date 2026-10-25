import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElicitationCard } from "../../web/components/pending-elicitations";
import { parseElicitationRequest } from "../../api/mcp-elicitation";

(globalThis as { React?: typeof React }).React = React;
const base = {
  threadId: "thread",
  turnId: null,
  serverName: "calendar",
  message: "Choose settings",
};
const render = (params: object) =>
  renderToStaticMarkup(
    createElement(ElicitationCard, {
      request: parseElicitationRequest("1", { ...base, ...params })!,
      onResolved() {},
    }),
  );

test("elicitation form renders typed controls, defaults, choice labels, and actions", () => {
  const html = render({
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Your name", default: "Ada" },
        age: { type: "integer", minimum: 1, maximum: 120 },
        allowed: { type: "boolean", default: false },
        option: { type: "string", oneOf: [{ const: "a", title: "Alpha" }] },
        colors: {
          type: "array",
          items: { type: "string", enum: ["Red", "Blue"] },
        },
      },
      required: ["name"],
    },
  });
  for (const text of [
    /Your name/,
    /value="Ada"/,
    /type="number"/,
    /min="1"/,
    /max="120"/,
    /Alpha/,
    /multiple=""/,
    /Decline/,
    /Cancel/,
    /Submit/,
  ])
    assert.match(html, text);
  assert.match(html, /value="false" selected=""/);
});

test("URL authorization has a safe external link and verification remains declineable", () => {
  const html = render({
    mode: "url",
    url: "https://example.com/auth",
    elicitationId: "e",
  });
  assert.match(html, /href="https:\/\/example.com\/auth"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Continue/);
  const unsafe = render({ mode: "url", url: "javascript:alert(1)" });
  assert.doesNotMatch(unsafe, /href=|type="submit"/);
  const verification = render({
    mode: "openai/userVerification",
    title: "Verify",
    description: "Check your device",
    challenge: "private",
  });
  assert.match(verification, /native device verification/);
  assert.match(verification, /Decline/);
  assert.doesNotMatch(verification, /type="submit"|private/);
  const unsupported = render({
    mode: "form",
    requestedSchema: { type: "array" },
  });
  assert.match(unsupported, /not supported/);
  assert.doesNotMatch(unsupported, /type="submit"/);
});
