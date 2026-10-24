import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { requestTranslation } from "../../web/transport/translation";

class TranslationEventSource extends EventTarget {
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  send(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("translation", { data: JSON.stringify(data) }),
    );
  }
}

const initial = { translationId: "job", translatedText: "", done: false };

test("local translation delivers SSE updates before resolving and closes at completion", async () => {
  const source = new TranslationEventSource();
  const updates: string[] = [];
  let finished = false;
  const result = requestTranslation(
    { text: "hello" },
    {
      requestJson: async <T>(_url: string, init?: RequestInit) => {
        assert.equal(JSON.parse(String(init?.body)).stream, true);
        return initial as T;
      },
      createEventSource: (url) => {
        assert.equal(url, "/api/translations/job/stream");
        return source as unknown as EventSource;
      },
      onProgress: (text) => updates.push(text),
    },
  ).then((response) => {
    finished = true;
    return response;
  });
  await setImmediate();
  source.send({ ...initial, translatedText: "你" });
  assert.deepEqual(updates, ["你"]);
  assert.equal(finished, false);
  source.send({ ...initial, translatedText: "你好\n" });
  source.send({ ...initial, translatedText: "你好", done: true });
  assert.deepEqual(await result, { translatedText: "你好" });
  assert.deepEqual(updates, ["你", "你好\n", "你好"]);
  assert.equal(source.closed, true);
});

for (const fallback of [false, true]) {
  test(`${fallback ? "dropped SSE falls back to" : "remote translation uses"} polling without restarting the command`, async () => {
    const source = new TranslationEventSource();
    const calls: string[] = [];
    const updates: string[] = [];
    let finish!: (data: unknown) => void;
    let polls = 0;
    const result = requestTranslation(
      { text: "hello" },
      {
        requestJson: async <T>(url: string) => {
          calls.push(url);
          if (url === "/api/translate") return initial as T;
          if (++polls === 1) return { ...initial, translatedText: "你" } as T;
          return new Promise((resolve) => {
            finish = (data) => resolve(data as T);
          }) as Promise<T>;
        },
        createEventSource: fallback
          ? () => source as unknown as EventSource
          : undefined,
        onProgress: (text) => updates.push(text),
      },
    );
    await setImmediate();
    if (fallback) source.onerror?.();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(updates, ["你"]);
    finish({ ...initial, translatedText: "你好", done: true });
    assert.deepEqual(await result, { translatedText: "你好" });
    assert.equal(calls.filter((url) => url === "/api/translate").length, 1);
  });
}

test("stream errors reject without returning partial output as a completed translation", async () => {
  const source = new TranslationEventSource();
  const result = requestTranslation(
    { text: "hello" },
    {
      requestJson: async <T>() => initial as T,
      createEventSource: () => source as unknown as EventSource,
      onProgress: () => {},
    },
  );
  const rejected = assert.rejects(result, /backend failed/);
  await setImmediate();
  source.send({
    ...initial,
    translatedText: "partial",
    error: "backend failed",
    done: true,
  });
  await rejected;
  assert.equal(source.closed, true);
});

test("translation concurrency leaves room for other streams and releases slots after failures", async () => {
  const requests: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const results = Promise.allSettled(
    Array.from({ length: 6 }, () =>
      requestTranslation(
        { text: "hello" },
        {
          requestJson: <T>() =>
            new Promise<T>((resolve, reject) => {
              requests.push({
                resolve: (value) => resolve(value as T),
                reject,
              });
            }),
        },
      ),
    ),
  );
  await setImmediate();
  assert.equal(requests.length, 4);
  requests[0].reject(new Error("unavailable"));
  await setImmediate();
  assert.equal(requests.length, 5);
  requests[1].resolve({ translatedText: "你好" });
  await setImmediate();
  assert.equal(requests.length, 6);
  for (const request of requests.slice(2))
    request.resolve({ translatedText: "你好" });
  assert.deepEqual(
    (await results).map((result) => result.status),
    [
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ],
  );
});

test("long translations stay below the API limit and preserve all text and separators", async () => {
  const text = [
    "# Codex conversation\n\n",
    "## Assistant\n\n",
    "A complete paragraph with Unicode 中文 😀.\n\n".repeat(7000),
    "```ts\n",
    "const value = true;\n".repeat(1000),
    "```\n\nEnd of the complete export.\n",
  ].join("");
  assert.ok(text.length > 200_000);
  const chunks: string[] = [];
  const updates: string[] = [];
  const response = await requestTranslation(
    { text, inputLang: "en", outputLang: "zh" },
    {
      requestJson: async <T>(_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(
          body.text.length <= 200_000,
          "backend rejects oversized translation requests",
        );
        assert.ok(body.text.trim(), "backend rejects whitespace-only requests");
        assert.equal(body.stream, true);
        assert.equal(body.inputLang, "en");
        assert.equal(body.outputLang, "zh");
        chunks.push(body.text);
        return { translatedText: body.text } as T;
      },
      onProgress: (value) => updates.push(value),
    },
  );
  assert.ok(chunks.length > 1);
  assert.equal(response.translatedText, text);
  assert.equal(updates.at(-1), text);
  for (const update of updates) assert.ok(text.startsWith(update));
});

for (const text of [
  "a".repeat(230_000),
  `x${"😀".repeat(115_000)}`,
  `first${"\r\n".repeat(115_000)}last`,
]) {
  test(`long translations handle ${text.includes("😀") ? "surrogate pairs" : text.includes("\r") ? "blank lines" : "unbroken lines"} without loss`, async () => {
    const response = await requestTranslation(
      { text },
      {
        requestJson: async <T>(_url: string, init?: RequestInit) => {
          const { text: chunk } = JSON.parse(String(init?.body));
          assert.ok(chunk.length <= 200_000);
          assert.ok(chunk.trim());
          assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false);
          assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false);
          return { translatedText: chunk } as T;
        },
      },
    );
    assert.equal(response.translatedText, text);
  });
}

for (const local of [true, false]) {
  test(`long translations combine sequential ${local ? "SSE" : "polling"} updates into one streamed result`, async () => {
    const sources: TranslationEventSource[] = [];
    const chunks: string[] = [];
    const updates: string[] = [];
    const polls: ((value: unknown) => void)[] = [];
    const result = requestTranslation(
      { text: `${"a".repeat(9000)}\n\n${"b".repeat(9000)}` },
      {
        requestJson: async <T>(url: string, init?: RequestInit) => {
          if (url === "/api/translate") {
            chunks.push(JSON.parse(String(init?.body)).text);
            return { ...initial, translationId: `job-${chunks.length}` } as T;
          }
          return await new Promise<T>((resolve) =>
            polls.push((value) => resolve(value as T)),
          );
        },
        createEventSource: local
          ? () => {
              const source = new TranslationEventSource();
              sources.push(source);
              return source as unknown as EventSource;
            }
          : undefined,
        onProgress: (value) => updates.push(value),
      },
    );
    await setImmediate();
    assert.equal(
      chunks.length,
      1,
      "do not start later chunks while the first is translating",
    );
    if (local) {
      sources[0].send({ ...initial, translatedText: "部分一" });
      assert.equal(updates.at(-1), "部分一");
      sources[0].send({ ...initial, translatedText: "完整一", done: true });
    } else polls[0]({ ...initial, translatedText: "完整一", done: true });
    await setImmediate();
    assert.equal(chunks.length, 2);
    assert.equal(updates.at(-1), "完整一\n\n");
    if (local) {
      sources[1].send({ ...initial, translatedText: "部分二" });
      assert.equal(updates.at(-1), "完整一\n\n部分二");
      sources[1].send({ ...initial, translatedText: "完整二", done: true });
    } else polls[1]({ ...initial, translatedText: "完整二", done: true });
    assert.deepEqual(await result, { translatedText: "完整一\n\n完整二" });
    assert.deepEqual(chunks, ["a".repeat(9000), "b".repeat(9000)]);
    if (local) assert.ok(sources.every((source) => source.closed));
  });
}

test("a failed later chunk rejects the whole translation and does not submit remaining chunks", async () => {
  let calls = 0;
  const updates: string[] = [];
  await assert.rejects(
    requestTranslation(
      { text: "x".repeat(60_000) },
      {
        requestJson: async <T>() => {
          if (++calls === 2) throw new Error("second chunk failed");
          return { translatedText: "first chunk" } as T;
        },
        onProgress: (value) => updates.push(value),
      },
    ),
    /second chunk failed/,
  );
  assert.equal(calls, 2);
  assert.equal(updates.at(-1), "first chunk");
});

test("empty output from a later chunk fails instead of silently dropping content", async () => {
  let calls = 0;
  await assert.rejects(
    requestTranslation(
      { text: "x".repeat(60_000) },
      {
        requestJson: async <T>() =>
          ({ translatedText: ++calls === 1 ? "first chunk" : "" }) as T,
      },
    ),
    /Translation is empty/,
  );
  assert.equal(calls, 2);
});
