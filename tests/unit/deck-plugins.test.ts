import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  DeckPluginFileUpload,
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
  capabilities: ["context.read", "state.read", "state.write"],
  entrypoints: { panel: "index.html" },
};

function upload(path: string, contents: string | Buffer): DeckPluginFileUpload {
  return {
    path,
    contentBase64: Buffer.isBuffer(contents)
      ? contents.toString("base64")
      : Buffer.from(contents).toString("base64"),
  };
}

function packageFiles(
  currentManifest = manifest,
  extraFiles: DeckPluginFileUpload[] = [],
): DeckPluginFileUpload[] {
  return [
    upload("plugin.json", JSON.stringify(currentManifest)),
    upload(
      currentManifest.entrypoints.panel!,
      `<!doctype html><html><head><link rel="stylesheet" href="assets/panel.css"></head><body><h1>${currentManifest.name}</h1><script type="module" src="panel.js"></script></body></html>`,
    ),
    upload("panel.js", "window.ready = true;"),
    upload("assets/panel.css", "h1 { color: green; }"),
    upload("assets/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ...extraFiles,
  ];
}

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
    install(files = packageFiles(), replaceVersion?: string) {
      return app.request(`${base}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, replaceVersion }),
      });
    },
  };
}

test("plugin packages install as real files with separate registry metadata", async (t) => {
  const home = join(
    tmpdir(),
    `deck-plugins-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  let changes = 0;
  const first = register(home, () => changes++);
  const result = await first.install();
  assert.equal(result.status, 200);
  assert.equal(changes, 1);

  const packageRoot = join(home, "codex-deck", "plugins", manifest.id);
  assert.equal(
    await readFile(join(packageRoot, "plugin.json"), "utf8"),
    `${JSON.stringify(manifest)}`,
  );
  assert.equal(
    await readFile(join(packageRoot, "panel.js"), "utf8"),
    "window.ready = true;",
  );
  assert.equal(
    (await stat(join(packageRoot, "assets", "icon.png"))).isFile(),
    true,
  );
  const registry = JSON.parse(
    await readFile(join(home, "codex-deck", "plugins.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(registry, [
    { id: manifest.id, source: "package", enabled: true },
  ]);

  const reopened = register(home);
  const plugin = (await reopened.list()).plugins[0];
  assert.equal(plugin?.id, manifest.id);
  assert.equal(plugin?.source, "package");
  assert.equal(plugin?.enabled, true);
  assert.equal(plugin?.entrypoints.panel, "index.html");
});

test("package panel entry and contained assets are served inside a restricted iframe", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-runtime`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { app, install } = register(home);
  assert.equal((await install()).status, 200);

  const runtimeResponse = await app.request(`${base}/${manifest.id}/runtime`);
  assert.equal(runtimeResponse.status, 200);
  const runtime = await runtimeResponse.json();
  assert.deepEqual(runtime.manifest.capabilities, manifest.capabilities);
  assert.deepEqual(runtime.state, {});

  const page = await app.request(`${base}/${manifest.id}/files/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /sandbox allow-scripts/,
  );
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /connect-src 'none'/,
  );
  assert.match(await page.text(), /panel\.js/);
  const invalidAssetBase = await app.request(
    `${base}/${manifest.id}/files/index.html`,
    {
      headers: { "x-codex-deck-plugin-file-base": "https://attacker.example/" },
    },
  );
  assert.equal(invalidAssetBase.status, 400);

  const script = await app.request(`${base}/${manifest.id}/files/panel.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await script.text(), "window.ready = true;");
  const image = await app.request(
    `${base}/${manifest.id}/files/assets/icon.png`,
  );
  assert.equal(image.headers.get("content-type"), "image/png");
});

test("replacement requires the reviewed version and preserves enabled state and plugin data", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-replace`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { app, install, post, list } = register(home);
  assert.equal((await install()).status, 200);
  assert.equal(
    (await install(packageFiles({ ...manifest, version: "2.0.0" }))).status,
    409,
  );

  await post(`/${manifest.id}/enabled`, { enabled: false });
  const saved = await app.request(`${base}/${manifest.id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: { visits: 3, note: "hello" } }),
  });
  assert.equal(saved.status, 404);
  await post(`/${manifest.id}/enabled`, { enabled: true });
  assert.equal(
    (
      await app.request(`${base}/${manifest.id}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { visits: 3, note: "hello" } }),
      })
    ).status,
    200,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(home, "codex-deck", "plugin-data", `${manifest.id}.json`),
        "utf8",
      ),
    ),
    { visits: 3, note: "hello" },
  );
  await post(`/${manifest.id}/enabled`, { enabled: false });

  const nextManifest = { ...manifest, version: "2.0.0", name: "Notes Next" };
  assert.equal(
    (await install(packageFiles(nextManifest), "1.0.0")).status,
    200,
  );
  await post(`/${manifest.id}/enabled`, { enabled: true });
  const nextRuntime = await app.request(`${base}/${manifest.id}/runtime`);
  assert.deepEqual((await nextRuntime.json()).state, {
    visits: 3,
    note: "hello",
  });
  await post(`/${manifest.id}/enabled`, { enabled: false });
  const plugin = (await list()).plugins[0];
  assert.equal(plugin?.name, "Notes Next");
  assert.equal(plugin?.enabled, false);
  assert.equal(plugin?.version, "2.0.0");
  assert.equal(
    (await app.request(`${base}/${manifest.id}/files/index.html`)).status,
    404,
  );
});

test("enabled package runtime and file access enforce install state and persist bounded state", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-state`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { app, install, post } = register(home);
  await install();

  assert.equal(
    (
      await app.request(`${base}/${manifest.id}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { visits: 3, note: "hello" } }),
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await (await app.request(`${base}/${manifest.id}/runtime`)).json()).state,
    { visits: 3, note: "hello" },
  );

  const source = await app.request(`${base}/${manifest.id}/source`);
  const sourceBody = await source.json();
  assert.equal(source.status, 200);
  assert.equal(sourceBody.manifest.entrypoints.panel, "index.html");
  assert.ok(
    sourceBody.files.some((file: { path: string }) => file.path === "panel.js"),
  );

  await post(`/${manifest.id}/enabled`, { enabled: false });
  assert.equal(
    (await app.request(`${base}/${manifest.id}/runtime`)).status,
    404,
  );
  assert.equal(
    (await app.request(`${base}/${manifest.id}/files/index.html`)).status,
    404,
  );
  assert.equal(
    (await app.request(`${base}/${manifest.id}/source`)).status,
    200,
  );
  await post(`/${manifest.id}/enabled`, { enabled: true });
  const tooLarge = await app.request(`${base}/${manifest.id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: { text: "x".repeat(70 * 1024) } }),
  });
  assert.equal(tooLarge.status, 413);
});

test("invalid plugin package manifests, files, and replacements are rejected", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-invalid`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { install, list } = register(home);
  const invalidManifests = [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, entrypoints: {} },
    { ...manifest, id: "../../notes" },
    { ...manifest, capabilities: ["shell.exec"] },
    { ...manifest, entrypoints: { panel: "../outside.html" } },
  ];
  for (const invalid of invalidManifests) {
    assert.equal(
      (await install(packageFiles(invalid as DeckPluginManifest))).status,
      400,
    );
  }
  assert.equal((await install([upload("../escape.txt", "nope")])).status, 400);
  assert.equal(
    (await install([upload("client.js", "window.noManifest = true;")])).status,
    400,
  );
  const badEncoding = [{ path: "plugin.json", contentBase64: "not base64?" }];
  assert.equal((await install(badEncoding)).status, 400);
  assert.equal((await list()).plugins.length, 0);
});

test("concurrent package installs serialize without losing either package", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-concurrent`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = register(home);
  const secondManifest = { ...manifest, id: "example.theme", name: "Theme" };
  const installs = await Promise.all([
    first.install(),
    first.install(packageFiles(secondManifest)),
  ]);
  assert.ok(installs.every((result) => result.status === 200));
  assert.deepEqual(
    (await first.list()).plugins.map((plugin) => plugin.id).sort(),
    ["example.notes", "example.theme"],
  );
});

test("uninstall removes the plugin package and registry entry", async (t) => {
  const home = join(tmpdir(), `deck-plugins-${Date.now()}-uninstall`);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { app, install, list } = register(home);
  await install();
  assert.equal(
    (await app.request(`${base}/${manifest.id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal((await list()).plugins.length, 0);
  await assert.rejects(
    readFile(join(home, "codex-deck", "plugins", manifest.id, "plugin.json")),
  );
});
