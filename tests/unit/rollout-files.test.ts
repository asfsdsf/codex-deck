import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readRolloutText,
  materializeRolloutForWrite,
} from "../../api/rollout-files";
import {
  getConversation,
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
