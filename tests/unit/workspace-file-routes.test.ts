import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerWorkspaceFileRoutes } from "../../api/server/workspace-file-routes";

test("workspace saves compare original contents, serialize concurrent callers, and emit changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-file-save-"));
  try {
    const file = join(root, "notes.md");
    await writeFile(file, "# Before\n");
    const changes: string[] = [];
    const app = new Hono();
    registerWorkspaceFileRoutes(app, {
      resolveSessionProjectPath: async () => root,
      resolveWorkflowProjectPath: async () => root,
      workflowRouteUnavailable: () => false,
      onChanged: (path) => changes.push(path),
    });
    const save = (content: string) =>
      app.request("/api/sessions/thread/file-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "notes.md",
          content,
          expectedContent: "# Before\n",
        }),
      });
    const responses = await Promise.all([save("# One\n"), save("# Two\n")]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal(changes.length, 1);
    assert.match(await readFile(file, "utf8"), /^# (One|Two)\n$/);
    const conflict = await save("# Three\n");
    assert.equal(conflict.status, 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace editor rejects symlink escapes, git metadata, binary files and unavailable remote workflow scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-file-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "deck-file-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "private");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    const app = new Hono();
    registerWorkspaceFileRoutes(app, {
      resolveSessionProjectPath: async () => root,
      resolveWorkflowProjectPath: async () => root,
      workflowRouteUnavailable: () => true,
      onChanged: () => assert.fail("No change should be emitted"),
    });
    const save = (path: string, scope = "sessions") =>
      app.request(`/api/${scope}/thread/file-content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          content: "changed",
          expectedContent: "private",
        }),
      });
    assert.equal((await save("link.txt")).status, 403);
    assert.equal((await save(join(outside, "secret.txt"))).status, 403);
    assert.equal((await save(".git/config")).status, 403);
    assert.equal((await save("binary.dat")).status, 400);
    assert.equal((await save("notes.md", "workflow-project")).status, 409);
    assert.equal(
      await readFile(join(outside, "secret.txt"), "utf8"),
      "private",
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("file and folder uploads create new workspace files without overwriting or following escaping links", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-file-upload-"));
  const outside = await mkdtemp(join(tmpdir(), "deck-upload-outside-"));
  try {
    await symlink(outside, join(root, "escape"));
    const events: string[] = [];
    const app = new Hono();
    registerWorkspaceFileRoutes(app, {
      resolveSessionProjectPath: async () => root,
      resolveWorkflowProjectPath: async () => root,
      workflowRouteUnavailable: () => false,
      onChanged: (path) => events.push(path),
    });
    const upload = (path: string) =>
      app.request("/api/sessions/thread/file-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          data: Buffer.from("uploaded").toString("base64"),
        }),
      });
    assert.equal((await upload("folder/note.md")).status, 200);
    assert.equal(
      await readFile(join(root, "folder", "note.md"), "utf8"),
      "uploaded",
    );
    assert.equal((await upload("folder/note.md")).status, 409);
    assert.equal((await upload("escape/outside.md")).status, 403);
    await assert.rejects(readFile(join(outside, "outside.md")), /ENOENT/);
    assert.equal((await upload("../outside.md")).status, 403);
    assert.equal((await upload(".git/config")).status, 403);
    assert.equal(events.length, 1);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
