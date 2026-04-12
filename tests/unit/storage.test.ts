import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addToFileIndex,
  deleteSession,
  fixDanglingTurns,
  getClaudeDir,
  getCodexDir,
  getConversation,
  getConversationStream,
  getProjects,
  getSessionTerminalRunOutput,
  getSessionTerminalRuns,
  getSessionWaitState,
  getCodexConfigDefaults,
  getSessionContext,
  getSessions,
  initStorage,
  invalidateHistoryCache,
  loadStorage,
  sessionExists,
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
