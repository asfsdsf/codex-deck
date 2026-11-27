import assert from "node:assert/strict";
import test from "node:test";
import { requestLocalJson } from "../../web/transport/shared";
import { readBeforeFirstMessageHooks } from "../../web/deck-plugins-api";

function mockFetch(
  t: test.TestContext,
  body: string,
  init: { status?: number; contentType?: string } = {},
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "application/json" },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("valid JSON objects with a text field are returned, not treated as non-JSON", async (t) => {
  const status = {
    jobId: "job-1",
    done: true,
    plugins: [],
    activePlugin: null,
    phase: "done",
    startedAt: 1,
    completedPlugins: [],
    text: "Write a new plugin: migrate dsh-context.",
    originalText: "Write a new plugin: migrate dsh-context.",
    changed: false,
  };
  mockFetch(t, JSON.stringify(status));
  assert.deepEqual(
    await requestLocalJson("/api/deck/plugins/hooks/before-first-message/job-1"),
    status,
  );
});

test("finished first-message hook statuses are readable through the plugin API", async (t) => {
  mockFetch(
    t,
    JSON.stringify({
      jobId: "job-2",
      done: true,
      plugins: [{ id: "prompt-allocator", name: "Prompt Allocator", waitingLabel: "…" }],
      activePlugin: null,
      phase: "done",
      startedAt: 1,
      completedPlugins: [{ pluginId: "prompt-allocator", pluginName: "Prompt Allocator", changed: true }],
      text: "Prepended rules\n\nOriginal message",
      originalText: "Original message",
      changed: true,
    }),
  );
  const result = await readBeforeFirstMessageHooks("job-2", "main");
  assert.equal(result.done, true);
  assert.equal(result.text, "Prepended rules\n\nOriginal message");
  assert.equal(result.changed, true);
});

test("successful non-JSON bodies still raise a non-JSON error", async (t) => {
  mockFetch(t, "<html>proxy page</html>", { contentType: "text/html" });
  await assert.rejects(
    requestLocalJson("/api/sessions"),
    /Endpoint returned a non-JSON response \(text\/html\): <html>proxy page<\/html>/,
  );
});

test("failed responses prefer the JSON error and fall back to a non-JSON preview", async (t) => {
  mockFetch(t, JSON.stringify({ error: "Plugin hook job expired or was not found." }), { status: 404 });
  await assert.rejects(requestLocalJson("/api/x"), /^Error: Plugin hook job expired or was not found\.$/);
  mockFetch(t, "Bad gateway", { status: 502, contentType: "text/plain" });
  await assert.rejects(requestLocalJson("/api/x"), /Request failed with status 502 \(text\/plain\): Bad gateway/);
  mockFetch(t, JSON.stringify({ text: "not an error field" }), { status: 500 });
  await assert.rejects(requestLocalJson("/api/x"), /^Error: Request failed with status 500$/);
});

test("empty and null bodies resolve to an empty object", async (t) => {
  mockFetch(t, "");
  assert.deepEqual(await requestLocalJson("/api/x"), {});
  mockFetch(t, "null");
  assert.deepEqual(await requestLocalJson("/api/x"), {});
});
