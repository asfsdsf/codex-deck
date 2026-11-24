import assert from "node:assert/strict";
import test from "node:test";
import {
  setCodexAppServerClientForTests,
  type CodexAppServerClientFacade,
} from "../../api/codex-app-server";
import { createServer } from "../../api/server";
import { createTempCodexDir } from "./test-utils";

test("runtime server initialization warms app-server model caches", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-startup-warmup",
  );
  let resolveModelsStarted!: () => void;
  let resolveModesStarted!: () => void;
  const modelsStarted = new Promise<void>((resolve) => {
    resolveModelsStarted = resolve;
  });
  const modesStarted = new Promise<void>((resolve) => {
    resolveModesStarted = resolve;
  });
  let modelCalls = 0;
  let modeCalls = 0;
  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => {
      modelCalls += 1;
      resolveModelsStarted();
      return [];
    },
    listCollaborationModes: async () => {
      modeCalls += 1;
      resolveModesStarted();
      return [];
    },
  };
  const server = createServer({
    port: 0,
    codexDir: rootDir,
    open: false,
    runtimeEntryPath: "runtime.js",
  });

  try {
    setCodexAppServerClientForTests(mockClient);
    await server.initialize();
    await Promise.all([modelsStarted, modesStarted]);
  } finally {
    server.stop();
    setCodexAppServerClientForTests(null);
    await cleanup();
  }

  assert.equal(modelCalls, 1);
  assert.equal(modeCalls, 1);
});
