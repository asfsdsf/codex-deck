import { expect, test } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("package views open in both panes and unload when disabled", async ({
  app,
  page,
  request,
}) => {
  const id = "example.pane-notes";
  const manifest = {
    schemaVersion: 1,
    id,
    name: "Notebook",
    version: "1.0.0",
    description: "Workspace notes",
    capabilities: [],
    entrypoints: {},
    contributions: {
      views: [
        {
          id: "left",
          title: "Notes list",
          slot: "pane.left",
          entrypoint: "notes.html",
        },
        {
          id: "right",
          title: "Notes page",
          slot: "pane.right",
          entrypoint: "notes.html",
        },
      ],
    },
  };
  const files = [
    ["plugin.json", JSON.stringify(manifest)],
    ["notes.html", "<h1>Notebook contents</h1>"],
  ].map(([path, content]) => ({
    path,
    contentBase64: Buffer.from(content).toString("base64"),
  }));
  const result = await request.post(`${app.baseURL}/api/deck/plugins/install`, {
    data: { files },
  });
  expect(result.ok(), await result.text()).toBe(true);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await page.getByRole("button", { name: "Notes list", exact: true }).click();
  await expect(
    page.locator(".pane-left").frameLocator("iframe").getByRole("heading"),
  ).toHaveText("Notebook contents");
  await page.getByRole("button", { name: "Expand right pane" }).click();
  await page.getByRole("button", { name: "Notes page", exact: true }).click();
  await expect(
    page.locator(".pane-right").frameLocator("iframe").getByRole("heading"),
  ).toHaveText("Notebook contents");
  const disable = await request.post(
    `${app.baseURL}/api/deck/plugins/${id}/enabled`,
    { data: { enabled: false } },
  );
  expect(disable.ok()).toBe(true);
  await expect(page.locator('iframe[title="Notebook"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Notes list", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Notes page" })).toHaveCount(0);
  await expect(
    page.locator('[data-right-pane-guide-entry="git"]'),
  ).toBeVisible();
});

test("More browses plugins and prepares an unsent pane-specific draft", async ({
  app,
  page,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "More left pane options" }).click();
  await page.getByRole("menuitem", { name: "Browse other plugins" }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins" });
  await expect(
    dialog.getByRole("searchbox", { name: "Search Deck plugins" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Expand right pane" }).click();
  await page.getByRole("button", { name: "More right pane options" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Create your plugin" }),
  ).toBeInViewport();
  let sent = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages(?:\?|$)/.test(request.url()))
      sent++;
  });
  await page.route("**/api/codex/threads", (route) =>
    route.fulfill({
      json: { threadId: "99999999-9999-9999-9999-999999999999" },
    }),
  );
  await page.getByRole("menuitem", { name: "Create your plugin" }).click();
  await expect(page.getByPlaceholder("Ask Codex anything...")).toHaveValue(
    /slot "pane.right"/,
  );
  expect(sent).toBe(0);
});

test("disabling package layouts restores the built-in panes", async ({
  app,
  page,
  request,
}) => {
  const id = "example.layout";
  const manifest = {
    schemaVersion: 1,
    id,
    name: "Custom workspace",
    version: "1.0.0",
    description: "Alternate pane layouts",
    capabilities: [],
    entrypoints: {},
    contributions: {
      views: [
        {
          id: "left",
          title: "Custom navigation",
          slot: "layout.left",
          entrypoint: "nav.html",
        },
        {
          id: "right",
          title: "Custom tools",
          slot: "layout.right",
          entrypoint: "tools.html",
        },
      ],
    },
  };
  const files = [
    ["plugin.json", JSON.stringify(manifest)],
    ["nav.html", "<h1>Notebook navigation</h1>"],
    ["tools.html", "<h1>Project notebook</h1>"],
  ].map(([path, content]) => ({
    path,
    contentBase64: Buffer.from(content).toString("base64"),
  }));
  const result = await request.post(`${app.baseURL}/api/deck/plugins/install`, {
    data: { files },
  });
  expect(result.ok(), await result.text()).toBe(true);
  await page.goto(app.baseURL);
  await expect(
    page
      .getByRole("complementary", { name: "Custom navigation" })
      .frameLocator("iframe")
      .getByRole("heading"),
  ).toHaveText("Notebook navigation");
  await page.getByRole("button", { name: "Expand right pane" }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Custom tools" })
      .frameLocator("iframe")
      .getByRole("heading"),
  ).toHaveText("Project notebook");
  await page.getByRole("button", { name: "More left pane options" }).click();
  await page.getByRole("menuitem", { name: "Browse other plugins" }).click();
  await page
    .getByRole("dialog", { name: "Plugins" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  expect(
    (
      await request.post(`${app.baseURL}/api/deck/plugins/${id}/enabled`, {
        data: { enabled: false },
      })
    ).ok(),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Workflow", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-right-pane-guide-entry="files"]'),
  ).toBeVisible();
});
