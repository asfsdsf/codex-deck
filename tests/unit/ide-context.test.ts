import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  applyIdeContextToInput,
  fetchIdeContext,
  IDE_CONTEXT_SOURCE_CLIENT_ID,
  IdeContextError,
  ideContextPromptSkipHint,
  ideContextUserFacingHint,
  legacyIpcSocketPaths,
  parseIdeContext,
  primaryIpcSocketPath,
  renderIdeContextPrompt,
  summarizeIdeContext,
  type IdeContext,
} from "../../api/codex-ide-context";
import {
  applyIdeContextForSend,
  registerIdeContextRoutes,
} from "../../api/server/ide-context-routes";
import {
  describeIdeContextStatus,
  formatIdeContextSummary,
  parseIdeCommandArgs,
  stripIdeContextPrefix,
} from "../../web/ide-context";
import { sanitizeText } from "../../web/utils";

const uid = process.getuid?.() ?? 0;
const unexpected = (): IdeContextError => {
  throw new Error("expected an IDE context failure");
};
const asIdeError = (error: unknown) => error as IdeContextError;
const unixOnly = process.platform === "win32" ? test.skip : test;

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Reads framed JSON messages from the client side of a fake router. */
function frameReader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const queue: Record<string, unknown>[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
      buffer = buffer.subarray(4 + length);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    }
  });
  return () =>
    new Promise<Record<string, unknown>>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
}

function tempSocketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ide-"));
  chmodSync(dir, 0o700);
  return dir;
}

async function listen(
  socketPath: string,
  onConnection: (
    socket: Socket,
    next: () => Promise<Record<string, unknown>>,
  ) => void,
): Promise<Server> {
  const server = createServer((socket) =>
    onConnection(socket, frameReader(socket)),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

const sampleContext = {
  activeFile: {
    label: "lib.rs",
    path: "src/lib.rs",
    fsPath: "/repo/src/lib.rs",
    selection: {
      start: { line: 4, character: 0 },
      end: { line: 6, character: 1 },
    },
    activeSelectionContent: "fn selected() {}",
    selections: [],
  },
  openTabs: [
    { label: "lib.rs", path: "src/lib.rs" },
    { label: "main.rs", path: "src/main.rs", startLine: 2 },
  ],
  processEnv: { path: "/usr/bin" },
};

function successResponse(requestId: unknown) {
  return {
    type: "response",
    requestId,
    resultType: "success",
    method: "ide-context",
    handledByClientId: "vscode-client",
    result: { type: "broadcast", ideContext: sampleContext },
  };
}

unixOnly(
  "fetches IDE context over the router protocol and answers inbound traffic",
  async () => {
    const dir = tempSocketDir();
    const socketPath = join(dir, "ipc.sock");
    const seen: Record<string, unknown>[] = [];
    const server = await listen(socketPath, async (socket, next) => {
      const request = await next();
      seen.push(request);
      socket.write(
        frame({
          type: "request",
          requestId: "inbound-request",
          sourceClientId: "vscode-client",
          version: 0,
          method: "unknown-method",
          params: {},
        }),
      );
      seen.push(await next());
      socket.write(
        frame({
          type: "client-discovery-request",
          requestId: "discovery",
          request,
        }),
      );
      seen.push(await next());
      socket.write(
        frame({
          type: "broadcast",
          method: "thread-stream-state-changed",
          params: "x".repeat(2 * 1024 * 1024),
        }),
      );
      socket.write(
        frame({
          type: "response",
          requestId: "someone-else",
          resultType: "success",
        }),
      );
      // Split the final frame across writes to exercise partial reads.
      const final = frame(successResponse(request.requestId));
      socket.write(final.subarray(0, 3));
      setTimeout(() => socket.write(final.subarray(3)), 10);
    });
    try {
      const context = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [socketPath],
      });
      assert.equal(
        context.activeFile?.activeSelectionContent,
        "fn selected() {}",
      );
      assert.deepEqual(context.openTabs, [
        { label: "lib.rs", path: "src/lib.rs" },
        { label: "main.rs", path: "src/main.rs" },
      ]);
      const [request, inboundResponse, discoveryResponse] = seen;
      assert.equal(request.type, "request");
      assert.equal(request.method, "ide-context");
      assert.equal(request.version, 0);
      assert.equal(request.sourceClientId, IDE_CONTEXT_SOURCE_CLIENT_ID);
      assert.deepEqual(request.params, { workspaceRoot: "/repo" });
      assert.match(String(request.requestId), /^[0-9a-f-]{36}$/);
      assert.deepEqual(inboundResponse, {
        type: "response",
        requestId: "inbound-request",
        resultType: "error",
        error: "no-handler-for-request",
      });
      assert.deepEqual(discoveryResponse, {
        type: "client-discovery-response",
        requestId: "discovery",
        response: { canHandle: false },
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

unixOnly(
  "falls back to the legacy socket only when the primary cannot connect",
  async () => {
    const dir = tempSocketDir();
    const legacyPath = join(dir, "legacy.sock");
    const server = await listen(legacyPath, async (socket, next) => {
      const request = await next();
      socket.write(frame(successResponse(request.requestId)));
    });
    try {
      const context = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [join(dir, "missing.sock"), legacyPath],
      });
      assert.equal(context.activeFile?.path, "src/lib.rs");
    } finally {
      server.close();
    }

    // A protocol error on the primary socket is final, like upstream.
    const primaryPath = join(dir, "primary.sock");
    const primary = await listen(primaryPath, (socket) => {
      socket.write(frame({ type: "mystery" }));
    });
    let legacyUsed = false;
    const legacy = await listen(legacyPath, () => {
      legacyUsed = true;
    });
    try {
      await assert.rejects(
        fetchIdeContext({
          workspaceRoot: "/repo",
          codexHome: "/unused",
          socketPaths: [primaryPath, legacyPath],
        }),
        (error: unknown) =>
          error instanceof IdeContextError &&
          error.kind === "invalid-response" &&
          /unexpected IDE context message type: mystery/.test(error.message),
      );
      assert.equal(legacyUsed, false);
    } finally {
      primary.close();
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

unixOnly(
  "maps router errors, timeouts, oversize frames and unsafe sockets to upstream hints",
  async () => {
    const dir = tempSocketDir();
    const errorPath = join(dir, "error.sock");
    const errorServer = await listen(errorPath, async (socket, next) => {
      const request = await next();
      socket.write(
        frame({
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "no-client-found",
        }),
      );
    });
    const silentPath = join(dir, "silent.sock");
    const silentServer = await listen(silentPath, () => {});
    const hugePath = join(dir, "huge.sock");
    const hugeServer = await listen(hugePath, (socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(256 * 1024 * 1024 + 1, 0);
      socket.write(header);
    });
    try {
      const requestFailed = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [errorPath],
      }).then(unexpected, asIdeError);
      assert.equal(requestFailed.kind, "request-failed");
      assert.equal(requestFailed.code, "no-client-found");
      assert.equal(
        ideContextUserFacingHint(requestFailed),
        "Open this project in VS Code or Cursor with the Codex extension active.",
      );

      const timedOut = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [silentPath],
        timeoutMs: 100,
      }).then(unexpected, asIdeError);
      assert.equal(timedOut.kind, "timeout");
      assert.equal(
        ideContextPromptSkipHint(timedOut),
        "Codex timed out waiting for IDE context. It will keep trying on future messages.",
      );

      const tooLarge = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [hugePath],
      }).then(unexpected, asIdeError);
      assert.equal(tooLarge.kind, "too-large");

      const missing = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        socketPaths: [join(dir, "nope.sock")],
      }).then(unexpected, asIdeError);
      assert.equal(missing.kind, "connect");
      assert.equal(
        ideContextUserFacingHint(missing),
        "Open this project in VS Code or Cursor with the Codex extension active.",
      );

      // A socket in a directory other users can write to is never used.
      const openDir = join(dir, "open");
      mkdirSync(openDir);
      chmodSync(openDir, 0o777);
      const openPath = join(openDir, "ipc.sock");
      let connected = false;
      const openServer = await listen(openPath, () => {
        connected = true;
      });
      try {
        const unsafe = await fetchIdeContext({
          workspaceRoot: "/repo",
          codexHome: "/unused",
          socketPaths: [openPath],
        }).then(unexpected, asIdeError);
        assert.equal(unsafe.kind, "connect");
        assert.match(unsafe.message, /writable by other users/);
        assert.equal(connected, false);
      } finally {
        openServer.close();
      }

      const unsupported = await fetchIdeContext({
        workspaceRoot: "/repo",
        codexHome: "/unused",
        platform: "win32",
      }).then(unexpected, asIdeError);
      assert.equal(unsupported.kind, "unsupported-platform");
    } finally {
      errorServer.close();
      silentServer.close();
      hugeServer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("socket discovery matches upstream paths", () => {
  assert.equal(
    primaryIpcSocketPath("/home/me/.codex"),
    "/home/me/.codex/ipc/ipc.sock",
  );
  assert.deepEqual(legacyIpcSocketPaths("/tmp", 501), [
    "/tmp/codex-ipc/ipc-501.sock",
  ]);
  assert.deepEqual(legacyIpcSocketPaths("/tmp", 0), [
    "/tmp/codex-ipc/ipc.sock",
    "/tmp/codex-ipc/ipc-0.sock",
  ]);
  assert.ok(uid >= 0);
});

function descriptor(label: string, path: string) {
  return { label, path };
}

test("renders the prompt context exactly like upstream", () => {
  const context = parseIdeContext(sampleContext);
  assert.equal(
    renderIdeContextPrompt(context),
    "# Context from my IDE setup:\n\n## Active file: src/lib.rs\n\n## Active selection of the file:\nfn selected() {}\n## Open tabs:\n- lib.rs: src/lib.rs\n- main.rs: src/main.rs\n",
  );
  assert.equal(
    renderIdeContextPrompt({ activeFile: null, openTabs: [] }),
    null,
  );

  const ranges: IdeContext = {
    activeFile: {
      ...descriptor("lib.rs", "src/lib.rs"),
      selection: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 5 },
      },
      activeSelectionContent: "",
      selections: [
        { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
        { start: { line: 3, character: 0 }, end: { line: 4, character: 1 } },
      ],
    },
    openTabs: [],
  };
  assert.equal(
    renderIdeContextPrompt(ranges),
    "# Context from my IDE setup:\n\n## Active file: src/lib.rs\n\n## Active selection ranges:\n- src/lib.rs: line 2, column 3 to line 2, column 6\n- src/lib.rs: line 4, column 1 to line 5, column 2\n",
  );

  const large = renderIdeContextPrompt({
    activeFile: {
      ...descriptor("large.txt", "large.txt"),
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      activeSelectionContent: `${"a".repeat(40_000)}tail`,
      selections: [],
    },
    openTabs: [],
  })!;
  assert.ok(large.includes("[Selection truncated to 40000 characters.]"));
  assert.ok(!large.includes("tail"));

  const manyTabs = renderIdeContextPrompt({
    activeFile: null,
    openTabs: Array.from({ length: 102 }, (_, index) =>
      descriptor(`file-${index}.rs`, `src/file-${index}.rs`),
    ),
  })!;
  assert.ok(manyTabs.includes("- file-99.rs: src/file-99.rs\n"));
  assert.ok(!manyTabs.includes("- file-100.rs: src/file-100.rs\n"));
  assert.ok(manyTabs.includes("[2 open tabs omitted.]\n"));

  assert.throws(
    () => parseIdeContext({ activeFile: { label: "x" } }),
    IdeContextError,
  );
  assert.throws(
    () => parseIdeContext({ openTabs: [{ label: 1 }] }),
    IdeContextError,
  );
});

test("applies context with the desktop request delimiter and keeps item order", () => {
  const context: IdeContext = {
    activeFile: {
      ...descriptor("lib.rs", "src/lib.rs"),
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      activeSelectionContent: "",
      selections: [],
    },
    openTabs: [],
  };
  const { input, applied } = applyIdeContextToInput(context, [
    { type: "image", url: "data:image/png;base64,AA==" },
    { type: "text", text: "Ask $figma" },
  ]);
  assert.equal(applied, true);
  assert.deepEqual(input, [
    { type: "image", url: "data:image/png;base64,AA==" },
    {
      type: "text",
      text: "# Context from my IDE setup:\n\n## Active file: src/lib.rs\n\n## My request for Codex:\nAsk $figma",
    },
  ]);
  const imageOnly = applyIdeContextToInput(context, [
    { type: "image", url: "data:image/png;base64,AA==" },
  ]);
  assert.equal(imageOnly.input[0].type, "text");
  assert.equal(
    applyIdeContextToInput({ activeFile: null, openTabs: [] }, []).applied,
    false,
  );

  // Transcripts show only the request, like upstream.
  const sent = (input[1] as { text: string }).text;
  assert.equal(stripIdeContextPrefix(sent), "Ask $figma");
  assert.equal(sanitizeText(sent), "Ask $figma");
  assert.equal(
    stripIdeContextPrefix("no prefix\n## My request for Codex:\nhi"),
    "no prefix\n## My request for Codex:\nhi",
  );
});

test("summaries keep selection text on the backend", () => {
  const summary = summarizeIdeContext(parseIdeContext(sampleContext));
  assert.deepEqual(summary.activeFile, { label: "lib.rs", path: "src/lib.rs" });
  assert.deepEqual(summary.selections, [
    { startLine: 5, startColumn: 1, endLine: 7, endColumn: 2 },
  ]);
  assert.equal(summary.selectionChars, 16);
  assert.equal(summary.openTabCount, 2);
  assert.equal(summary.hasPromptContext, true);
  assert.ok(!JSON.stringify(summary).includes("fn selected"));
  assert.equal(
    formatIdeContextSummary(summary),
    "lib.rs · lines 5–7 selected · 2 open tabs",
  );
});

test("/ide command parsing and status wording follow the TUI", () => {
  assert.equal(parseIdeCommandArgs(""), "toggle");
  assert.equal(parseIdeCommandArgs(" ON "), "on");
  assert.equal(parseIdeCommandArgs("off"), "off");
  assert.equal(parseIdeCommandArgs("status"), "status");
  assert.equal(parseIdeCommandArgs("maybe"), null);
  assert.deepEqual(
    describeIdeContextStatus({
      available: false,
      reason: "connect",
      hint: "Open it.",
    }),
    { enabled: false, message: "IDE context could not be enabled. Open it." },
  );
  const summary = summarizeIdeContext({ activeFile: null, openTabs: [] });
  assert.equal(
    describeIdeContextStatus({ available: true, summary }).message,
    "IDE context is on. Connected to your IDE.",
  );
});

test("IDE context route and send helper use the thread workspace", async () => {
  const roots: string[] = [];
  const fetch = async (options: { workspaceRoot: string }) => {
    roots.push(options.workspaceRoot);
    if (options.workspaceRoot === "/down") {
      throw new IdeContextError("connect", "ECONNREFUSED");
    }
    return parseIdeContext(sampleContext);
  };
  const app = new Hono();
  registerIdeContextRoutes(app, {
    fetch,
    codexHome: () => "/codex",
    getClient: () => ({
      getThreadSummary: async () => ({ cwd: "/repo" }) as never,
    }),
  });
  const ok = await (
    await app.request("/api/codex/ide-context?threadId=t1")
  ).json();
  assert.equal(ok.available, true);
  assert.equal(ok.summary.activeFile.path, "src/lib.rs");
  const down = await (
    await app.request("/api/codex/ide-context?cwd=/down")
  ).json();
  assert.deepEqual(down, {
    available: false,
    reason: "connect",
    hint: "Open this project in VS Code or Cursor with the Codex extension active.",
  });
  assert.deepEqual(roots, ["/repo", "/down"]);

  const sent = await applyIdeContextForSend(
    [{ type: "text", text: "hi" }],
    "/repo",
    {
      fetch,
      codexHome: () => "/codex",
    },
  );
  assert.equal(sent.ideContext.applied, true);
  assert.match(
    (sent.input[0] as { text: string }).text,
    /## My request for Codex:\nhi$/,
  );

  const skipped = await applyIdeContextForSend(
    [{ type: "text", text: "hi" }],
    "/down",
    {
      fetch,
      codexHome: () => "/codex",
    },
  );
  assert.deepEqual(skipped.input, [{ type: "text", text: "hi" }]);
  assert.equal(skipped.ideContext.applied, false);
  assert.equal(
    skipped.ideContext.skippedHint,
    "Open this project in VS Code or Cursor with the Codex extension active.",
  );
  const noWorkspace = await applyIdeContextForSend(
    [{ type: "text", text: "hi" }],
    null,
    {
      fetch,
    },
  );
  assert.equal(noWorkspace.ideContext.applied, false);
});
