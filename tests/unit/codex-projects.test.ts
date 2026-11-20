import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import { ProjectService, parseProject } from "../../api/codex-projects";
import { registerOrganizationRoutes } from "../../api/server/organization-routes";
import {
  getProjectMoveTarget,
  getThreadOrganizationLabel,
  getThreadsInDirectory,
  newIdempotencyKey,
  parseRootList,
} from "../../web/codex-projects-view";
import { getOrganizationDialogForCommand } from "../../web/components/organization-dialog";

const project = (id: string, position: number) => ({
  id,
  name: id.toUpperCase(),
  roots: [{ path: `/w/${id}` }],
  metadata: {},
  position,
  createdAt: 1,
  updatedAt: 1,
  recencyAt: null,
});

test("project snapshots combine projects, sections, and recent thread assignments", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const service = new ProjectService(
    async (method, params) => {
      calls.push([method, params]);
      if (method === "project/list")
        return { data: [project("b", 1), project("a", 0)], nextCursor: null };
      if (method === "threadSection/list")
        return {
          data: [{ id: "s1", name: "Pinned", appearance: null }],
          nextCursor: null,
        };
      if (method === "thread/list")
        return {
          data: [
            {
              id: "t1",
              projectId: "a",
              section: { id: "s1", name: "Pinned" },
              cwd: "/w/a",
            },
            { id: "t2", projectId: null, section: null, cwd: "/w/a" },
          ],
          nextCursor: null,
        };
      throw new Error(`unexpected ${method}`);
    },
    () => undefined,
  );
  const snapshot = await service.snapshot();
  assert.deepEqual(
    snapshot.projects.map((entry) => entry.id),
    ["a", "b"],
  );
  assert.deepEqual(snapshot.projects[0].roots, ["/w/a"]);
  assert.deepEqual(snapshot.threads.t1, {
    projectId: "a",
    sectionId: "s1",
    cwd: "/w/a",
  });
  assert.equal(
    calls.find(([method]) => method === "thread/list")?.[1].useStateDbOnly,
    true,
  );
  assert.equal(getThreadOrganizationLabel(snapshot, "t1"), "A · Pinned");
  assert.equal(getThreadOrganizationLabel(snapshot, "t2"), null);
  assert.deepEqual(getThreadsInDirectory(snapshot, "/w/a"), ["t1", "t2"]);

  const legacy = new ProjectService(
    async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    },
    () => undefined,
  );
  const unavailable = await legacy.snapshot();
  assert.equal(unavailable.available, false);
  assert.equal(getThreadOrganizationLabel(unavailable, "t1"), null);
  assert.throws(() => parseProject({ id: "x" }), /Invalid project/);
});

test("project and section mutations use upstream semantics and broadcast", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  let notified = 0;
  const service = new ProjectService(
    async (method, params) => {
      calls.push([method, params]);
      if (
        method.startsWith("project/") &&
        method !== "project/delete" &&
        method !== "project/move"
      )
        return { project: project("p", 0) };
      if (
        method === "threadSection/create" ||
        method === "threadSection/update"
      )
        return { section: { id: "s", name: String(params.name) } };
      return {};
    },
    () => {
      notified += 1;
    },
  );
  await service.createProject({
    name: "P",
    roots: ["/w/p"],
    idempotencyKey: "k",
  });
  await service.createProject({
    name: "P",
    roots: ["/w/p"],
    idempotencyKey: "k2",
    threadIds: ["t1"],
  });
  await service.updateProject("p", { name: "Renamed" });
  await service.moveProject("p", null);
  await service.deleteProject("p");
  await service.assignThread("t1", "p");
  await service.assignThread("t1", null);
  await service.createSection("Later");
  await service.renameSection("s", "Soon");
  await service.moveThreadToSection("t1", null);
  await service.deleteSection("s");
  assert.deepEqual(calls, [
    [
      "project/create",
      { name: "P", roots: [{ path: "/w/p" }], idempotencyKey: "k" },
    ],
    [
      "project/import",
      {
        name: "P",
        roots: [{ path: "/w/p" }],
        idempotencyKey: "k2",
        threads: ["t1"],
      },
    ],
    ["project/update", { projectId: "p", name: "Renamed" }],
    ["project/move", { projectId: "p", beforeProjectId: null }],
    ["project/delete", { projectId: "p" }],
    ["thread/metadata/update", { threadId: "t1", projectId: "p" }],
    ["thread/metadata/update", { threadId: "t1", projectId: "" }],
    ["threadSection/create", { name: "Later" }],
    ["threadSection/update", { sectionId: "s", name: "Soon" }],
    ["thread/section/move", { threadId: "t1", sectionId: null }],
    ["threadSection/delete", { sectionId: "s" }],
  ]);
  assert.equal(notified, 11);
});

test("project notifications from any Codex client refresh every browser", () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const events: Record<string, unknown>[] = [];
  client.subscribeAppServerEvents((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  const internal = client as unknown as {
    handleServerNotification: (method: string, params: unknown) => void;
  };
  internal.handleServerNotification("project/changed", {
    projectId: "p",
    changeType: "deleted",
  });
  internal.handleServerNotification("thread/project/updated", {
    threadId: "t1",
    projectId: null,
  });
  assert.deepEqual(
    events.map((event) => [event.type, event.scope, event.threadId]),
    [
      ["native_state_changed", "projects", null],
      ["native_state_changed", "projects", null],
    ],
  );
});

test("project view helpers order moves, parse roots, and create retry keys", () => {
  const projects = ["a", "b", "c"].map((id, index) =>
    parseProject(project(id, index)),
  );
  assert.equal(getProjectMoveTarget(projects, 0, -1), undefined);
  assert.equal(getProjectMoveTarget(projects, 1, -1), "a");
  assert.equal(getProjectMoveTarget(projects, 0, 1), "c");
  assert.equal(getProjectMoveTarget(projects, 1, 1), null);
  assert.equal(getProjectMoveTarget(projects, 2, 1), undefined);
  assert.deepEqual(parseRootList(" /a \n\n/b\n/a"), ["/a", "/b"]);
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
  assert.equal(getOrganizationDialogForCommand("/projects"), "projects");
});

test("project routes validate names, absolute roots, and identifiers", async () => {
  const seen: unknown[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      seen.push([name, ...args]);
      return name.includes("Section") ? { id: "s" } : { id: "p" };
    };
  const app = new Hono();
  registerOrganizationRoutes(app, {
    getService: () =>
      ({
        projects: {
          snapshot: async () => ({ available: true }),
          createProject: record("createProject"),
          updateProject: record("updateProject"),
          moveProject: record("moveProject"),
          deleteProject: record("deleteProject"),
          assignThread: record("assignThread"),
          moveThreadToSection: record("moveThreadToSection"),
          createSection: record("createSection"),
          renameSection: record("renameSection"),
          deleteSection: record("deleteSection"),
        },
      }) as never,
  });
  const post = (path: string, body: unknown) =>
    app.request(`/api/codex${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  assert.equal((await app.request("/api/codex/projects")).status, 200);
  const create = { name: "P", roots: ["/w/p"], idempotencyKey: "k" };
  assert.equal((await post("/projects", { ...create, name: " " })).status, 400);
  assert.equal(
    (await post("/projects", { ...create, roots: ["relative"] })).status,
    400,
  );
  assert.equal(
    (await post("/projects", { ...create, idempotencyKey: "" })).status,
    400,
  );
  assert.equal(
    (await post("/projects", { ...create, roots: ["C:\\work"] })).status,
    200,
  );
  assert.equal((await post("/projects/p/update", {})).status, 400);
  assert.equal((await post("/projects/p/update", { name: "Q" })).status, 200);
  assert.equal((await post("/projects/p/move", {})).status, 200);
  assert.equal((await post("/projects/p/delete", {})).status, 200);
  assert.equal(
    (await post("/threads/t/project", { projectId: "" })).status,
    200,
  );
  assert.equal(
    (await post("/threads/t/section", { sectionId: 5 })).status,
    400,
  );
  assert.equal(
    (await post("/threads/t/section", { sectionId: "s" })).status,
    200,
  );
  assert.equal((await post("/thread-sections", { name: "" })).status, 400);
  assert.equal((await post("/thread-sections", { name: "S" })).status, 200);
  assert.equal(
    (await post("/thread-sections/s/update", { name: "T" })).status,
    200,
  );
  assert.equal((await post("/thread-sections/s/delete", {})).status, 200);
  assert.deepEqual(seen, [
    [
      "createProject",
      { name: "P", roots: ["C:\\work"], idempotencyKey: "k", threadIds: null },
    ],
    ["updateProject", "p", { name: "Q", roots: null }],
    ["moveProject", "p", null],
    ["deleteProject", "p"],
    ["assignThread", "t", null],
    ["moveThreadToSection", "t", "s"],
    ["createSection", "S"],
    ["renameSection", "s", "T"],
    ["deleteSection", "s"],
  ]);
});
