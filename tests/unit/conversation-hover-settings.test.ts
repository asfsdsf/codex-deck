import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../../api/server";
import {
  resolveConversationHoverSettings,
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
} from "../../api/conversation-hover-settings";
import { createTempCodexDir } from "./test-utils";
import { createRemoteTransport } from "../../web/transport/remote";
import type { RemoteClient } from "../../web/remote-client";

test("hover settings preserve false preferences and ignore invalid runtime values", () => {
  const settings = resolveConversationHoverSettings({
    timestamp: false,
    model: true,
    input_tokens: "false" as unknown as boolean,
  });
  assert.equal(settings.timestamp, false);
  assert.equal(settings.model, true);
  assert.equal(settings.input_tokens, true);
  assert.equal(settings.enabled, true);
});

const readerBuffers = new WeakMap<
  ReadableStreamDefaultReader<Uint8Array>,
  string
>();

async function readSettings(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = readerBuffers.get(reader) ?? "";
  while (true) {
    let boundary: number;
    while ((boundary = text.indexOf("\n\n")) !== -1) {
      const frame = text.slice(0, boundary);
      text = text.slice(boundary + 2);
      if (!/^event: hoverSettings$/m.test(frame)) continue;
      readerBuffers.set(reader, text);
      return JSON.parse(/^data: (.*)$/m.exec(frame)![1]);
    }
    const next = await reader.read();
    assert.equal(next.done, false);
    text += new TextDecoder().decode(next.value);
  }
}

test("saving floating tip preferences broadcasts on the shared sessions stream to every reader", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "hover-settings-stream",
  );
  const server = createServer({ port: 0, codexDir: rootDir, open: false });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const responses = await Promise.all([
      server.app.request("/api/sessions/stream"),
      server.app.request("/api/sessions/stream"),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      readers.push(response.body!.getReader());
    }
    for (const reader of readers)
      assert.deepEqual(
        await readSettings(reader),
        DEFAULT_CONVERSATION_HOVER_SETTINGS,
      );
    const file = await (
      await server.app.request("/api/codex-deck/config")
    ).json();
    const result = await server.app.request("/api/codex-deck/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: file.revision,
        content:
          "[conversation_hover]\nmodel = true\ntimestamp = false\ninput_tokens = false\n",
      }),
    });
    assert.equal(result.status, 200);
    const applied = await result.json();
    assert.deepEqual(applied.appliedKeys, ["conversation_hover"]);
    assert.deepEqual(applied.restartRequiredKeys, []);
    for (const reader of readers) {
      const settings = await readSettings(reader);
      assert.equal(settings.model, true);
      assert.equal(settings.timestamp, false);
      assert.equal(settings.input_tokens, false);
    }
    const settings = await (
      await server.app.request("/api/codex-deck/hover-settings?codexHome=work")
    ).json();
    assert.equal(settings.model, true);
    assert.equal(settings.timestamp, false);
  } finally {
    for (const reader of readers) await reader.cancel();
    server.stop();
    await cleanup();
  }
});

test("remote floating tip settings use the same encrypted JSON transport", async () => {
  let received = () => {};
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  const requested: string[] = [];
  const settings = { ...DEFAULT_CONVERSATION_HOVER_SETTINGS, enabled: false };
  const transport = createRemoteTransport({
    requestJson: async (url: string) => {
      requested.push(url);
      return settings;
    },
  } as unknown as RemoteClient);
  const unsubscribe = transport.subscribeConversationHoverSettings({
    onSettings: (value) => {
      assert.deepEqual(value, settings);
      received();
    },
  });
  try {
    await ready;
    assert.deepEqual(requested, ["/api/codex-deck/hover-settings"]);
  } finally {
    unsubscribe();
  }
});
