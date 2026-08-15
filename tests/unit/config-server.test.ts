import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server";

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
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
