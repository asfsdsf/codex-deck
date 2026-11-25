import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("settings display effective config values without saving inherited fields", async ({
  page,
  app,
}) => {
  // Model a higher-priority local file without changing the developer's config.
  await page.route("**/api/codex-deck/config", async (route) => {
    const response = await route.fetch();
    const file = await response.json();
    await route.fulfill({
      response,
      json: {
        ...file,
        configPaths: ["/project/config.toml", file.path],
        effectiveConfig: {
          ...file.effectiveConfig,
          port: 14000,
          dev: false,
          open: false,
          translationCommand: "printf inherited",
          proxy: {
            httpProxy: "http://127.0.0.1:7890",
            httpsProxy: "http://127.0.0.1:7890",
            noProxy: "localhost,127.0.0.1,::1",
          },
          remote: { username: "inherited-user" },
          conversationHover: { model: true, timestamp: false },
        },
      },
    });
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await page
    .getByRole("button", { name: "Codex Deck settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings.getByLabel("Port", { exact: false })).toHaveValue(
    "14000",
  );
  await expect(
    settings
      .getByRole("group", { name: "Development CORS" })
      .getByRole("button", { name: "Off", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    settings
      .getByRole("group", { name: "Open browser on startup" })
      .getByRole("button", { name: "Off", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    settings.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByText(
      "Values from /project/config.toml take priority over this file.",
    ),
  ).toBeVisible();

  await settings
    .getByRole("button", { name: "Translation", exact: true })
    .click();
  await expect(
    settings.getByLabel("Translation command", { exact: false }),
  ).toHaveValue("printf inherited");
  await settings.getByRole("button", { name: "Proxy", exact: true }).click();
  await expect(settings.getByLabel("HTTP_PROXY", { exact: true })).toHaveValue(
    "http://127.0.0.1:7890",
  );
  await expect(settings.getByLabel("HTTPS_PROXY", { exact: true })).toHaveValue(
    "http://127.0.0.1:7890",
  );
  await expect(settings.getByLabel("NO_PROXY", { exact: true })).toHaveValue(
    "localhost,127.0.0.1,::1",
  );
  await settings.getByRole("button", { name: "Remote", exact: true }).click();
  await expect(settings.getByLabel("Username", { exact: true })).toHaveValue(
    "inherited-user",
  );
  await settings
    .getByRole("button", { name: "Floating tip", exact: true })
    .click();
  await expect(
    settings.getByRole("checkbox", { name: "Model", exact: true }),
  ).toBeChecked();
  await expect(
    settings.getByRole("checkbox", { name: "Message time", exact: true }),
  ).not.toBeChecked();
  await settings
    .getByRole("checkbox", { name: "Input tokens", exact: true })
    .uncheck();
  await settings
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    settings.getByText("Settings applied", { exact: true }),
  ).toBeVisible();
  const saved = await readFile(
    join(app.rootDir, "codex-deck", "config.toml"),
    "utf-8",
  );
  expect(saved).toContain("input_tokens = false");
  expect(saved).not.toMatch(
    /port =|open =|dev =|translation_command =|http_proxy =|https_proxy =|no_proxy =|username =|model =|timestamp =/,
  );
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(settings.getByLabel("Port", { exact: false })).toHaveValue(
    "14000",
  );
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).not.toBeVisible();
  await page
    .getByRole("button", { name: "Codex Deck settings", exact: true })
    .click();
  await expect(settings).toBeVisible();
  await expect(
    settings.getByText("Loading settings", { exact: true }),
  ).not.toBeVisible();
  await expect(settings.getByLabel("Port", { exact: false })).toHaveValue(
    "14000",
  );
});

test("closing during a reload keeps settings usable on reopen", async ({
  page,
  app,
}) => {
  let reads = 0;
  let releaseReload!: () => void;
  let reloadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  await page.route("**/api/codex-deck/config", async (route) => {
    if (route.request().method() === "GET" && ++reads === 2) {
      reloadStarted();
      await released;
    }
    await route.continue();
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  const open = page.getByRole("button", {
    name: "Codex Deck settings",
    exact: true,
  });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await open.click();
  await expect(settings.getByLabel("Port", { exact: false })).toBeVisible();
  await settings
    .getByRole("button", { name: "Reload settings", exact: true })
    .click();
  await started;
  try {
    await settings.getByRole("button", { name: "Close settings" }).click();
    await open.click();
    await expect(settings.getByLabel("Port", { exact: false })).toBeEnabled();
  } finally {
    releaseReload();
  }
  await expect(
    settings.getByText("Loading settings", { exact: true }),
  ).not.toBeVisible();
  await expect(settings.getByLabel("Port", { exact: false })).toBeEnabled();
});

test("a delayed background refresh preserves edits and their saved revision", async ({
  page,
  app,
}) => {
  let reads = 0;
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/api/codex-deck/config", async (route) => {
    if (route.request().method() === "GET" && ++reads === 2) {
      const response = await route.fetch();
      refreshStarted();
      await released;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  const open = page.getByRole("button", {
    name: "Codex Deck settings",
    exact: true,
  });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const port = settings.getByLabel("Port", { exact: false });
  await open.click();
  await expect(port).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await open.click();
  await started;
  try {
    await port.fill("14001");
    await settings
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(
      settings.getByText("Settings applied", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseRefresh();
  }
  await expect(port).toHaveValue("14001");
  await port.fill("14002");
  await settings
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    settings.getByText("Settings applied", { exact: true }),
  ).toBeVisible();
  expect(
    await readFile(join(app.rootDir, "codex-deck", "config.toml"), "utf-8"),
  ).toContain("port = 14002");
});

test("reopening settings preserves unsaved forms and blank home rows", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  const open = page.getByRole("button", {
    name: "Codex Deck settings",
    exact: true,
  });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await open.click();
  const port = settings.getByLabel("Port", { exact: false });
  await expect(port).toBeVisible();
  await port.fill("14500");
  await settings.getByRole("button", { name: "Close settings" }).click();
  await open.click();
  await expect(port).toHaveValue("14500");
  await settings
    .getByRole("button", { name: "Reload settings", exact: true })
    .click();
  await expect(port).toHaveValue("");
  await settings
    .getByRole("button", { name: "Codex homes", exact: true })
    .click();
  await settings.getByRole("button", { name: "Add home", exact: true }).click();
  await expect(settings.getByLabel("Home ID", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await open.click();
  await settings
    .getByRole("button", { name: "Codex homes", exact: true })
    .click();
  await expect(settings.getByLabel("Home ID", { exact: true })).toBeVisible();
});
