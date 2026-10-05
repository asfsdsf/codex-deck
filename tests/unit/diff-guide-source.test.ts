import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { DiffGuideStore } from "../../api/diff-guide-store";
import {
  readDiffGuideSource,
  reconstructDiffGuideSource,
} from "../../api/diff-guide-source";
import { registerDiffGuideRoutes } from "../../api/server/diff-guide-routes";
import { initStorage } from "../../api/storage";
import { createDiffGuideSourceBridge } from "../../web/diff-guide-source";
import { setImmediate } from "node:timers/promises";

const run = promisify(execFile);
async function fixture(
  action: (context: {
    root: string;
    repo: string;
    snapshot: any;
    path: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "deck-source-"));
  try {
    await run("python3", [
      join(process.cwd(), "skills/codex-deck-diff/tests/create_fixture.py"),
      "--output",
      root,
      "--omit-source",
    ]);
    const path = join(root, "snapshot.json");
    await action({
      root,
      repo: join(root, "repo"),
      path,
      snapshot: JSON.parse(await readFile(path, "utf8")),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const source = (
  repo: string,
  snapshot: unknown,
  path: string,
  side: "left" | "right" = "right",
  start = 1,
  limit = 1000,
) => readDiffGuideSource(repo, snapshot, { path, side, start, limit });

test("Git source reconstructs captured code, renames, deletions and unchanged definitions after working-tree edits", async () => {
  await fixture(async ({ repo, snapshot }) => {
    assert.equal(snapshot.sourceMode, "project");
    assert.equal(snapshot.blobs, undefined);
    await writeFile(join(repo, "main.py"), "later edits\n");
    await writeFile(join(repo, "helper.py"), "later definition\n");
    const current = await source(repo, snapshot, "main.py");
    assert.equal(current.lines[9], "limit = 10");
    assert.equal(current.lines[65], "result = Token()");
    assert.equal(current.totalLines, 140);
    const before = await source(repo, snapshot, "main.py", "left");
    assert.equal(before.lines[9], "value_10 = 10");
    assert.deepEqual((await source(repo, snapshot, "new-name.txt")).lines, [
      "Renamed contents",
    ]);
    assert.deepEqual(
      (await source(repo, snapshot, "removed.txt", "left")).lines,
      ["Old response"],
    );
    assert.deepEqual(
      (await source(repo, snapshot, "helper.py", "right", 4, 2)).lines,
      ["class Token(Base):", "    pass"],
    );
    const page = await source(repo, snapshot, "main.py", "right", 8, 3);
    assert.equal(page.lineStart, 8);
    assert.equal(page.nextLine, 11);
    assert.equal(page.lines.length, 3);
    await assert.rejects(
      source(repo, snapshot, "removed.txt"),
      /not in the captured comparison/,
    );
    await assert.rejects(
      source(repo, snapshot, "main.py", "right", 141),
      /out of bounds/,
    );
  });
});

test("source validates fingerprints, paths, repository identity and missing pinned commits", async () => {
  await fixture(async ({ root, repo, snapshot, path }) => {
    for (const bad of ["../secret", ".git/config", "/absolute", "a//b", "a\0b"])
      await assert.rejects(source(repo, snapshot, bad), /Invalid source/);
    await assert.rejects(
      source(repo, { ...snapshot, schemaVersion: 2 }, "main.py"),
      /Regenerate/,
    );
    const bad = structuredClone(snapshot);
    bad.files["main.py"].rows.find((row: any) => row.kind === "add").text =
      "tampered";
    await assert.rejects(source(repo, bad, "main.py"), /fingerprint/);
    const other = join(root, "other");
    await run("git", ["init", "--quiet", other]);
    await assert.rejects(source(other, snapshot, "main.py"), /does not match/);
    await run("python3", [
      "-c",
      "import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from git_snapshot import digest; p=Path(sys.argv[2]); s=json.loads(p.read_text()); s['comparison']['base']='0'*40; s['comparison']['fingerprint']=digest(s); p.write_text(json.dumps(s))",
      join(process.cwd(), "skills/codex-deck-diff/scripts"),
      path,
    ]);
    const missing = JSON.parse(await readFile(path, "utf8"));
    await assert.rejects(
      source(repo, missing, "main.py"),
      /Baseline commit.*unavailable/,
    );
  });
});

test("Unicode source, BOM, final newline, empty baselines and response byte bounds are preserved", async () => {
  await fixture(async ({ root, repo }) => {
    await writeFile(
      join(repo, "中文😀.txt"),
      "\ufeffcaptured 中文 😀\r\nlast line",
    );
    await writeFile(join(repo, "\u007f.txt"), "ASCII escape\n");
    await writeFile(join(repo, "large-line.txt"), "a".repeat(1024 * 1024 + 1));
    const path = join(root, "new-snapshot.json");
    await run("python3", [
      join(process.cwd(), "skills/codex-deck-diff/scripts/capture_diff.py"),
      "--repo",
      repo,
      "--output",
      path,
      "--omit-source",
    ]);
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual((await source(repo, snapshot, "中文😀.txt")).lines, [
      "\ufeffcaptured 中文 😀\r",
      "last line",
    ]);
    assert.deepEqual((await source(repo, snapshot, "\u007f.txt")).lines, [
      "ASCII escape",
    ]);
    await assert.rejects(source(repo, snapshot, "large-line.txt"), /1 MiB/);
    const corrupted = snapshot.files["main.py"];
    assert.throws(
      () =>
        reconstructDiffGuideSource(
          { ...corrupted, lineCount: 999 },
          Buffer.from("wrong\n"),
        ),
      /baseline|range|numbering|reconstruction/,
    );
    const empty = join(root, "empty");
    await run("git", ["init", "--quiet", empty]);
    await writeFile(join(empty, "new.txt"), "before first commit");
    await run("python3", [
      join(process.cwd(), "skills/codex-deck-diff/scripts/capture_diff.py"),
      "--repo",
      empty,
      "--output",
      path,
      "--overwrite",
      "--omit-source",
    ]);
    assert.deepEqual(
      (await source(empty, JSON.parse(await readFile(path, "utf8")), "new.txt"))
        .lines,
      ["before first commit"],
    );
  });
});

test("source route scopes reads to the persisted guide and validates pagination", async () => {
  await fixture(async ({ root, repo, path }) => {
    initStorage(root);
    const store = new DiffGuideStore(root);
    await store.write({
      sessionId: "source-guide",
      parentSessionId: "origin",
      requestId: "request",
      projectRoot: repo,
      prompt: "",
      thread: { threadId: "source-guide", cwd: repo, name: null },
      turnId: null,
      status: "generating",
      error: null,
    });
    await copyFile(
      path,
      join(store.directory("source-guide"), "snapshot.json"),
    );
    const app = new Hono();
    registerDiffGuideRoutes(app);
    const response = await app.request(
      "/api/diff-guides/source-guide/source?path=main.py&side=right&start=10&limit=1",
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).lines, ["limit = 10"]);
    for (const query of [
      "side=other",
      "start=0",
      "limit=1001",
      "start=1.5",
      "path=../secret",
    ]) {
      const params = new URLSearchParams({ path: "main.py" });
      for (const [key, value] of new URLSearchParams(query))
        params.set(key, value);
      assert.equal(
        (await app.request(`/api/diff-guides/source-guide/source?${params}`))
          .status,
        400,
      );
    }
    assert.equal(
      (await app.request("/api/diff-guides/missing/source?path=main.py"))
        .status,
      404,
    );
  });
});

test("iframe source bridge validates requests and ignores late responses after dispose", async () => {
  const responses: unknown[] = [];
  const frame = {
    postMessage: (value: unknown) => responses.push(value),
  } as unknown as Window;
  let finish!: (value: any) => void;
  let calls = 0;
  const bridge = createDiffGuideSourceBridge({
    getFrameWindow: () => frame,
    token: "token",
    load: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const message = (
    overrides: Record<string, unknown> = {},
    origin: unknown = frame,
  ) =>
    bridge.onMessage({
      source: origin,
      data: {
        type: "codex-deck:diff-guide:source",
        token: "token",
        requestId: "one",
        path: "main.py",
        side: "right",
        start: 1,
        limit: 200,
        ...overrides,
      },
    } as MessageEvent);
  message({ token: "stale" });
  message({}, {});
  message({ limit: 1001 });
  assert.equal(responses.length, 1);
  message();
  message();
  await setImmediate();
  assert.equal(calls, 1);
  bridge.dispose();
  finish({ path: "main.py", side: "right", lines: ["captured"] });
  await setImmediate();
  assert.equal(responses.length, 1);
});
