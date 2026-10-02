import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import {
  eventMsgLine,
  responseItemMessageLine,
  sessionMetaLine,
} from "../unit/test-utils";

test("floating tip settings persist in TOML and update another browser without reloading", async ({
  page,
  context,
  app,
}) => {
  const path = join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`);
  await appendFile(
    path,
    [
      JSON.stringify({
        type: "turn_context",
        payload: {
          model: "recorded-model",
          effort: "high",
          service_tier: "fast",
        },
      }),
      responseItemMessageLine("assistant", "Reply with measured usage"),
      eventMsgLine({
        type: "token_count",
        info: {
          model_context_window: 1000,
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            cached_input_tokens: 50,
          },
        },
      }),
      "",
    ].join("\n"),
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const second = await context.newPage();
  const other = new CodexDeckPage(second);
  await other.goto(app.baseURL);
  await other.selectSession("Review the launch checklist");
  const reply = second.locator('[data-conversation-message="4"]');
  await reply.hover();
  const tooltip = second.getByRole("tooltip");
  await expect(
    tooltip.getByText("Input tokens", { exact: true }),
  ).toBeVisible();
  await expect(tooltip.getByText("50.0%", { exact: true })).toBeVisible();
  await expect(tooltip.getByText("recorded-model")).toHaveCount(0);

  const loadingConfig = page.waitForResponse((response) =>
    response.url().includes("/api/codex-deck/config"),
  );
  await page
    .getByRole("button", { name: "Codex Deck settings", exact: true })
    .click();
  const loadedConfig = await (await loadingConfig).json();
  expect(typeof loadedConfig.revision).toBe("string");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings
    .getByRole("button", { name: "Floating tip", exact: true })
    .click();
  await settings.getByRole("checkbox", { name: "Model", exact: true }).check();
  await settings
    .getByRole("checkbox", { name: "Reasoning effort", exact: true })
    .check();
  await settings
    .getByRole("checkbox", { name: "Service tier", exact: true })
    .check();
  await settings
    .getByRole("checkbox", { name: "Input tokens", exact: true })
    .uncheck();
  await settings
    .getByRole("checkbox", { name: "Message number", exact: true })
    .uncheck();
  await settings
    .getByRole("checkbox", { name: "Message time", exact: true })
    .uncheck();
  await settings
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(
    settings.getByText("Settings applied", { exact: true }),
  ).toBeVisible();
  await reply.hover();
  await expect(
    tooltip.getByText("recorded-model", { exact: true }),
  ).toBeVisible();
  await expect(
    tooltip.getByText("Reasoning effort", { exact: true }),
  ).toBeVisible();
  await expect(
    tooltip.getByText("Service tier", { exact: true }),
  ).toBeVisible();
  await expect(tooltip.getByText("Input tokens", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    tooltip.locator("time, [data-hover-message-number]"),
  ).toHaveCount(0);
  const toml = await readFile(
    join(app.rootDir, "codex-deck", "config.toml"),
    "utf-8",
  );
  expect(toml).toContain("[conversation_hover]");
  expect(toml).toContain("model = true");
  expect(toml).toContain("input_tokens = false");

  await settings
    .getByRole("checkbox", { name: "Show floating tip", exact: true })
    .uncheck();
  await settings
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(tooltip).toHaveCount(0);
  await reply.hover();
  await expect(tooltip).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Reset defaults", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await reply.hover();
  await expect(tooltip.locator("[data-hover-message-number]")).toHaveText("#4");
  await expect(
    tooltip.getByText("Input tokens", { exact: true }),
  ).toBeVisible();
  await second.close();
});

test("direct config edits select fields and work on a mobile layout in both themes", async ({
  page,
  app,
}) => {
  const configDir = join(app.rootDir, "codex-deck");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  await writeFile(
    configPath,
    "[conversation_hover]\nmessage_number = false\ntimestamp = true\n",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page
    .getByRole("button", { name: "Collapse left pane", exact: true })
    .click();
  const reply = page.locator('[data-conversation-message="3"]');
  await reply.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip.locator("time")).toHaveCount(1);
  await expect(tooltip.locator("[data-hover-message-number]")).toHaveCount(0);
  await writeFile(
    configPath,
    "[conversation_hover]\nmessage_number = true\ntimestamp = false\n",
  );
  await expect(tooltip.locator("[data-hover-message-number]")).toHaveText("#3");
  await expect(tooltip.locator("time")).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await reply.hover();
    expect(
      await tooltip.evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    await page
      .getByRole("button", { name: "Expand left pane", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Codex Deck settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Floating tip", exact: true })
      .click();
    await expect(
      settings.getByRole("checkbox", {
        name: "Show floating tip",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Collapse left pane", exact: true })
      .click();
  }
});

test("additional Codex homes receive global floating tip preferences on their shared stream", async ({
  page,
  app,
}) => {
  const workHome = join(app.rootDir, "work-home");
  await mkdir(join(workHome, "sessions"), { recursive: true });
  await mkdir(join(workHome, "codex-deck"), { recursive: true });
  await writeFile(
    join(workHome, "codex-deck", "config.toml"),
    "[conversation_hover]\nenabled = false\n",
  );
  await writeFile(
    join(workHome, "sessions", "work-session.jsonl"),
    [
      sessionMetaLine("work-session", app.projects.alpha, Date.now()),
      responseItemMessageLine("user", "Work home conversation"),
      responseItemMessageLine("assistant", "Work home reply"),
      "",
    ].join("\n"),
  );
  const currentConfig = await (
    await page.request.get(`${app.baseURL}/api/codex-deck/config`)
  ).json();
  const content = `[codex_homes.work]\npath = ${JSON.stringify(workHome)}\nlabel = "Work"\n\n[conversation_hover]\nmessage_number = false\ntimestamp = true\n`;
  const saved = await page.request.post(
    `${app.baseURL}/api/codex-deck/config`,
    {
      data: { revision: currentConfig.revision, content },
    },
  );
  expect(saved.ok()).toBe(true);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await page
    .getByRole("combobox", { name: "Codex home", exact: true })
    .selectOption("work");
  await ui.selectSession("Work home conversation");
  const reply = page.locator('[data-conversation-message="2"]');
  await reply.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip.locator("time")).toHaveCount(1);
  await expect(tooltip.locator("[data-hover-message-number]")).toHaveCount(0);
  await writeFile(
    join(app.rootDir, "codex-deck", "config.toml"),
    content
      .replace("message_number = false", "message_number = true")
      .replace("timestamp = true", "timestamp = false"),
  );
  await expect(tooltip.locator("[data-hover-message-number]")).toHaveText("#2");
  await expect(tooltip.locator("time")).toHaveCount(0);
});
