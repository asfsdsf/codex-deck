import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server";
import { Hono } from "hono";
import { registerConfigRoutes } from "../../api/server/config-routes";
import type {
  CodexDeckConfigFileResponse,
  CodexDeckConfigWriteResponse,
} from "../../api/storage";

test("config routes return merged settings while preserving the editable home file", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-config-sources-"));
  const cwd = process.cwd();
  const codexHome = join(root, "home");
  const homePath = join(codexHome, "codex-deck", "config.toml");
  const localPath = join(root, "config.toml");
  const homeContent =
    'port = 13000\nopen = true\n[remote]\nusername = "home-user"\npassword = "home-password"\n';
  const localContent =
    'port = 14000\nopen = false\ntranslation_command = "printf local"\n[remote]\nusername = "local-user"\n[conversation_hover]\nmodel = true\n';
  try {
    await mkdir(join(codexHome, "codex-deck"), { recursive: true });
    await writeFile(homePath, homeContent);
    await writeFile(localPath, localContent);
    process.chdir(root);
    const app = new Hono();
    registerConfigRoutes(app, {
      codexHome,
      applyConfig: async () => ({
        appliedKeys: [],
        restartRequiredKeys: [],
        homes: [],
        mainHomeId: "main",
      }),
    });

    const response = await app.request("/api/codex-deck/config");
    assert.equal(response.status, 200);
    const loaded = (await response.json()) as CodexDeckConfigFileResponse;
    assert.equal(loaded.path, homePath);
    assert.equal(loaded.content, homeContent);
    assert.deepEqual(loaded.configPaths, [
      join(process.cwd(), "config.toml"),
      homePath,
    ]);
    assert.deepEqual(loaded.effectiveConfig, {
      port: 14000,
      open: false,
      translationCommand: "printf local",
      remote: { username: "local-user", password: "home-password" },
      conversationHover: { model: true },
    });

    const savedContent =
      homeContent + "\n[conversation_hover]\ntimestamp = false\n";
    const saveResponse = await app.request("/api/codex-deck/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: savedContent,
        revision: loaded.revision,
      }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = (await saveResponse.json()) as CodexDeckConfigWriteResponse;
    assert.equal(saved.content, savedContent);
    assert.equal(saved.effectiveConfig?.port, 14000);
    assert.deepEqual(saved.effectiveConfig?.conversationHover, {
      timestamp: false,
      model: true,
    });
    assert.equal(saved.hoverSettings?.timestamp, false);
    assert.equal(saved.hoverSettings?.model, true);
    assert.deepEqual(saved.configPaths, loaded.configPaths);
    assert.equal(await readFile(homePath, "utf-8"), savedContent);
    assert.equal(await readFile(localPath, "utf-8"), localContent);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("config routes save the main home file and apply runtime settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-config-server-"));
  const mainHome = join(root, "main");
  const workHome = join(root, "work");
  await mkdir(mainHome, { recursive: true });
  await mkdir(workHome, { recursive: true });
  const server = createServer({ port: 0, codexDir: mainHome, open: false });

  try {
    const initialResponse = await server.app.request("/api/codex-deck/config");
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json()) as {
      path: string;
      content: string;
      revision: string;
    };
    assert.equal(initial.content, "");
    assert.equal(initial.path, join(mainHome, "codex-deck", "config.toml"));

    const content = [
      "# config edited from the web UI",
      'translation_command = "printf applied"',
      "",
      "[codex_homes.work]",
      `path = ${JSON.stringify(workHome)}`,
      'label = "Work"',
      "",
    ].join("\n");
    const applyResponse = await server.app.request(
      "/api/codex-deck/config?codexHome=work",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, revision: initial.revision }),
      },
    );
    assert.equal(applyResponse.status, 200);
    const applied = (await applyResponse.json()) as {
      revision: string;
      appliedKeys: string[];
      restartRequiredKeys: string[];
      homes: Array<{ id: string; label: string }>;
    };
    assert.deepEqual(applied.appliedKeys, [
      "translation_command",
      "codex_homes",
    ]);
    assert.deepEqual(applied.restartRequiredKeys, []);
    assert.deepEqual(
      applied.homes.map((home) => [home.id, home.label]),
      [
        ["main", "Main"],
        ["work", "Work"],
      ],
    );
    assert.equal(await readFile(initial.path, "utf-8"), content);
    assert.equal(
      (await server.app.request("/api/projects?codexHome=work")).status,
      503,
    );

    const translateResponse = await server.app.request("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(translateResponse.status, 200);
    assert.deepEqual(await translateResponse.json(), {
      translatedText: "applied",
    });

    const staleResponse = await server.app.request("/api/codex-deck/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "port = 13000\n",
        revision: initial.revision,
      }),
    });
    assert.equal(staleResponse.status, 409);

    const restartResponse = await server.app.request("/api/codex-deck/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `port = 13000\n${content}`,
        revision: applied.revision,
      }),
    });
    assert.equal(restartResponse.status, 200);
    const restartResult = (await restartResponse.json()) as {
      appliedKeys: string[];
      restartRequiredKeys: string[];
    };
    assert.deepEqual(restartResult.appliedKeys, []);
    assert.deepEqual(restartResult.restartRequiredKeys, ["port"]);

    const updateStatusResponse = await server.app.request(
      "/api/codex-deck/update?codexHome=work",
    );
    assert.equal(updateStatusResponse.status, 200);
    const updateStatus = (await updateStatusResponse.json()) as {
      daemonManaged: boolean;
      restartSupported: boolean;
    };
    assert.equal(updateStatus.daemonManaged, false);
    assert.equal(updateStatus.restartSupported, false);

    const unmanagedUpdateResponse = await server.app.request(
      "/api/codex-deck/update",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "source", sourceRoot: root }),
      },
    );
    assert.equal(unmanagedUpdateResponse.status, 503);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
