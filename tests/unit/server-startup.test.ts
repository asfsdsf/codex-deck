import assert from "node:assert/strict";
import test from "node:test";
import {
  setCodexAppServerClientForTests,
  type CodexAppServerClientFacade,
} from "../../api/codex-app-server";
import { createServer } from "../../api/server";
import { createTempCodexDir } from "./test-utils";

test(
  "server initialization warms app-server caches once without waiting for RPCs",
  { timeout: 5000 },
  async () => {
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
        return new Promise(() => {});
      },
      listCollaborationModes: async () => {
        modeCalls += 1;
        resolveModesStarted();
        return new Promise(() => {});
      },
    };
    const server = createServer({
      port: 0,
      codexDir: rootDir,
      open: false,
      warmAppServer: true,
    });

    try {
      setCodexAppServerClientForTests(mockClient);
      const initialization = server.initialize();
      assert.equal(server.initialize(), initialization);
      await initialization;
      await Promise.all([modelsStarted, modesStarted]);
    } finally {
      server.stop();
      setCodexAppServerClientForTests(null);
      await cleanup();
    }

    assert.equal(modelCalls, 1);
    assert.equal(modeCalls, 1);
  },
);

for (const warmAppServer of [false, true]) {
  test(`server initialization tolerates unavailable app-server (warmup=${warmAppServer})`, async () => {
    const { rootDir, cleanup } = await createTempCodexDir(
      "server-startup-unavailable",
    );
    let calls = 0;
    const unavailable = () => {
      calls += 1;
      throw new Error("Codex unavailable");
    };
    const server = createServer({
      port: 0,
      codexDir: rootDir,
      open: false,
      warmAppServer,
    });
    try {
      setCodexAppServerClientForTests({
        listModels: unavailable,
        listCollaborationModes: unavailable,
      });
      await server.initialize();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, warmAppServer ? 2 : 0);
    } finally {
      server.stop();
      setCodexAppServerClientForTests(null);
      await cleanup();
    }
  });
}
