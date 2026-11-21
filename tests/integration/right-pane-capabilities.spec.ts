import type { Page } from "@playwright/test";
import type {
  CodexHookMetadata,
  CodexSkillMetadata,
  SessionHookStateUpdate,
} from "../../api/storage";
import {
  test,
  expect,
  type IntegrationAppFixture,
} from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });

async function mockCapabilities(page: Page, app: IntegrationAppFixture) {
  const skills: CodexSkillMetadata[] = [
    {
      name: "workspace-review",
      description:
        "Review changes with the project conventions and prepare a concise report.",
      shortDescription: "Review code and prepare a report",
      interface: {
        displayName: "Workspace review",
        shortDescription: null,
        defaultPrompt: "Review the current workspace changes.",
        iconSmall: null,
        iconLarge: null,
        brandColor: null,
      },
      dependencies: {
        tools: [
          {
            type: "mcp",
            value: "repository",
            description: "Read repository changes",
            transport: null,
            command: null,
            url: null,
          },
        ],
      },
      path: `${app.projects.alpha}/.agents/skills/workspace-review/SKILL.md`,
      scope: "repo",
      enabled: true,
    },
    {
      name: "release-notes",
      description: "Write a release announcement from the commit history.",
      shortDescription: null,
      interface: null,
      dependencies: null,
      path: "/user/skills/release-notes/SKILL.md",
      scope: "user",
      enabled: false,
    },
  ];
  const hooks: CodexHookMetadata[] = [
    {
      key: "project:preToolUse:0",
      eventName: "preToolUse",
      handlerType: "command",
      matcher: "Bash",
      command: "pnpm lint --check",
      timeoutSec: 30,
      statusMessage: null,
      sourcePath: `${app.projects.alpha}/.codex/hooks.json`,
      source: "project",
      pluginId: null,
      displayOrder: 0,
      enabled: true,
      isManaged: false,
      currentHash: "review-hash",
      trustStatus: "modified",
    },
    {
      key: "managed:sessionStart:0",
      eventName: "sessionStart",
      handlerType: "command",
      matcher: null,
      command: "prepare-workspace",
      timeoutSec: 60,
      statusMessage: null,
      sourcePath: "/managed/hooks.json",
      source: "system",
      pluginId: null,
      displayOrder: 1,
      enabled: true,
      isManaged: true,
      currentHash: "managed-hash",
      trustStatus: "managed",
    },
  ];
  const writes: unknown[] = [];
  await page.route("**/api/sessions/*/skills", (route) =>
    route.fulfill({
      json: {
        sessionId: app.sessions.alpha,
        projectPath: app.projects.alpha,
        cwd: app.projects.alpha,
        skills,
        errors: [],
        unavailableReason: null,
      },
    }),
  );
  await page.route("**/api/sessions/*/skills/config", async (route) => {
    const body = route.request().postDataJSON() as {
      path: string;
      enabled: boolean;
    };
    writes.push(body);
    skills.find((skill) => skill.path === body.path)!.enabled = body.enabled;
    await route.fulfill({
      json: {
        sessionId: app.sessions.alpha,
        ...body,
        effectiveEnabled: body.enabled,
      },
    });
  });
  await page.route("**/api/sessions/*/hooks", (route) =>
    route.fulfill({
      json: {
        sessionId: app.sessions.alpha,
        projectPath: app.projects.alpha,
        cwd: app.projects.alpha,
        hooks,
        warnings: [],
        errors: [],
        unavailableReason: null,
      },
    }),
  );
  await page.route("**/api/sessions/*/hooks/config", async (route) => {
    const body = route.request().postDataJSON() as {
      updates: SessionHookStateUpdate[];
    };
    writes.push(body);
    for (const update of body.updates) {
      const hook = hooks.find((entry) => entry.key === update.key)!;
      if (update.enabled !== undefined) hook.enabled = update.enabled;
      if (update.trustedHash) hook.trustStatus = "trusted";
    }
    await route.fulfill({
      json: { sessionId: app.sessions.alpha, ...body, ok: true },
    });
  });
  await page.route("**/api/codex/threads/*/hook-runs", (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            threadId: app.sessions.alpha,
            turnId: null,
            run: {
              id: "run-1",
              eventName: "PreToolUse",
              handlerType: "command",
              executionMode: "sync",
              scope: "repo",
              source: "project",
              sourcePath: hooks[0].sourcePath,
              displayOrder: 0,
              status: "completed",
              statusMessage: null,
              startedAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 42,
              entries: [{ kind: "stdout", text: "Lint checks passed." }],
            },
          },
        ],
      },
    }),
  );
  return { skills, hooks, writes };
}

async function openPane(page: Page, app: IntegrationAppFixture) {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page
    .getByRole("button", { name: "Expand right pane", exact: true })
    .click();
  return page.locator(".pane-right");
}

for (const theme of ["light", "dark"] as const) {
  test(`Skills and Hooks support discovery, filtering, review and configuration in ${theme} mode`, async ({
    page,
    app,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const data = await mockCapabilities(page, app);
    const pane = await openPane(page, app);
    await pane.evaluate((element) => {
      element.style.width = "600px";
    });
    await expect(
      pane.locator('[data-right-pane-guide-entry="skills"]'),
    ).toBeVisible();
    await expect(
      pane.locator('[data-right-pane-guide-entry="hooks"]'),
    ).toBeVisible();
    await pane.screenshot({ path: testInfo.outputPath(`start-${theme}.png`) });
    await pane.locator('[data-right-pane-guide-entry="skills"]').click();
    const rows = pane.locator("[data-catalog-key]");
    await expect(rows).toHaveCount(2);
    await pane.getByRole("button", { name: "Disabled 1", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("release-notes");
    await pane.getByRole("button", { name: "All 2", exact: true }).click();
    await pane
      .getByRole("textbox", { name: "Search skills", exact: true })
      .fill("report");
    await expect(rows).toHaveCount(1);
    await rows.click();
    await expect(
      pane.getByRole("heading", { name: "Workspace review", exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByText("Review the current workspace changes.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByText("Read repository changes", { exact: true }),
    ).toBeVisible();
    await pane.screenshot({
      path: testInfo.outputPath(`skill-details-${theme}.png`),
    });
    await pane
      .getByRole("button", { name: "Disable skill", exact: true })
      .click();
    await expect(
      pane.getByRole("button", { name: "Enable skill", exact: true }),
    ).toBeEnabled();
    expect(data.writes).toContainEqual({
      path: data.skills[0].path,
      enabled: false,
    });
    await pane
      .getByRole("button", { name: "Back to skills", exact: true })
      .click();
    await expect(
      pane.getByRole("textbox", { name: "Search skills", exact: true }),
    ).toHaveValue("report");
    await expect(rows).toBeFocused();
    await pane
      .getByRole("textbox", { name: "Search skills", exact: true })
      .fill("nothing-matches");
    await expect(pane.getByText("No matches", { exact: true })).toBeVisible();
    await pane
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(rows).toHaveCount(2);
    await pane.screenshot({ path: testInfo.outputPath(`skills-${theme}.png`) });
    await pane.getByRole("button", { name: "New tab", exact: true }).click();
    await pane.locator('[data-right-pane-guide-entry="hooks"]').click();
    await expect(rows).toHaveCount(2);
    await pane
      .getByRole("button", { name: "Needs review 1", exact: true })
      .click();
    await expect(rows).toHaveCount(1);
    await pane.screenshot({ path: testInfo.outputPath(`hooks-${theme}.png`) });
    await rows.click();
    await expect(
      pane.getByRole("heading", { name: "PreToolUse", exact: true }),
    ).toBeVisible();
    await expect(pane.locator("pre")).toHaveText("pnpm lint --check");
    await pane.screenshot({
      path: testInfo.outputPath(`hook-details-${theme}.png`),
    });
    await pane.getByRole("button", { name: "Trust hook", exact: true }).click();
    await expect(pane.getByText("Trusted", { exact: true })).toBeVisible();
    expect(data.writes).toContainEqual({
      updates: [{ key: data.hooks[0].key, trustedHash: "review-hash" }],
    });
    await pane
      .getByRole("button", { name: "Disable hook", exact: true })
      .click();
    await expect(
      pane.getByRole("button", { name: "Enable hook", exact: true }),
    ).toBeEnabled();
    expect(data.writes).toContainEqual({
      updates: [{ key: data.hooks[0].key, enabled: false }],
    });
    await pane
      .getByRole("button", { name: "Back to hooks", exact: true })
      .click();
    await expect(rows).toHaveCount(0);
    await pane.getByRole("button", { name: "All 2", exact: true }).click();
    await rows.filter({ hasText: "SessionStart" }).click();
    await expect(
      pane.getByRole("button", { name: "Always on", exact: true }),
    ).toBeDisabled();
    await pane.getByRole("button", { name: "Executions", exact: true }).click();
    await pane.locator("summary").filter({ hasText: "PreToolUse" }).click();
    await expect(
      pane.getByText("Lint checks passed.", { exact: true }),
    ).toBeVisible();
    await pane.screenshot({
      path: testInfo.outputPath(`executions-${theme}.png`),
    });
    await pane
      .getByRole("button", { name: "Configuration", exact: true })
      .click();
    await pane.getByRole("button", { name: "All 2", exact: true }).click();
    await expect(rows).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await rows.filter({ hasText: "PreToolUse" }).click();
    await expect(
      pane.getByRole("heading", { name: "PreToolUse", exact: true }),
    ).toBeVisible();
    await pane.screenshot({
      path: testInfo.outputPath(`hooks-mobile-${theme}.png`),
    });
    expect(
      await pane.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });
}

test("split panes load Skills and Hooks independently and preserve detail selection", async ({
  page,
  app,
}) => {
  const data = await mockCapabilities(page, app);
  const pane = await openPane(page, app);
  await pane.evaluate((element) => {
    element.style.width = "648px";
  });
  await pane.locator('[data-right-pane-guide-entry="skills"]').click();
  await expect(pane.locator("[data-catalog-key]")).toHaveCount(2);
  await pane.getByRole("button", { name: "Split", exact: true }).click();
  const docks = pane.locator(".right-pane__dock");
  await docks.last().locator('[data-right-pane-guide-entry="hooks"]').click();
  await expect(docks.last().locator("[data-catalog-key]")).toHaveCount(2);
  await docks.first().locator("[data-catalog-key]").first().click();
  await docks.last().locator("[data-catalog-key]").first().click();
  await expect(
    docks
      .first()
      .getByRole("heading", { name: "Workspace review", exact: true }),
  ).toBeVisible();
  await expect(
    docks.last().getByRole("heading", { name: "PreToolUse", exact: true }),
  ).toBeVisible();
  await docks
    .last()
    .getByRole("button", { name: "Trust hook", exact: true })
    .click();
  await expect(
    docks.last().getByText("Trusted", { exact: true }),
  ).toBeVisible();
  expect(data.writes).toContainEqual({
    updates: [{ key: data.hooks[0].key, trustedHash: "review-hash" }],
  });
  await docks
    .first()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await expect(
    docks.last().getByRole("heading", { name: "PreToolUse", exact: true }),
  ).toBeVisible();
  await expect(
    docks.last().getByRole("button", { name: "Disable hook", exact: true }),
  ).toBeEnabled();
  await docks
    .last()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await docks.last().locator('[data-right-pane-guide-entry="skills"]').click();
  await docks.last().locator("[data-catalog-key]").first().click();
  await docks.first().locator('[data-right-pane-guide-entry="hooks"]').click();
  await expect(docks.first().locator("[data-catalog-key]")).toHaveCount(2);
  await expect(
    docks
      .last()
      .getByRole("heading", { name: "Workspace review", exact: true }),
  ).toBeVisible();
  await docks
    .first()
    .getByRole("button", { name: "New tab", exact: true })
    .click();
  await expect(
    docks
      .last()
      .getByRole("heading", { name: "Workspace review", exact: true }),
  ).toBeVisible();
  for (const dock of await docks.all()) {
    expect(
      await dock.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
});

test("capability load failures remain recoverable with Refresh", async ({
  page,
  app,
}) => {
  await mockCapabilities(page, app);
  const pane = await openPane(page, app);
  await page.route(
    "**/api/sessions/*/skills",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Skills temporarily unavailable" },
      }),
    { times: 1 },
  );
  await pane.locator('[data-right-pane-guide-entry="skills"]').click();
  await expect(pane.getByRole("alert")).toContainText(
    "Skills temporarily unavailable",
  );
  await pane
    .getByRole("button", { name: "Refresh skills", exact: true })
    .click();
  await expect(pane.locator("[data-catalog-key]")).toHaveCount(2);
  await expect(pane.getByRole("alert")).toHaveCount(0);
});
