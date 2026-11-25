import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });

async function mockProcesses(page: Page, sessionId: string) {
  const state = {
    output: "Server ready on port 3000\n",
    running: true,
    liveAvailable: true,
    outputAvailable: true,
    listReads: 0,
    outputReads: 0,
  };
  await page.route("**/api/sessions/*/terminal-runs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const selectedSession = path.split("/")[3];
    const isOutput = path.endsWith("/123");
    if (isOutput) {
      state.outputReads++;
      await route.fulfill({
        status: state.outputAvailable ? 200 : 503,
        json: state.outputAvailable
          ? {
              sessionId,
              processId: "123",
              command: "pnpm dev",
              isRunning: state.running,
              output: state.output,
              unavailableReason: null,
            }
          : { error: "Output temporarily unavailable" },
      });
    } else {
      state.listReads++;
      await route.fulfill({
        json: {
          sessionId: selectedSession,
          runs:
            selectedSession === sessionId && state.running
              ? [
                  {
                    processId: "123",
                    callId: "call-123",
                    command: "pnpm dev",
                    isRunning: true,
                    startedAt: null,
                    endedAt: null,
                    latestActivityAt: null,
                  },
                ]
              : [],
          unavailableReason: null,
        },
      });
    }
  });
  await page.route(
    "**/api/codex/threads/*/background-terminals",
    async (route) => {
      const selectedSession = new URL(route.request().url()).pathname.split(
        "/",
      )[4];
      await route.fulfill({
        status: state.liveAvailable ? 200 : 503,
        json: state.liveAvailable
          ? {
              terminals:
                selectedSession === sessionId && state.running
                  ? [
                      {
                        processId: "123",
                        itemId: "item-123",
                        command: "pnpm dev",
                        cwd: "/workspace",
                        osPid: 456,
                        cpuPercent: 1.5,
                        rssKb: 4096,
                      },
                    ]
                  : [],
            }
          : { error: "Live discovery temporarily unavailable" },
      });
    },
  );
  return state;
}

async function openProcess(page: Page) {
  const pane = page.locator(".pane-right");
  await page
    .getByRole("button", { name: "Expand right pane", exact: true })
    .click();
  await pane.locator('[data-right-pane-guide-entry="process"]').click();
  return pane;
}

for (const theme of ["light", "dark"] as const) {
  test(`Process lists live commands and keeps final output in ${theme} mode`, async ({
    page,
    app,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const state = await mockProcesses(page, app.sessions.alpha);
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    const pane = await openProcess(page);
    await expect(
      pane.getByRole("tab", { name: "Process Close", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      pane.getByText("Local · Refresh every 0.5s", { exact: true }),
    ).toBeVisible();
    await pane.screenshot({
      path: testInfo.outputPath(`process-list-${theme}.png`),
    });
    await pane.locator('[data-catalog-key="123"]').click();
    await expect(
      pane.getByLabel("Process output", { exact: true }),
    ).toContainText("Server ready");
    await expect(pane.getByText("456", { exact: true })).toBeVisible();
    state.output += "Compiled successfully\n";
    await expect(
      pane.getByLabel("Process output", { exact: true }),
    ).toContainText("Compiled successfully");
    await pane.screenshot({
      path: testInfo.outputPath(`process-${theme}.png`),
    });
    state.output += "Server shut down\n";
    state.running = false;
    await expect(
      pane.getByLabel("Process output", { exact: true }),
    ).toContainText("Server shut down");
    await expect(pane.getByText("Finished", { exact: true })).toBeVisible();
    await pane
      .getByRole("button", { name: "Back to process", exact: true })
      .click();
    await expect(pane.locator('[data-catalog-key="123"]')).toContainText(
      "Finished",
    );
    await ui.selectSession("Summarize the beta release notes");
    await expect(pane.locator('[data-catalog-key="123"]')).toHaveCount(0);
    await expect(
      pane.getByLabel("Process output", { exact: true }),
    ).toHaveCount(0);
    await expect(
      pane.getByText("No process available", { exact: true }),
    ).toBeVisible();
  });
}

test("Process refresh settings apply immediately, persist, and synchronize browser pages", async ({
  page,
  context,
  app,
}) => {
  await mockProcesses(page, app.sessions.alpha);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const pane = await openProcess(page);
  const other = await context.newPage();
  await mockProcesses(other, app.sessions.alpha);
  const otherUi = new CodexDeckPage(other);
  await otherUi.goto(app.baseURL);
  await otherUi.selectSession("Review the launch checklist");
  const otherPane = await openProcess(other);
  await page
    .getByRole("button", { name: "Codex Deck settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const local = settings.getByLabel("Local refresh (seconds)", { exact: true });
  const remote = settings.getByLabel("Remote refresh (seconds)", {
    exact: true,
  });
  await expect(local).toHaveValue("0.5");
  await expect(remote).toHaveValue("2");
  await local.fill("1.25");
  await remote.fill("4.75");
  await remote.press("Tab");
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(pane.locator(".right-pane-process__footer")).toHaveText(
    "Local · Refresh every 1.25s",
  );
  await expect(otherPane.locator(".right-pane-process__footer")).toHaveText(
    "Local · Refresh every 1.25s",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Codex Deck settings", exact: true })
    .click();
  await expect(local).toHaveValue("1.25");
  await expect(remote).toHaveValue("4.75");
  await local.fill("0");
  await local.press("Tab");
  await expect(local).toHaveValue("1.25");
  await other.close();
});

test("Process polling recovers after errors and stops when another pane is selected", async ({
  page,
  app,
}) => {
  const state = await mockProcesses(page, app.sessions.alpha);
  state.liveAvailable = false;
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const pane = await openProcess(page);
  await expect(pane.getByRole("alert")).toContainText(
    "Live discovery temporarily unavailable",
  );
  await pane.locator('[data-catalog-key="123"]').click();
  await expect(
    pane.getByLabel("Process output", { exact: true }),
  ).toContainText("Server ready");
  state.outputAvailable = false;
  await expect(pane.getByRole("alert").last()).toContainText(
    "Output temporarily unavailable",
  );
  await expect(
    pane.getByLabel("Process output", { exact: true }),
  ).toContainText("Server ready");
  state.liveAvailable = true;
  state.outputAvailable = true;
  state.output = "Output recovered\n";
  await expect(pane.getByLabel("Process output", { exact: true })).toHaveText(
    "Output recovered\n",
  );
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await pane.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(
    pane.locator('[data-right-pane-guide-entry="process"]'),
  ).toBeVisible();
  const reads = [state.listReads, state.outputReads];
  await page.waitForTimeout(1100);
  expect([state.listReads, state.outputReads]).toEqual(reads);
});

test("Process polling pauses while the page is hidden and catches up on wake", async ({
  page,
  app,
}) => {
  const state = await mockProcesses(page, app.sessions.alpha);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const pane = await openProcess(page);
  await pane.locator('[data-catalog-key="123"]').click();
  await expect(
    pane.getByLabel("Process output", { exact: true }),
  ).toContainText("Server ready");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Let requests already in flight settle before measuring the dormant page.
  await page.waitForTimeout(100);
  const reads = [state.listReads, state.outputReads];
  state.output = "Output produced while hidden\n";
  await page.waitForTimeout(1100);
  expect([state.listReads, state.outputReads]).toEqual(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(pane.getByLabel("Process output", { exact: true })).toHaveText(
    "Output produced while hidden\n",
  );
});

test("Process keeps commands, output, and controls inside a phone-sized pane", async ({
  page,
  app,
}, testInfo) => {
  const state = await mockProcesses(page, app.sessions.alpha);
  state.output = `${"A long output line ".repeat(35)}\n`;
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const pane = await openProcess(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await pane.locator('[data-catalog-key="123"]').click();
  await expect(
    pane.getByLabel("Process output", { exact: true }),
  ).toContainText("A long output line");
  const container = await pane.boundingBox();
  for (const label of [
    "Refresh process",
    "Back to process",
    "New tab",
    "Fullscreen",
    "Collapse right sidebar",
  ]) {
    const control = pane.getByRole("button", { name: label, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(container!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      container!.x + container!.width + 1,
    );
  }
  expect(
    await pane
      .locator(".right-pane-catalog__detail")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await pane.screenshot({ path: testInfo.outputPath("process-mobile.png") });
});
