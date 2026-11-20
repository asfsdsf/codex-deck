import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  buildPermissionOptions,
  PermissionManager,
  parsePermissionSettings,
} from "../../api/codex-permissions";
import { registerWorkspaceRoutes } from "../../api/server/workspace-routes";
import { parsePermissionArgs } from "../../web/permission-args";

const builtins = [
  { id: ":read-only", description: null, allowed: true },
  { id: ":workspace", description: null, allowed: true },
  { id: ":danger-full-access", description: null, allowed: true },
];

function resume(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: [],
    },
    activePermissionProfile: { id: ":workspace", extends: null },
    ...overrides,
  };
}

test("permission options mirror the upstream picker, current markers, and requirement gates", () => {
  const settings = parsePermissionSettings("t", resume());
  const options = buildPermissionOptions(
    settings,
    [...builtins, { id: "locked", description: "Team", allowed: false }],
    {
      allowedApprovalPolicies: ["on-request", "untrusted"],
      allowedApprovalsReviewers: null,
      allowedSandboxModes: null,
      allowedPermissionProfiles: null,
    },
    true,
  );
  assert.deepEqual(
    options.map((option) => option.label),
    [
      "Ask for approval",
      "Approve for me",
      "Full Access",
      "Read Only",
      "locked",
    ],
  );
  assert.equal(options[0].isCurrent, true);
  assert.equal(options[1].isCurrent, false);
  assert.equal(options[2].requiresConfirmation, true);
  assert.equal(options[2].disabledReason, "Disabled by requirements");
  assert.equal(options[4].disabledReason, "Disabled by requirements");
  assert.equal(options[4].description, "Team");
  assert.deepEqual(buildPermissionOptions(settings, [], null, true), []);

  const unknown = buildPermissionOptions(
    parsePermissionSettings(
      "t",
      resume({ activePermissionProfile: { id: "gone", extends: null } }),
    ),
    builtins,
    null,
    false,
  );
  assert.equal(unknown.at(-1)?.disabledReason, "Not available on this server");
  assert.equal(unknown.at(-1)?.isCurrent, true);
  assert.equal(
    unknown.some((option) => option.label === "Approve for me"),
    false,
  );
});

test("permission manager applies selections via thread/settings/update and broadcasts updates", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let current = resume();
  const notified: string[] = [];
  const manager = new PermissionManager(
    async (method, params) => {
      calls.push([method, params]);
      if (method === "thread/resume") return current;
      if (method === "configRequirements/read") return { requirements: null };
      if (method === "config/read") return { config: { features: {} } };
      if (method === "permissionProfile/list")
        return { data: builtins, nextCursor: null };
      if (method === "thread/settings/update") {
        current = resume({
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: params.approvalsReviewer,
          activePermissionProfile: { id: params.permissions, extends: null },
        });
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
    (id) => notified.push(id),
  );
  const snapshot = await manager.apply("t", { profileId: ":approve-for-me" });
  const update = calls.find(([method]) => method === "thread/settings/update");
  assert.deepEqual(update?.[1], {
    threadId: "t",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  assert.equal(
    snapshot.options.find((option) => option.isCurrent)?.label,
    "Approve for me",
  );
  assert.deepEqual(notified, ["t"]);
  await assert.rejects(
    manager.apply("t", { profileId: "missing" }),
    /Unknown permission profile/,
  );

  manager.handleNotification("thread/settings/updated", {
    threadId: "t",
    threadSettings: { ...current, approvalPolicy: "never" },
  });
  assert.deepEqual(notified, ["t", "t"]);
});

test("permission discovery reports unsupported servers with upstream wording", async () => {
  const manager = new PermissionManager(
    async (method) => {
      if (method === "thread/resume") return resume();
      const error = Object.assign(new Error("Method not found"), {
        code: -32601,
      });
      throw error;
    },
    () => {},
  );
  await assert.rejects(
    manager.read("t"),
    /does not support permission discovery/,
  );
});

test("/permissions inline args and route validation", async () => {
  assert.deepEqual(
    parsePermissionArgs(":workspace --approval-policy=never --reviewer user"),
    {
      profileId: ":workspace",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    },
  );
  assert.throws(() => parsePermissionArgs(""), /Usage: \/permissions/);
  assert.throws(() => parsePermissionArgs("a b"), /Unexpected/);
  assert.throws(
    () => parsePermissionArgs("a --reviewer=robot"),
    /Unknown permission reviewer/,
  );

  const app = new Hono();
  const applied: unknown[] = [];
  registerWorkspaceRoutes(app, {
    getClient: () => ({
      applyPermissions: async (id, selection) => {
        applied.push([id, selection]);
        return {} as never;
      },
    }),
  });
  const post = (body: unknown) =>
    app.request("/api/codex/threads/t/permissions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  assert.equal((await post({})).status, 400);
  assert.equal(
    (await post({ profileId: ":workspace", approvalPolicy: "sometimes" }))
      .status,
    400,
  );
  assert.equal(
    (await post({ profileId: ":workspace", approvalsReviewer: "auto_review" }))
      .status,
    200,
  );
  assert.deepEqual(applied, [
    [
      "t",
      {
        profileId: ":workspace",
        approvalPolicy: null,
        approvalsReviewer: "auto_review",
      },
    ],
  ]);
});
