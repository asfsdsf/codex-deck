import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyConversationLiveEvent,
  clearConversationIndexes,
  readConversationMessageSnapshot,
  readConversationMessageUpdates,
  readConversationMessageWindow,
} from "../../api/conversation-index";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
  sessionMetaLine,
} from "./test-utils";

const record = (line: string, ordinal: number) =>
  JSON.stringify({ ...JSON.parse(line), ordinal }) + "\n";
const reply = (text: string, ordinal: number) =>
  record(responseItemMessageLine("assistant", text), ordinal);

function forkMeta(id: string, parent: string, ordinal: number, bytes: number) {
  return (
    JSON.stringify({
      type: "session_meta",
      ordinal,
      payload: {
        id,
        cwd: "/repo",
        forked_from_id: parent,
        history_mode: "paginated",
        history_base: {
          thread_id: parent,
          end_ordinal_exclusive: ordinal,
          end_byte_offset: bytes,
        },
      },
    }) + "\n"
  );
}

async function withFiles(
  run: (
    paths: Record<string, string>,
    resolve: (id: string) => Promise<string | null>,
  ) => Promise<void>,
) {
  const { rootDir, cleanup } = await createTempCodexDir("conversation-fork");
  const paths = Object.fromEntries(
    ["parent", "child", "grandchild"].map((id) => [
      id,
      join(rootDir, `${id}.jsonl`),
    ]),
  );
  try {
    await run(paths, async (id) => paths[id] ?? null);
  } finally {
    for (const path of Object.values(paths)) clearConversationIndexes(path);
    await cleanup();
  }
}

test("referenced forks paginate inherited history and never include later parent messages", async () => {
  await withFiles(async (paths, resolve) => {
    const prefix =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      Array.from({ length: 202 }, (_, i) =>
        reply(`parent ${i + 1}`, i + 1),
      ).join("");
    await writeFile(paths.parent, prefix + reply("parent after fork", 203));
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 203, Buffer.byteLength(prefix)) +
        reply("child answer", 204),
    );
    const [first, second] = await Promise.all([
      readConversationMessageWindow(paths.child, undefined, resolve),
      readConversationMessageWindow(paths.child, undefined, resolve),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.totalMessages, 203);
    assert.deepEqual(
      first.messages.map((m) => m.messageNumber),
      [201, 202, 203],
    );
    const older = await readConversationMessageWindow(
      paths.child,
      first.historyStartSequence,
      resolve,
    );
    assert.equal(older.messages.length, 200);
    assert.equal(older.historyStartSequence, 0);
    assert.equal(older.messages.at(-1)?.messageNumber, 200);
    assert.equal(older.fileId, first.fileId);
    await appendFile(paths.parent, reply("another later parent answer", 204));
    const unchanged = await readConversationMessageUpdates(
      paths.child,
      first.nextOffset,
      undefined,
      resolve,
    );
    assert.equal(unchanged.fileId, first.fileId);
    assert.deepEqual(unchanged.messages, []);
    assert.equal(unchanged.totalMessages, 203);
    const all = await readConversationMessageSnapshot(paths.child, resolve);
    assert.ok(all.slice(0, 202).every((m) => m.editable === false));
    assert.ok(!JSON.stringify(all).includes("after fork"));
  });
});

test("fork live updates and persisted completions retain inherited numbering for all readers", async () => {
  await withFiles(async (paths, resolve) => {
    const prefix =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      reply("parent", 1);
    await writeFile(paths.parent, prefix);
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 2, Buffer.byteLength(prefix)),
    );
    const initial = await readConversationMessageWindow(
      paths.child,
      undefined,
      resolve,
    );
    await appendFile(
      paths.child,
      record(eventMsgLine({ type: "task_started", turn_id: "child-turn" }), 3),
    );
    await applyConversationLiveEvent(
      paths.child,
      {
        type: "assistant_delta",
        threadId: "child",
        turnId: "child-turn",
        itemId: "answer",
        delta: "hello",
      },
      resolve,
    );
    const partial = await readConversationMessageUpdates(
      paths.child,
      initial.nextOffset,
      undefined,
      resolve,
    );
    const answer = partial.messages.find((m) => m.type === "assistant")!;
    assert.equal(answer.messageNumber, 2);
    assert.equal(answer.streaming, true);
    await appendFile(paths.child, reply("hello", 4));
    const [a, b] = await Promise.all([
      readConversationMessageUpdates(
        paths.child,
        partial.nextOffset,
        undefined,
        resolve,
      ),
      readConversationMessageUpdates(
        paths.child,
        partial.nextOffset,
        undefined,
        resolve,
      ),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.fileId, initial.fileId);
    assert.equal(a.totalMessages, 2);
    assert.equal(a.messages.length, 1);
    assert.equal(a.messages[0].uuid, answer.uuid);
    assert.equal(a.messages[0].streaming, false);
    assert.equal(a.messages[0].messageNumber, 2);
  });
});

test("nested forks replay each ancestor only up to the selected ordinal and byte boundary", async () => {
  await withFiles(async (paths, resolve) => {
    const root =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      reply("root shared", 1);
    const child =
      forkMeta("child", "parent", 2, Buffer.byteLength(root)) +
      reply("child shared", 3);
    await writeFile(paths.parent, root + reply("root later", 2));
    await writeFile(paths.child, child + reply("child later", 4));
    await writeFile(
      paths.grandchild,
      forkMeta("grandchild", "child", 4, Buffer.byteLength(child)) +
        reply("grandchild", 5),
    );
    const all = await readConversationMessageSnapshot(
      paths.grandchild,
      resolve,
    );
    assert.deepEqual(
      all.map((m) => m.message?.content),
      ["root shared", "child shared", "grandchild"].map((text) => [
        { type: "text", text },
      ]),
    );
    assert.equal(new Set(all.map((m) => m.uuid)).size, 3);
    assert.deepEqual(
      all.map((m) => m.messageNumber),
      [1, 2, 3],
    );

    // A fork selecting an earlier turn can cut inside a parent's inherited history.
    await writeFile(
      paths.grandchild,
      forkMeta("grandchild", "child", 1, Buffer.byteLength(child)) +
        reply("earlier fork", 2),
    );
    const earlier = await readConversationMessageSnapshot(
      paths.grandchild,
      resolve,
    );
    assert.deepEqual(
      earlier.map((m) => m.message?.content),
      [[{ type: "text", text: "earlier fork" }]],
    );
  });
});

test("forks handle legacy ordinals, malformed complete lines and UTF-8 records across read chunks", async () => {
  await withFiles(async (paths, resolve) => {
    const root =
      sessionMetaLine("parent", "/repo", 1700000000000) +
      "\n" +
      responseItemMessageLine("assistant", "继承".repeat(200000)) +
      "\n" +
      "{malformed}\n\n" +
      responseItemMessageLine("assistant", "later") +
      "\n";
    await writeFile(paths.parent, root);
    // The byte prefix deliberately extends beyond the ordinal cutoff.
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 2, Buffer.byteLength(root)) +
        reply("child", 3),
    );
    const all = await readConversationMessageSnapshot(paths.child, resolve);
    assert.equal(all.length, 2);
    assert.deepEqual(all[0].message?.content, [
      { type: "text", text: "继承".repeat(200000) },
    ]);
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 3, Buffer.byteLength(root)) +
        reply("child", 4),
    );
    // Malformed complete records are skipped by the regular parser.
    assert.equal(
      (await readConversationMessageSnapshot(paths.child, resolve)).length,
      3,
    );
  });
});

test("inherited edit records are read-only and child offset edit IDs address the child's physical file", async () => {
  await withFiles(async (paths, resolve) => {
    const parent =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      reply("parent editable", 1) +
      record(
        eventMsgLine({ type: "agent_message", message: "parent editable" }),
        2,
      );
    const meta = forkMeta("child", "parent", 3, Buffer.byteLength(parent));
    await writeFile(paths.parent, parent);
    await writeFile(
      paths.child,
      meta +
        reply("child editable", 4) +
        record(
          eventMsgLine({ type: "agent_message", message: "child editable" }),
          5,
        ),
    );
    const all = await readConversationMessageSnapshot(paths.child, resolve);
    assert.equal(all.length, 2);
    assert.equal(all[0].editable, false);
    assert.equal(all[0].editId, undefined);
    assert.equal(all[0].editText, undefined);
    assert.equal(all[1].editable, true);
    assert.equal(
      all[1].editId,
      `offset:${Buffer.byteLength(meta)}:2026-01-01T00:00:00.000Z`,
    );
    const repeated = await readConversationMessageSnapshot(
      paths.child,
      resolve,
    );
    assert.deepEqual(repeated, all);
    assert.equal(
      (await readConversationMessageSnapshot(paths.parent))[0].editable,
      true,
    );
  });
});

test("fork history keeps parser context for inherited tool calls", async () => {
  await withFiles(async (paths, resolve) => {
    const parent =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      record(
        responseItemRawLine({
          type: "function_call",
          call_id: "shared-call",
          name: "exec_command",
          arguments: "{}",
        }),
        1,
      );
    await writeFile(paths.parent, parent);
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 2, Buffer.byteLength(parent)) +
        record(
          responseItemRawLine({
            type: "function_call_output",
            call_id: "shared-call",
            output: "child result",
          }),
          3,
        ),
    );
    const all = await readConversationMessageSnapshot(paths.child, resolve);
    assert.equal(all.length, 1);
    assert.equal(all[0].messageNumber, 1);
    const content = all[0].message?.content as { type: string; name: string }[];
    assert.deepEqual(
      content.map((b) => b.type),
      ["tool_use", "tool_result"],
    );
    assert.equal(content[1].name, "exec_command");
  });
});

test("fork cache resets when an ancestor is replaced and reports missing, cyclic or truncated references", async () => {
  await withFiles(async (paths, resolve) => {
    const parent =
      record(sessionMetaLine("parent", "/repo", 1700000000000), 0) +
      reply("before", 1);
    await writeFile(paths.parent, parent);
    await writeFile(
      paths.child,
      forkMeta("child", "parent", 2, Buffer.byteLength(parent)) +
        reply("child", 3),
    );
    const first = await readConversationMessageWindow(
      paths.child,
      undefined,
      resolve,
    );
    await writeFile(paths.parent + ".new", parent.replace("before", "edited"));
    await rename(paths.parent + ".new", paths.parent);
    const replaced = await readConversationMessageWindow(
      paths.child,
      undefined,
      resolve,
    );
    assert.notEqual(replaced.fileId, first.fileId);
    assert.match(JSON.stringify(replaced.messages), /edited/);
    await writeFile(paths.parent, "");
    await assert.rejects(
      readConversationMessageWindow(paths.child, undefined, resolve),
      /truncated/,
    );
    await writeFile(paths.child, forkMeta("child", "missing", 1, 100));
    await assert.rejects(
      readConversationMessageWindow(paths.child, undefined, resolve),
      /unavailable/,
    );
    await writeFile(paths.child, forkMeta("child", "parent", 1, 100));
    await writeFile(paths.parent, forkMeta("parent", "child", 1, 100));
    await assert.rejects(
      readConversationMessageWindow(paths.child, undefined, resolve),
      /Cyclic/,
    );
  });
});

test("copied fork histories without a history reference are not replayed twice", async () => {
  await withFiles(async (paths, resolve) => {
    const meta = JSON.parse(sessionMetaLine("child", "/repo", 1700000000000));
    meta.payload.forked_from_id = "parent";
    await writeFile(
      paths.child,
      JSON.stringify(meta) +
        "\n" +
        reply("copied parent", 1) +
        reply("child", 2),
    );
    const all = await readConversationMessageSnapshot(paths.child, resolve);
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((m) => m.messageNumber),
      [1, 2],
    );
  });
});
