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
  await ui.selectSession("Review the launch checklist");

  await page.getByRole("button", { name: "plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  await expect(
    dialog.getByText(
      "A plugin is a folder with plugin.json, its panel HTML, JavaScript, styles, and any local assets.",
    ),
  ).toBeVisible();
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

  await dialog
    .getByLabel("Plugin package folder")
    .setInputFiles("examples/deck-plugins/release-notes");
  await expect(
    dialog.getByText("Example team · v1.0.0 · Package"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Install plugin" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("I reviewed the package source and trust this plugin.")
    .check();
  await dialog.getByRole("button", { name: "Install plugin" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Review plugin code", exact: true })
    .click();
  await expect(
    dialog.getByText(/const channel = "codex-deck-plugin"/),
  ).toBeVisible();
  await expect(dialog.locator('iframe[title="Release Notes"]')).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Open plugin", exact: true })
    .click();
  const pluginFrame = page.frameLocator('iframe[title="Release Notes"]');
  await expect(pluginFrame.locator("#status")).toContainText(
    app.sessions.alpha,
  );
  await expect(pluginFrame.locator("#status")).toContainText(
    app.projects.alpha,
  );
  await expect(pluginFrame.locator("#status")).toContainText(
    "Saved plugin note",
  );
  await expect(pluginFrame.locator("body")).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );
  await expect(pluginFrame.locator("body")).toHaveCSS("padding", "16px");
  await dialog.getByRole("button", { name: "Close plugin" }).last().click();
  await dialog
    .getByRole("button", { name: "Open plugin", exact: true })
    .click();
  await expect(pluginFrame.locator("#status")).toContainText(
    "Saved plugin note",
  );
  await dialog.getByRole("button", { name: "Close plugin" }).last().click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

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

test("built-in plugins expose optional enablement and shared-service views", async ({
  app,
  context,
  page,
  request,
}) => {
  await context.addInitScript(() =>
    localStorage.setItem("codex-deck:theme:v1", "light"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins", exact: true });
  const recap = dialog
    .locator("li")
    .filter({ has: page.getByText("Conversation recap", { exact: true }) });
  await expect(recap.getByText("Built-in", { exact: true })).toBeVisible();
  await recap.getByRole("button").click();
  await expect(
    dialog.getByRole("button", { name: "Uninstall", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const snapshot = await (
        await request.get(`${app.baseURL}/api/deck/plugins/contributions`)
      ).json();
      return snapshot.plugins.some(
        (p: { id: string }) => p.id === "codex-deck.recap",
      );
    })
    .toBe(false);
  await dialog.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Disable", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Back to plugins" }).click();
  const manager = dialog
    .locator("li")
    .filter({ has: page.getByText("Plugin manager", { exact: true }) });
  await manager.getByRole("button").click();
  await expect(dialog.getByText("Required by Deck")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Disable", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const folder = join(process.cwd(), "examples/deck-plugins/session-inspector");
  const files = await Promise.all(
    (await readdir(folder)).map(async (name) => ({
      path: name,
      contentBase64: (await readFile(join(folder, name))).toString("base64"),
    })),
  );
  const install = await request.post(
    `${app.baseURL}/api/deck/plugins/install`,
    { data: { files } },
  );
  expect(install.ok()).toBe(true);
  await expect
    .poll(async () => {
      const snapshot = await (
        await request.get(`${app.baseURL}/api/deck/plugins/contributions`)
      ).json();
      return snapshot.plugins.some(
        (p: { id: string; workerError?: string }) =>
          p.id === "example.session-inspector" && !p.workerError,
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "plugins", exact: true }).click();
  await dialog
    .locator("li")
    .filter({ has: page.getByText("Session inspector", { exact: true }) })
    .getByRole("button")
    .click();
  await dialog
    .getByRole("button", { name: "Open plugin", exact: true })
    .click();
  const frame = page.frameLocator('iframe[title="Session inspector"]');
  await expect(
    frame.getByRole("heading", { name: "Session inspector" }),
  ).toBeVisible();
  await expect(frame.locator("#result")).toContainText("warnings");
  await expect(frame.locator("body")).not.toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/deck-plugin-redesign-mobile-light.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect(frame.locator("body")).toHaveClass(/dark/);
  await page.screenshot({
    path: "/tmp/deck-plugin-redesign-mobile-dark.png",
    fullPage: true,
  });
});
