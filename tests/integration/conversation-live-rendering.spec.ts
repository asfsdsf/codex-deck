import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`keeps message content mounted during live updates at width ${viewport.width} in ${colorScheme}`, async ({
      page,
      app,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await app.appendSessionMessage(
        "alpha",
        "assistant",
        [
          "Existing **formatted** answer with [source](src/main.ts).",
          "",
          "```ts",
          `export const longLine = "${"keep this code scrolled ".repeat(20)}";`,
          "```",
        ].join("\n"),
      );
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (viewport.width < 500) {
        await page.getByRole("button", { name: "Collapse left pane" }).click();
      }
      const entry = page.locator('[data-conversation-message="4"]');
      await expect(entry.getByRole("link", { name: "source" })).toBeVisible();
      const code = entry.locator("pre");
      await code.evaluate((node) => (node.scrollLeft = 120));
      await expect
        .poll(() => code.evaluate((node) => node.scrollLeft))
        .toBe(120);

      await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "[data-search-entry], [data-search-entry] p, [data-search-entry] pre, [data-search-entry] a",
          ),
        );
        const state = window as typeof window & {
          liveRenderingFaults: string[];
          liveRenderingObserver: MutationObserver;
        };
        state.liveRenderingFaults = [];
        state.liveRenderingObserver = new MutationObserver(() => {
          for (const node of nodes) {
            if (!node.isConnected) {
              state.liveRenderingFaults.push(node.tagName);
            }
          }
        });
        state.liveRenderingObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      });

      for (let index = 1; index <= 3; index += 1) {
        const text = `Live answer ${index}`;
        await app.appendSessionMessage("alpha", "assistant", text);
        await expect(page.getByText(text, { exact: true })).toBeVisible();
      }
      const faults = await page.evaluate(() => {
        const state = window as typeof window & {
          liveRenderingFaults: string[];
          liveRenderingObserver: MutationObserver;
        };
        state.liveRenderingObserver.disconnect();
        return [...new Set(state.liveRenderingFaults)];
      });
      expect(faults).toEqual([]);
      await expect
        .poll(() => code.evaluate((node) => node.scrollLeft))
        .toBe(120);

      await entry.getByRole("link", { name: "source" }).click();
      await expect(
        ui.rightPane.getByText("launchChecklist", { exact: false }).first(),
      ).toBeVisible();
    });
  }
}
