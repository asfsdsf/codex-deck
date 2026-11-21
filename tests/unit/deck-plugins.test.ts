import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  DeckPluginManifest,
  DeckPluginsSnapshot,
} from "../../api/deck-plugin-manifest";
import { DeckPluginStore } from "../../api/deck-plugin-store";
import { registerDeckPluginRoutes } from "../../api/server/deck-plugin-routes";

const base = "/api/deck/plugins";
const manifest: DeckPluginManifest = {
  schemaVersion: 1,
  id: "example.notes",
  name: "Notes",
  version: "1.0.0",
  description: "Notes plugin metadata.",
  author: "Example team",
};

function register(home: string, onChange: () => void = () => {}) {
  const app = new Hono();
  registerDeckPluginRoutes(app, new DeckPluginStore(home, onChange));
  return {
    app,
    post(path: string, data: unknown) {
      return app.request(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    async list(): Promise<DeckPluginsSnapshot> {
      return (await app.request(base)).json();
    },
  };
}

test("plugin registry persists per selected Codex home and serializes mutations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "deck-plugins-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "main");
  let changes = 0;
  const first = register(home, () => changes++);
  const otherManifest = { ...manifest, id: "example.theme", name: "Theme" };
  const installs = await Promise.all([
    first.post("/install", { manifest }),
    first.post("/install", { manifest: otherManifest }),
  ]);
  for (const result of installs) assert.equal(result.status, 200);
  assert.equal(changes, 2);

  const reopened = register(home);
  const savedRegistry = JSON.parse(
    await readFile(join(home, "codex-deck", "plugins.json"), "utf8"),
  ) as unknown[];
  assert.equal(savedRegistry.length, 2);
  const installed = (await reopened.list()).plugins;
  assert.deepEqual(
    installed.map((plugin) => plugin.id),
    ["example.notes", "example.theme"],
  );
  assert.ok(installed.every((plugin) => plugin.enabled));
  assert.ok(
    (await register(join(directory, "alternate")).list()).plugins.length === 0,
  );

  assert.equal(
    (await first.post("/example.notes/enabled", { enabled: false })).status,
    200,
  );
  assert.equal(
    (await reopened.list()).plugins.find((plugin) => plugin.id === manifest.id)
      ?.enabled,
    false,
  );
  assert.equal(
    (await first.app.request(`${base}/example.notes`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.ok(
    !(await reopened.list()).plugins.some(
      (plugin) => plugin.id === manifest.id,
    ),
  );
  assert.equal(changes, 4);
});

test("replacing a plugin requires the reviewed version and keeps its enablement", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "deck-plugins-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { app, list, post } = register(home);
  assert.equal((await post("/install", { manifest })).status, 200);
  const next = { ...manifest, version: "2.0.0" };
  assert.equal((await post("/install", { manifest: next })).status, 409);
  assert.equal(
    (await post("/install", { manifest: next, replaceVersion: "0.9.0" }))
      .status,
    409,
  );
  await post("/example.notes/enabled", { enabled: false });
  assert.equal(
    (await post("/install", { manifest: next, replaceVersion: "1.0.0" }))
      .status,
    200,
  );
  const plugin = (await list()).plugins.find(
    (entry) => entry.id === manifest.id,
  );
  assert.equal(plugin?.enabled, false);
  assert.equal(plugin?.version, "2.0.0");
  await post("/example.notes/enabled", { enabled: true });
  assert.equal(
    (await app.request(`${base}/example.notes/actions`)).status,
    404,
  );
});

test("invalid, oversized, or executable manifests are rejected", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "deck-plugins-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { list, post } = register(home);
  for (const badManifest of [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, id: "codex-deck.legacy" },
    { ...manifest, id: "../../notes" },
    { ...manifest, actions: [{ type: "prompt", prompt: "Do something." }] },
  ]) {
    assert.equal(
      (await post("/install", { manifest: badManifest })).status,
      400,
    );
  }
  assert.equal(
    (
      await post("/install", {
        manifest: { ...manifest, name: "x".repeat(140 * 1024) },
      })
    ).status,
    413,
  );
  assert.equal((await list()).plugins.length, 0);
});
