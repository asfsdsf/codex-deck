import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getSessionOrigin,
  SIDE_CONVERSATION_BOUNDARY_PROMPT,
} from "../../api/session-origins";
import {
  deleteSession,
  getSessions,
  initStorage,
  loadStorage,
  syncSessionFileIndex,
} from "../../api/storage";
import {
  createTempCodexDir,
  responseItemMessageLine,
  sessionMetaLine,
  zstdFrame,
  writeSessionFile,
} from "./test-utils";

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

for (const indexed of [false, true]) {
  for (const kind of ["review", "side"] as const) {
    test(
      `${kind} sessions recover their parent from ${indexed ? "SQLite-backed" : "rollout"} summaries without markers`,
      { skip: indexed && !hasSqlite },
      async () => {
        const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
          "native-review-origins",
        );
        const statements = [
          "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, source TEXT, first_user_message TEXT);",
        ];
        try {
          for (const compressed of [false, true]) {
            const id = `${compressed ? "compressed" : "plain"}-${kind}`;
            const meta = JSON.parse(
              sessionMetaLine(id, "/project", 1700000000000),
            );
            Object.assign(
              meta.payload,
              kind === "review"
                ? {
                    source: { subagent: "review" },
                    thread_source: "subagent",
                    parent_thread_id: "parent",
                    originator: "codex-tui",
                  }
                : {
                    source: "vscode",
                    forked_from_id: "parent",
                    history_mode: "paginated",
                    history_base: { thread_id: "parent" },
                  },
            );
            const path = join(sessionsDir, `${id}.jsonl`);
            const text =
              JSON.stringify(meta) +
              "\n" +
              (kind === "side"
                ? responseItemMessageLine(
                    "user",
                    SIDE_CONVERSATION_BOUNDARY_PROMPT,
                  ) + "\n"
                : "");
            await writeFile(
              path + (compressed ? ".zst" : ""),
              compressed
                ? Buffer.concat([
                    zstdFrame(
                      text + " ".repeat(131000 - Buffer.byteLength(text)),
                    ),
                    Buffer.from("invalid unread transcript tail"),
                  ])
                : text,
            );
            const quote = (value: string) =>
              "'" + value.replaceAll("'", "''") + "'";
            statements.push(
              `INSERT INTO threads VALUES (${quote(id)}, ${quote(path)}, '/project', ${quote(kind === "review" ? '{"subagent":"review"}' : "vscode")}, 'Inspect the code');`,
            );
          }
          const normal = JSON.parse(
            sessionMetaLine("ordinary-fork", "/project", 1700000000000),
          );
          Object.assign(normal.payload, {
            source: "cli",
            parent_thread_id: "parent",
            forked_from_id: "parent",
          });
          await writeSessionFile(sessionsDir, "ordinary-fork.jsonl", [
            JSON.stringify(normal),
            responseItemMessageLine(
              "user",
              `Explain this prompt: ${SIDE_CONVERSATION_BOUNDARY_PROMPT}`,
            ),
          ]);
          if (indexed)
            execFileSync("sqlite3", [
              join(rootDir, "state_5.sqlite"),
              statements.join("\n"),
            ]);
          initStorage(rootDir);
          await loadStorage();
          const sessions = await getSessions();
          for (const id of [`plain-${kind}`, `compressed-${kind}`]) {
            assert.deepEqual(
              sessions.find((session) => session.id === id)?.origin,
              { kind, parentSessionId: "parent" },
            );
          }
          assert.equal(
            sessions.find((session) => session.id === "ordinary-fork")?.origin,
            undefined,
          );
          await assert.rejects(
            access(join(rootDir, "codex-deck", "session-origins")),
            { code: "ENOENT" },
          );
        } finally {
          await cleanup();
        }
      },
    );
  }
}

test("origins survive reloads and ignore obsolete Deck markers", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("session-origins");
  try {
    for (const id of ["source", "review", "side"]) {
      const meta = JSON.parse(sessionMetaLine(id, "/project", 1700000000000));
      if (id === "review") {
        Object.assign(meta.payload, {
          source: { subagent: "review" },
          parent_thread_id: "source",
        });
      } else if (id === "side") {
        meta.payload.forked_from_id = "source";
      }
      await writeSessionFile(sessionsDir, `${id}.jsonl`, [
        JSON.stringify(meta),
        ...(id === "side"
          ? [responseItemMessageLine("user", SIDE_CONVERSATION_BOUNDARY_PROMPT)]
          : []),
      ]);
    }
    // Neither old review nor side markers may classify a session or override
    // the parent recorded by Codex.
    const directory = join(rootDir, "codex-deck", "session-origins");
    await mkdir(directory, { recursive: true });
    for (const id of ["source", "review", "side"]) {
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify({
          kind: id === "review" ? "review" : "side",
          parentSessionId: "wrong-parent",
        }),
      );
    }
    initStorage(rootDir);
    await loadStorage();
    let sessions = await getSessions();
    assert.deepEqual(sessions.find((s) => s.id === "review")?.origin, {
      kind: "review",
      parentSessionId: "source",
    });
    assert.deepEqual(sessions.find((s) => s.id === "side")?.origin, {
      kind: "side",
      parentSessionId: "source",
    });
    assert.equal(sessions.find((s) => s.id === "source")?.origin, undefined);
    initStorage(rootDir);
    await loadStorage();
    assert.deepEqual(
      (await getSessions()).find((s) => s.id === "review")?.origin,
      { kind: "review", parentSessionId: "source" },
    );
    assert.deepEqual(
      (await getSessions()).find((s) => s.id === "side")?.origin,
      { kind: "side", parentSessionId: "source" },
    );

    await deleteSession("review");
    sessions = await getSessions();
    assert.equal(
      sessions.some((s) => s.id === "source"),
      true,
    );
    assert.equal(
      sessions.some((s) => s.id === "review"),
      false,
    );
    await deleteSession("side");
    assert.deepEqual(
      (await getSessions()).map((session) => session.id),
      ["source"],
    );
  } finally {
    await cleanup();
  }
});

test("a side boundary arriving after the fork refreshes cached origins before listing", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("new-session-origin");
  try {
    await writeSessionFile(sessionsDir, "source.jsonl", [
      sessionMetaLine("source", "/project", Date.now()),
    ]);
    initStorage(rootDir);
    await loadStorage();
    assert.equal((await getSessions()).length, 1);
    const meta = JSON.parse(sessionMetaLine("child", "/project", Date.now()));
    meta.payload.forked_from_id = "source";
    const path = await writeSessionFile(sessionsDir, "child.jsonl", [
      JSON.stringify(meta),
    ]);
    await syncSessionFileIndex("child", path);
    assert.equal(
      (await getSessions()).find((session) => session.id === "child")?.origin,
      undefined,
    );
    await appendFile(
      path,
      responseItemMessageLine("user", SIDE_CONVERSATION_BOUNDARY_PROMPT) + "\n",
    );
    const update = syncSessionFileIndex("child", path);
    const listing = getSessions();
    await update;
    assert.deepEqual(
      (await listing).find((session) => session.id === "child")?.origin,
      {
        kind: "side",
        parentSessionId: "source",
      },
    );
    await assert.rejects(
      access(join(rootDir, "codex-deck", "session-origins")),
      { code: "ENOENT" },
    );
  } finally {
    await cleanup();
  }
});

test("side detection requires a fork's own boundary and excludes ordinary or inherited messages", () => {
  const boundary = responseItemMessageLine(
    "user",
    SIDE_CONVERSATION_BOUNDARY_PROMPT,
  );
  const metadata = { id: "child", forked_from_id: "parent" };
  assert.deepEqual(getSessionOrigin(metadata, [boundary]), {
    kind: "side",
    parentSessionId: "parent",
  });
  assert.deepEqual(
    getSessionOrigin({ id: "child", history_base: { thread_id: "parent" } }, [
      boundary,
    ]),
    { kind: "side", parentSessionId: "parent" },
  );
  assert.equal(getSessionOrigin({ id: "child" }, [boundary]), undefined);
  assert.equal(
    getSessionOrigin({ id: "child", forked_from_id: "child" }, [boundary]),
    undefined,
  );
  assert.equal(
    getSessionOrigin(metadata, [
      responseItemMessageLine("assistant", SIDE_CONVERSATION_BOUNDARY_PROMPT),
    ]),
    undefined,
  );
  assert.equal(
    getSessionOrigin({ ...metadata, forked_from_ordinal_exclusive: 10 }, [
      JSON.stringify({ ...JSON.parse(boundary), ordinal: 5 }),
      responseItemMessageLine("user", "An ordinary fork's own question"),
    ]),
    undefined,
  );
});
