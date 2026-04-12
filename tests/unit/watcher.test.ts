import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getWatchRootsForTests,
  initWatcher,
  onHistoryChange,
  offHistoryChange,
  onSessionChange,
  offSessionChange,
  onWorkflowChange,
  offWorkflowChange,
  shouldIgnoreWatchPathForTests,
  shouldUsePollingForWatcherForTests,
  startWatcher,
  stopWatcher,
  waitForWatcherReady,
} from "../../api/watcher";
import {
  createTempCodexDir,
  sessionMetaLine,
  waitFor,
  writeSessionFile,
} from "./test-utils";

const TEST_TIMEOUT_MS = 6000;

test(
  "history listener fires when history.jsonl changes",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { rootDir, cleanup } = await createTempCodexDir("watcher-history");
    const historyPath = join(rootDir, "history.jsonl");
    await writeFile(historyPath, "", "utf-8");

    let fired = 0;
    const callback = () => {
      fired += 1;
    };

    try {
      initWatcher(rootDir);
      onHistoryChange(callback);
      startWatcher();
      await waitForWatcherReady();

      await appendFile(
        historyPath,
        JSON.stringify({ hello: "world" }) + "\n",
        "utf-8",
      );

      await waitFor(() => fired > 0, 3000);
      assert.equal(fired > 0, true);
    } finally {
      offHistoryChange(callback);
      stopWatcher();
      await cleanup();
    }
  },
);

test(
  "session listener extracts id from uuid file name",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { rootDir, sessionsDir, cleanup } =
      await createTempCodexDir("watcher-session");
    const historyPath = join(rootDir, "history.jsonl");
    await writeFile(historyPath, "", "utf-8");
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const relativePath = join("project-a", `${sessionId}.jsonl`);
    const filePath = await writeSessionFile(sessionsDir, relativePath, [
      sessionMetaLine(sessionId, "/repo/project-a", Date.now()),
    ]);

    let received: { sessionId: string; filePath: string } | null = null;
    const callback = (changedSessionId: string, changedPath: string) => {
      received = {
        sessionId: changedSessionId,
        filePath: changedPath,
      };
    };

    try {
      initWatcher(rootDir);
      onSessionChange(callback);
      startWatcher();
      await waitForWatcherReady();

      await appendFile(
        filePath,
        JSON.stringify({ type: "event_msg" }) + "\n",
        "utf-8",
      );

      await waitFor(() => received !== null, 5000);
      assert.equal(received?.sessionId, sessionId);
      assert.equal(received?.filePath, filePath);
    } finally {
      offSessionChange(callback);
      stopWatcher();
      await cleanup();
    }
  },
);

test(
  "session listener falls back to session_meta id when filename has no uuid",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { rootDir, sessionsDir, cleanup } =
      await createTempCodexDir("watcher-meta");
    const historyPath = join(rootDir, "history.jsonl");
    await writeFile(historyPath, "", "utf-8");
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const relativePath = join("project-b", "session-log.jsonl");
    const filePath = await writeSessionFile(sessionsDir, relativePath, [
      sessionMetaLine(sessionId, "/repo/project-b", Date.now()),
    ]);

    let receivedSessionId = "";
    const callback = (changedSessionId: string) => {
      receivedSessionId = changedSessionId;
    };

    try {
      initWatcher(rootDir);
      onSessionChange(callback);
      startWatcher();
      await waitForWatcherReady();

      await appendFile(
        filePath,
        JSON.stringify({ type: "event_msg" }) + "\n",
        "utf-8",
      );

      await waitFor(() => Boolean(receivedSessionId), 5000);
      assert.equal(receivedSessionId, sessionId);
    } finally {
      offSessionChange(callback);
      stopWatcher();
      await cleanup();
    }
  },
);

test(
  "workflow listener extracts workflow key from registry changes",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { rootDir, cleanup } = await createTempCodexDir(
      "watcher-workflow-registry",
    );
    const historyPath = join(rootDir, "history.jsonl");
    const workflowsDir = join(rootDir, "codex-deck", "workflows");
    const workflowPath = join(workflowsDir, "project-demo.json");

    await mkdir(workflowsDir, { recursive: true });
    await writeFile(historyPath, "", "utf-8");
    await writeFile(
      workflowPath,
      JSON.stringify({ key: "project-demo" }),
      "utf-8",
    );

    let received: { workflowKey: string; filePath: string } | null = null;
    const callback = (workflowKey: string, filePath: string) => {
      received = { workflowKey, filePath };
    };

    try {
      initWatcher(rootDir);
      onWorkflowChange(callback);
      startWatcher();
      await waitForWatcherReady();

      await writeFile(
        workflowPath,
        JSON.stringify({ key: "project-demo", status: "running" }),
        "utf-8",
      );

      await waitFor(() => received !== null, 5000);
      assert.equal(received?.workflowKey, "project-demo");
      assert.equal(received?.filePath, workflowPath);
    } finally {
      offWorkflowChange(callback);
      stopWatcher();
      await cleanup();
    }
  },
);

test(
  "removed listeners do not receive events",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
      "watcher-remove-listener",
    );
    const historyPath = join(rootDir, "history.jsonl");
    await writeFile(historyPath, "", "utf-8");

    const sessionId = "33333333-3333-3333-3333-333333333333";
    const sessionPath = await writeSessionFile(
      sessionsDir,
      `${sessionId}.jsonl`,
      [sessionMetaLine(sessionId, "/repo/project-c", Date.now())],
    );

    let historyCalls = 0;
    let sessionCalls = 0;
    const historyCb = () => {
      historyCalls += 1;
    };
    const sessionCb = () => {
      sessionCalls += 1;
    };

    try {
      initWatcher(rootDir);
      onHistoryChange(historyCb);
      onSessionChange(sessionCb);
      offHistoryChange(historyCb);
      offSessionChange(sessionCb);
      startWatcher();
      await waitForWatcherReady();

      await appendFile(
        historyPath,
        JSON.stringify({ test: true }) + "\n",
        "utf-8",
      );
      await appendFile(
        sessionPath,
        JSON.stringify({ type: "event_msg" }) + "\n",
        "utf-8",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(historyCalls, 0);
      assert.equal(sessionCalls, 0);
    } finally {
      stopWatcher();
      await cleanup();
    }
  },
);

test("stopWatcher is safe to call multiple times", () => {
  stopWatcher();
  stopWatcher();
  assert.ok(true);
});

test("watcher roots exclude unrelated codex directories", () => {
  const codexHome = join("/tmp", "codex-home");
  initWatcher(codexHome);
  assert.deepEqual(getWatchRootsForTests(), [
    join(codexHome, "history.jsonl"),
    join(codexHome, "sessions"),
    join(codexHome, "codex-deck", "workflows"),
  ]);
  assert.equal(
    shouldIgnoreWatchPathForTests(
      join(codexHome, "shell_snapshots", "example.sh"),
    ),
    true,
  );
  assert.equal(
    shouldIgnoreWatchPathForTests(
      join(codexHome, "sessions", "project-a", "session.jsonl"),
    ),
    false,
  );
  assert.equal(
    shouldIgnoreWatchPathForTests(
      join(codexHome, "codex-deck", "workflows", "project-demo.json"),
    ),
    false,
  );
});

test("watcher defaults to polling on Windows", () => {
  assert.equal(shouldUsePollingForWatcherForTests("win32", {}), true);
  assert.equal(shouldUsePollingForWatcherForTests("linux", {}), false);
});

test("watcher polling env override takes precedence over platform default", () => {
  assert.equal(
    shouldUsePollingForWatcherForTests("win32", {
      CODEX_DECK_USE_POLLING: "0",
    }),
    false,
  );
  assert.equal(
    shouldUsePollingForWatcherForTests("linux", {
      CODEX_DECK_USE_POLLING: "1",
    }),
    true,
  );
  assert.equal(
    shouldUsePollingForWatcherForTests("linux", {
      CLAUDE_RUN_USE_POLLING: "1",
    }),
    true,
  );
  assert.equal(
    shouldUsePollingForWatcherForTests("win32", {
      CLAUDE_RUN_USE_POLLING: "0",
    }),
    false,
  );
});
