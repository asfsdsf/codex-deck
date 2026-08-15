import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHomeRuntimeManager } from "../../api/codex-home-runtime-manager";
import type { ResolvedCodexHome } from "../../api/codex-home-registry";

test("additional Codex home runtime proxies requests to an isolated child", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-runtime-"));
  const entryPath = join(root, "runtime.mjs");
  await writeFile(
    entryPath,
    [
      'import { createServer } from "node:http";',
      "const server = createServer((request, response) => {",
      '  if (request.url?.startsWith("/stream")) {',
      '    response.writeHead(200, { "content-type": "text/plain" });',
      '    response.write("first");',
      '    setTimeout(() => response.end("-second"), 5);',
      "    return;",
      "  }",
      '  let body = "";',
      '  request.setEncoding("utf8");',
      '  request.on("data", (chunk) => { body += chunk; });',
      '  request.on("end", () => {',
      '    response.setHeader("content-type", "application/json");',
      "    response.end(JSON.stringify({",
      "      url: request.url,",
      "      method: request.method,",
      "      body,",
      "      codexHome: process.env.CODEX_HOME,",
      "      translationCommand: process.env.CODEXDECK_RUNTIME_TRANSLATION_COMMAND,",
      "    }));",
      "  });",
      "});",
      'server.listen(0, "127.0.0.1", () => {',
      "  const address = server.address();",
      '  process.send?.({ type: "codex-home-runtime-ready", port: address.port });',
      "});",
      'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    ].join("\n"),
  );

  const home: ResolvedCodexHome = {
    id: "work",
    label: "Work",
    path: join(root, "home"),
    isMain: false,
    available: true,
    unavailableReason: null,
    translationCommand: "translate-work",
  };
  const manager = new CodexHomeRuntimeManager([home], entryPath);

  try {
    const response = await manager.fetch(
      "work",
      new Request("http://codex-deck.test/api/echo?foo=1&codexHome=work", {
        method: "POST",
        body: "payload",
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: "/api/echo?foo=1",
      method: "POST",
      body: "payload",
      codexHome: home.path,
      translationCommand: "translate-work",
    });

    const streamResponse = await manager.fetch(
      "work",
      new Request("http://codex-deck.test/stream?codexHome=work"),
    );
    assert.equal(await streamResponse.text(), "first-second");
  } finally {
    manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("additional Codex home runtime reports unknown and unavailable homes", async () => {
  const manager = new CodexHomeRuntimeManager(
    [
      {
        id: "missing",
        label: "Missing",
        path: "/missing",
        isMain: false,
        available: false,
        unavailableReason: "Directory does not exist",
      },
    ],
    "/unused/runtime.mjs",
  );

  assert.equal(
    (await manager.fetch("unknown", new Request("http://test/api"))).status,
    404,
  );
  const unavailable = await manager.fetch(
    "missing",
    new Request("http://test/api"),
  );
  assert.equal(unavailable.status, 409);
  assert.deepEqual(await unavailable.json(), {
    error: "Directory does not exist",
  });
});
