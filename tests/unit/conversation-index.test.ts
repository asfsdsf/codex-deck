import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyConversationLiveEvent,
  readConversationMessageWindow,
  readConversationMessageUpdates,
  readConversationMessageSnapshot,
  clearConversationIndexes,
} from "../../api/conversation-index";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
} from "./test-utils";

const line = (value: string) => `${value}\n`;

test("delayed reply token usage preserves numbering and reaches independent readers", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("numbered-reply-usage");
  const path = join(rootDir, "session.jsonl");
  try {
    await writeFile(path, line(responseItemMessageLine("assistant", "Answer")));
    const first = await readConversationMessageWindow(path);
    const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    await appendFile(
      path,
      line(
        eventMsgLine({
          type: "token_count",
          info: { last_token_usage: usage },
        }),
      ),
    );
    const [a, b] = await Promise.all([
      readConversationMessageUpdates(path, first.nextOffset),
      readConversationMessageUpdates(path, first.nextOffset),
    ]);
    assert.deepEqual(a.messages, b.messages);
    assert.equal(a.messages.length, 1);
    assert.deepEqual(a.messages[0].message?.usage, usage);
    assert.equal(a.messages[0].uuid, first.messages[0].uuid);
    assert.equal(a.messages[0].sequence, first.messages[0].sequence);
    assert.equal(a.messages[0].messageNumber, first.messages[0].messageNumber);
    assert.ok(a.messages[0].revision! > first.messages[0].revision!);
    assert.equal(a.totalMessages, 1);
    assert.equal(
      (await readConversationMessageUpdates(path, a.nextOffset)).messages
        .length,
      0,
    );
  } finally {
    clearConversationIndexes(path);
    await cleanup();
  }
});

test("numbered history pages are fixed before backfill and concurrent readers share one generation", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("numbered-pages");
  const path = join(rootDir, "session.jsonl");
  try {
    await writeFile(
      path,
      Array.from({ length: 604 }, (_, i) =>
        line(responseItemMessageLine("assistant", `message ${i + 1}`)),
      ).join(""),
    );
    const [first, second] = await Promise.all([
      readConversationMessageWindow(path),
      readConversationMessageWindow(path),
    ]);
    assert.equal(first.fileId, second.fileId);
    assert.equal(first.totalMessages, 604);
    assert.deepEqual(
      first.messages.map((message) => message.messageNumber),
      [601, 602, 603, 604],
    );
    const older = await readConversationMessageWindow(
      path,
      first.historyStartSequence,
    );
    assert.equal(older.messages.at(-1)?.messageNumber, 600);
    assert.deepEqual(
      (await readConversationMessageWindow(path)).messages,
      first.messages,
    );
    await appendFile(
      path,
      line(responseItemMessageLine("assistant", "appended")),
    );
    const updates = await readConversationMessageUpdates(
      path,
      first.nextOffset,
    );
    assert.equal(updates.fileId, first.fileId);
    assert.deepEqual(
      updates.messages.map((message) => message.messageNumber),
      [605],
    );
    assert.equal(updates.totalMessages, 605);
    assert.equal(
      (await readConversationMessageUpdates(path, updates.nextOffset)).messages
        .length,
      0,
    );
  } finally {
    clearConversationIndexes(path);
    await cleanup();
  }
});

test("tool completion, reasoning usage and split edit records retain their numbers", () => {
  const state = new ConversationParserState();
  const chunks = [
    line(
      responseItemRawLine({
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: "{}",
      }),
    ),
    line(
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call-1",
        output: "done",
      }),
    ),
    line(
      responseItemRawLine({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
      }),
    ),
    line(
      eventMsgLine({
        type: "token_count",
        info: { last_token_usage: { input_tokens: 3, output_tokens: 2 } },
      }),
    ),
    line(responseItemMessageLine("assistant", "editable answer")),
    line(eventMsgLine({ type: "agent_message", message: "editable answer" })),
  ];
  let offset = 0;
  const snapshots = chunks.map((text) => {
    const result = parseConversationTextChunk(text, offset, undefined, state);
    offset += result.consumedBytes;
    return result.messages;
  });
  assert.equal(snapshots[0][0].sequence, snapshots[1][0].sequence);
  assert.equal(snapshots[0][0].messageNumber, snapshots[1][0].messageNumber);
  assert.equal((snapshots[1][0].message?.content as unknown[]).length, 2);
  assert.equal(snapshots[2][0].sequence, snapshots[3][0].sequence);
  assert.equal(snapshots[4][0].sequence, snapshots[5][0].sequence);
  assert.equal(snapshots[4][0].editable, undefined);
  assert.equal(snapshots[5][0].editable, true);
  assert.deepEqual(
    state.messages.map((message) => message.messageNumber),
    [1, 2, 3],
  );
});

test("stream snapshots and persisted completions share one number, including logs without item IDs", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("numbered-stream");
  const path = join(rootDir, "session.jsonl");
  try {
    await writeFile(
      path,
      line(eventMsgLine({ type: "task_started", turn_id: "turn-1" })),
    );
    const initial = await readConversationMessageWindow(path);
    await applyConversationLiveEvent(path, {
      type: "assistant_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: "hello",
    });
    const partial = await readConversationMessageUpdates(
      path,
      initial.nextOffset,
    );
    assert.equal(partial.messages[0].streaming, true);
    await applyConversationLiveEvent(path, {
      type: "assistant_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: " world",
    });
    await applyConversationLiveEvent(path, {
      type: "item_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      item: { type: "agentMessage", text: "hello world!" },
    });
    const final = await readConversationMessageUpdates(
      path,
      partial.nextOffset,
    );
    assert.equal(final.messages.length, 1);
    assert.equal(final.messages[0].sequence, partial.messages[0].sequence);
    assert.equal(
      final.messages[0].messageNumber,
      partial.messages[0].messageNumber,
    );
    assert.equal(final.messages[0].streaming, false);
    assert.ok(final.messages[0].revision! > partial.messages[0].revision!);
    await appendFile(
      path,
      line(responseItemMessageLine("assistant", "hello world!")),
    );
    const persisted = await readConversationMessageUpdates(
      path,
      final.nextOffset,
    );
    assert.equal(persisted.messages.length, 1);
    assert.equal(persisted.messages[0].sequence, partial.messages[0].sequence);
    assert.equal(persisted.messages[0].streaming, false);
    await applyConversationLiveEvent(path, {
      type: "assistant_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      delta: "late",
    });
    assert.equal(
      (await readConversationMessageUpdates(path, persisted.nextOffset))
        .messages.length,
      0,
    );
    await applyConversationLiveEvent(path, {
      type: "assistant_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-2",
      delta: "second answer",
    });
    await appendFile(
      path,
      line(responseItemMessageLine("assistant", "second answer")),
    );
    const second = await readConversationMessageUpdates(
      path,
      persisted.nextOffset,
    );
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].messageNumber, 2);
    assert.equal(second.messages[0].streaming, false);
    assert.equal((await readConversationMessageWindow(path)).totalMessages, 2);
  } finally {
    clearConversationIndexes(path);
    await cleanup();
  }
});

for (const notification of ["assistant_delta", "item_completed"] as const) {
  test(`${notification} after cached history keeps a new item at the end of its turn`, async () => {
    const { rootDir, cleanup } = await createTempCodexDir(
      "numbered-live-identity",
    );
    const path = join(rootDir, "session.jsonl");
    const reply = (id: string, text: string) =>
      line(
        responseItemRawLine({
          type: "message",
          id,
          role: "assistant",
          content: [{ type: "output_text", text }],
        }),
      );
    try {
      await writeFile(
        path,
        line(eventMsgLine({ type: "task_started", turn_id: "turn-1" })) +
          reply("old-item", "Earlier reply") +
          line(
            responseItemRawLine({
              type: "function_call",
              call_id: "call-1",
              name: "exec_command",
              arguments: "{}",
            }),
          ),
      );
      const initial = await readConversationMessageWindow(path);
      const identity = {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "new-item",
      };
      await applyConversationLiveEvent(
        path,
        notification === "assistant_delta"
          ? { ...identity, type: notification, delta: "Final reply" }
          : {
              ...identity,
              type: notification,
              item: { type: "agentMessage", text: "Final reply" },
            },
      );
      await appendFile(path, reply("new-item", "Final reply"));
      const [first, second] = await Promise.all([
        readConversationMessageUpdates(path, initial.nextOffset),
        readConversationMessageUpdates(path, initial.nextOffset),
      ]);
      assert.deepEqual(first.messages, second.messages);
      assert.equal(first.totalMessages, 3);
      assert.equal(first.messages.at(-1)?.messageNumber, 3);
      const cached = await readConversationMessageSnapshot(path);
      const summarize = (messages: typeof cached) =>
        messages.map(({ type, sequence, messageNumber, message }) => ({
          type,
          sequence,
          messageNumber,
          content: message?.content,
        }));
      assert.deepEqual(cached[1].message?.content, [
        { type: "text", text: "Earlier reply" },
      ]);
      assert.equal(cached.at(-1)?.itemId, "new-item");
      assert.equal(cached.at(-1)?.messageNumber, 3);
      assert.deepEqual(
        (await readConversationMessageWindow(path)).messages,
        cached,
      );
      clearConversationIndexes(path);
      assert.deepEqual(
        summarize(await readConversationMessageSnapshot(path)),
        summarize(cached),
      );
    } finally {
      clearConversationIndexes(path);
      await cleanup();
    }
  });
}

test("replacement and truncation reset the numbered generation", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("numbered-reset");
  const path = join(rootDir, "session.jsonl");
  try {
    await writeFile(
      path,
      line(responseItemMessageLine("assistant", "original answer")),
    );
    const first = await readConversationMessageWindow(path);
    await writeFile(
      `${path}.new`,
      line(responseItemMessageLine("assistant", "replacement")),
    );
    await rename(`${path}.new`, path);
    const replaced = await readConversationMessageWindow(path);
    assert.notEqual(replaced.fileId, first.fileId);
    await writeFile(path, "");
    const truncated = await readConversationMessageWindow(path);
    assert.notEqual(truncated.fileId, replaced.fileId);
    assert.equal(truncated.totalMessages, 0);
    await appendFile(path, line(responseItemMessageLine("assistant", "new")));
    assert.equal(
      (await readConversationMessageWindow(path)).messages[0].sequence,
      1,
    );
  } finally {
    clearConversationIndexes(path);
    await cleanup();
  }
});
