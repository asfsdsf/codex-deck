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
