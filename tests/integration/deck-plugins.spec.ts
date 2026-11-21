import { expect, test } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("the sidebar and /plugins share a window that lists both plugin systems", async ({
  app,
  context,
  page,
  request,
}) => {
  let codexPluginInstalled = false;
  let codexPluginInstallRequests = 0;
  const codexPluginsSnapshot = () => ({
    enabled: true,
    disabledReason: null,
    marketplaces: [
      {
        name: "example-market",
        displayName: "Example",
        path: null,
        removable: false,
        upgradable: false,
        plugins: [
          {
            id: "example.codex",
            name: "Example Codex plugin",
            displayName: "Example Codex plugin",
            description: "An upstream Codex plugin.",
            developer: "Example team",
            category: null,
            marketplaceName: "example-market",
            installed: codexPluginInstalled,
            enabled: codexPluginInstalled,
            statusLabel: codexPluginInstalled ? "Installed" : "Available",
            authPolicy: null,
            featured: false,
            canToggle: codexPluginInstalled,
            canInstall: !codexPluginInstalled,
            installBlockedReason: null,
            canUninstall: codexPluginInstalled,
            uninstallBlockedReason: null,
            sourceSummary: "Example marketplace",
            keywords: [],
          },
        ],
      },
    ],
    loadErrors: [],
  });
  await page.route("**/api/codex/plugins**", async (route) => {
    if (
      route.request().method() === "POST" &&
      new URL(route.request().url()).pathname === "/api/codex/plugins/install"
    ) {
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({
        pluginId: "example.codex",
        marketplaceName: "example-market",
      });
      codexPluginInstalled = true;
      codexPluginInstallRequests++;
      await route.fulfill({
        json: {
          snapshot: codexPluginsSnapshot(),
          authPolicy: null,
          appsNeedingAuth: [],
        },
      });
      return;
    }
    await route.fulfill({ json: codexPluginsSnapshot() });
  });
  await context.addInitScript(() =>
    localStorage.setItem("codex-deck:theme:v1", "light"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);

  await page.getByRole("button", { name: "plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  await expect(dialog.getByText("Codex", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Codex Deck", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    dialog.getByText("Example Codex plugin", { exact: false }).first(),
  ).toBeVisible();
  const codexPlugin = dialog
    .locator("li")
    .filter({ hasText: "Example Codex plugin" });
  await codexPlugin
    .getByRole("button", { name: "Install", exact: true })
    .click();
  const installConfirmation = dialog.getByRole("alertdialog", {
    name: "Confirm plugin change",
  });
  await expect(installConfirmation).toBeVisible();
  await expect(installConfirmation).toBeInViewport();
  await expect(installConfirmation).toContainText(
    "Install Example Codex plugin?",
  );
  await installConfirmation
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await expect.poll(() => codexPluginInstallRequests).toBe(1);
  await expect(
    dialog.getByText("Installed Example Codex plugin.", { exact: true }),
  ).toBeVisible();

  await dialog.getByLabel("Plugin manifest").setInputFiles({
    name: "release-notes.deck-plugin.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "example.release-notes",
        name: "Release Notes",
        author: "Example team",
        version: "1.0.0",
        description: "Release notes plugin metadata.",
      }),
    ),
  });
  await expect(
    dialog.getByText("Example team · v1.0.0 · Manifest file"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Install plugin" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  const disable = await request.post(
    `${app.baseURL}/api/deck/plugins/example.release-notes/enabled`,
    { data: { enabled: false } },
  );
  expect(disable.ok()).toBeTruthy();

  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "Collapse left pane" }).click();
  const draft = page.getByPlaceholder("Ask Codex anything...");
  await draft.fill("/plugins");
  await draft.press("Enter");
  await expect(page.getByRole("dialog", { name: "Plugins" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Expand left pane" }).click();
  await page.getByRole("button", { name: "plugins", exact: true }).click();
  const reopened = page.getByRole("dialog", { name: "Plugins" });
  await reopened
    .getByRole("searchbox", { name: "Search Deck plugins" })
    .fill("Release Notes");
  await reopened.getByText("Release Notes", { exact: true }).click();
  await expect(reopened.getByRole("button", { name: "Enable" })).toBeVisible();
});
