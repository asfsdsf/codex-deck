import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createServer } from "../../api/server";
import { LlmConversations } from "../../api/llm-conversations";
import { readChatCompletion } from "../../api/llm-completion";
import { createTempCodexDir } from "./test-utils";

test("chat completions keep visible thinking separate from the answer", async () => {
  const cases = [
    [{ content: "Answer only" }, "", "Answer only"],
    [
      { content: "Final", reasoning_content: "First step" },
      "First step",
      "Final",
    ],
    [
      {
        content: "Final",
        reasoning: "Summary",
        reasoning_details: [{ type: "reasoning.summary", summary: "Summary" }],
      },
      "Summary",
      "Final",
    ],
    [
      {
        content: "Final",
        reasoning_details: [
          { type: "reasoning.encrypted", data: "opaque" },
          { type: "reasoning.summary", summary: "Summary" },
        ],
      },
      "Summary",
      "Final",
    ],
    [
      {
        content: [
          { type: "thinking", thinking: "Considering" },
          { type: "text", text: "Conclusion" },
        ],
      },
      "Considering",
      "Conclusion",
    ],
    [
      { content: "<think>Working through it.</think>\nFinal" },
      "Working through it.",
      "Final",
    ],
    [
      { content: "Example: <think>literal markup</think>" },
      "",
      "Example: <think>literal markup</think>",
    ],
  ] as const;
  for (const [message, thinking, content] of cases) {
    const reply = await readChatCompletion(
      Response.json({ choices: [{ message }] }),
      async () => {},
    );
    assert.deepEqual(reply, { thinking, content });
  }
});

test("stream decoding handles split UTF-8 and reports unfinished replies", async () => {
  const wire =
    ': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"café"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"Final"}}]}\r\n\r\n';
  const streamed = (suffix: string) => {
    const bytes = new TextEncoder().encode(wire + suffix);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const seen: string[] = [];
  assert.deepEqual(
    await readChatCompletion(streamed("data: [DONE]\r\n\r\n"), async (text) => {
      seen.push(text);
    }),
    { thinking: "café", content: "Final" },
  );
  assert.deepEqual(seen, ["café"]);
  await assert.rejects(
    readChatCompletion(streamed(""), async () => {}),
    /Incomplete/,
  );
});

test("direct chat sends completed rounds, persists isolated history and handles concurrent retries", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("deck-direct-chat");
  const requests: {
    path?: string;
    auth?: string;
    body: { model: string; messages: { role: string; content: string }[] };
  }[] = [];
  let finishFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const upstream = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (requests.length === 1) await first;
    if (requests.length === 3) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "Reply " + requests.length } }],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const server = createServer({ port: 0, codexDir: rootDir, open: false });
  const root = "/api/codex-homes/providers";
  const post = (path: string, body: unknown) =>
    server.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const input = {
      label: "Example",
      model: "test-model",
      url: "http://127.0.0.1:" + address.port + "/v1",
      apiKey: "mock-key",
    };
    assert.equal(
      (await post(root, { ...input, url: "file:///tmp/example" })).status,
      400,
    );
    const added = await post(root, input);
    assert.equal(added.status, 201);
    const descriptor = await added.json();
    const catalog = await (await server.app.request("/api/codex-homes")).json();
    assert.deepEqual(catalog.homes[1], descriptor);
    assert.equal(JSON.stringify(catalog).includes("mock-key"), false);
    assert.equal(catalog.homes[0].id, "main");
    const providerId = descriptor.id.slice(4);
    const id = randomUUID();
    const path = root + "/" + providerId + "/conversations/" + id;
    const credentials = join(
      rootDir,
      "codex-deck",
      "providers",
      providerId + ".json",
    );
    if (process.platform !== "win32")
      assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    const send = (
      message: string,
      expectedTurns: number,
      requestId = randomUUID(),
      model?: string,
    ) => post(path, { message, expectedTurns, requestId, model });
    const key = randomUUID();
    assert.deepEqual(
      (await Promise.all([send("Hello", 0, key), send("Hello", 0, key)])).map(
        (r) => r.status,
      ),
      [202, 202],
    );
    assert.equal((await send("Racing writer", 0)).status, 409);
    assert.equal((await send("Too early", 1)).status, 409);
    finishFirst();
    const store = new LlmConversations(rootDir);
    async function settled(index: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const turn = (await store.read(providerId, id)).turns[index];
        if (turn.assistant || turn.error) return turn;
        await delay(10);
      }
      throw Error("Turn did not settle");
    }
    assert.equal((await settled(0)).assistant, "Reply 1");
    const followupKey = randomUUID();
    assert.equal(
      (await send("Follow up", 1, followupKey, "custom/fast")).status,
      202,
    );
    assert.equal((await settled(1)).model, "custom/fast");
    assert.equal(
      (await send("Follow up", 1, followupKey, "custom/other")).status,
      409,
    );
    assert.deepEqual(requests[1], {
      path: "/v1/chat/completions",
      auth: "Bearer mock-key",
      body: {
        model: "custom/fast",
        stream: true,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Reply 1" },
          { role: "user", content: "Follow up" },
        ],
      },
    });
    assert.equal((await send("Failure", 2)).status, 202);
    assert.match((await settled(2)).error!, /401/);
    assert.equal((await send("Retry", 3)).status, 202);
    assert.equal((await settled(3)).assistant, "Reply 4");
    assert.equal(requests[3].body.model, "test-model");
    assert.equal(
      requests[3].body.messages.some((m) => m.content === "Failure"),
      false,
    );
    assert.equal((await store.list(providerId))[0].id, id);
    const other = await store.addProvider({ ...input, label: "Other" });
    assert.deepEqual(await store.list(other.id.slice(4)), []);
    assert.equal(
      (await server.app.request(path.replace(providerId, other.id.slice(4))))
        .status,
      404,
    );
    const saved = await readFile(
      join(rootDir, "codex-deck", "conversation", providerId, id, "1.json"),
      "utf8",
    );
    assert.equal(JSON.parse(saved).assistant, "Reply 2");
    const providerPath = root + "/" + providerId;
    // A provider saved before editing shipped has no revision field.
    const oldProvider = JSON.parse(await readFile(credentials, "utf8"));
    delete oldProvider.revision;
    await writeFile(credentials, JSON.stringify(oldProvider));
    const settings = await (await server.app.request(providerPath)).json();
    assert.equal(settings.hasApiKey, true);
    assert.equal(settings.revision, "initial");
    assert.ok(!JSON.stringify(settings).includes("mock-key"));
    const edit = {
      label: "Renamed",
      model: "new-model",
      url: settings.url,
      revision: settings.revision,
    };
    const saves = await Promise.all([
      post(providerPath, edit),
      post(providerPath, edit),
    ]);
    assert.deepEqual(saves.map((r) => r.status).sort(), [200, 409]);
    const updated = await saves.find((r) => r.ok)!.json();
    assert.equal(updated.id, descriptor.id);
    assert.equal((await send("After editing", 4)).status, 202);
    assert.equal((await settled(4)).assistant, "Reply 5");
    assert.equal(requests[4].auth, "Bearer mock-key");
    assert.equal(requests[4].body.model, "new-model");
    assert.equal(
      (
        await post(providerPath, {
          ...edit,
          revision: updated.providerRevision,
          apiKey: "replacement-key",
        })
      ).status,
      200,
    );
    assert.equal(
      JSON.parse(await readFile(credentials, "utf8")).apiKey,
      "replacement-key",
    );
    const rotated = await store.settings(providerId);
    const changedOrigin = await (
      await post(providerPath, {
        ...edit,
        revision: rotated.revision,
        url: "https://example.invalid/v1",
      })
    ).json();
    assert.equal((await store.settings(providerId)).hasApiKey, false);
    const restored = await (
      await post(providerPath, {
        ...edit,
        revision: changedOrigin.providerRevision,
        apiKey: "replacement-key",
      })
    ).json();
    const cleared = await (
      await post(providerPath, {
        ...edit,
        revision: restored.providerRevision,
        apiKey: "",
      })
    ).json();
    assert.equal((await store.settings(providerId)).hasApiKey, false);
    const remove = (revision: string) =>
      server.app.request(providerPath + "?revision=" + revision, {
        method: "DELETE",
      });
    assert.equal((await remove(updated.providerRevision)).status, 409);
    assert.equal((await remove(cleared.providerRevision)).status, 200);
    assert.equal((await server.app.request(providerPath)).status, 404);
    assert.equal((await send("Removed", 5)).status, 404);
    assert.ok(!(await store.providers()).some((p) => p.id === descriptor.id));
    assert.equal((await store.read(providerId, id)).turns.length, 5);
    assert.deepEqual(await readdir(sessionsDir), []);
  } finally {
    finishFirst();
    await server.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await cleanup();
  }
});
