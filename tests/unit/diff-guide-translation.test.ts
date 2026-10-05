import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createDiffGuideTranslationBridge } from "../../web/diff-guide-translation";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "../../web/translation-cache";

function fixture(
  translate: Parameters<
    typeof createDiffGuideTranslationBridge
  >[0]["translate"],
) {
  const responses: Record<string, unknown>[] = [];
  const frame = {
    postMessage: (data: Record<string, unknown>, origin: string) => {
      assert.equal(origin, "*");
      responses.push(data);
    },
  } as unknown as Window;
  let currentFrame: Window | null = frame;
  const bridge = createDiffGuideTranslationBridge({
    getFrameWindow: () => currentFrame,
    token: "frame-token",
    translate,
  });
  const message = (
    texts: unknown,
    requestId = "request",
    overrides: Record<string, unknown> = {},
    source: unknown = frame,
  ) => {
    bridge.onMessage({
      source,
      data: {
        type: "codex-deck:diff-guide:translate",
        token: "frame-token",
        requestId,
        texts,
        ...overrides,
      },
    } as MessageEvent);
  };
  return {
    ...bridge,
    frame,
    responses,
    message,
    replaceFrame: () => {
      currentFrame = null;
    },
  };
}

const unique = (value: string) => `${value} ${randomUUID()}`;

test("translation bridge serves grouped fields through the supplied transport and shared cache", async () => {
  const texts = [unique("Main heading"), unique("Main description")];
  const calls: unknown[] = [];
  const bridge = fixture(async (request) => {
    calls.push(request);
    return { translatedText: `中文 ${request.text}` };
  });
  bridge.message(texts);
  await setImmediate();
  assert.deepEqual(
    calls,
    texts.map((text) => ({ text, inputLang: "en", outputLang: "zh" })),
  );
  assert.deepEqual(bridge.responses[0], {
    type: "codex-deck:diff-guide:translation",
    token: "frame-token",
    requestId: "request",
    texts: texts.map((text) => `中文 ${text}`),
  });
  assert.equal(getCachedTranslation(texts[0], "en", "zh"), `中文 ${texts[0]}`);
  bridge.message(texts, "cached");
  await setImmediate();
  assert.equal(calls.length, 2);
  assert.equal(bridge.responses.length, 2);
  bridge.dispose();
});

test("translation bridge reuses message translations and leaves empty grouped fields alone", async () => {
  const source = unique("Already translated message");
  setCachedTranslation(source, "en", "zh", "已有翻译");
  const bridge = fixture(async () => {
    throw new Error("Transport should not be called");
  });
  bridge.message([source, ""]);
  await setImmediate();
  assert.deepEqual(bridge.responses[0].texts, ["已有翻译", ""]);
  bridge.dispose();
});

test("translation bridge rejects other frames, stale tokens, invalid envelopes and oversized text", async () => {
  let calls = 0;
  const bridge = fixture(async () => {
    calls++;
    return { translatedText: "translated" };
  });
  bridge.message(["hello"], "wrong-source", {}, {});
  bridge.message(["hello"], "wrong-token", { token: "old-token" });
  bridge.message(["hello"], "wrong-type", { type: "another-channel" });
  bridge.message(["hello"], "x".repeat(129));
  for (const texts of [null, [], [42], ["a", "b", "c"]]) bridge.message(texts);
  bridge.message(["x".repeat(200_001)], "oversized");
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(bridge.responses.length, 1);
  assert.match(String(bridge.responses[0].error), /too long/);
  bridge.dispose();
});

test("concurrent blocks share pending translations and duplicate request IDs are ignored", async () => {
  const source = unique("Shared source");
  let finish!: (value: { translatedText: string }) => void;
  let calls = 0;
  const bridge = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  bridge.message([source], "first");
  bridge.message([source], "first");
  bridge.message([source], "second");
  await setImmediate();
  assert.equal(calls, 1);
  finish({ translatedText: "共同翻译" });
  await setImmediate();
  assert.deepEqual(
    bridge.responses.map((data) => data.requestId),
    ["first", "second"],
  );
  bridge.dispose();
});

test("group failures are retryable and successful fields are cached without partial display", async () => {
  const sources = [unique("Note title"), unique("Note description")];
  const calls: string[] = [];
  let failing = true;
  const bridge = fixture(async ({ text }) => {
    calls.push(text);
    if (text === sources[1] && failing)
      throw new Error("Translation unavailable");
    return { translatedText: `中文 ${text}` };
  });
  bridge.message(sources, "first");
  await setImmediate();
  assert.equal(bridge.responses[0].error, "Translation unavailable");
  assert.equal(bridge.responses[0].texts, undefined);
  failing = false;
  bridge.message(sources, "retry");
  await setImmediate();
  assert.deepEqual(calls, [sources[0], sources[1], sources[1]]);
  assert.ok(Array.isArray(bridge.responses[1].texts));
  bridge.dispose();
});

test("closed or replaced frames cannot receive outstanding translation responses", async () => {
  for (const cleanup of ["dispose", "replaceFrame"] as const) {
    let finish!: (value: { translatedText: string }) => void;
    const bridge = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    bridge.message([unique("Pending translation")]);
    await setImmediate();
    bridge[cleanup]();
    finish({ translatedText: "Delayed result" });
    await setImmediate();
    assert.deepEqual(bridge.responses, []);
    bridge.dispose();
  }
});
