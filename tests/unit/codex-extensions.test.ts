import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { CodexExtensions, type ExtensionRpc } from "../../api/codex-extensions";
import { validatePresetInput } from "../../api/codex-presets";
import { registerExtensionRoutes } from "../../api/server/extension-routes";

function harness(
  handler: (
    method: string,
    params: Record<string, unknown> | undefined,
    options?: { threadId?: string | null; timeoutMs?: number },
  ) => unknown,
) {
  const calls: { method: string; params: unknown; options?: unknown }[] = [];
  const notified: string[] = [];
  const rpc: ExtensionRpc = async (method, params, options) => {
    calls.push({ method, params, options });
    return handler(method, params, options);
  };
  const extensions = new CodexExtensions(rpc, (scope) => notified.push(scope));
  const app = new Hono();
  registerExtensionRoutes(app, { getExtensions: () => extensions });
  return { calls, notified, extensions, app };
}

const userLayer = (presets: Record<string, unknown>, version = "v1") => ({
  name: { type: "user", file: "/home/u/.codex/config.toml", profile: null },
  version,
  config: { tui: { presets } },
  disabledReason: null,
});

test("preset validation mirrors upstream QuickDial rules", () => {
  assert.equal(validatePresetInput("  "), "Preset input cannot be empty.");
  assert.match(validatePresetInput(" !ls") ?? "", /not shell commands/);
  assert.match(validatePresetInput("é".repeat(4001)) ?? "", /8,000 UTF-8/);
  assert.equal(validatePresetInput("/review"), null);
});

test("presets read effective config, mark non-user layers read-only, and write quoted slots", async () => {
  let version = "v1";
  const { calls, notified, app } = harness((method, params) => {
    if (method === "config/read")
      return {
        config: {
          tui: {
            presets: {
              "1": { input: "Summarize the diff", label: "" },
              "2": { input: "/review", label: "Review" },
              x: { input: "ignored" },
            },
          },
        },
        layers: [
          {
            name: { type: "project", dotCodexFolder: "/repo/.codex" },
            version: "p1",
            config: { tui: { presets: { "2": { input: "/review" } } } },
            disabledReason: null,
          },
          userLayer({ "1": { input: "Summarize the diff" } }, version),
        ],
      };
    if (method === "config/value/write") {
      assert.equal((params as Record<string, unknown>).expectedVersion, "v1");
      version = "v2";
      return { status: "ok", version: "v2" };
    }
    throw new Error(`unexpected ${method}`);
  });

  const read = await app.request("/api/codex/presets?cwd=/repo");
  assert.equal(read.status, 200);
  const snapshot = await read.json();
  assert.equal(snapshot.version, "v1");
  assert.deepEqual(
    snapshot.presets.map((p: Record<string, unknown>) => [
      p.slot,
      p.label,
      p.readOnly,
      p.source,
    ]),
    [
      ["1", null, false, "user"],
      ["2", "Review", true, "project"],
    ],
  );
  assert.deepEqual(calls[0].params, { includeLayers: true, cwd: "/repo" });

  const readOnly = await app.request("/api/codex/presets/2", {
    method: "POST",
    body: JSON.stringify({ input: "/diff" }),
  });
  assert.equal(readOnly.status, 400);
  assert.match((await readOnly.json()).error, /outside your user config/);

  const invalid = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "!rm -rf /" }),
  });
  assert.equal(invalid.status, 400);
  const badSlot = await app.request("/api/codex/presets/12", {
    method: "POST",
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(badSlot.status, 400);

  const stale = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "hi", expectedVersion: "old" }),
  });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /another window/);
  assert.deepEqual(notified, []);

  const saved = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "Explain this", label: " Explain " }),
  });
  assert.equal(saved.status, 200);
  const write = calls.find((call) => call.method === "config/value/write");
  assert.deepEqual(write?.params, {
    keyPath: 'tui.presets."3"',
    value: { input: "Explain this", label: "Explain" },
    mergeStrategy: "replace",
    expectedVersion: "v1",
  });
  assert.deepEqual(notified, ["presets"]);

  version = "v1";
  const removed = await app.request("/api/codex/presets/1", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  const deletion = calls.filter((call) => call.method === "config/value/write");
  assert.equal(
    (deletion.at(-1)?.params as Record<string, unknown>).value,
    null,
  );
  assert.deepEqual(notified, ["presets", "presets"]);
});

test("presets fall back to merging layers when the effective config omits tui", async () => {
  const { extensions } = harness(() => ({
    config: {},
    layers: [
      userLayer({ "4": { label: "Top" } }),
      {
        name: { type: "system", file: "/etc/codex/config.toml" },
        version: "s",
        config: { tui: { presets: { "4": { input: "base", label: "Low" } } } },
        disabledReason: null,
      },
    ],
  }));
  const snapshot = await extensions.readPresets();
  assert.deepEqual(snapshot.presets[0], {
    slot: "4",
    input: "base",
    label: "Top",
    source: "user",
    readOnly: false,
    invalidReason: null,
  });
});
