import { expect, test } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("a collapsed left rail stays beside the workspace and keeps its controls usable", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);

  const leftPane = page.locator(".pane-left");
  await page.getByRole("button", { name: "Collapse left pane" }).click();
  await expect(leftPane).toBeVisible();
  await expect(leftPane).toHaveAttribute("aria-label", "Collapsed left pane");
  expect(await leftPane.boundingBox()).toMatchObject({ x: 0, width: 48 });

  const views = leftPane.getByRole("group", { name: "Primary views" });
  await expect(leftPane.getByRole("button", { name: /selector/ })).toHaveCount(
    0,
  );
  for (const label of ["Terminal", "Codex", "Workflow"]) {
    const view = views.getByRole("button", { name: label });
    await expect(view).toBeVisible();
    await view.click();
    await expect(view).toHaveAttribute("aria-pressed", "true");
    await expect(leftPane).toBeVisible();
  }

  await leftPane.getByRole("button", { name: "plugins" }).click();
  const plugins = page.getByRole("dialog", { name: "Plugins" });
  await expect(plugins).toBeVisible();
  await plugins.getByRole("button", { name: "Close" }).click();

  await leftPane.getByRole("button", { name: "Codex Deck settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();

  await leftPane.getByRole("button", { name: "Search sessions" }).click();
  await expect(leftPane).not.toHaveAttribute(
    "aria-label",
    "Collapsed left pane",
  );
  await expect(page.getByPlaceholder("Search...")).toBeFocused();
  expect(await leftPane.boundingBox()).toMatchObject({ x: 0, width: 320 });
});
