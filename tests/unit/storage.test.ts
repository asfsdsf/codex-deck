import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addToFileIndex,
  archiveSession,
  deleteSession,
  editConversationMessage,
  fixDanglingTurns,
  getClaudeDir,
  getCodexDir,
  getConversation,
  getConversationMessageWindow,
  getConversationMessageUpdates,
  getConversationStream,
  getConversationRawWindow,
  getProjects,
  getSessionTerminalRunOutput,
  getSessionTerminalRuns,
  getSessionWaitState,
  getCodexConfigDefaults,
  getSessionContext,
  getSessions,
  initStorage,
  ingestConversationLiveEvent,
  invalidateHistoryCache,
  loadStorage,
  sessionExists,
  syncSessionFileIndex,
} from "../../api/storage";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
  sessionMetaLine,
  writeHistoryFile,
  writeSessionFile,
} from "./test-utils";

const SESSION_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SESSION_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function setStorageDir(rootDir: string): void {
  initStorage(rootDir);
  invalidateHistoryCache();
}

test("initStorage updates codex dir aliases", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("storage-init");

  try {
    setStorageDir(rootDir);
    assert.equal(getCodexDir(), rootDir);
    assert.equal(getClaudeDir(), rootDir);
  } finally {
    await cleanup();
  }
});

test("storage resolves a fork's parent history and edits only its own physical records", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-fork-history",
  );
  try {
    const parentLines = [
      sessionMetaLine(SESSION_A, "/repo", Date.now()),
      responseItemMessageLine("assistant", "Inherited reply"),
      eventMsgLine({ type: "agent_message", message: "Inherited reply" }),
    ];
    const parentPath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      parentLines,
    );
    const parentText = await readFile(parentPath, "utf8");
    const childMeta = JSON.stringify({
      type: "session_meta",
      ordinal: 3,
      payload: {
        id: SESSION_B,
        cwd: "/repo",
        timestamp: Date.now(),
        history_base: {
          thread_id: SESSION_A,
          end_ordinal_exclusive: 3,
          end_byte_offset: Buffer.byteLength(parentText),
        },
      },
    });
    const childPath = await writeSessionFile(
      sessionsDir,
      `${SESSION_B}.jsonl`,
      [
        childMeta,
        responseItemMessageLine("assistant", "Own reply"),
        eventMsgLine({ type: "agent_message", message: "Own reply" }),
      ],
    );
    await appendFile(
      parentPath,
      responseItemMessageLine("assistant", "Later parent reply") + "\n",
    );
    setStorageDir(rootDir);
    await loadStorage();
    const snapshot = await getConversation(SESSION_B);
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[0].editable, false);
    assert.equal(snapshot[0].editId, undefined);
    assert.equal(snapshot[1].editable, true);
    assert.equal(
      snapshot[1].editId,
      `offset:${Buffer.byteLength(childMeta) + 1}:2026-01-01T00:00:00.000Z`,
    );
    const window = await getConversationMessageWindow(SESSION_B);
    assert.deepEqual(window.messages, snapshot);
    assert.equal(window.totalMessages, 2);
    const initialUpdates = await getConversationMessageUpdates(SESSION_B, 0);
    assert.deepEqual(initialUpdates.messages, snapshot);

    const parentBeforeEdit = await readFile(parentPath, "utf8");
    const result = await editConversationMessage(SESSION_B, {
      editId: snapshot[1].editId!,
      expectedText: "Own reply",
      text: "Edited own reply",
    });
    assert.equal(result.sessionRecordsUpdated, 2);
    assert.equal(await readFile(parentPath, "utf8"), parentBeforeEdit);
    const afterEdit = await getConversationMessageWindow(SESSION_B);
    assert.notEqual(afterEdit.fileId, window.fileId);
    assert.deepEqual(afterEdit.messages[1].message?.content, [
      { type: "text", text: "Edited own reply" },
    ]);
    assert.equal(
      (await readFile(childPath, "utf8")).includes("Inherited reply"),
      false,
    );

    await appendFile(
      childPath,
      eventMsgLine({ type: "task_started", turn_id: "child-turn" }) + "\n",
    );
    await ingestConversationLiveEvent({
      type: "assistant_delta",
      threadId: SESSION_B,
      turnId: "child-turn",
      itemId: "live-child",
      delta: "Next reply",
    });
    const live = await getConversationMessageUpdates(
      SESSION_B,
      afterEdit.nextOffset,
    );
    assert.equal(live.totalMessages, 3);
    assert.equal(live.messages.find((m) => m.streaming)?.messageNumber, 3);
  } finally {
    await cleanup();
  }
});

test("getSessions and getProjects merge session metadata + history cache", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-sessions");

  try {
    const sessionAFile = `${SESSION_A}.jsonl`;
    await writeSessionFile(sessionsDir, sessionAFile, [
      sessionMetaLine(SESSION_A, "/repo/project-a", 1700000000000),
      responseItemMessageLine("user", "AGENTS.md bootstrap"),
      responseItemMessageLine("user", "  Real   prompt from user  "),
      responseItemMessageLine("assistant", "Acknowledged."),
    ]);

    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_B,
        ts: 1700000000,
        text: "  history entry for old session  ",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const sessions = await getSessions();
    const projects = await getProjects();

    const a = sessions.find((session) => session.id === SESSION_A);
    const b = sessions.find((session) => session.id === SESSION_B);

    assert.ok(a);
    assert.equal(a.display, "Real prompt from user");
    assert.equal(a.project, "/repo/project-a");
    assert.equal(a.projectName, "project-a");

    assert.ok(b);
    assert.equal(b.display, "history entry for old session");
    assert.equal(b.project, "");

    assert.deepEqual(projects, ["/repo/project-a"]);
  } finally {
    await cleanup();
  }
});

test("getSessions excludes archived sessions even when history entries remain", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-archived-sessions",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: SESSION_A,
          cwd: "/repo/project-a",
          timestamp: 1700000000000,
          archived_at: "2026-01-01T00:00:00.000Z",
        },
      }),
      responseItemMessageLine("user", "archived session"),
    ]);

    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: "archived session from history",
      }),
      JSON.stringify({
        session_id: SESSION_B,
        ts: 1700000001,
        text: "active session",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const sessions = await getSessions();
    assert.equal(
      sessions.some((session) => session.id === SESSION_A),
      false,
    );
    assert.equal(
      sessions.some((session) => session.id === SESSION_B),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("session listing scans once for history-only entries and discovers new rollouts", async (t) => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-session-list-scan",
  );
  const missingIds = Array.from(
    { length: 12 },
    (_, index) => `history-only-${index}`,
  );
  let restoreReaddir = () => {};

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/existing", Date.now()),
      responseItemMessageLine("user", "existing rollout"),
    ]);
    await writeHistoryFile(
      rootDir,
      [...missingIds, SESSION_C].map((id) =>
        JSON.stringify({
          session_id: id,
          ts: 1700000000,
          text: `History for ${id}`,
        }),
      ),
    );
    setStorageDir(rootDir);
    await loadStorage();

    // The listing must still find rollouts added after the initial index scan.
    await writeSessionFile(sessionsDir, `${SESSION_C}.jsonl`, [
      sessionMetaLine(SESSION_C, "/repo/new", Date.now()),
      responseItemMessageLine("user", "new rollout"),
    ]);
    const readdirSpy = t.mock.method(fsPromises, "readdir");
    syncBuiltinESMExports();
    restoreReaddir = () => {
      readdirSpy.mock.restore();
      syncBuiltinESMExports();
    };

    const [sessions, projects] = await Promise.all([
      getSessions(),
      getProjects(),
    ]);
    assert.equal(sessions.length, missingIds.length + 2);
    assert.equal(
      sessions.find((session) => session.id === SESSION_C)?.project,
      "/repo/new",
    );
    assert.ok(
      missingIds.every((id) =>
        sessions.some(
          (session) =>
            session.id === id && session.display === `History for ${id}`,
        ),
      ),
    );
    assert.deepEqual(projects, ["/repo/existing", "/repo/new"]);
    assert.equal(
      readdirSpy.mock.calls.filter((call) => call.arguments[0] === sessionsDir)
        .length,
      1,
    );
    assert.deepEqual(await getSessions(), sessions);
    assert.equal(readdirSpy.mock.calls.length, 1);

    await appendFile(
      join(rootDir, "history.jsonl"),
      JSON.stringify({
        session_id: SESSION_B,
        ts: 1700000001,
        text: "New history",
      }) + "\n",
    );
    invalidateHistoryCache();
    const updatedHistory = await getSessions();
    assert.equal(
      updatedHistory.find((session) => session.id === SESSION_B)?.display,
      "New history",
    );

    const latestTimestamp = "2027-01-01T00:00:00.000Z";
    await appendFile(
      join(sessionsDir, `${SESSION_A}.jsonl`),
      responseItemMessageLine("user", "Updated rollout", latestTimestamp) +
        "\n",
    );
    const indexUpdate = syncSessionFileIndex(
      SESSION_A,
      join(sessionsDir, `${SESSION_A}.jsonl`),
    );
    // An SSE listener reads the list while the shared watcher updates its
    // index. It must see the update rather than the previous cached snapshot.
    const [updatedSessions] = await Promise.all([getSessions(), indexUpdate]);
    assert.equal(
      updatedSessions.find((session) => session.id === SESSION_A)
        ?.lastUserMessageAt,
      Date.parse(latestTimestamp),
    );
  } finally {
    restoreReaddir();
    await cleanup();
  }
});

test("session listing does not cache a snapshot invalidated during discovery", async (t) => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-session-cache-race",
  );
  let resumeScan = () => {};
  let scanStarted = () => {};
  const started = new Promise<void>((resolve) => {
    scanStarted = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resumeScan = resolve;
  });
  let restoreReaddir = () => {};
  try {
    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: "Old history",
      }),
    ]);
    setStorageDir(rootDir);
    await loadStorage();
    const originalReaddir = fsPromises.readdir;
    let held = false;
    const spy = t.mock.method(
      fsPromises,
      "readdir",
      async (...args: Parameters<typeof fsPromises.readdir>) => {
        if (args[0] === sessionsDir && !held) {
          held = true;
          scanStarted();
          await resumed;
        }
        return Reflect.apply(originalReaddir, fsPromises, args);
      },
    );
    syncBuiltinESMExports();
    restoreReaddir = () => {
      spy.mock.restore();
      syncBuiltinESMExports();
    };

    const listing = getSessions();
    await started;
    await appendFile(
      join(rootDir, "history.jsonl"),
      JSON.stringify({
        session_id: SESSION_B,
        ts: 1700000001,
        text: "Arrived during scan",
      }) + "\n",
    );
    invalidateHistoryCache();
    resumeScan();
    await listing;
    assert.equal(
      (await getSessions()).find((session) => session.id === SESSION_B)
        ?.display,
      "Arrived during scan",
    );
  } finally {
    resumeScan();
    restoreReaddir();
    await cleanup();
  }
});

test("getSessions sorts file-backed sessions by latest user message time", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-session-user-message-order",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/newer-session", 2000),
      responseItemMessageLine(
        "user",
        "older user message",
        "2026-01-01T00:01:00.000Z",
      ),
      responseItemMessageLine(
        "assistant",
        "newer assistant response",
        "2026-01-01T00:10:00.000Z",
      ),
    ]);
    await writeSessionFile(sessionsDir, `${SESSION_B}.jsonl`, [
      sessionMetaLine(SESSION_B, "/repo/older-session", 1000),
      responseItemMessageLine(
        "user",
        "newer user message",
        "2026-01-01T00:05:00.000Z",
      ),
      responseItemMessageLine(
        "assistant",
        "older assistant response",
        "2026-01-01T00:06:00.000Z",
      ),
    ]);
    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: Date.parse("2026-01-01T00:01:00.000Z") / 1000,
        text: "older user message",
      }),
      JSON.stringify({
        session_id: SESSION_B,
        ts: Date.parse("2026-01-01T00:02:00.000Z") / 1000,
        text: "stale history message",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const sessions = await getSessions();
    assert.deepEqual(
      sessions.map((session) => session.id),
      [SESSION_B, SESSION_A],
    );
    assert.equal(
      sessions[0]?.timestamp,
      Date.parse("2026-01-01T00:05:00.000Z"),
    );
    assert.equal(sessions[0]?.createdAt, 1000);
    assert.equal(
      sessions[0]?.lastUserMessageAt,
      Date.parse("2026-01-01T00:05:00.000Z"),
    );
    assert.equal(
      sessions[1]?.timestamp,
      Date.parse("2026-01-01T00:01:00.000Z"),
    );
    assert.equal(sessions[1]?.createdAt, 2000);
  } finally {
    await cleanup();
  }
});

test("session timestamps handle large lines and files without a trailing newline", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-session-large-lines",
  );
  const timestamp = "2026-01-01T00:05:00.000Z";
  const largeText = "😀".repeat(100_000);
  const largeOutput = responseItemRawLine({
    type: "function_call_output",
    call_id: "large-output",
    output: largeText,
  });
  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo", 1000),
      responseItemMessageLine("user", "First prompt", timestamp),
      responseItemMessageLine("assistant", "Reply"),
      largeOutput,
    ]);
    await writeFile(
      join(sessionsDir, `${SESSION_B}.jsonl`),
      [
        sessionMetaLine(SESSION_B, "/repo", 1000),
        responseItemMessageLine("user", "First prompt"),
        responseItemMessageLine("assistant", "Reply"),
        largeOutput,
        responseItemMessageLine("user", largeText, timestamp),
      ].join("\r\n"),
    );
    // A rollout without metadata also exercises the first unterminated
    // fragment, when the backward scan reaches the beginning of the file.
    await writeFile(
      join(sessionsDir, `${SESSION_C}.jsonl`),
      responseItemMessageLine("user", largeText, timestamp),
    );
    setStorageDir(rootDir);
    await loadStorage();
    const sessions = await getSessions();
    assert.equal(sessions.length, 3);
    assert.ok(
      sessions.every(
        (session) => session.lastUserMessageAt === Date.parse(timestamp),
      ),
    );
  } finally {
    await cleanup();
  }
});

test("archiveSession removes active session discovery metadata after rollout removal", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-archive-session",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "archive me"),
    ]);
    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: "archive me from history",
      }),
    ]);
    await writeFile(
      join(rootDir, "session_index.jsonl"),
      `${JSON.stringify({
        id: SESSION_A,
        thread_name: "archive me",
        updated_at: "2026-01-01T00:00:00Z",
      })}\n`,
      "utf-8",
    );

    setStorageDir(rootDir);
    await loadStorage();

    await rm(filePath, { force: true });
    const syncResult = await syncSessionFileIndex(SESSION_A, filePath);
    assert.equal(syncResult, "removed");

    const result = await archiveSession(SESSION_A);
    assert.equal(result.sessionId, SESSION_A);
    assert.equal(result.removedHistoryEntries, 1);
    assert.equal(result.removedSessionIndexEntries, 1);

    const sessions = await getSessions();
    assert.equal(
      sessions.some((session) => session.id === SESSION_A),
      false,
    );
  } finally {
    await cleanup();
  }
});

test("syncSessionFileIndex removes stale file index entries for missing files", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-sync-session-index",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "temporary session"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    await rm(filePath, { force: true });
    const result = await syncSessionFileIndex(SESSION_A, filePath);
    assert.equal(result, "removed");

    const exists = await sessionExists(SESSION_A);
    assert.equal(exists.exists, false);
  } finally {
    await cleanup();
  }
});

test("getConversation parses user, reasoning, tool, turn-aborted, and system-error messages", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-conversation",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "hello"),
      responseItemRawLine({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "please inspect this screenshot" },
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      }),
      responseItemRawLine({
        type: "reasoning",
        summary: [{ text: "Plan steps" }],
        last_token_usage: {
          input_tokens: 1200,
          output_tokens: 345,
          total_tokens: 1545,
          reasoning_output_tokens: 123,
        },
      }),
      responseItemRawLine({
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_1",
        output: "file content",
      }),
      eventMsgLine({
        type: "agent_reasoning",
        text: "Need to inspect more files",
      }),
      eventMsgLine({
        type: "turn_aborted",
        reason: "interrupted",
      }),
      eventMsgLine({
        type: "error",
        message:
          "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
        codex_error_info: "context_window_exceeded",
      }),
      eventMsgLine({
        type: "context_compacted",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);

    assert.equal(messages.length >= 5, true);
    assert.equal(
      messages.some((message) => message.type === "user"),
      true,
    );
    assert.equal(
      messages.some((message) => message.type === "reasoning"),
      true,
    );
    const reasoningMessage = messages.find(
      (message) => message.type === "reasoning",
    );
    assert.ok(reasoningMessage);
    assert.ok(Array.isArray(reasoningMessage.message?.content));
    assert.deepEqual(reasoningMessage.message.content[0]?.token_usage, {
      input_tokens: 1200,
      output_tokens: 345,
      total_tokens: 1545,
      reasoning_output_tokens: 123,
    });
    assert.equal(
      messages.some((message) => message.type === "agent_reasoning"),
      true,
    );
    assert.equal(
      messages.some((message) => message.type === "turn_aborted"),
      true,
    );
    assert.equal(
      messages.some(
        (message) =>
          message.type === "system_error" &&
          message.summary === "Error" &&
          message.message?.content ===
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
      true,
    );
    assert.equal(
      messages.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some(
            (block) =>
              block.type === "text" && block.text === "Context compacted",
          ),
      ),
      true,
    );
    assert.equal(
      messages.some(
        (message) =>
          message.type === "user" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some((block) => block.type === "image"),
      ),
      true,
    );

    const toolMessage = messages.find(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some((block) => block.type === "tool_use"),
    );

    assert.ok(toolMessage);
    const content = toolMessage.message?.content;
    assert.equal(Array.isArray(content), true);
    assert.equal(
      (content as Array<{ type?: string }>).some(
        (block) => block.type === "tool_result",
      ),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("getConversation keeps unresolved tool calls in chronological order", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-conversation-tool-order",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "function_call",
        call_id: "call_old",
        name: "exec_command",
        arguments: { cmd: "echo old command" },
      }),
      eventMsgLine({
        type: "exec_command_end",
        call_id: "call_old",
        process_id: "12345",
        command: ["/bin/zsh", "-lc", "echo old command"],
        aggregated_output: "old output\n",
      }),
      responseItemRawLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "final assistant message" }],
      }),
      eventMsgLine({
        type: "task_complete",
        turn_id: "turn_1",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);
    const assistantTextIndex = messages.findIndex(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) =>
            block.type === "text" && block.text === "final assistant message",
        ),
    );
    const pendingExecToolIndex = messages.findIndex(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) =>
            block.type === "tool_use" &&
            block.name === "exec_command" &&
            block.id === "call_old",
        ),
    );

    assert.equal(assistantTextIndex >= 0, true);
    assert.equal(pendingExecToolIndex >= 0, true);
    assert.equal(pendingExecToolIndex < assistantTextIndex, true);
    assert.equal(messages[messages.length - 1]?.type, "task_complete");
  } finally {
    await cleanup();
  }
});

test("getConversationStream emits system_error messages from error events", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-system-error",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    assert.equal(initial.done, true);

    await appendFile(
      filePath,
      `${eventMsgLine({
        type: "error",
        message:
          "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
        codex_error_info: "context_window_exceeded",
      })}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    const systemError = next.messages.find(
      (message) => message.type === "system_error",
    );

    assert.ok(systemError);
    assert.equal(systemError.summary, "Error");
    assert.equal(
      systemError.message?.content,
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    );
    assert.equal(next.nextOffset > initial.nextOffset, true);
    assert.equal(next.done, true);
  } finally {
    await cleanup();
  }
});

test("getConversation emits thread_goal messages from goal update events", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-thread-goal-message",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      eventMsgLine({
        type: "thread_goal_updated",
        thread_id: SESSION_A,
        turn_id: null,
        goal: {
          threadId: SESSION_A,
          objective: "Ship goal rendering",
          status: "paused",
          tokenBudget: 20000,
          tokensUsed: 1250,
          timeUsedSeconds: 90,
          createdAt: 100,
          updatedAt: 120,
        },
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);
    const goalMessage = messages.find(
      (message) => message.type === "thread_goal",
    );

    assert.ok(goalMessage);
    assert.equal(goalMessage.message?.content, "Ship goal rendering");
    assert.equal(goalMessage.threadGoal?.status, "paused");
    assert.equal(goalMessage.threadGoal?.tokensUsed, 1250);
  } finally {
    await cleanup();
  }
});

test("getConversation collapses consecutive token_count rate limit notices", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-token-limit-notice",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "hello"),
      eventMsgLine({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: null,
          plan_type: null,
        },
      }),
      eventMsgLine({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: null,
          plan_type: null,
        },
      }),
      eventMsgLine({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: null,
          plan_type: null,
        },
      }),
      eventMsgLine({
        type: "task_complete",
        turn_id: "turn_1",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);
    const notices = messages.filter(
      (message) => message.type === "token_limit_notice",
    );

    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.repeatCount, 3);
    assert.equal(notices[0]?.repeatCountMax, 6);
    assert.equal(notices[0]?.rateLimitId, "codex");
    assert.equal(
      notices[0]?.message?.content,
      "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
    );
  } finally {
    await cleanup();
  }
});

test("getConversationStream collapses consecutive token_count rate limit notices in a streamed batch", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-token-limit-notice",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    assert.equal(initial.done, true);

    await appendFile(
      filePath,
      `${eventMsgLine({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: null,
          plan_type: null,
        },
      })}\n${eventMsgLine({
        type: "token_count",
        info: null,
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: null,
          plan_type: null,
        },
      })}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    const notices = next.messages.filter(
      (message) => message.type === "token_limit_notice",
    );

    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.repeatCount, 2);
    assert.equal(next.nextOffset > initial.nextOffset, true);
    assert.equal(next.done, true);
  } finally {
    await cleanup();
  }
});

test("getConversation collapses duplicate turn_aborted records and keeps explicit block text", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-conversation-turn-aborted-dedupe",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      eventMsgLine({
        type: "turn_aborted",
        reason: "interrupted",
      }),
      responseItemMessageLine(
        "user",
        "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.\n</turn_aborted>",
      ),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);
    const turnAbortedMessages = messages.filter(
      (message) => message.type === "turn_aborted",
    );

    assert.equal(turnAbortedMessages.length, 1);
    assert.equal(
      turnAbortedMessages[0]?.message?.content,
      "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.",
    );
  } finally {
    await cleanup();
  }
});

test("getConversationStream collapses duplicate turn_aborted records in a streamed batch", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-turn-aborted-dedupe",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    assert.equal(initial.done, true);

    await appendFile(
      filePath,
      `${responseItemMessageLine(
        "user",
        "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.\n</turn_aborted>",
      )}\n${eventMsgLine({
        type: "turn_aborted",
        reason: "interrupted",
      })}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    const turnAbortedMessages = next.messages.filter(
      (message) => message.type === "turn_aborted",
    );

    assert.equal(turnAbortedMessages.length, 1);
    assert.equal(
      turnAbortedMessages[0]?.message?.content,
      "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.",
    );
    assert.equal(next.nextOffset > initial.nextOffset, true);
  } finally {
    await cleanup();
  }
});

test("getConversation preserves tool_use and tool_result timestamps", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-tool-block-timestamps",
  );

  try {
    const toolUseTimestamp = "2026-01-01T00:00:00.000Z";
    const toolResultTimestamp = "2026-01-01T00:00:01.250Z";

    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      JSON.stringify({
        timestamp: toolUseTimestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: { cmd: "echo hello" },
        },
      }),
      JSON.stringify({
        timestamp: toolResultTimestamp,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "done",
        },
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation(SESSION_A);
    const toolMessage = messages.find(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some((block) => block.type === "tool_use"),
    );
    assert.ok(toolMessage);
    assert.equal(toolMessage.timestamp, toolUseTimestamp);

    const content = toolMessage.message?.content;
    assert.ok(Array.isArray(content));

    const toolUseBlock = content.find((block) => block.type === "tool_use");
    const toolResultBlock = content.find(
      (block) => block.type === "tool_result",
    );
    assert.ok(toolUseBlock);
    assert.ok(toolResultBlock);
    assert.equal(toolUseBlock?.timestamp, toolUseTimestamp);
    assert.equal(toolResultBlock?.timestamp, toolResultTimestamp);
  } finally {
    await cleanup();
  }
});

test("deleteSession removes rollout, registry entries, and session caches", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-delete-session",
  );

  try {
    const sessionFilePath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      [
        sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
        responseItemMessageLine("user", "to be deleted"),
      ],
    );

    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: "delete me",
      }),
      JSON.stringify({
        session_id: SESSION_B,
        ts: 1700000001,
        text: "keep me",
      }),
    ]);

    await writeFile(
      join(rootDir, "session_index.jsonl"),
      [
        JSON.stringify({
          id: SESSION_A,
          thread_name: "delete me",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        JSON.stringify({
          id: SESSION_B,
          thread_name: "keep me",
          updated_at: "2026-01-01T00:00:01Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    setStorageDir(rootDir);
    await loadStorage();

    const beforeExists = await sessionExists(SESSION_A);
    assert.equal(beforeExists.exists, true);

    const result = await deleteSession(SESSION_A);
    assert.equal(result.sessionId, SESSION_A);
    assert.equal(
      result.removedSessionFilePaths.includes(sessionFilePath),
      true,
    );
    assert.equal(result.removedHistoryEntries, 1);
    assert.equal(result.removedSessionIndexEntries, 1);

    const afterExists = await sessionExists(SESSION_A);
    assert.equal(afterExists.exists, false);

    const sessions = await getSessions();
    assert.equal(
      sessions.some((session) => session.id === SESSION_A),
      false,
    );
    assert.equal(
      sessions.some((session) => session.id === SESSION_B),
      true,
    );

    const historyContent = await readFile(
      join(rootDir, "history.jsonl"),
      "utf-8",
    );
    assert.equal(historyContent.includes(SESSION_A), false);
    assert.equal(historyContent.includes(SESSION_B), true);

    const indexContent = await readFile(
      join(rootDir, "session_index.jsonl"),
      "utf-8",
    );
    assert.equal(indexContent.includes(SESSION_A), false);
    assert.equal(indexContent.includes(SESSION_B), true);
  } finally {
    await cleanup();
  }
});

test("editConversationMessage updates paired JSONL records, history, and thread metadata", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-edit-conversation-message",
  );
  const timestamp = "2026-07-22T01:31:24.357Z";
  const originalUserText = "Original user prompt";
  const editedUserText = "Edited user prompt";
  const originalAssistantText = "Original assistant reply";
  const editedAssistantText = "Edited assistant reply";

  try {
    const sessionFilePath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      [
        sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
        JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context />" }],
            internal_chat_message_metadata_passthrough: {
              turn_id: "turn-1",
            },
          },
        }),
        JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: originalUserText }],
            internal_chat_message_metadata_passthrough: {
              turn_id: "turn-1",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-22T01:31:24.358Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: originalUserText,
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-22T01:31:24.397Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: originalAssistantText,
            phase: "final",
          },
        }),
        JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-item-1",
            role: "assistant",
            content: [{ type: "output_text", text: originalAssistantText }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-22T01:31:29.357Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: originalAssistantText,
            phase: "synthetic",
          },
        }),
        responseItemRawLine({
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: "Original command result",
        }),
      ],
    );

    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: originalUserText,
      }),
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000001,
        text: originalUserText,
      }),
    ]);

    const stateDbPath = join(rootDir, "state_5.sqlite");
    const sqliteSetup = spawnSync(
      "sqlite3",
      [
        stateDbPath,
        `CREATE TABLE threads (id TEXT PRIMARY KEY, first_user_message TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL);
         INSERT INTO threads VALUES ('${SESSION_A}', '${originalUserText}', '${originalUserText}', '${originalUserText}');`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(sqliteSetup.status, 0, sqliteSetup.stderr);

    setStorageDir(rootDir);
    await loadStorage();

    const before = await getConversation(SESSION_A);
    const environmentMessage = before.find(
      (message) => message.editText === "<environment_context />",
    );
    const userMessage = before.find(
      (message) => message.editText === originalUserText,
    );
    const assistantMessage = before.find(
      (message) => message.editText === originalAssistantText,
    );
    assert.equal(environmentMessage, undefined);
    assert.equal(userMessage?.editable, true);
    assert.equal(userMessage?.editId, "turn:turn-1");
    assert.equal(assistantMessage?.editable, true);
    assert.equal(assistantMessage?.editId, "item:assistant-item-1");

    const streamedMessages = [];
    let streamOffset = 0;
    let originalFileId: string | undefined;
    while (true) {
      const batch = await getConversationStream(SESSION_A, streamOffset, {
        maxPayloadBytes: 256,
      });
      streamedMessages.push(...batch.messages);
      originalFileId = batch.fileId ?? originalFileId;
      assert.ok(batch.nextOffset > streamOffset || batch.done);
      streamOffset = batch.nextOffset;
      if (batch.done) {
        break;
      }
    }
    assert.equal(
      streamedMessages.find((message) => message.editText === originalUserText)
        ?.editable,
      true,
    );
    assert.equal(
      streamedMessages.find(
        (message) => message.editText === originalAssistantText,
      )?.editable,
      true,
    );

    const userResult = await editConversationMessage(SESSION_A, {
      editId: "turn:turn-1",
      expectedText: originalUserText,
      text: editedUserText,
    });
    assert.equal(userResult.sessionRecordsUpdated, 2);
    assert.equal(userResult.historyRecordsUpdated, 2);
    assert.equal(userResult.sqlite.threadsUpdated, 1);
    const editedStream = await getConversationStream(SESSION_A, 0);
    assert.ok(originalFileId);
    assert.notEqual(editedStream.fileId, originalFileId);

    const assistantResult = await editConversationMessage(SESSION_A, {
      editId: "item:assistant-item-1",
      expectedText: originalAssistantText,
      text: editedAssistantText,
    });
    assert.equal(assistantResult.sessionRecordsUpdated, 2);
    assert.equal(assistantResult.historyRecordsUpdated, 0);
    assert.equal(
      assistantResult.sqlite.skippedReason,
      "assistant messages are not stored in the thread database",
    );

    const sessionRecords = (await readFile(sessionFilePath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      sessionRecords.filter(
        (record) =>
          JSON.stringify(record).includes(editedUserText) &&
          (record.type === "response_item" || record.type === "event_msg"),
      ).length,
      2,
    );
    assert.equal(
      sessionRecords.filter(
        (record) =>
          JSON.stringify(record).includes(editedAssistantText) &&
          (record.type === "response_item" || record.type === "event_msg"),
      ).length,
      2,
    );
    assert.equal(
      JSON.stringify(sessionRecords).includes("Original command result"),
      true,
    );
    assert.equal(
      sessionRecords.some(
        (record) =>
          record.type === "event_msg" &&
          record.payload?.phase === "synthetic" &&
          record.payload?.message === originalAssistantText,
      ),
      true,
    );

    const historyContent = await readFile(
      join(rootDir, "history.jsonl"),
      "utf-8",
    );
    assert.equal(historyContent.includes(originalUserText), false);
    assert.equal(historyContent.match(/Edited user prompt/g)?.length, 2);

    const sqliteRow = spawnSync(
      "sqlite3",
      [
        stateDbPath,
        `SELECT first_user_message || '|' || title || '|' || preview FROM threads WHERE id='${SESSION_A}';`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(sqliteRow.status, 0, sqliteRow.stderr);
    assert.equal(
      sqliteRow.stdout.trim(),
      `${editedUserText}|${editedUserText}|${editedUserText}`,
    );
  } finally {
    await cleanup();
  }
});

test("editConversationMessage invalidates only the edited thread's paginated history projection", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-edit-invalidates-thread-history",
  );
  const originalText = "Short prompt";
  const editedText =
    "A substantially longer edited prompt that changes every later byte offset";

  try {
    const records = [
      JSON.parse(sessionMetaLine(SESSION_A, "/repo/project-a", Date.now())),
      {
        timestamp: "2026-09-03T08:50:23.400Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        timestamp: "2026-09-03T08:50:23.434Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "user-item-1",
          role: "user",
          content: [{ type: "input_text", text: originalText }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-09-03T08:50:23.435Z",
        type: "event_msg",
        payload: { type: "user_message", message: originalText },
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        timestamp: `2026-09-03T08:50:${24 + index}.000Z`,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: index } },
      })),
      {
        timestamp: "2026-09-03T08:50:31.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ].map((record, ordinal) => JSON.stringify({ ...record, ordinal }));
    const sessionFilePath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      records,
    );
    const originalFileSize = Buffer.byteLength(
      await readFile(sessionFilePath, "utf-8"),
      "utf-8",
    );

    const threadHistoryDbPath = join(rootDir, "thread_history_7.sqlite");
    const sqliteSetup = spawnSync(
      "sqlite3",
      [
        threadHistoryDbPath,
        `CREATE TABLE thread_history_projection_state (
           thread_id TEXT PRIMARY KEY,
           next_rollout_byte_offset INTEGER NOT NULL,
           next_rollout_ordinal INTEGER NOT NULL
         );
         CREATE TABLE thread_turns (
           thread_id TEXT NOT NULL,
           turn_id TEXT NOT NULL,
           rollout_ordinal INTEGER NOT NULL
         );
         CREATE TABLE thread_items (
           thread_id TEXT NOT NULL,
           turn_id TEXT NOT NULL,
           item_id TEXT NOT NULL,
           rollout_ordinal INTEGER NOT NULL,
           item_json TEXT NOT NULL
         );
         CREATE TABLE thread_realtime_items (
           thread_id TEXT NOT NULL,
           item_id TEXT NOT NULL,
           rollout_ordinal INTEGER NOT NULL,
           item_json TEXT NOT NULL
         );
         INSERT INTO thread_history_projection_state VALUES ('${SESSION_A}', ${originalFileSize}, 12);
         INSERT INTO thread_history_projection_state VALUES ('${SESSION_B}', 900, 9);
         INSERT INTO thread_turns VALUES ('${SESSION_A}', 'turn-1', 1);
         INSERT INTO thread_turns VALUES ('${SESSION_B}', 'turn-2', 1);
         INSERT INTO thread_items VALUES ('${SESSION_A}', 'turn-1', 'item-1', 2, '{"text":"${originalText}"}');
         INSERT INTO thread_items VALUES ('${SESSION_B}', 'turn-2', 'item-2', 2, '{"text":"keep"}');
         INSERT INTO thread_realtime_items VALUES ('${SESSION_A}', 'realtime-1', 3, '{"text":"${originalText}"}');
         INSERT INTO thread_realtime_items VALUES ('${SESSION_B}', 'realtime-2', 3, '{"text":"keep"}');`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(sqliteSetup.status, 0, sqliteSetup.stderr);

    setStorageDir(rootDir);
    await loadStorage();

    const result = await editConversationMessage(SESSION_A, {
      editId: "item:user-item-1",
      expectedText: originalText,
      text: editedText,
    });

    assert.equal(result.sessionRecordsUpdated, 2);
    assert.equal(result.sqlite.threadHistory.dbPath, threadHistoryDbPath);
    assert.equal(result.sqlite.threadHistory.projectionRowsDeleted, 1);
    assert.equal(result.sqlite.threadHistory.turnRowsDeleted, 1);
    assert.equal(result.sqlite.threadHistory.itemRowsDeleted, 1);
    assert.equal(result.sqlite.threadHistory.realtimeRowsDeleted, 1);
    assert.equal(result.sqlite.threadHistory.skippedReason, null);
    assert.deepEqual(result.sqlite.threadHistory.warnings, []);

    const affectedRows = spawnSync(
      "sqlite3",
      [
        threadHistoryDbPath,
        `SELECT
           (SELECT count(*) FROM thread_history_projection_state WHERE thread_id='${SESSION_A}') || '|' ||
           (SELECT count(*) FROM thread_turns WHERE thread_id='${SESSION_A}') || '|' ||
           (SELECT count(*) FROM thread_items WHERE thread_id='${SESSION_A}') || '|' ||
           (SELECT count(*) FROM thread_realtime_items WHERE thread_id='${SESSION_A}');`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(affectedRows.status, 0, affectedRows.stderr);
    assert.equal(affectedRows.stdout.trim(), "0|0|0|0");

    const unrelatedRows = spawnSync(
      "sqlite3",
      [
        threadHistoryDbPath,
        `SELECT
           (SELECT count(*) FROM thread_history_projection_state WHERE thread_id='${SESSION_B}') || '|' ||
           (SELECT count(*) FROM thread_turns WHERE thread_id='${SESSION_B}') || '|' ||
           (SELECT count(*) FROM thread_items WHERE thread_id='${SESSION_B}') || '|' ||
           (SELECT count(*) FROM thread_realtime_items WHERE thread_id='${SESSION_B}');`,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(unrelatedRows.status, 0, unrelatedRows.stderr);
    assert.equal(unrelatedRows.stdout.trim(), "1|1|1|1");

    const editedFileSize = Buffer.byteLength(
      await readFile(sessionFilePath, "utf-8"),
      "utf-8",
    );
    assert.ok(editedFileSize > originalFileSize);
  } finally {
    await cleanup();
  }
});

test("editConversationMessage preserves the JSONL edit when the projection schema is unavailable", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-edit-missing-thread-history-schema",
  );
  const originalText = "Original prompt";
  const editedText = "Edited prompt survives a stale projection schema";

  try {
    const sessionFilePath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      [
        sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:23.434Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "user-item-1",
            role: "user",
            content: [{ type: "input_text", text: originalText }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:23.435Z",
          type: "event_msg",
          payload: { type: "user_message", message: originalText },
        }),
      ],
    );
    const threadHistoryDbPath = join(rootDir, "thread_history_1.sqlite");
    const sqliteSetup = spawnSync(
      "sqlite3",
      [threadHistoryDbPath, "CREATE TABLE unrelated_cache (id TEXT);"],
      { encoding: "utf-8" },
    );
    assert.equal(sqliteSetup.status, 0, sqliteSetup.stderr);

    setStorageDir(rootDir);
    await loadStorage();

    const result = await editConversationMessage(SESSION_A, {
      editId: "item:user-item-1",
      expectedText: originalText,
      text: editedText,
    });

    assert.equal(result.sessionRecordsUpdated, 2);
    assert.equal(result.sqlite.threadHistory.dbPath, threadHistoryDbPath);
    assert.equal(
      result.sqlite.threadHistory.skippedReason,
      "thread history projection tables not found",
    );
    assert.equal(result.sqlite.threadHistory.warnings.length, 1);
    const content = await readFile(sessionFilePath, "utf-8");
    assert.equal(content.includes(originalText), false);
    assert.equal(content.match(new RegExp(editedText, "g"))?.length, 2);
  } finally {
    await cleanup();
  }
});

test("editConversationMessage updates new item_completed message pairs", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-edit-item-completed-message",
  );
  const originalUserText = "Original new-format user prompt";
  const editedUserText = "Edited new-format user prompt";
  const originalAssistantText = "Original new-format assistant reply";
  const editedAssistantText = "Edited new-format assistant reply";

  try {
    const sessionFilePath = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      [
        sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:23.434Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "new-user-response-item",
            role: "user",
            content: [
              { type: "input_text", text: originalUserText },
              { type: "input_image", image_url: "data:image/png;base64,abc" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:23.434Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "UserMessage",
              id: "different-user-event-item",
              content: [
                { type: "text", text: originalUserText },
                { type: "image", image_url: "data:image/png;base64,abc" },
              ],
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:38.638Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "AgentMessage",
              id: "new-assistant-response-item",
              content: [
                { type: "Text", text: originalAssistantText },
                { type: "metadata", value: "preserve-me" },
              ],
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-03T08:50:38.643Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "new-assistant-response-item",
            role: "assistant",
            content: [{ type: "output_text", text: originalAssistantText }],
          },
        }),
      ],
    );
    await writeHistoryFile(rootDir, [
      JSON.stringify({
        session_id: SESSION_A,
        ts: 1700000000,
        text: originalUserText,
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const before = await getConversation(SESSION_A);
    assert.equal(
      before.find((message) => message.editText === originalUserText)?.editable,
      true,
    );
    assert.equal(
      before.find((message) => message.editText === originalAssistantText)
        ?.editable,
      true,
    );

    const userResult = await editConversationMessage(SESSION_A, {
      editId: "item:new-user-response-item",
      expectedText: originalUserText,
      text: editedUserText,
    });
    assert.equal(userResult.sessionRecordsUpdated, 2);

    const assistantResult = await editConversationMessage(SESSION_A, {
      editId: "item:new-assistant-response-item",
      expectedText: originalAssistantText,
      text: editedAssistantText,
    });
    assert.equal(assistantResult.sessionRecordsUpdated, 2);

    const sessionRecords = (await readFile(sessionFilePath, "utf-8"))
      .trim()
      .split("\n")
      .map((record) => JSON.parse(record));
    assert.equal(
      sessionRecords.filter((record) =>
        JSON.stringify(record).includes(editedUserText),
      ).length,
      2,
    );
    assert.equal(
      sessionRecords.filter((record) =>
        JSON.stringify(record).includes(editedAssistantText),
      ).length,
      2,
    );
    assert.equal(
      JSON.stringify(sessionRecords).includes("data:image/png;base64,abc"),
      true,
    );
    assert.equal(JSON.stringify(sessionRecords).includes("preserve-me"), true);
  } finally {
    await cleanup();
  }
});

test("getConversationStream returns incremental updates from offsets", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-stream");

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    assert.equal(initial.done, true);
    assert.equal(
      initial.messages.some((message) => message.type === "user"),
      true,
    );

    await appendFile(
      filePath,
      `${responseItemMessageLine("assistant", "second message")}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    assert.equal(next.messages.length > 0, true);
    assert.equal(
      next.messages.some((message) => message.type === "assistant"),
      true,
    );
    assert.equal(next.nextOffset > initial.nextOffset, true);
    assert.equal(next.done, true);
  } finally {
    await cleanup();
  }
});

test("getConversationStream links delayed reasoning and reply usage across batches for multiple readers", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-reply-usage",
  );
  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted",
      }),
    ]);
    setStorageDir(rootDir);
    await loadStorage();
    const initial = await getConversationStream(SESSION_A, 0);
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 10,
      cache_write_input_tokens: 30,
    };
    await appendFile(
      filePath,
      [
        responseItemMessageLine("assistant", "Running a command"),
        responseItemRawLine({
          type: "function_call",
          call_id: "call-usage",
          name: "exec_command",
          arguments: "{}",
        }),
        responseItemRawLine({
          type: "function_call_output",
          call_id: "call-usage",
          output: "done",
        }),
        eventMsgLine({
          type: "token_count",
          info: { last_token_usage: usage },
        }),
        responseItemMessageLine("assistant", "Final answer"),
        "",
      ].join("\n"),
    );
    const a = await getConversationStream(SESSION_A, initial.nextOffset);
    const b = await getConversationStream(SESSION_A, initial.nextOffset);
    assert.deepEqual(a.messages, b.messages);
    const reasoning = a.messages.find(
      (message) => message.type === "reasoning",
    )!;
    const commentary = a.messages.find((message) => message.message?.usage)!;
    const normalizedUsage = {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 10,
      cache_creation_input_tokens: 30,
    };
    assert.equal(reasoning.uuid, initial.messages[0].uuid);
    assert.ok(Array.isArray(reasoning.message?.content));
    assert.deepEqual(reasoning.message.content[0].token_usage, normalizedUsage);
    assert.deepEqual(commentary.message?.usage, normalizedUsage);
    const final = a.messages.find(
      (message) =>
        Array.isArray(message.message?.content) &&
        message.message.content[0]?.text === "Final answer",
    )!;
    assert.equal(final.message?.usage, undefined);
    const finalUsage = { input_tokens: 200, output_tokens: 5 };
    await appendFile(
      filePath,
      `${eventMsgLine({ type: "token_count", info: { last_token_usage: finalUsage } })}\n`,
    );
    const last = await getConversationStream(SESSION_A, a.nextOffset);
    assert.equal(last.messages.length, 1);
    assert.equal(last.messages[0].uuid, final.uuid);
    assert.deepEqual(last.messages[0].message?.usage, finalUsage);
    await appendFile(
      filePath,
      `${eventMsgLine({ type: "token_count", info: { last_token_usage: usage } })}\n`,
    );
    assert.equal(
      (await getConversationStream(SESSION_A, last.nextOffset)).messages.length,
      0,
    );
  } finally {
    await cleanup();
  }
});

test("getConversationStream emits reasoning token usage updates from later token_count events", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-reasoning-usage",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    const initialReasoning = initial.messages.find(
      (message) => message.type === "reasoning",
    );
    assert.ok(initialReasoning);
    assert.ok(Array.isArray(initialReasoning.message?.content));
    assert.equal(initialReasoning.message.content[0]?.token_usage, undefined);

    await appendFile(
      filePath,
      `${eventMsgLine({
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 16929,
            cached_input_tokens: 11136,
            output_tokens: 346,
            reasoning_output_tokens: 68,
            total_tokens: 17275,
          },
        },
      })}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0]?.uuid, initialReasoning.uuid);
    assert.ok(Array.isArray(next.messages[0]?.message?.content));
    assert.deepEqual(next.messages[0]?.message?.content[0]?.token_usage, {
      input_tokens: 16929,
      output_tokens: 346,
      total_tokens: 17275,
      reasoning_output_tokens: 68,
      cache_read_input_tokens: 11136,
    });
  } finally {
    await cleanup();
  }
});

test("getConversationStream does not overwrite reasoning usage with later token_count events", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-reasoning-usage-stable",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    const initialReasoning = initial.messages.find(
      (message) => message.type === "reasoning",
    );
    assert.ok(initialReasoning);

    await appendFile(
      filePath,
      `${eventMsgLine({
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 16929,
            cached_input_tokens: 11136,
            output_tokens: 346,
            reasoning_output_tokens: 68,
            total_tokens: 17275,
          },
        },
      })}\n`,
      "utf-8",
    );
    const firstUsageUpdate = await getConversationStream(
      SESSION_A,
      initial.nextOffset,
    );

    await appendFile(
      filePath,
      `${eventMsgLine({
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 17000,
            cached_input_tokens: 12000,
            output_tokens: 20,
            reasoning_output_tokens: 0,
            total_tokens: 17020,
          },
        },
      })}\n`,
      "utf-8",
    );
    const duplicateUsageUpdate = await getConversationStream(
      SESSION_A,
      firstUsageUpdate.nextOffset,
    );

    assert.equal(firstUsageUpdate.messages.length, 1);
    assert.equal(firstUsageUpdate.messages[0]?.uuid, initialReasoning.uuid);
    assert.equal(duplicateUsageUpdate.messages.length, 0);
  } finally {
    await cleanup();
  }
});

test("getConversationStream stops at malformed trailing json without crashing", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-malformed",
  );

  try {
    const filePath = join(sessionsDir, `${SESSION_A}.jsonl`);
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "valid line"),
    ]);
    await appendFile(filePath, '{"bad":\n', "utf-8");

    setStorageDir(rootDir);
    await loadStorage();

    const result = await getConversationStream(SESSION_A, 0);
    assert.equal(
      result.messages.some((message) => message.type === "user"),
      true,
    );
    assert.equal(result.nextOffset > 0, true);
    assert.equal(result.done, false);
  } finally {
    await cleanup();
  }
});

test("getConversationStream resumes from offsets when later json lines contain carriage returns", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-carriage-return",
  );

  try {
    const assistantLine = responseItemMessageLine(
      "assistant",
      "follow-up message",
    ).replace(',"payload":', ',\r"payload":');

    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message ".repeat(340)),
      assistantLine,
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const first = await getConversationStream(SESSION_A, 0, {
      maxPayloadBytes: 5000,
    });
    assert.equal(
      first.messages.some((message) => message.type === "user"),
      true,
    );
    assert.equal(first.done, false);
    assert.equal(first.nextOffset > 0, true);

    const next = await getConversationStream(SESSION_A, first.nextOffset, {
      maxPayloadBytes: 5000,
    });
    assert.equal(
      next.messages.some((message) => message.type === "assistant"),
      true,
    );
    assert.equal(next.nextOffset > first.nextOffset, true);
    assert.equal(next.done, true);
  } finally {
    await cleanup();
  }
});

test("getConversationStream supports payload-bounded chunking with monotonic offsets", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-chunked",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message ".repeat(80)),
      responseItemMessageLine("assistant", "second message ".repeat(80)),
      responseItemMessageLine("assistant", "third message ".repeat(80)),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    let offset = 0;
    let done = false;
    let iterations = 0;
    while (!done && iterations < 10) {
      const chunk = await getConversationStream(SESSION_A, offset, {
        maxPayloadBytes: 256,
      });
      assert.equal(chunk.nextOffset >= offset, true);
      assert.equal(
        chunk.messages.length > 0 || chunk.done || chunk.nextOffset > offset,
        true,
      );
      if (!chunk.done) {
        assert.equal(chunk.nextOffset > offset, true);
      }
      offset = chunk.nextOffset;
      done = chunk.done;
      iterations += 1;
    }

    assert.equal(done, true);
    assert.equal(iterations > 1, true);
  } finally {
    await cleanup();
  }
});

test("bounded conversation batches retain every message and respect the payload limit", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-prefixes",
  );
  try {
    const texts = Array.from(
      { length: 75 },
      (_, index) => `${index}: ${"内容 ".repeat(10)}`,
    );
    const lines = texts.flatMap((text) => [
      JSON.stringify({
        type: "turn_context",
        payload: { instructions: "x".repeat(1000) },
      }),
      responseItemMessageLine("assistant", text),
    ]);
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, lines);
    setStorageDir(rootDir);
    await loadStorage();
    let offset = 0;
    const seen: string[] = [];
    while (true) {
      const chunk = await getConversationStream(SESSION_A, offset, {
        maxPayloadBytes: 1500,
      });
      assert.ok(chunk.nextOffset > offset);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({
            messages: chunk.messages,
            nextOffset: chunk.nextOffset,
            done: chunk.done,
          }),
        ) <= 1500,
      );
      for (const message of chunk.messages) {
        const blocks = message.message?.content;
        if (Array.isArray(blocks))
          seen.push(...blocks.map((block) => block.text ?? ""));
      }
      offset = chunk.nextOffset;
      if (chunk.done) break;
    }
    assert.deepEqual(seen, texts);
  } finally {
    await cleanup();
  }
});

test("raw history windows retain oversized UTF-8 records and cover the file without gaps", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-window-records",
  );
  try {
    const lines = [
      sessionMetaLine(SESSION_A, "/repo", Date.now()),
      responseItemMessageLine("assistant", "工具输出🙂".repeat(20000)),
      responseItemMessageLine("assistant", "latest"),
    ];
    const path = await writeSessionFile(
      sessionsDir,
      `${SESSION_A}.jsonl`,
      lines,
    );
    setStorageDir(rootDir);
    await loadStorage();
    let beforeOffset: number | undefined;
    const chunks: Buffer[] = [];
    while (true) {
      const window = await getConversationRawWindow(
        SESSION_A,
        beforeOffset,
        128,
      );
      const bytes = Buffer.from(window.chunkBase64, "base64");
      if (beforeOffset !== undefined)
        assert.equal(window.endOffset, beforeOffset);
      assert.ok(window.endOffset > window.startOffset);
      for (const line of bytes.toString("utf-8").trim().split("\n"))
        assert.doesNotThrow(() => JSON.parse(line));
      chunks.unshift(bytes);
      beforeOffset = window.startOffset;
      if (window.done) break;
    }
    assert.deepEqual(Buffer.concat(chunks), await readFile(path));
  } finally {
    await cleanup();
  }
});

test("fixDanglingTurns appends synthetic completions for unfinished turns", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-fix-dangling",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_C}.jsonl`, [
      sessionMetaLine(SESSION_C, "/repo/project-c", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn_1" }),
      eventMsgLine({ type: "task_started", turn_id: "turn_2" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn_1" }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const result = await fixDanglingTurns(SESSION_C);
    assert.deepEqual(result.danglingTurnIds, ["turn_2"]);
    assert.deepEqual(result.appendedTurnIds, ["turn_2"]);
    assert.equal(result.endedTurnCountAfter, result.endedTurnCountBefore + 1);

    const content = await readFile(filePath, "utf-8");
    assert.equal(content.includes('"type":"task_complete"'), true);
    assert.equal(content.includes('"turn_id":"turn_2"'), true);
  } finally {
    await cleanup();
  }
});

test("getSessionContext computes context percentage from token_count", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-context");

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      eventMsgLine({
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 20000,
            input_tokens: 15000,
            output_tokens: 5000,
            cached_input_tokens: 4000,
          },
          model_context_window: 100000,
        },
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const context = await getSessionContext(SESSION_A);
    assert.equal(context.modelContextWindow, 100000);
    assert.equal(context.contextLeftPercent, 91);
    assert.equal(context.usedTokens, null);
    assert.deepEqual(context.tokenUsage, {
      totalTokens: 16000,
      inputTokens: 11000,
      outputTokens: 5000,
    });
  } finally {
    await cleanup();
  }
});

test("getSessionContext falls back to 100% when only model context window is known", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-context-fallback",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_B}.jsonl`, [
      sessionMetaLine(SESSION_B, "/repo/project-b", Date.now()),
      eventMsgLine({
        type: "task_started",
        turn_id: "turn_a",
        model_context_window: 200000,
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const context = await getSessionContext(SESSION_B);
    assert.equal(context.modelContextWindow, 200000);
    assert.equal(context.contextLeftPercent, 100);
    assert.equal(context.usedTokens, null);
    assert.equal(context.tokenUsage, null);
  } finally {
    await cleanup();
  }
});

test("fixDanglingTurns throws for unknown sessions and addToFileIndex can register paths", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-errors");

  try {
    setStorageDir(rootDir);
    await loadStorage();

    await assert.rejects(
      () => fixDanglingTurns("   "),
      /session id is required/,
    );
    await assert.rejects(
      () => fixDanglingTurns("deadbeef-dead-beef-dead-beefdeadbeef"),
      /session file not found/,
    );

    const externalId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const externalPath = await writeSessionFile(
      sessionsDir,
      `${externalId}.jsonl`,
      [
        sessionMetaLine(externalId, "/repo/project-d", Date.now()),
        responseItemMessageLine("user", "hello"),
      ],
    );

    addToFileIndex(externalId, externalPath);
    const sessions = await getSessions();
    assert.equal(
      sessions.some((session) => session.id === externalId),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("getConversation returns empty array for unknown session", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "storage-conversation-missing",
  );

  try {
    setStorageDir(rootDir);
    await loadStorage();

    const messages = await getConversation("missing-session-id");
    assert.deepEqual(messages, []);
  } finally {
    await cleanup();
  }
});

test("getConversationStream keeps offset when starting after end of file", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-after-end",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "first message"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const fromOffset = 999999;
    const result = await getConversationStream(SESSION_A, fromOffset);
    assert.deepEqual(result.messages, []);
    assert.equal(result.nextOffset, fromOffset);
    assert.equal(result.done, true);
  } finally {
    await cleanup();
  }
});

test("getConversationStream carries tool name map across incremental reads", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-stream-tool-map",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "function_call",
        call_id: "call_stream_1",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initial = await getConversationStream(SESSION_A, 0);
    assert.equal(initial.messages.length > 0, true);

    await appendFile(
      filePath,
      `${responseItemRawLine({
        type: "function_call_output",
        call_id: "call_stream_1",
        output: "done",
      })}\n`,
      "utf-8",
    );

    const next = await getConversationStream(SESSION_A, initial.nextOffset);
    const toolResultOnly = next.messages.find(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) => block.type === "tool_result" && block.name === "read_file",
        ),
    );

    assert.ok(toolResultOnly);
  } finally {
    await cleanup();
  }
});

test("terminal run helpers parse background runs and merged output", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-terminal-runs",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      eventMsgLine({
        type: "exec_command_begin",
        source: "unified_exec_startup",
        call_id: "call_bg_1",
        process_id: "1000",
        command: ["bash", "-lc", "echo one"],
      }),
      eventMsgLine({
        type: "exec_command_output_delta",
        call_id: "call_bg_1",
        chunk: Buffer.from("hello from run 1\n", "utf-8").toString("base64"),
      }),
      eventMsgLine({
        type: "terminal_interaction",
        call_id: "call_bg_1",
        process_id: "1000",
        stdin: "ls -la\n",
      }),
      eventMsgLine({
        type: "exec_command_end",
        call_id: "call_bg_1",
        process_id: "1000",
      }),
      eventMsgLine({
        type: "exec_command_begin",
        source: "unified_exec_startup",
        call_id: "call_bg_2",
        process_id: "2000",
        command: ["bash", "-lc", "tail -f app.log"],
      }),
      eventMsgLine({
        type: "exec_command_output_delta",
        call_id: "call_bg_2",
        chunk: Buffer.from("streaming...\n", "utf-8").toString("base64"),
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const runsResponse = await getSessionTerminalRuns(SESSION_A);
    assert.equal(runsResponse.unavailableReason, null);
    assert.equal(runsResponse.runs.length, 1);
    assert.equal(runsResponse.runs[0]?.processId, "2000");
    assert.equal(runsResponse.runs[0]?.isRunning, true);

    const run1Output = await getSessionTerminalRunOutput(SESSION_A, "1000");
    assert.equal(run1Output, null);

    const run2Output = await getSessionTerminalRunOutput(SESSION_A, "2000");
    assert.ok(run2Output);
    assert.equal(run2Output?.isRunning, true);
    assert.match(run2Output?.output ?? "", /streaming\.\.\./);
  } finally {
    await cleanup();
  }
});

test("terminal run output returns null for unknown process id", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-terminal-run-missing",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemMessageLine("user", "hello"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const missing = await getSessionTerminalRunOutput(SESSION_A, "9999");
    assert.equal(missing, null);
  } finally {
    await cleanup();
  }
});

test("terminal run helpers parse response-item running sessions and end-only events", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-terminal-runs-response-item",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "function_call",
        name: "exec_command",
        call_id: "call_bg_3",
        arguments: { cmd: "pnpm test" },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_bg_3",
        output:
          "Chunk ID: abc123\nWall time: 1.00 seconds\nProcess running with session ID 3000\nOriginal token count: 2\nOutput:\nboot output\n",
      }),
      responseItemRawLine({
        type: "function_call",
        name: "write_stdin",
        call_id: "call_poll_3",
        arguments: { session_id: 3000, chars: "" },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_poll_3",
        output:
          "Chunk ID: def456\nWall time: 0.50 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nfinal tail\n",
      }),
      eventMsgLine({
        type: "exec_command_end",
        source: "unified_exec_startup",
        call_id: "call_bg_3",
        process_id: "3000",
        command: ["bash", "-lc", "pnpm test"],
        aggregated_output: "full aggregated output\n",
      }),
      eventMsgLine({
        type: "exec_command_end",
        source: "unified_exec_startup",
        call_id: "call_bg_4",
        process_id: "4000",
        command: ["bash", "-lc", "echo end-only"],
        aggregated_output: "end-only output\n",
      }),
      responseItemRawLine({
        type: "function_call",
        name: "exec_command",
        call_id: "call_bg_5",
        arguments: { cmd: "tail -f app.log" },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_bg_5",
        output:
          "Chunk ID: ghi789\nWall time: 1.00 seconds\nProcess running with session ID 5000\nOriginal token count: 2\nOutput:\nstreaming line\n",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const runsResponse = await getSessionTerminalRuns(SESSION_A);
    assert.equal(runsResponse.unavailableReason, null);

    assert.equal(runsResponse.runs.length, 1);
    const run5000 = runsResponse.runs.find((run) => run.processId === "5000");
    assert.ok(run5000);
    assert.equal(run5000?.isRunning, true);

    const run3000Output = await getSessionTerminalRunOutput(SESSION_A, "3000");
    assert.equal(run3000Output, null);

    const run4000Output = await getSessionTerminalRunOutput(SESSION_A, "4000");
    assert.equal(run4000Output, null);

    const run5000Output = await getSessionTerminalRunOutput(SESSION_A, "5000");
    assert.ok(run5000Output);
    assert.equal(run5000Output?.isRunning, true);
    assert.match(run5000Output?.output ?? "", /streaming line/);
  } finally {
    await cleanup();
  }
});

test("terminal run helpers clear active runs after interrupted turn_aborted", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-terminal-runs-aborted",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "function_call",
        name: "exec_command",
        call_id: "call_bg_6",
        arguments: { cmd: "tail -f app.log" },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_bg_6",
        output:
          "Chunk ID: jkl012\nWall time: 1.00 seconds\nProcess running with session ID 6000\nOriginal token count: 1\nOutput:\nline\n",
      }),
      eventMsgLine({
        type: "turn_aborted",
        reason: "interrupted",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const runsResponse = await getSessionTerminalRuns(SESSION_A);
    assert.equal(runsResponse.unavailableReason, null);
    assert.equal(runsResponse.runs.length, 0);
  } finally {
    await cleanup();
  }
});

test("terminal run helpers ignore running marker text inside command output body", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-terminal-runs-false-positive-body",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_A}.jsonl`, [
      sessionMetaLine(SESSION_A, "/repo/project-a", Date.now()),
      responseItemRawLine({
        type: "function_call",
        name: "exec_command",
        call_id: "call_body_marker",
        arguments: {
          cmd: 'rg -n "Process running with session ID" ~/.codex -S | head -n 80',
        },
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_body_marker",
        output:
          "Chunk ID: marker1\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\n20257: Process running with session ID 20257\n",
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const runsResponse = await getSessionTerminalRuns(SESSION_A);
    assert.equal(runsResponse.unavailableReason, null);
    assert.equal(runsResponse.runs.length, 0);
    const output = await getSessionTerminalRunOutput(SESSION_A, "20257");
    assert.equal(output, null);
  } finally {
    await cleanup();
  }
});

test("fixDanglingTurns is a no-op when no dangling turns exist", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-fix-noop");

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_B}.jsonl`, [
      sessionMetaLine(SESSION_B, "/repo/project-b", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn_1" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn_1" }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const before = await readFile(filePath, "utf-8");
    const result = await fixDanglingTurns(SESSION_B);
    const after = await readFile(filePath, "utf-8");

    assert.deepEqual(result.danglingTurnIds, []);
    assert.deepEqual(result.appendedTurnIds, []);
    assert.equal(before, after);
  } finally {
    await cleanup();
  }
});

test("superseded unfinished turns are not treated as dangling", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-fix-superseded",
  );

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_C}.jsonl`, [
      sessionMetaLine(SESSION_C, "/repo/project-c", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn_1" }),
      eventMsgLine({ type: "task_started", turn_id: "turn_2" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn_2" }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const waitState = await getSessionWaitState(SESSION_C);
    assert.equal(waitState.isWaiting, false);
    assert.equal(waitState.activeTurnId, null);
    assert.deepEqual(waitState.danglingTurnIds, []);

    const before = await readFile(filePath, "utf-8");
    const result = await fixDanglingTurns(SESSION_C);
    const after = await readFile(filePath, "utf-8");
    assert.deepEqual(result.danglingTurnIds, []);
    assert.deepEqual(result.appendedTurnIds, []);
    assert.equal(before, after);
  } finally {
    await cleanup();
  }
});

test("getSessionWaitState reflects active dangling turns and resolves after completion", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-wait-state");

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_C}.jsonl`, [
      sessionMetaLine(SESSION_C, "/repo/project-c", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn_1" }),
      eventMsgLine({ type: "task_started", turn_id: "turn_2" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn_1" }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const initialState = await getSessionWaitState(SESSION_C);
    assert.equal(initialState.isWaiting, true);
    assert.equal(initialState.activeTurnId, "turn_2");
    assert.deepEqual(initialState.danglingTurnIds, ["turn_2"]);

    await appendFile(
      filePath,
      `${eventMsgLine({ type: "task_complete", turn_id: "turn_2" })}\n`,
      "utf-8",
    );

    const completedState = await getSessionWaitState(SESSION_C);
    assert.equal(completedState.isWaiting, false);
    assert.equal(completedState.activeTurnId, null);
    assert.deepEqual(completedState.danglingTurnIds, []);
  } finally {
    await cleanup();
  }
});

test("getSessionWaitState reuses cached result when session file is temporarily unavailable", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-wait-cache");

  try {
    const filePath = await writeSessionFile(sessionsDir, `${SESSION_B}.jsonl`, [
      sessionMetaLine(SESSION_B, "/repo/project-b", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn_cached" }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const cachedState = await getSessionWaitState(SESSION_B);
    assert.equal(cachedState.isWaiting, true);
    assert.equal(cachedState.activeTurnId, "turn_cached");

    await rm(filePath, { force: true });

    const fallbackState = await getSessionWaitState(SESSION_B);
    assert.equal(fallbackState.isWaiting, true);
    assert.equal(fallbackState.activeTurnId, "turn_cached");
    assert.deepEqual(fallbackState.danglingTurnIds, ["turn_cached"]);
  } finally {
    await cleanup();
  }
});

test("getSessionContext returns usedTokens when model context window is unavailable", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "storage-context-used-only",
  );

  try {
    await writeSessionFile(sessionsDir, `${SESSION_C}.jsonl`, [
      sessionMetaLine(SESSION_C, "/repo/project-c", Date.now()),
      eventMsgLine({
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 45678,
          },
        },
      }),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const context = await getSessionContext(SESSION_C);
    assert.equal(context.contextLeftPercent, null);
    assert.equal(context.modelContextWindow, null);
    assert.equal(context.usedTokens, 45678);
    assert.equal(context.tokenUsage, null);
  } finally {
    await cleanup();
  }
});

test("getSessionContext returns nulls for missing sessions", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "storage-context-missing",
  );

  try {
    setStorageDir(rootDir);
    await loadStorage();

    const context = await getSessionContext("missing-session-id");
    assert.deepEqual(context, {
      sessionId: "missing-session-id",
      contextLeftPercent: null,
      usedTokens: null,
      modelContextWindow: null,
      tokenUsage: null,
    });
  } finally {
    await cleanup();
  }
});

test("getCodexConfigDefaults reads top-level configured model and efforts", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("storage-config");

  try {
    await writeFile(
      join(rootDir, "config.toml"),
      [
        'model = "gpt-5.4" # inline comment',
        'model_reasoning_effort = "xhigh"',
        'plan_mode_reasoning_effort = "high"',
        "",
        '[projects."/repo/demo"]',
        'model = "wrong-model"',
      ].join("\n"),
      "utf-8",
    );

    setStorageDir(rootDir);

    const defaults = await getCodexConfigDefaults();
    assert.deepEqual(defaults, {
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      planModeReasoningEffort: "high",
    });
  } finally {
    await cleanup();
  }
});

test("getSessions falls back to no-prompt display when no user message exists", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("storage-no-prompt");
  const noPromptSessionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

  try {
    await writeSessionFile(sessionsDir, `${noPromptSessionId}.jsonl`, [
      sessionMetaLine(noPromptSessionId, "/repo/project-a", Date.now()),
      responseItemMessageLine("assistant", "assistant-only content"),
    ]);

    setStorageDir(rootDir);
    await loadStorage();

    const sessions = await getSessions();
    const session = sessions.find((entry) => entry.id === noPromptSessionId);
    assert.ok(session);
    assert.equal(session.display, "(no prompt text)");
  } finally {
    await cleanup();
  }
});
