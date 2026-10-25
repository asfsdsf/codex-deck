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
    });
  }
}
