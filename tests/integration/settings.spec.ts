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
    /port =|open =|dev =|translation_command =|username =|model =|timestamp =/,
  );
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(settings.getByLabel("Port", { exact: false })).toHaveValue(
    "14000",
  );
});
