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
      "const pendingStreams = new Map();",
      'process.on("message", (message) => {',
      '  if (message?.type === "codex-home-runtime-abort") {',
      "    const finish = pendingStreams.get(message.requestId);",
      "    finish?.();",
      "    return;",
      "  }",
      '  if (message?.type !== "codex-home-runtime-request") return;',
      "  const url = new URL(message.url);",
      '  if (url.pathname === "/stream") {',
      "    process.send?.({",
      '      type: "codex-home-runtime-response-start",',
      "      requestId: message.requestId,",
      "      status: 200,",
      '      statusText: "OK",',
      '      headers: [["content-type", "text/plain"]],',
      "      hasBody: true,",
      "    });",
      "    process.send?.({",
      '      type: "codex-home-runtime-response-chunk",',
      "      requestId: message.requestId,",
      '      chunkBase64: Buffer.from("first").toString("base64"),',
      "    });",
      "    setTimeout(() => {",
      "      process.send?.({",
      '        type: "codex-home-runtime-response-chunk",',
      "        requestId: message.requestId,",
      '        chunkBase64: Buffer.from("-second").toString("base64"),',
      "      });",
      "      process.send?.({",
      '        type: "codex-home-runtime-response-end",',
      "        requestId: message.requestId,",
      "      });",
      "    }, 5);",
      "    return;",
      "  }",
      '  if (url.pathname === "/stream-until-abort") {',
      "    process.send?.({",
      '      type: "codex-home-runtime-response-start",',
      "      requestId: message.requestId,",
      "      status: 200,",
      '      statusText: "OK",',
      '      headers: [["content-type", "text/plain"]],',
      "      hasBody: true,",
      "    });",
      "    process.send?.({",
      '      type: "codex-home-runtime-response-chunk",',
      "      requestId: message.requestId,",
      '      chunkBase64: Buffer.from("ready").toString("base64"),',
      "    });",
      "    pendingStreams.set(message.requestId, () => {",
      "      pendingStreams.delete(message.requestId);",
      "      process.send?.({",
      '        type: "codex-home-runtime-response-end",',
      "        requestId: message.requestId,",
      "      });",
      "    });",
      "    return;",
      "  }",
      "  const responseBody = JSON.stringify({",
      "      url: `${url.pathname}${url.search}`,",
      "      method: message.method,",
      "      body: message.bodyBase64",
      '        ? Buffer.from(message.bodyBase64, "base64").toString("utf8")',
      '        : "",',
      "      codexHome: process.env.CODEX_HOME,",
      "      mainCodexHome: process.env.CODEXDECK_RUNTIME_MAIN_CODEX_HOME,",
      "      translationCommand: process.env.CODEXDECK_RUNTIME_TRANSLATION_COMMAND,",
      '      transport: "ipc",',
      "  });",
      "  process.send?.({",
      '    type: "codex-home-runtime-response-start",',
      "    requestId: message.requestId,",
      "    status: 200,",
      '    statusText: "OK",',
      '    headers: [["content-type", "application/json"]],',
      "    hasBody: true,",
      "  });",
      "  process.send?.({",
      '    type: "codex-home-runtime-response-chunk",',
      "    requestId: message.requestId,",
      '    chunkBase64: Buffer.from(responseBody).toString("base64"),',
      "  });",
      "  process.send?.({",
      '    type: "codex-home-runtime-response-end",',
      "    requestId: message.requestId,",
      "  });",
      "});",
      'process.send?.({ type: "codex-home-runtime-ready" });',
      'process.on("SIGTERM", () => process.exit(0));',
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
  const mainCodexHome = join(root, "main-home");
  const manager = new CodexHomeRuntimeManager([home], entryPath, mainCodexHome);

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
      mainCodexHome,
      translationCommand: "translate-work",
      transport: "ipc",
    });

    await manager.updateHomes([
      {
        ...home,
        translationCommand: "translate-updated",
      },
    ]);
    const updatedResponse = await manager.fetch(
      "work",
      new Request("http://codex-deck.test/api/echo?codexHome=work"),
    );
    assert.equal(updatedResponse.status, 200);
    assert.deepEqual(await updatedResponse.json(), {
      url: "/api/echo",
      method: "GET",
      body: "",
      codexHome: home.path,
      mainCodexHome,
      translationCommand: "translate-updated",
      transport: "ipc",
    });

    const streamResponse = await manager.fetch(
      "work",
      new Request("http://codex-deck.test/stream?codexHome=work"),
    );
    assert.equal(await streamResponse.text(), "first-second");

    const abortController = new AbortController();
    const abortResponse = await manager.fetch(
      "work",
      new Request("http://codex-deck.test/stream-until-abort", {
        signal: abortController.signal,
      }),
    );
    const reader = abortResponse.body?.getReader();
    assert.ok(reader);
    const firstChunk = await reader.read();
    assert.equal(new TextDecoder().decode(firstChunk.value), "ready");
    abortController.abort();
    assert.equal((await reader.read()).done, true);
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
