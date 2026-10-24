import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TranslateTextProgress } from "../../api/storage";
import { registerTranslationRoutes } from "../../api/server/translation-routes";

async function readProgress(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (p: TranslateTextProgress) => boolean,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "stream ended before expected progress");
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split("\n").find((line) => line.startsWith("data: "));
      if (data) {
        const progress = JSON.parse(data.slice(6)) as TranslateTextProgress;
        if (until(progress)) return progress;
      }
    }
  }
}

test(
  "translation jobs fan out partial output, replay snapshots, and retain final output for polling",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "translation-routes-"));
    const gate = join(directory, "continue");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = new Hono();
    registerTranslationRoutes(app, {
      translationCommand:
        "printf '你好'; while [ ! -f $PROMPT ]; do sleep 0.01; done; printf '世界\\n'",
    });
    const response = await app.request("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text: gate, stream: true }),
    });
    const initial = (await response.json()) as TranslateTextProgress;
    assert.equal(initial.done, false);
    const path = `/api/translations/${initial.translationId}`;
    const readers = await Promise.all(
      [1, 2].map(async () => {
        const stream = await app.request(`${path}/stream`);
        assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
        return stream.body!.getReader();
      }),
    );
    try {
      for (const reader of readers) {
        const partial = await readProgress(
          reader,
          (p) => p.translatedText === "你好",
        );
        assert.equal(partial.done, false);
      }
      const snapshot = await (await app.request(path)).json();
      assert.equal(snapshot.translatedText, "你好");
      assert.equal(snapshot.done, false);
      await readers[0].cancel(); // Disconnecting one browser must preserve the other.
      await writeFile(gate, "");
      const final = await readProgress(readers[1], (p) => p.done);
      assert.equal(final.translatedText, "你好世界");
      const replay = await (
        await app.request(`${path}/stream`)
      ).body!.getReader();
      assert.deepEqual(await readProgress(replay, (p) => p.done), final);
      await replay.cancel();
      assert.deepEqual(await (await app.request(path)).json(), final);
    } finally {
      await writeFile(gate, "");
      await Promise.all(readers.map((reader) => reader.cancel()));
    }
  },
);

test("streamed command failures are terminal and legacy JSON translations still work", async () => {
  const app = new Hono();
  registerTranslationRoutes(app, {
    translationCommand: "printf partial; echo failed >&2; exit 1",
  });
  const response = await app.request("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text: "hello", stream: true }),
  });
  const initial = (await response.json()) as TranslateTextProgress;
  const reader = (
    await app.request(`/api/translations/${initial.translationId}/stream`)
  ).body!.getReader();
  const final = await readProgress(reader, (p) => p.done);
  assert.match(final.error!, /failed/);
  await reader.cancel();

  const legacy = new Hono();
  registerTranslationRoutes(legacy, {
    translationCommand: "printf '%s' $PROMPT",
  });
  assert.deepEqual(
    await (
      await legacy.request("/api/translate", {
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
      })
    ).json(),
    { translatedText: "hello" },
  );
});

for (const stream of [false, true]) {
  test(`the real translation route accepts a full export over 200,000 characters using ${stream ? "streaming and polling" : "legacy JSON"}`, async () => {
    const text = `# Codex conversation\n\n${"A complete paragraph with quotes ' and Unicode 中文 😀.\n\n".repeat(5000)}End of export.\n`;
    assert.ok(text.length > 200_000);
    const app = new Hono();
    registerTranslationRoutes(app, {
      translationCommand: "printf '%s' $PROMPT",
    });
    // Submit the whole export, as an already-open/older browser would. Do not
    // mock /api/translate: its size validation caused the reported regression.
    const response = await app.request("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text, stream, inputLang: "en", outputLang: "zh" }),
    });
    assert.equal(response.status, 200);
    if (!stream) {
      assert.deepEqual(await response.json(), { translatedText: text });
      return;
    }
    const initial = (await response.json()) as TranslateTextProgress;
    const path = `/api/translations/${initial.translationId}`;
    const reader = (await app.request(`${path}/stream`)).body!.getReader();
    try {
      const final = await readProgress(reader, (progress) => progress.done);
      assert.equal(final.error, undefined);
      assert.equal(final.translatedText, text);
      assert.deepEqual(await (await app.request(path)).json(), final);
    } finally {
      await reader.cancel();
    }
  });
}
