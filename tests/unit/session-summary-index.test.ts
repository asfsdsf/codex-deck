import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSessionSummaryIndex } from "../../api/session-summary-index";
import {
  readRolloutPrefix,
  readRolloutText,
  statRolloutSource,
} from "../../api/rollout-files";
import {
  getConversationMessageWindow,
  getSessions,
  initStorage,
  loadStorage,
} from "../../api/storage";
import {
  createTempCodexDir,
  responseItemMessageLine,
  sessionMetaLine,
  zstdFrame,
} from "./test-utils";

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;
const id = (i: number) =>
  `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`;
const sqlString = (value: string) => "'" + value.replace(/'/g, "''") + "'";

test("compressed discovery and fallback summaries never hydrate transcript bodies", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("bounded-summary");
  try {
    for (let i = 0; i < 40; i++) {
      const head =
        sessionMetaLine(id(i), "/repo", 1700000000000) +
        "\n" +
        responseItemMessageLine("user", `Prompt ${i}`) +
        "\n";
      const padding = " ".repeat(131000 - Buffer.byteLength(head));
      await writeFile(
        join(sessionsDir, id(i) + ".jsonl.zst"),
        Buffer.concat([
          zstdFrame(head + padding),
          zstdFrame(" ".repeat(131000)),
          zstdFrame(" ".repeat(131000)),
          Buffer.from("invalid unread transcript tail"),
        ]),
      );
    }
    initStorage(rootDir);
    await loadStorage();
    const [first, second] = await Promise.all([getSessions(), getSessions()]);
    assert.equal(first.length, 40);
    assert.deepEqual(first, second);
    assert.ok(
      first.every(
        (s) => s.project === "/repo" && s.display.startsWith("Prompt "),
      ),
    );
    const path = join(sessionsDir, id(0) + ".jsonl.zst");
    assert.equal((await readRolloutPrefix(path, 64)).length, 64);
    assert.ok((await statRolloutSource(path)).size > 256 * 1024);
    // A full reader would reach this invalid tail; listing must never do that.
    await assert.rejects(readRolloutText(path));
  } finally {
    await cleanup();
  }
});

test(
  "session lists use indexed summaries across compressed cache eviction and plain transitions",
  { skip: !hasSqlite },
  async () => {
    const { rootDir, sessionsDir, cleanup } =
      await createTempCodexDir("indexed-summary");
    const db = join(rootDir, "state_5.sqlite");
    try {
      const statements = [
        "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, created_at INTEGER, recency_at_ms INTEGER, first_user_message TEXT, archived INTEGER);",
      ];
      for (let i = 0; i < 40; i++) {
        const path = join(sessionsDir, id(i) + ".jsonl");
        await writeFile(
          path + ".zst",
          "not a transcript: listing uses the native summary index",
        );
        statements.push(
          `INSERT INTO threads VALUES (${sqlString(id(i))}, ${sqlString(path)}, '/indexed-repo', 1700000000, ${1700000000000 + i}, 'Indexed prompt ${i}', 0);`,
        );
      }
      statements.push(
        `INSERT INTO threads VALUES ('missing-rollout', '/missing/rollout.jsonl', '/not-listed', 1700000000, 1700000000000, 'Stale missing rollout', 0);`,
      );
      execFileSync("sqlite3", [db, statements.join("\n")]);
      initStorage(rootDir);
      await loadStorage();
      const sessions = await getSessions();
      assert.equal(sessions.length, 40);
      assert.equal(sessions[0].id, id(39));
      assert.equal(sessions[0].lastUserMessageAt, 1700000000039);
      assert.ok(
        sessions.every(
          (s) =>
            s.display.startsWith("Indexed prompt ") &&
            s.project === "/indexed-repo",
        ),
      );
      await assert.rejects(getConversationMessageWindow(id(0)));
      // A writable plain sibling must take precedence over immutable indexed history.
      await writeFile(
        join(sessionsDir, id(0) + ".jsonl"),
        sessionMetaLine(id(0), "/indexed-repo", 1700000000000) +
          "\n" +
          responseItemMessageLine(
            "user",
            "Fresh plain prompt",
            "2027-01-01T00:00:00Z",
          ) +
          "\n",
      );
      await loadStorage();
      const updated = await getSessions();
      assert.equal(updated[0].id, id(0));
      assert.equal(updated[0].display, "Fresh plain prompt");
    } finally {
      await cleanup();
    }
  },
);

test(
  "optional summary indexes tolerate old schemas, missing sqlite and corrupt databases",
  { skip: !hasSqlite },
  async () => {
    const { rootDir, cleanup } = await createTempCodexDir(
      "summary-compatibility",
    );
    const db = join(rootDir, "state.sqlite");
    try {
      execFileSync("sqlite3", [
        db,
        "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, title TEXT); INSERT INTO threads VALUES ('old','/old.jsonl','/repo',1700000000,1700000001,'Old prompt');",
      ]);
      const summaries = await readSessionSummaryIndex(db);
      assert.equal(summaries.get("/old.jsonl")?.recencyAt, 1700000001000);
      assert.equal(summaries.get("/old.jsonl")?.display, "Old prompt");
      const original = process.env.PATH;
      try {
        process.env.PATH = rootDir;
        assert.equal((await readSessionSummaryIndex(db)).size, 0);
      } finally {
        process.env.PATH = original;
      }
      const corrupt = join(rootDir, "corrupt.sqlite");
      await writeFile(corrupt, "not a database");
      assert.equal((await readSessionSummaryIndex(corrupt)).size, 0);
    } finally {
      await cleanup();
    }
  },
);
