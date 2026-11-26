import assert from "node:assert/strict";
import test from "node:test";
import {
  __TEST_ONLY__ as WEB_API_TEST_ONLY,
  getCodexThreadState,
  listCodexCollaborationModes,
  listCodexModels,
} from "../../web/api";
import {
  getCodexProjects,
  getThreadReadStates,
} from "../../web/codex-organization-api";
import { requestJson } from "../../web/transport";
import {
  addCodexHomeToApiUrl,
  setActiveCodexHomeId,
} from "../../web/codex-home-scope";
import { RemoteClient } from "../../web/remote-client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

test.afterEach(() => {
  setActiveCodexHomeId("main");
  WEB_API_TEST_ONLY.resetApiRequestCaches();
});

test("API URL scoping preserves main URLs and existing query parameters", () => {
  assert.equal(addCodexHomeToApiUrl("/api/sessions", "main"), "/api/sessions");
  assert.equal(
    addCodexHomeToApiUrl("/api/sessions?limit=10", "work"),
    "/api/sessions?limit=10&codexHome=work",
  );
  assert.equal(
    addCodexHomeToApiUrl("/api/codex-homes", "work"),
    "/api/codex-homes",
  );
  assert.equal(
    addCodexHomeToApiUrl("/api/codex-deck/config", "work"),
    "/api/codex-deck/config",
  );
  assert.equal(
    addCodexHomeToApiUrl("/assets/app.js", "work"),
    "/assets/app.js",
  );
});

test("Codex model caches are isolated by active home", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return jsonResponse({
      models: [
        { id: url.includes("codexHome=work") ? "work-model" : "main-model" },
      ],
    });
  };

  try {
    setActiveCodexHomeId("main");
    assert.equal((await listCodexModels())[0]?.id, "main-model");
    assert.equal((await listCodexModels())[0]?.id, "main-model");

    setActiveCodexHomeId("work");
    assert.equal((await listCodexModels())[0]?.id, "work-model");
    assert.equal((await listCodexModels())[0]?.id, "work-model");

    setActiveCodexHomeId("main");
    assert.equal((await listCodexModels())[0]?.id, "main-model");

    assert.deepEqual(calls, [
      "/api/codex/models",
      "/api/codex/models?codexHome=work",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a busy home's background RPCs leave connections for session history", async (t) => {
  let release!: () => void;
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input, "http://codex-deck.local");
    urls.push(url);
    if (url.pathname.startsWith("/api/codex/")) await busy;
    return jsonResponse({});
  });

  setActiveCodexHomeId("work");
  const snapshots = Promise.all([
    getThreadReadStates(),
    getCodexProjects(["running"]),
    listCodexModels(),
    listCodexCollaborationModes(),
    getCodexThreadState("running", "turn-1"),
  ]);
  try {
    await requestJson("/api/conversation/running/messages");
    assert.deepEqual(
      urls.map((url) => url.pathname),
      [
        "/api/codex/read-states",
        "/api/codex/projects",
        "/api/conversation/running/messages",
      ],
    );
    setActiveCodexHomeId("other");
  } finally {
    release();
    await snapshots;
  }
  assert.equal(urls.length, 6);
  assert.ok(urls.every((url) => url.searchParams.get("codexHome") === "work"));
});

test("remote requests preserve the selected Codex home in the relay path", async () => {
  class CapturingRemoteClient extends RemoteClient {
    public capturedBody: unknown = null;

    public override async callRemote<T>(
      _method: string,
      body: unknown,
    ): Promise<T> {
      this.capturedBody = body;
      return { status: 200, body: { projects: [] } } as T;
    }
  }

  const client = new CapturingRemoteClient();
  setActiveCodexHomeId("work");
  await client.requestJson("/api/projects?archived=false");

  assert.deepEqual(client.capturedBody, {
    method: "GET",
    path: "/api/projects?archived=false&codexHome=work",
    body: undefined,
  });
});
