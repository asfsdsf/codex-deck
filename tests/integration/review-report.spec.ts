import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemMessageLine } from "../unit/test-utils";
import {
  reviewReportFixture,
  reviewUserActionFixture,
} from "../fixtures/review-report";

for (const theme of ["dark", "light"] as const) {
  for (const mobile of [false, true]) {
    test(`review feedback and final reports render in ${theme} mode on ${mobile ? "mobile" : "desktop"}`, async ({
      page,
      context,
      app,
    }, testInfo) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await context.addInitScript(
        (value) => localStorage.setItem("codex-deck:theme:v1", value),
        theme,
      );
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      const report = structuredClone(reviewReportFixture);
      const originalPath = report.findings[0].code_location.absolute_file_path;
      report.findings[0].code_location = {
        absolute_file_path: join(app.projects.alpha, "src", "main.ts"),
        line_range: { start: 2, end: 4 },
      };
      const wrapped = reviewUserActionFixture
        .replace(
          originalPath,
          report.findings[0].code_location.absolute_file_path,
        )
        .replace(":9880-9882", ":2-4");
      const json = JSON.stringify(report, null, 2);
      await appendFile(
        join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
        [
          responseItemMessageLine("user", wrapped),
          responseItemMessageLine("assistant", json),
          "",
        ].join("\n"),
      );
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (mobile) {
        const collapse = page.getByRole("button", {
          name: "Collapse left pane",
        });
        if (await collapse.isVisible()) await collapse.click();
      }
      const cards = page.getByRole("region", {
        name: "Code review",
        exact: true,
      });
      await expect(cards).toHaveCount(2);
      for (const [index, format] of ["feedback", "final"].entries()) {
        const card = cards.nth(index);
        await expect(card.getByRole("article")).toHaveCount(4);
        await expect(card.getByText("4 findings", { exact: true })).toHaveCount(
          1,
        );
        await expect(
          card.locator("code", { hasText: /^serviceTier$/ }),
        ).toHaveCount(1);
        await expect(card.locator("details pre")).toBeHidden();
        await card.evaluate((element) =>
          element.scrollIntoView({ block: "start" }),
        );
        await page.screenshot({
          path: testInfo.outputPath(
            `${format}-${theme}-${mobile ? "mobile" : "desktop"}.png`,
          ),
        });
        const box = await card.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
        expect(
          await card.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      }
      const final = cards.last();
      await expect(
        final.getByText("Changes requested", { exact: true }),
      ).toHaveCount(1);
      const original = final.getByText("Original review", { exact: true });
      await original.click();
      await expect(final.locator("details pre")).toBeVisible();
      expect(await final.locator("details pre").textContent()).toBe(json);
      await original.click();
      const message = final.locator(
        "xpath=ancestor::div[contains(@class, 'group relative')][1]",
      );
      await message.hover();
      await message
        .getByRole("button", { name: "Copy message", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(json);

      const sourceLine = page.getByText("export const launchChecklist = [", {
        exact: true,
      });
      // Exercise the linked-file race: content can load before the root tree,
      // whose directory-only snapshot must not clear the nested file selection.
      const contentResponse = page.waitForResponse((response) =>
        response.url().includes("/file-content?"),
      );
      await page.route("**/file-tree/nodes?*", async (route) => {
        const response = await route.fetch();
        await (await contentResponse).finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
        await route.fulfill({ response });
      });
      await final.locator('a[href$="#L2"]').click();
      await expect(
        page.getByRole("button", { name: "src", exact: true }),
      ).toBeVisible();
      await expect(sourceLine).toBeVisible();
    });
  }
}
