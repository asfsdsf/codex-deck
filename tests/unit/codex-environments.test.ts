import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import {
  EnvironmentService,
  environmentCwdFromUri,
  parseThreadEnvironments,
} from "../../api/codex-environments";
import { registerOrganizationRoutes } from "../../api/server/organization-routes";
import { parseSkillList } from "../../web/components/codex-environments";
import { getOrganizationDialogForCommand } from "../../web/components/organization-dialog";

test("environment cwd URIs and thread selections are parsed defensively", () => {
  assert.equal(
    environmentCwdFromUri("file:///Users/me/a%20b"),
    "/Users/me/a b",
  );
  assert.equal(environmentCwdFromUri("file:///C:/work"), "C:/work");
  assert.equal(environmentCwdFromUri(null), null);
  assert.deepEqual(
    parseThreadEnvironments([
      { environmentId: "remote", cwd: "/w", runtimeWorkspaceRoots: ["/w", 1] },
      { environmentId: 3 },
    ]),
    [{ environmentId: "remote", cwd: "/w", runtimeWorkspaceRoots: ["/w"] }],
  );
  assert.equal(parseThreadEnvironments(null), null);
  assert.deepEqual(parseSkillList("a, b\nb,,"), ["a", "b"]);
});

test("environment snapshots read status, info only when ready, and thread selections", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const service = new EnvironmentService(
    async (method, params) => {
      calls.push([method, params]);
      if (method === "environment/add") return {};
      if (method === "environment/status")
        return params.environmentId === "local"
          ? { status: "ready" }
          : { status: "disconnected", error: "socket closed" };
      if (method === "environment/info")
        return {
          shell: { name: "zsh", path: "/bin/zsh" },
          cwd: "file:///home/me",
        };
      if (method === "thread/read")
        return {
          thread: { environments: [{ environmentId: "local", cwd: "/x" }] },
        };
      throw new Error(`unexpected ${method}`);
    },
    () => undefined,
  );
  const registration = await service.add({
    environmentId: "remote-a",
    execServerUrl: "wss://exec.example",
    authBearerToken: "secret",
    requiredSkills: ["deploy"],
  });
  assert.equal(registration.hasAuthToken, true);
  assert.equal(JSON.stringify(registration).includes("secret"), false);
  assert.deepEqual(calls[0][1], {
    environmentId: "remote-a",
    execServerUrl: "wss://exec.example",
    authBearerToken: "secret",
    skills: { required: ["deploy"] },
  });
  const snapshot = await service.snapshot("thread-1");
  assert.equal(snapshot.available, true);
  const [local, remote] = snapshot.environments;
  assert.equal(local.builtIn, true);
  assert.equal(local.cwd, "/home/me");
  assert.equal(remote.status, "disconnected");
  assert.equal(remote.statusError, "socket closed");
  assert.equal(
    calls.filter(
      ([method, params]) =>
        method === "environment/info" && params.environmentId === "remote-a",
    ).length,
    0,
    "info is not read for disconnected environments",
  );
  assert.deepEqual(snapshot.thread?.environments, [
    { environmentId: "local", cwd: "/x" },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);

  const legacy = new EnvironmentService(
    async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    },
    () => undefined,
  );
  assert.equal((await legacy.snapshot()).available, false);
});

test("pending environment selections apply to the next accepted turn only", () => {
  const notified: (string | null)[] = [];
  const service = new EnvironmentService(
    async () => ({}),
    (id) => notified.push(id),
  );
  const selection = [{ environmentId: "remote-a", cwd: "/srv" }];
  service.setPendingSelection("t1", selection);
  const params: Record<string, unknown> = {};
  service.applyPendingSelection("t2", params);
  assert.equal(params.environments, undefined);
  service.applyPendingSelection("t1", params);
  assert.deepEqual(params.environments, selection);
  const explicit = { environments: [] as unknown[] };
  service.applyPendingSelection("t1", explicit);
  assert.deepEqual(explicit.environments, [], "explicit turn values win");
  service.confirmSelection("t1", explicit);
  service.applyPendingSelection("t1", {});
  service.confirmSelection("t1", params);
  const after: Record<string, unknown> = {};
  service.applyPendingSelection("t1", after);
  assert.equal(after.environments, undefined);
  assert.deepEqual(notified, ["t1", "t1"]);
});

test("environment connection notifications are retained per thread and broadcast", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const events: Record<string, unknown>[] = [];
  client.subscribeAppServerEvents((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  const internal = client as unknown as {
    handleServerNotification: (method: string, params: unknown) => void;
  };
  internal.handleServerNotification("thread/environment/connected", {
    threadId: "t1",
    environmentId: "remote-a",
  });
  internal.handleServerNotification("thread/environment/disconnected", {
    threadId: "t1",
    environmentId: "remote-a",
  });
  assert.deepEqual(
    events.map((event) => [event.type, event.scope, event.threadId]),
    [
      ["native_state_changed", "environments", "t1"],
      ["native_state_changed", "environments", "t1"],
    ],
  );
  const service = new EnvironmentService(
    async (method) => {
      if (method === "environment/status") return { status: "ready" };
      if (method === "environment/info") return { shell: null, cwd: null };
      return { thread: {} };
    },
    () => undefined,
  );
  service.handleNotification("thread/environment/disconnected", {
    threadId: "t1",
    environmentId: "local",
  });
  const snapshot = await service.snapshot("t1");
  assert.equal(snapshot.thread?.events[0].connected, false);
  assert.equal((await service.snapshot("t2")).thread?.events.length, 0);
});

test("environment routes validate registrations and selections", async () => {
  const seen: unknown[] = [];
  const app = new Hono();
  registerOrganizationRoutes(app, {
    getService: () =>
      ({
        environments: {
          snapshot: async (threadId: string | null) => ({ threadId }),
          add: async (input: unknown) => {
            seen.push(["add", input]);
            return { environmentId: "e" };
          },
          setPendingSelection: (...args: unknown[]) =>
            seen.push(["select", ...args]),
        },
      }) as never,
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(
    await (await app.request("/api/codex/environments?threadId=t")).json(),
    { threadId: "t" },
  );
  const base = { environmentId: "remote-a", execServerUrl: "wss://h:1" };
  assert.equal(
    (await post("/api/codex/environments", { ...base, environmentId: "a b" }))
      .status,
    400,
  );
  assert.equal(
    (
      await post("/api/codex/environments", {
        ...base,
        execServerUrl: "https://h",
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("/api/codex/environments", { ...base, connectTimeoutMs: -1 }))
      .status,
    400,
  );
  assert.equal(
    (
      await post("/api/codex/environments", {
        ...base,
        requiredSkills: [" deploy "],
      })
    ).status,
    200,
  );
  const selection = "/api/codex/threads/t1/environment-selection";
  assert.equal(
    (await post(selection, { environmentId: "remote-a" })).status,
    400,
  );
  assert.equal(
    (await post(selection, { environmentId: "remote-a", cwd: " /srv " }))
      .status,
    200,
  );
  assert.equal((await post(selection, { environmentId: null })).status, 200);
  assert.deepEqual(seen, [
    [
      "add",
      {
        ...base,
        authBearerToken: null,
        connectTimeoutMs: null,
        requiredSkills: ["deploy"],
      },
    ],
    ["select", "t1", [{ environmentId: "remote-a", cwd: "/srv" }]],
    ["select", "t1", null],
  ]);
  assert.equal(
    getOrganizationDialogForCommand("/environments"),
    "environments",
  );
});
