import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  changeThreadWorkingDirectory,
  resolveRequestedWorkingDirectory,
} from "../../api/codex-working-directory";
import { registerWorkspaceRoutes } from "../../api/server/workspace-routes";
import type { CodexThreadSummary } from "../../api/storage";

function summary(
  threadId: string,
  cwd: string,
  status: CodexThreadSummary["status"] = "idle",
): CodexThreadSummary {
  return {
    threadId,
    name: null,
    preview: "",
    cwd,
    agentNickname: null,
    agentRole: null,
    parentThreadId: null,
    canAcceptDirectInput: null,
    agentPath: null,
    source: null,
    status,
    updatedAt: null,
  };
}

test("working directory resolution expands ~ and resolves relative paths against the current cwd", () => {
  assert.equal(
    resolveRequestedWorkingDirectory("", "/a", "/home/u"),
    "/home/u",
  );
  assert.equal(
    resolveRequestedWorkingDirectory("~", "/a", "/home/u"),
    "/home/u",
  );
  assert.equal(
    resolveRequestedWorkingDirectory("~/src", "/a", "/home/u"),
    "/home/u/src",
  );
  assert.equal(
    resolveRequestedWorkingDirectory("../b", "/a/c", "/home/u"),
    "/a/b",
  );
  assert.equal(resolveRequestedWorkingDirectory("/x/./y", "", "/h"), "/x/y");
  assert.throws(() => resolveRequestedWorkingDirectory("rel", "", "/h"));
});

test("/cd forks the conversation into an existing directory and rejects bad targets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deck-cd-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "child"));
  await writeFile(join(root, "file.txt"), "x");
  const forks: unknown[] = [];
  const archived: string[] = [];
  let status: CodexThreadSummary["status"] = "idle";
  const deps = {
    getThreadSummary: async (id: string) => summary(id, root, status),
    forkThread: async (id: string, options?: { cwd?: string }) => {
      forks.push({ id, options });
      return summary("forked", options?.cwd ?? root);
    },
    archiveThread: async (id: string) => {
      archived.push(id);
    },
  };

  const result = await changeThreadWorkingDirectory(deps, "source", "child");
  assert.equal(result.cwd, join(root, "child"));
  assert.equal(result.thread.threadId, "forked");
  assert.deepEqual(forks, [
    { id: "source", options: { cwd: join(root, "child") } },
  ]);

  await assert.rejects(
    changeThreadWorkingDirectory(deps, "source", "file.txt"),
    /Not a directory/,
  );
  await assert.rejects(
    changeThreadWorkingDirectory(deps, "source", "missing"),
    /Cannot access directory/,
  );
  status = "active";
  await assert.rejects(
    changeThreadWorkingDirectory(deps, "source", "child"),
    /a task is running/,
  );
  status = "idle";
  await assert.rejects(
    changeThreadWorkingDirectory(
      { ...deps, hasBackgroundTerminals: async () => true },
      "source",
      "child",
    ),
    /background terminals block/,
  );
  await assert.rejects(
    changeThreadWorkingDirectory(
      { ...deps, forkThread: async () => summary("wrong", root) },
      "source",
      "child",
    ),
    /not applied/,
  );
  assert.deepEqual(archived, ["wrong"]);
});

test("working-directory route validates input and maps user errors to 4xx", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deck-cd-route-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = new Hono();
  registerWorkspaceRoutes(app, {
    getClient: () => ({
      getThreadSummary: async (id: string) => summary(id, root),
      forkThread: async (_id: string, options?: { cwd?: string }) =>
        summary("forked", options?.cwd ?? ""),
    }),
  });
  const post = (body: unknown) =>
    app.request("/api/codex/threads/t1/working-directory", {
      method: "POST",
      body: JSON.stringify(body),
    });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ path: "missing" })).status, 400);
  const ok = await post({ path: "." });
  assert.equal(ok.status, 200);
  const payload = (await ok.json()) as {
    cwd: string;
    previousThreadId: string;
  };
  assert.equal(payload.cwd, root);
  assert.equal(payload.previousThreadId, "t1");
});
