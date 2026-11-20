import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  resolveWorktreeRoot,
  WorktreeManager,
  WorktreeService,
} from "../../api/codex-worktrees";
import { registerWorkspaceRoutes } from "../../api/server/workspace-routes";
import type { CodexThreadSummary } from "../../api/storage";

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    { cwd, stdio: "ignore" },
  );
}

async function repository(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "deck-wt-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "project");
  await mkdir(join(repo, "pkg"), { recursive: true });
  await writeFile(join(repo, "pkg", "file.txt"), "hello\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { base, repo, pool: join(base, "codex-home", "worktrees") };
}

function summary(
  threadId: string,
  cwd: string,
  status: CodexThreadSummary["status"] = "idle",
): CodexThreadSummary {
  return {
    threadId,
    name: threadId === "owner" ? "Owner thread" : null,
    preview: "",
    cwd,
    agentNickname: null,
    agentRole: null,
    parentThreadId: null,
    canAcceptDirectInput: null,
    agentPath: null,
    source: null,
    status,
    updatedAt: 1,
  };
}

test("worktree root follows desktop.git-worktree-root", () => {
  assert.equal(resolveWorktreeRoot("/h", null), "/h/worktrees");
  assert.equal(
    resolveWorktreeRoot("/h", { "git-worktree-root": " " }),
    "/h/worktrees",
  );
  assert.equal(
    resolveWorktreeRoot("/h", { "git-worktree-root": "/pool" }),
    "/pool",
  );
  assert.throws(() =>
    resolveWorktreeRoot("/h", { "git-worktree-root": "rel" }),
  );
});

test("managed worktrees are created, listed with owners, and removed", async (t) => {
  const { repo, pool } = await repository(t);
  const manager = new WorktreeManager(pool);
  const checkout = await manager.create(join(repo, "pkg"));
  assert.match(checkout.root, /worktrees\/[0-9a-f]{4}\/project$/);
  assert.equal(checkout.cwd, join(checkout.root, "pkg"));
  assert.equal(
    await readFile(join(checkout.cwd, "file.txt"), "utf8"),
    "hello\n",
  );
  const listed = await manager.list(repo);
  assert.deepEqual(
    listed.map((entry) => entry.root),
    [checkout.root],
  );
  assert.equal(listed[0].cwd, checkout.root);
  assert.equal(await manager.owner(checkout.root), null);
  await manager.bindThread(checkout.root, "thread-1");
  await manager.bindThread(checkout.root, "thread-1");
  await assert.rejects(
    manager.bindThread(checkout.root, "thread-2"),
    /already belongs/,
  );
  assert.equal(await manager.owner(checkout.root), "thread-1");
  await assert.rejects(
    manager.remove(checkout.cwd, checkout.root),
    /switch to another checkout/,
  );
  await manager.remove(repo, checkout.root);
  assert.equal(existsSync(checkout.root), false);
  assert.deepEqual(await manager.list(repo), []);
});

test("worktree service forks into a new checkout and binds ownership", async (t) => {
  const { base, repo } = await repository(t);
  const forks: unknown[] = [];
  let notified = 0;
  const service = new WorktreeService({
    codexHome: () => join(base, "codex-home"),
    readDesktopConfig: async () => null,
    getThreadSummary: async (id) =>
      id === "busy" ? summary(id, repo, "active") : summary(id, repo),
    forkThread: async (id, options) => {
      forks.push([id, options]);
      return summary("forked", options?.cwd ?? "");
    },
    createThread: async (cwd) => summary("fresh", cwd),
    notify: () => {
      notified++;
    },
  });
  await assert.rejects(service.start("busy", "fork"), /idle primary session/);
  const result = await service.start("source", "fork");
  assert.equal(result.thread.threadId, "forked");
  assert.deepEqual(forks, [["source", { cwd: result.checkout.cwd }]]);
  const fresh = await service.start("source", "new");
  assert.equal(fresh.thread.threadId, "fresh");
  assert.ok(notified >= 2);

  const listing = await service.list("source");
  assert.equal(listing.entries.length, 2);
  const owners = listing.entries.map((entry) => entry.ownerThreadId).sort();
  assert.deepEqual(owners, ["forked", "fresh"]);
  assert.ok(
    listing.entries.every((entry) => entry.owner.status === "resumable"),
  );
  const removed = await service.remove("source", result.checkout.root);
  assert.match(removed.message, /Thread history was kept/);
});

test("worktree routes validate the requested mode", async () => {
  const app = new Hono();
  registerWorkspaceRoutes(app, { getClient: () => ({}) });
  const response = await app.request("/api/codex/threads/t/worktrees", {
    method: "POST",
    body: JSON.stringify({ mode: "elsewhere" }),
  });
  assert.equal(response.status, 400);
});
