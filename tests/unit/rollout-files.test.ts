import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readRolloutText,
  materializeRolloutForWrite,
} from "../../api/rollout-files";
import {
  getConversation,
  getConversationMessageWindow,
  getConversationRawWindow,
  getSessions,
  initStorage,
  loadStorage,
  syncSessionFileIndex,
} from "../../api/storage";
import { searchSessionContent } from "../../api/session-content-search";
import {
  createTempCodexDir,
  responseItemMessageLine,
  sessionMetaLine,
  zstdFrame,
} from "./test-utils";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("compressed histories support discovery, byte windows, search, and representation transitions", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("compressed-history");
  const path = join(sessionsDir, `${id}.jsonl`);
  const lines = [
    sessionMetaLine(id, "/repo", Date.now()),
    responseItemMessageLine("user", "Needle 中文"),
  ];
  const text = lines.join("\n") + "\n";
  try {
    await writeFile(path + ".zst", zstdFrame(text));
    initStorage(rootDir);
    await loadStorage();
    assert.equal((await getSessions())[0].id, id);
    assert.match(JSON.stringify(await getConversation(id)), /Needle 中文/);
    const raw = await getConversationRawWindow(id);
    assert.equal(Buffer.from(raw.chunkBase64, "base64").toString(), text);
    const search = await searchSessionContent({
      query: "needle 中文",
      searchRoot: sessionsDir,
      sessionFiles: [{ sessionId: id, filePath: path + ".zst" }],
    });
    assert.deepEqual(search.sessionIds, [id]);
    await materializeRolloutForWrite(path + ".zst");
    await appendFile(
      path,
      responseItemMessageLine("assistant", "after materialization") + "\n",
    );
    await syncSessionFileIndex(id, path);
    assert.match(
      JSON.stringify(await getConversation(id)),
      /after materialization/,
    );
    await writeFile(path + ".zst", zstdFrame(await readFile(path, "utf8")));
    await rm(path);
    await syncSessionFileIndex(id, path + ".zst");
    assert.match(
      JSON.stringify(await getConversation(id)),
      /after materialization/,
    );
    assert.equal((await getSessions()).length, 1);
  } finally {
    await cleanup();
  }
});

test("rollout decoder handles concatenated frames and seek-table skippable frames, invalidates replacements, and rejects corruption", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("compressed-frames");
  const path = join(rootDir, "records.jsonl.zst");
  try {
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a5e, 0);
    skip.writeUInt32LE(4, 4);
    await writeFile(
      path,
      Buffer.concat([zstdFrame("first\n"), zstdFrame("second\n"), skip]),
    );
    const [a, b] = await Promise.all([
      readRolloutText(path),
      readRolloutText(path),
    ]);
    assert.equal(a, "first\nsecond\n");
    assert.equal(a, b);
    await writeFile(path, zstdFrame("replacement\n"));
    assert.equal(await readRolloutText(path), "replacement\n");
    await writeFile(path, "invalid zstandard");
    await assert.rejects(readRolloutText(path));
  } finally {
    await cleanup();
  }
});

test("concurrent compressed readers remain readable across cache eviction", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "compressed-concurrent",
  );
  try {
    const paths = Array.from({ length: 128 }, (_, i) =>
      join(rootDir, `${i}.jsonl.zst`),
    );
    await Promise.all(
      paths.map((path, i) => writeFile(path, zstdFrame(`record-${i}\n`))),
    );
    const texts = await Promise.all(paths.map((path) => readRolloutText(path)));
    assert.deepEqual(
      texts,
      paths.map((_, i) => `record-${i}\n`),
    );
  } finally {
    await cleanup();
  }
});

test("fork lineage resolves immutable rollout IDs in compressed archives across reverts", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("archived-lineage");
  const thread = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const rollout = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const child = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const grandchild = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const archived = join(rootDir, "archived_sessions");
  const record = (line: string, ordinal: number) =>
    JSON.stringify({ ...JSON.parse(line), ordinal }) + "\n";
  const answer = (text: string, ordinal: number) =>
    record(responseItemMessageLine("assistant", text), ordinal);
  const fork = (id: string, parent: string, ordinal: number, bytes: number) =>
    JSON.stringify({
      type: "session_meta",
      ordinal,
      payload: {
        id,
        cwd: "/repo",
        history_mode: "paginated",
        history_base: {
          thread_id: parent,
          end_ordinal_exclusive: ordinal,
          end_byte_offset: bytes,
        },
      },
    }) + "\n";
  const parentPrefix =
    record(sessionMetaLine(thread, "/repo", Date.now()), 0) +
    answer("retained before revert", 1);
  const childPrefix =
    fork(child, rollout, 2, Buffer.byteLength(parentPrefix)) +
    answer("child retained", 3);
  try {
    await mkdir(archived, { recursive: true });
    await writeFile(
      join(archived, `rollout-${rollout}.jsonl.zst`),
      zstdFrame(parentPrefix + answer("excluded parent tail", 2)),
    );
    await writeFile(
      join(sessionsDir, `rollout-${thread}.jsonl`),
      sessionMetaLine(thread, "/repo", Date.now()) +
        "\n" +
        responseItemMessageLine("assistant", "new thread history") +
        "\n",
    );
    await writeFile(
      join(archived, `rollout-${child}.jsonl.zst`),
      zstdFrame(childPrefix + answer("excluded child tail", 4)),
    );
    await writeFile(
      join(sessionsDir, `rollout-${grandchild}.jsonl`),
      fork(grandchild, child, 4, Buffer.byteLength(childPrefix)) +
        answer("grandchild answer", 5),
    );
    initStorage(rootDir);
    await loadStorage();
    const messages = (await getConversationMessageWindow(grandchild)).messages;
    assert.deepEqual(
      messages.map((m) => m.messageNumber),
      [1, 2, 3],
    );
    const text = JSON.stringify(messages);
    assert.match(text, /retained before revert/);
    assert.match(text, /child retained/);
    assert.match(text, /grandchild answer/);
    assert.doesNotMatch(text, /excluded|new thread history/);
    assert.ok(messages.slice(0, 2).every((m) => m.editable === false));
    const sessions = await getSessions();
    assert.deepEqual(
      sessions.map((s) => s.id).sort(),
      [thread, grandchild].sort(),
    );
    // An unavailable immutable rollout must never resolve to the current thread
    // just because its metadata still has the same logical ID.
    await rm(join(archived, `rollout-${rollout}.jsonl.zst`));
    await assert.rejects(
      getConversationMessageWindow(grandchild),
      /unavailable/,
    );
  } finally {
    await cleanup();
  }
});
