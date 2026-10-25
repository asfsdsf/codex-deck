import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { __TEST_ONLY__ } from "../../api/codex-app-server";

test(
  "shared daemon handles follow-up messages, events, and client responses without another writer",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = mkdtempSync("/tmp/deck-sock-");
    mkdirSync(join(directory, "app-server-control"));
    const socketPath = join(
      directory,
      "app-server-control",
      "app-server-control.sock",
    );
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const methods: string[] = [];
    let connections = 0;
    let turns = 0;
    let response: unknown;
    let receiveResponse!: () => void;
    const responseReceived = new Promise<void>((resolve) => {
      receiveResponse = resolve;
    });
    sockets.on("connection", (socket) => {
      connections += 1;
      let initialized = false;
      let subscribed = false;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.result) {
          response = message;
          receiveResponse();
          return;
        }
        methods.push(message.method);
        if (message.method === "initialized") {
          initialized = true;
          return;
        }
        if (message.method !== "initialize") assert.equal(initialized, true);
        if (message.method === "initialize") {
          assert.equal(message.params.clientInfo.name, "codex-deck");
          assert.equal(
            message.params.capabilities.mcpServerOpenaiFormElicitation,
            true,
          );
          assert.deepEqual(message.params.capabilities.extensions, {
            "openai/form": {},
            "openai/elicitation": { form: {} },
          });
        }
        let result: unknown = {};
        if (message.method === "config/read") result = { config: {} };
        if (message.method === "thread/resume") subscribed = true;
        if (message.method === "thread/read") {
          result = {
            thread: {
              id: "locked-thread",
              status: { type: "idle" },
              turns: [],
            },
          };
        }
        if (message.method === "turn/start") {
          assert.equal(
            subscribed,
            true,
            "subscribe before sending to a thread already loaded by another client",
          );
          result = { turn: { id: `turn-${++turns}` } };
          if (message.params.input[0].text === "disconnect") {
            socket.terminate();
            return;
          }
          socket.send(
            JSON.stringify({
              method: "turn/started",
              params: {
                threadId: "locked-thread",
                turn: { id: `turn-${turns}`, status: "inProgress" },
              },
            }),
          );
        }
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new __TEST_ONLY__.CodexAppServerClient({
      env: { CODEX_HOME: directory },
    });
    t.after(async () => {
      await client.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    client.subscribeAppServerEvents((event) => firstEvents.push(event));
    client.subscribeAppServerEvents((event) => secondEvents.push(event));
    // Concurrent pages must share a single connection and initialize it once.
    await Promise.all([
      client.getThreadSummary("locked-thread"),
      client.getThreadState("locked-thread"),
    ]);
    assert.equal(connections, 1);
    assert.equal(methods.filter((method) => method === "initialize").length, 1);
    assert.deepEqual(
      await client.sendMessage({
        threadId: "locked-thread",
        text: "first question",
      }),
      { turnId: "turn-1" },
    );
    assert.deepEqual(
      await client.sendMessage({
        threadId: "locked-thread",
        text: "follow-up question",
      }),
      { turnId: "turn-2" },
    );
    assert.equal(turns, 2);
    assert.equal(methods.includes("thread/start"), false);
    assert.deepEqual(firstEvents, secondEvents);
    assert.equal(firstEvents.length, 2);
    await (
      client as unknown as {
        respondToServerRequest: (id: number, value: unknown) => Promise<void>;
      }
    ).respondToServerRequest(100, { decision: "accept" });
    await responseReceived;
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 100,
      result: { decision: "accept" },
    });

    // Restarting Deck only reconnects its client; the daemon and thread survive.
    assert.equal(await client.restartAppServer(), true);
    assert.equal(connections, 2);
    assert.deepEqual(
      await client.sendMessage({
        threadId: "locked-thread",
        text: "after reconnect",
      }),
      { turnId: "turn-3" },
    );
    await assert.rejects(
      client.sendMessage({ threadId: "locked-thread", text: "disconnect" }),
      /shared app-server connection closed/,
    );
    assert.equal(turns, 4, "an ambiguous failed send must never be replayed");
    await client.getThreadSummary("locked-thread");
    assert.equal(connections, 3);
    assert.equal(turns, 4);
  },
);

for (const [description, options] of [
  ["discovery disabled", { sharedSocketPath: null }],
  [
    "a stale daemon socket",
    { sharedSocketPath: "/tmp/codex-deck-missing-daemon.sock" },
  ],
  [
    "an isolated Codex home",
    { env: { CODEX_HOME: "/tmp/codex-deck-missing-home" } },
  ],
] as const) {
  test(`standalone app-server remains available with ${description}`, async () => {
    const client = new __TEST_ONLY__.CodexAppServerClient(options);
    let starts = 0;
    const internals = client as unknown as {
      ensureStarted: () => void;
      ensureInitialized: () => Promise<void>;
      requestRaw: () => Promise<unknown>;
    };
    internals.ensureStarted = () => {
      starts += 1;
    };
    internals.ensureInitialized = async () => {};
    internals.requestRaw = async () => ({ thread: { id: "thread-1" } });
    try {
      const summary = await client.getThreadSummary("thread-1");
      assert.equal(summary.threadId, "thread-1");
      assert.equal(starts, 1);
    } finally {
      await client.close();
    }
  });
}
