import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemRawLine } from "../unit/test-utils";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 480 },
]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`view mode fills ${viewport.width}x${viewport.height} in ${colorScheme} and restores the layout`, async ({
      page,
      app,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (viewport.width < 500) {
        await page.getByRole("button", { name: "Collapse left pane" }).click();
      } else {
        await ui.chooseRightPaneMode("File tree");
      }
      const leftVisible = await page.locator(".pane-left").isVisible();
      const rightVisible = await page.locator(".pane-right").isVisible();
      const composer = page.getByPlaceholder("Ask Codex anything...");
      await composer.fill("Keep this draft while reading");
      const reply = page.getByText("The deployment steps are ready.", {
        exact: true,
      });
      const canvas = page.getByRole("region", { name: "Message canvas" });
      const activeMode = page.locator("[data-conversation-view-mode]");

      await reply.click();
      await expect(activeMode).toHaveCount(0);
      await reply.dblclick();
      await expect(activeMode).toHaveCount(1);
      await expect(composer).toBeHidden();
      await expect(page.locator(".pane-left")).toBeHidden();
      await expect(page.locator(".pane-right")).toBeHidden();
      await expect(page.locator(".pane-header-center")).toBeHidden();
      await expect
        .poll(() => canvas.boundingBox())
        .toEqual({
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
        });
      await expect(reply).toBeVisible();

      await reply.click();
      await expect(activeMode).toHaveCount(0);
      await expect(composer).toHaveValue("Keep this draft while reading");
      await expect(page.locator(".pane-header-center")).toBeVisible();
      expect(await page.locator(".pane-left").isVisible()).toBe(leftVisible);
      expect(await page.locator(".pane-right").isVisible()).toBe(rightVisible);

      await reply.dblclick();
      await expect(activeMode).toHaveCount(1);
      // Both click events and the trailing dblclick must leave view mode closed.
      await reply.dblclick();
      await expect(activeMode).toHaveCount(0);
      await reply.dblclick();
      await expect(activeMode).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(activeMode).toHaveCount(0);
    });
  }
}

test("translation buttons and message links keep their actions in both modes", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    "Read the [launch file](src/main.ts) for details.",
  );
  await page.route("**/api/translate", (route) =>
    route.fulfill({ json: { translatedText: "翻译后的消息" } }),
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const activeMode = page.locator("[data-conversation-view-mode]");
  const block = page.locator('[data-conversation-message="4"]');
  await block.hover();
  await block
    .getByRole("button", { name: "Translate message to Chinese" })
    .dblclick();
  await expect(activeMode).toHaveCount(0);
  await block
    .getByRole("button", { name: "Show original", exact: true })
    .click();
  const link = page.getByRole("link", { name: "launch file" });
  await link.dblclick();
  await expect(activeMode).toHaveCount(0);

  const reply = page.getByText("The deployment steps are ready.", {
    exact: true,
  });
  await reply.dblclick();
  await expect(activeMode).toHaveCount(1);
  await link.click();
  await expect(activeMode).toHaveCount(1);
  await block.hover();
  await block
    .getByRole("button", { name: "Translate message to Chinese" })
    .click();
  await expect(block.getByText("翻译后的消息", { exact: true })).toBeVisible();
  await expect(activeMode).toHaveCount(1);
  await block
    .getByRole("button", { name: "Show original", exact: true })
    .dblclick();
  await expect(activeMode).toHaveCount(1);
  await reply.click();
  await expect(activeMode).toHaveCount(0);
});

test("double clicking a collapsed group expands it without entering view mode", async ({
  page,
  app,
}) => {
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    responseItemRawLine({
      type: "function_call",
      call_id: "view-mode-tool",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo hello" }),
    }) + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const collapsedGroup = page
    .locator('[data-conversation-click-action="true"]')
    .first();
  await expect(collapsedGroup).toBeVisible();
  await collapsedGroup.dblclick();
  await expect(page.locator("[data-conversation-view-mode]")).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Collapse this default block group" })
      .first(),
  ).toBeVisible();
});

test.describe("touch view mode", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("enters with two taps and exits with one tap", async ({ page, app }) => {
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    const collapseLeft = page.getByRole("button", {
      name: "Collapse left pane",
    });
    if (await collapseLeft.isVisible()) await collapseLeft.click();
    const reply = page.getByText("The deployment steps are ready.", {
      exact: true,
    });
    await expect(reply).toBeVisible();
    const bounds = await reply.boundingBox();
    if (!bounds) throw new Error("Message has no bounds");
    await page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(page.locator("[data-conversation-view-mode]")).toHaveCount(1);
    await reply.tap();
    await expect(page.locator("[data-conversation-view-mode]")).toHaveCount(0);
  });
});
