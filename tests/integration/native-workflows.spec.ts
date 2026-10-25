import { readFile } from "node:fs/promises";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

for (const theme of ["dark", "light"] as const) {
  for (const mobile of [false, true]) {
    test(`native workflows in ${theme} on ${mobile ? "mobile" : "desktop"}`, async ({
      page,
      context,
      app,
    }, testInfo) => {
      await context.addInitScript(
        (value) => localStorage.setItem("codex-deck:theme:v1", value),
        theme,
      );
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      let reloads = 0;
      await page.route("**/api/codex/mcp**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/reload")) {
          reloads++;
          await route.fulfill({ json: { ok: true } });
        } else if (path.endsWith("/login"))
          await route.fulfill({
            json: {
              authorizationUrl: "https://auth.example/authorize",
              loginId: "attempt",
            },
          });
        else
          await route.fulfill({
            json: {
              servers: [
                {
                  name: "example-mcp",
                  runtimeStatus: "connected",
                  authStatus: "oAuth",
                  tools: {
                    search: {
                      description: "Search project documents.",
                      inputSchema: { type: "object" },
                    },
                  },
                  resources: [],
                  resourceTemplates: [],
                },
              ],
              updates: [
                {
                  name: "example-mcp",
                  threadId: app.sessions.alpha,
                  status: "ready",
                },
              ],
            },
          });
      });
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (mobile)
        await page.getByRole("button", { name: "Collapse left pane" }).click();
      await page.getByPlaceholder("Message Codex...").fill("/mcp");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const dialog = page.getByRole("dialog", { name: "MCP administration" });
      await expect(
        dialog.getByText("example-mcp", { exact: true }),
      ).toBeVisible();
      await dialog.getByText("Tools (1)", { exact: true }).click();
      await dialog.getByText("search", { exact: true }).click();
      await expect(dialog.getByText("Search project documents.")).toBeVisible();
      await dialog.getByRole("button", { name: "OAuth login" }).click();
      await expect(
        dialog.getByRole("link", { name: "Open authorization page" }),
      ).toHaveAttribute("href", "https://auth.example/authorize");
      await dialog
        .getByRole("button", { name: "Reload configuration" })
        .click();
      await expect.poll(() => reloads).toBe(1);
      await expect(
        dialog.getByText("Startup: ready", { exact: true }),
      ).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
      await page.screenshot({
        path: testInfo.outputPath(
          `mcp-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeHidden();
      let redemptions = 0;
      await page.route("**/api/codex/usage**", async (route) => {
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON().idempotencyKey).toBeTruthy();
          redemptions++;
          await route.fulfill({ json: { outcome: "reset" } });
        } else
          await route.fulfill({
            json: {
              rates: {
                ordinaryUsageAllowed: false,
                rateLimits: {
                  limitName: "Included usage",
                  primary: {
                    usedPercent: 85,
                    windowDurationMins: 300,
                    resetsAt: 1800000000,
                  },
                  credits: {
                    balance: "12.5",
                    hasCredits: true,
                    unlimited: false,
                  },
                },
                rateLimitResetCredits: {
                  availableCount: 1,
                  credits: [
                    {
                      id: "credit-1",
                      title: "Earned reset",
                      resetType: "codexRateLimits",
                      status: "available",
                      expiresAt: 1800000000,
                    },
                  ],
                },
              },
              activity: {
                summary: {
                  lifetimeTokens: 42000,
                  peakDailyTokens: 10000,
                  currentStreakDays: 3,
                },
                dailyUsageBuckets: [{ startDate: "2026-10-25", tokens: 3000 }],
              },
              thread: {
                estimatedUsageCreditsMicros: 1250000,
                estimatedUsageUsdMicros: 500000,
                groups: [],
              },
              errors: [],
            },
          });
      });
      await page.getByPlaceholder("Message Codex...").fill("/usage");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const usage = page.getByRole("dialog", { name: "Usage dashboard" });
      await expect(usage.getByText("85% used", { exact: true })).toBeVisible();
      await expect(
        usage.getByText("1.25 credits · $0.5000 USD", { exact: true }),
      ).toBeVisible();
      await usage.getByRole("button", { name: "Redeem reset credit" }).click();
      expect(redemptions).toBe(0);
      await usage.getByRole("button", { name: "Confirm redeem" }).click();
      await expect(
        usage.getByText("Usage limits reset.", { exact: true }),
      ).toBeVisible();
      expect(redemptions).toBe(1);
      await page.screenshot({
        path: testInfo.outputPath(
          `usage-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await usage.getByRole("button", { name: "Close", exact: true }).click();
      let recapStarted = false;
      await page.route("**/api/codex/threads/*/recap*", async (route) => {
        if (route.request().method() === "POST") recapStarted = true;
        await route.fulfill({
          json: {
            recap: recapStarted
              ? {
                  threadId: app.sessions.alpha,
                  status: "completed",
                  phase: "Summary ready",
                  summary: "The launch checklist is ready and validated.",
                  nextAction: "Publish the launch notes.",
                  error: null,
                }
              : null,
          },
        });
      });
      await page.getByPlaceholder("Message Codex...").fill("/recap");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const recap = page.getByRole("dialog", { name: "Conversation recap" });
      await expect(
        recap.getByText("The launch checklist is ready and validated.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        recap.getByText("Publish the launch notes.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(
          `recap-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await recap.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .getByPlaceholder("Message Codex...")
        .fill("/export launch-notes.md");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const exported = page.getByRole("dialog", { name: "Export transcript" });
      await expect(
        exported.getByRole("textbox", { name: "Markdown preview" }),
      ).toContainText("The deployment steps are ready.");
      const downloadPromise = page.waitForEvent("download");
      await exported.getByRole("button", { name: "Download Markdown" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("launch-notes.md");
      const markdown = await readFile((await download.path())!, "utf8");
      expect(markdown).toContain("## User");
      expect(markdown).toContain("The deployment steps are ready.");
      await page.screenshot({
        path: testInfo.outputPath(
          `export-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await exported
        .getByRole("button", { name: "Close", exact: true })
        .click();
      let featureEnabled = false;
      const feature = () => ({
        name: "beta_feature",
        displayName: "Example beta",
        description: "A feature supplied by the host.",
        stage: "beta",
        enabled: featureEnabled,
        defaultEnabled: false,
      });
      await page.route("**/api/codex/experimental**", async (route) => {
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON().updates).toEqual({
            beta_feature: true,
          });
          featureEnabled = true;
        }
        await route.fulfill({ json: { features: [feature()], warning: null } });
      });
      await page.getByPlaceholder("Message Codex...").fill("/experimental");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const experimental = page.getByRole("dialog", {
        name: "Experimental features",
      });
      await experimental
        .getByRole("checkbox", { name: "Example beta" })
        .check();
      await experimental
        .getByRole("button", { name: "Save feature settings" })
        .click();
      await expect(
        experimental.getByText("Feature settings saved.", { exact: true }),
      ).toBeVisible();
      await expect(
        experimental.getByRole("checkbox", { name: "Example beta" }),
      ).toBeChecked();
      await page.screenshot({
        path: testInfo.outputPath(
          `experimental-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await experimental
        .getByRole("button", { name: "Close", exact: true })
        .click();
      let daybreakEnabled = false;
      let daybreakEligible = true;
      await page.route("**/api/codex/threads/*/daybreak*", async (route) => {
        if (route.request().method() === "POST") {
          daybreakEnabled = route.request().postDataJSON().enabled;
        }
        await route.fulfill({
          json: {
            enabled: daybreakEnabled,
            eligible: daybreakEligible,
            model: "example",
            models: [
              {
                id: "example",
                name: "Example",
                programs: ["standard", "daybreakBlue"],
              },
            ],
            reason: daybreakEligible
              ? null
              : "Daybreak eligibility is unavailable.",
          },
        });
      });
      await page.getByPlaceholder("Message Codex...").fill("/daybreak");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const daybreak = page.getByRole("dialog", { name: "Daybreak selection" });
      await daybreak.getByRole("button", { name: "Turn Daybreak on" }).click();
      await expect(
        daybreak.getByText(
          "Daybreak enabled for new turns in this conversation.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(daybreakEnabled).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(
          `daybreak-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      daybreakEligible = false;
      await daybreak
        .getByRole("button", { name: "Refresh eligibility" })
        .click();
      await expect(
        daybreak.getByText("Daybreak eligibility is unavailable.", {
          exact: true,
        }),
      ).toBeVisible();
      await daybreak.getByRole("button", { name: "Turn Daybreak off" }).click();
      await expect(
        daybreak.getByRole("button", { name: "Turn Daybreak on" }),
      ).toBeDisabled();
      expect(daybreakEnabled).toBe(false);
      await daybreak
        .getByRole("button", { name: "Close", exact: true })
        .click();
      let warningRefreshes = 0;
      await page.route("**/api/codex/warnings*", async (route) => {
        warningRefreshes++;
        await route.fulfill({
          json: {
            warnings: [
              {
                id: "warning-1",
                timestamp: 1800000000000,
                method: "configWarning",
                threadId: null,
                summary:
                  "Project configuration is disabled until this project is trusted.",
                details: { path: "/repo/.codex", password: "[redacted]" },
              },
              {
                id: "warning-2",
                timestamp: 1800000001000,
                method: "deprecationNotice",
                threadId: app.sessions.alpha,
                summary: "A configured feature is deprecated.",
                details: { feature: "legacy_feature" },
              },
            ],
          },
        });
      });
      await page.getByPlaceholder("Message Codex...").fill("/warnings");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const warnings = page.getByRole("dialog", { name: "Retained warnings" });
      await expect(
        warnings.getByText("2 retained warnings", { exact: true }),
      ).toBeVisible();
      await expect(
        warnings.getByText(
          "Project configuration is disabled until this project is trusted.",
          { exact: true },
        ),
      ).toBeVisible();
      const beforeRefresh = warningRefreshes;
      await warnings.getByRole("button", { name: "Refresh warnings" }).click();
      await expect.poll(() => warningRefreshes).toBeGreaterThan(beforeRefresh);
      await warnings
        .getByText("Warning details", { exact: true })
        .last()
        .click();
      await page.screenshot({
        path: testInfo.outputPath(
          `warnings-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await warnings
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.route("**/api/codex/debug-config*", async (route) => {
        await route.fulfill({
          json: {
            cwd: "/repo",
            config: { model: "example", api_key: "[redacted]" },
            origins: {
              model: {
                name: { type: "user", file: "/home/user/.codex/config.toml" },
                version: "v1",
              },
            },
            layers: [
              {
                name: { type: "user", file: "/home/user/.codex/config.toml" },
                version: "v1",
                config: { model: "example" },
              },
              {
                name: { type: "project", dot_codex_folder: "/repo/.codex" },
                version: "v2",
                config: {},
                disabledReason: "Project is not trusted",
              },
            ],
            requirements: { allowed_approval_policies: ["never"] },
            requirementSources: null,
            supportsIndependentSpeedModes: true,
            errors: [],
          },
        });
      });
      await page.getByPlaceholder("Message Codex...").fill("/debug-config");
      await page.getByPlaceholder("Message Codex...").press("Enter");
      const config = page.getByRole("dialog", {
        name: "Configuration diagnostics",
      });
      await expect(
        config.getByText("Disabled: Project is not trusted", { exact: true }),
      ).toBeVisible();
      await expect(
        config.getByText(
          "Requirement sources are not exposed by the connected server.",
          { exact: true },
        ),
      ).toBeVisible();
      await config
        .getByText("Effective configuration", { exact: true })
        .click();
      await expect(
        config.getByText('"api_key": "[redacted]"', { exact: false }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(
          `config-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        ),
      });
      await config.getByRole("button", { name: "Close", exact: true }).click();
    });
  }
}
