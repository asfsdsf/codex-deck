import {
  getDeckPluginSource,
  installDeckPlugin,
  listDeckPlugins,
  requestDeckPluginWorker,
  setDeckPluginEnabled,
  uninstallDeckPlugin,
} from "../../web/deck-plugins-api";
import { setActiveCodexHomeId } from "../../web/codex-home-scope";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createLocalTransport } from "../../web/transport/local";
import { createRemoteTransport } from "../../web/transport/remote";
import type { RemoteClient } from "../../web/remote-client";
import type { CodexAppServerEvent } from "../../api/storage";

const event: CodexAppServerEvent = {
  type: "native_state_changed",
  scope: "deck-plugins",
  threadId: null,
  revision: "plugin-status-1",
};
class FakeEventSource extends EventTarget {
  static sources: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.sources.push(this);
  }
  close() {
    this.closed = true;
  }
  send(name: string, payload: unknown) {
    this.dispatchEvent(
      new MessageEvent(name, { data: JSON.stringify(payload) }),
    );
  }
}

test("local SSE fans plugin status changes to every subscriber and delivers reconnect snapshots", (t) => {
  const previous = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  t.after(() => {
    globalThis.EventSource = previous;
  });
  const transport = createLocalTransport();
  const seen: CodexAppServerEvent[][] = [[], []];
  let snapshots = 0;
  const subs = seen.map((events) =>
    transport.subscribeSessionsStream({
      onSessions: () => {
        snapshots++;
      },
      onSessionsUpdate: () => {},
      onSessionsRemoved: () => {},
      onCodexAppServerEvent: (value) => events.push(value),
    }),
  );
  const source = FakeEventSource.sources.at(-1)!;
  source.send("codexAppServerEvent", event);
  source.send("sessions", []);
  assert.deepEqual(seen, [[event], [event]]);
  assert.equal(snapshots, 2);
  for (const stop of subs) stop();
  assert.equal(source.closed, true);
});

test("remote polling preserves plugin status and terminal failure details in encrypted delta delivery", async (t) => {
  const failure: CodexAppServerEvent = {
    type: "thread_status",
    threadId: "s",
    turnId: "failed",
    status: "idle",
    terminalStatus: "failed",
    error: { message: "Provider timeout", additionalDetails: "HTTP 503" },
    timestamp: Date.now(),
  };
  const client = {
    requestJson: async (path: string) => {
      assert.match(path, /^\/api\/sessions\/delta\?/);
      return {
        version: 2,
        isFullSnapshot: true,
        sessions: [],
        updates: [],
        removedSessionIds: [],
        skillsChangedSessionIds: [],
        codexAppServerEvents: [event, failure],
      };
    },
  } as unknown as RemoteClient;
  const transport = createRemoteTransport(client);
  const seen: CodexAppServerEvent[] = [];
  let snapshots = 0;
  const stop = transport.subscribeSessionsStream({
    onSessions: () => {
      snapshots++;
    },
    onSessionsUpdate: () => {},
    onSessionsRemoved: () => {},
    onCodexAppServerEvent: (value) => seen.push(value),
  });
  t.after(stop);
  await setImmediate();
  assert.equal(snapshots, 1);
  assert.deepEqual(seen, [event, failure]);
});

test("worker UI operations poll short requests and pin the original Codex home during a switch", async (t) => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  setActiveCodexHomeId("main");
  t.after(() => {
    globalThis.fetch = previous;
    setActiveCodexHomeId("main");
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.match(url, /codexHome=main$/);
    if (init?.method === "POST") {
      setActiveCodexHomeId("work");
      return Response.json({ requestId: "job" });
    }
    return Response.json({ done: true, result: { connected: true } });
  };
  assert.deepEqual(
    await requestDeckPluginWorker("example.worker", "settings.test", {}),
    { connected: true },
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/worker\/job\?/);
});

test("plugin registry operations stay scoped to their owning Codex home", async (t) => {
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ plugins: [], files: [] });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });

  await listDeckPlugins("work");
  await installDeckPlugin({ files: [] }, "work");
  await setDeckPluginEnabled("example.plugin", false, "work");
  await uninstallDeckPlugin("example.plugin", "work");
  await getDeckPluginSource("example.plugin", "work");

  assert.equal(urls.length, 5);
  for (const value of urls)
    assert.equal(
      new URL(value, "http://codex-deck.local").searchParams.get("codexHome"),
      "work",
    );
});
