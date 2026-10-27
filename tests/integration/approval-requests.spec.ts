import type { BrowserContext } from "@playwright/test";
import type {
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
} from "../../api/storage";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
} from "../unit/test-utils";
import {
  test,
  expect,
  type IntegrationAppFixture,
} from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

function approval(
  app: IntegrationAppFixture,
  overrides: Partial<CodexApprovalRequest> = {},
): CodexApprovalRequest {
  return {
    requestId: "approval-1",
    threadId: app.sessions.alpha,
    turnId: "approval-turn",
    itemId: "approval-call",
    kind: "commandExecution",
    reason: "Allow this operation to continue the task.",
    command: "echo approval-test",
    cwd: app.projects.alpha,
    permissions: null,
    availableDecisions: [
      { id: "accept", label: "Allow once", description: "Approve once." },
      { id: "decline", label: "Deny", description: "Reject this request." },
    ],
    ...overrides,
  };
}

async function mockApprovals(
  context: BrowserContext,
  app: IntegrationAppFixture,
  requests: CodexApprovalRequest[],
) {
  const state = {
    requests,
    submissions: [] as {
      requestId: string;
      response: CodexApprovalResponsePayload;
    }[],
    failNext: false,
    holdResponse: undefined as Promise<void> | undefined,
  };
  const path = `**/api/codex/threads/${app.sessions.alpha}/requests/approvals`;
  await context.route(path, (route) =>
    route.fulfill({ json: { requests: state.requests } }),
  );
  await context.route(`${path}/*/respond`, async (route) => {
    const requestId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    state.submissions.push({
      requestId,
      response: route.request().postDataJSON(),
    });
    if (state.failNext) {
      state.failNext = false;
      await route.fulfill({
        status: 500,
        json: { error: "Temporary approval failure" },
      });
      return;
    }
    await state.holdResponse;
    state.requests = state.requests.filter((r) => r.requestId !== requestId);
    await route.fulfill({ json: { ok: true } });
  });
  return state;
}

for (const tool of [
  "exec_command",
  "exec",
  "apply_patch",
  "request_permissions",
  null,
] as const) {
  test(`approval remains actionable for ${tool ?? "a missing tool block"}`, async ({
    page,
    context,
    app,
  }) => {
    const lines = [
      eventMsgLine({ type: "task_started", turn_id: "approval-turn" }),
      responseItemMessageLine("assistant", "Waiting for approval."),
    ];
    if (tool) {
      lines.push(
        responseItemRawLine(
          tool === "exec"
            ? {
                type: "custom_tool_call",
                call_id: "outer-exec-call",
                name: tool,
                input:
                  'const results = await Promise.allSettled([tools.exec_command({cmd: "echo approval-test"}), tools.exec_command({cmd: "pwd"})]); text(results);',
              }
            : {
                type: "function_call",
                call_id: "approval-call",
                name: tool,
                arguments: JSON.stringify({ cmd: "echo approval-test" }),
              },
        ),
      );
    }
    await appendFile(
      join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
      lines.join("\n") + "\n",
    );
    const request = approval(app, {
      kind:
        tool === "apply_patch"
          ? "fileChange"
          : tool === "request_permissions"
            ? "permissions"
            : "commandExecution",
      ...(tool === "request_permissions"
        ? { permissions: { network: { enabled: true }, fileSystem: null } }
        : {}),
    });
    const state = await mockApprovals(context, app, [request]);
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    const panel = page.getByRole("region", { name: "Pending approvals" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(request.reason!);
    const label =
      request.kind === "permissions" ? "Allow (turn)" : "Allow once";
    // The standard command must also have exactly one set of controls.
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveCount(1);
    if (tool === "apply_patch" || tool === "request_permissions") {
      // Neither changing text/block mode nor expanding the tool is required.
      await expect(
        page.getByRole("button", { name: "Text Mode", exact: true }),
      ).toBeVisible();
    }
    await panel.getByRole("button", { name: label, exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(state.submissions).toEqual([
      {
        requestId: request.requestId,
        response:
          request.kind === "permissions"
            ? { grant: "allow", scope: "turn" }
            : { decisionId: "accept" },
      },
    ]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`failed approvals can be retried on mobile in ${theme} mode`, async ({
    page,
    context,
    app,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await context.addInitScript(
      (value) => localStorage.setItem("codex-deck:theme:v1", value),
      theme,
    );
    const state = await mockApprovals(context, app, [
      approval(app, { command: `echo ${"long-command-".repeat(40)}` }),
    ]);
    state.failNext = true;
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    await page.getByRole("button", { name: "Collapse left pane" }).click();
    const panel = page.getByRole("region", { name: "Pending approvals" });
    const allow = panel.getByRole("button", {
      name: "Allow once",
      exact: true,
    });
    await allow.click();
    await expect(panel.getByRole("alert")).toContainText(
      "Temporary approval failure",
    );
    await expect(allow).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`approval-${theme}.png`),
    });
    await allow.click();
    await expect(panel).toHaveCount(0);
    expect(state.submissions).toHaveLength(2);
  });
}

test("approval callbacks for one item remain separate and permission decisions keep their scope", async ({
  page,
  context,
  app,
}) => {
  const state = await mockApprovals(context, app, [
    approval(app),
    approval(app, {
      requestId: "approval-2",
      kind: "permissions",
      permissions: { network: { enabled: true }, fileSystem: null },
    }),
  ]);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const panel = page.getByRole("region", { name: "Pending approvals" });
  await expect(panel.locator("[data-pending-approval-request]")).toHaveCount(2);
  await panel
    .getByRole("button", { name: "Allow (session)", exact: true })
    .click();
  await expect(panel.locator("[data-pending-approval-request]")).toHaveCount(1);
  await panel.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(state.submissions).toEqual([
    { requestId: "approval-2", response: { grant: "allow", scope: "session" } },
    { requestId: "approval-1", response: { decisionId: "decline" } },
  ]);
});

test("approval responses are submitted once and all open pages catch up", async ({
  page,
  context,
  app,
}) => {
  const state = await mockApprovals(context, app, [approval(app)]);
  let release!: () => void;
  state.holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  const second = await context.newPage();
  try {
    for (const current of [page, second]) {
      const ui = new CodexDeckPage(current);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      await expect(
        current.getByRole("region", { name: "Pending approvals" }),
      ).toBeVisible();
    }
    await page.bringToFront();
    const panel = page.getByRole("region", { name: "Pending approvals" });
    await panel
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Allow once", exact: true }),
    ).toBeDisabled();
    await expect.poll(() => state.submissions.length).toBe(1);
    release();
    await expect(panel).toHaveCount(0);
    await second.bringToFront();
    await expect(
      second.getByRole("region", { name: "Pending approvals" }),
    ).toHaveCount(0);
    expect(state.submissions).toHaveLength(1);
  } finally {
    release();
    await second.close();
  }
});

test("a late approval poll cannot put another session's request in the panel", async ({
  page,
  context,
  app,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await context.route(
    `**/api/codex/threads/${app.sessions.alpha}/requests/approvals`,
    async (route) => {
      started = true;
      await hold;
      await route.fulfill({ json: { requests: [approval(app)] } });
    },
  );
  await context.route(
    `**/api/codex/threads/${app.sessions.beta}/requests/approvals`,
    (route) => route.fulfill({ json: { requests: [] } }),
  );
  const ui = new CodexDeckPage(page);
  try {
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    await expect.poll(() => started).toBe(true);
    const betaPoll = page.waitForResponse((response) =>
      response
        .url()
        .endsWith(`/threads/${app.sessions.beta}/requests/approvals`),
    );
    await ui.selectSession("Summarize the beta release notes");
    await betaPoll;
    const alphaPoll = page.waitForResponse((response) =>
      response
        .url()
        .endsWith(`/threads/${app.sessions.alpha}/requests/approvals`),
    );
    release();
    await alphaPoll;
    await expect(
      page.getByRole("region", { name: "Pending approvals" }),
    ).toHaveCount(0);
    await ui.selectSession("Review the launch checklist");
    await expect(
      page.getByRole("region", { name: "Pending approvals" }),
    ).toBeVisible();
  } finally {
    release();
  }
});
