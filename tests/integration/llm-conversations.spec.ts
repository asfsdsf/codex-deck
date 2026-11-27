import { createServer } from "node:http";
import { once } from "node:events";
import { test, expect } from "./helpers/codex-deck-fixture";

test("add a provider, continue chat from another tab, and switch back to Codex", async ({
  page,
  context,
  app,
}) => {
  const efforts: (string | undefined)[] = [];
  const sentModels: string[] = [];
  let discoveryRequests = 0;
  let releaseAnswer!: () => void;
  const answerReady = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  const upstream = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      discoveryRequests++;
      if (
        req.headers.authorization !== "Bearer mock-key" ||
        discoveryRequests > 2
      ) {
        res.writeHead(403).end();
        return;
      }
      const id = discoveryRequests === 1 ? "first-model" : "refreshed-model";
      res.end(JSON.stringify({ data: [{ id, display_name: "Listed " + id }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages, reasoning_effort, stream, model } = JSON.parse(
      Buffer.concat(chunks).toString(),
    );
    if (messages.length > 1 && stream) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Streaming is unsupported" }));
      return;
    }
    efforts.push(reasoning_effort);
    sentModels.push(model);
    if (messages.length === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"delta":{"reasoning_content":"Checking the route."}}]}\n\n',
      );
      await answerReady;
      res.end(
        'data: {"choices":[{"delta":{"content":"Received 1 messages"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: "Received " + messages.length + " messages" } },
        ],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw Error("Missing mock provider port");
  try {
    await page.goto(app.baseURL, { waitUntil: "domcontentloaded" });
    const selector = page.getByRole("button", { name: /^Codex home:/ });
    await page
      .getByRole("button", { name: "Codex Deck settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings
      .getByRole("button", { name: "Codex homes", exact: true })
      .click();
    const addProvider = settings.getByRole("button", {
      name: "Add provider",
      exact: true,
    });
    await expect(addProvider).toHaveAttribute("aria-expanded", "false");
    await expect(settings.getByText("No chat providers")).toBeVisible();
    await expect(settings.getByLabel("Provider name")).toHaveCount(0);
    await addProvider.click();
    await expect(settings.getByLabel("Provider name")).toBeFocused();
    await settings
      .locator("form")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(settings.getByLabel("Provider name")).toHaveCount(0);
    await settings.getByRole("button", { name: "Close settings" }).click();
    await selector.click();
    await page.getByRole("menuitem", { name: "Add chat provider" }).click();
    await settings.getByLabel("Provider name").fill("Test provider");
    await settings
      .getByLabel("OpenAI-compatible API URL")
      .fill("http://127.0.0.1:" + address.port + "/v1");
    await settings.getByLabel("Model ID").fill("example");
    await settings.getByLabel("Default reasoning effort").fill("medium");
    await settings.getByLabel("API key (optional)").fill("mock-key");
    await settings
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(
      settings.getByText("Test provider", { exact: true }),
    ).toBeVisible();
    await expect(settings.getByLabel("Provider name")).toHaveCount(0);
    await settings.getByRole("button", { name: "Close settings" }).click();
    await selector.click();
    await page.getByRole("menuitemradio", { name: /Test provider/ }).click();
    const right = page.getByRole("complementary", { name: "Right pane" });
    const expandRight = page.getByRole("button", {
      name: "Expand right pane",
      exact: true,
    });
    await expandRight.click();
    await expect(
      right.getByRole("tab", { name: "Start", exact: true }),
    ).toBeVisible();
    await expect(right.locator("[data-right-pane-guide-entry]")).toHaveCount(0);
    const handle = right.getByRole("separator", {
      name: "Resize right pane",
      exact: true,
    });
    const grip = await handle.boundingBox();
    expect(grip).toBeTruthy();
    const initialWidth = await right.evaluate((el) => el.clientWidth);
    const x = grip!.x + grip!.width / 2,
      y = grip!.y + grip!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 140, y, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() => right.evaluate((el) => el.clientWidth))
      .toBe(initialWidth + 140);
    await right.getByRole("button", { name: "Split", exact: true }).click();
    const docks = right.locator(".right-pane__dock");
    await expect(docks).toHaveCount(2);
    await docks
      .last()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(docks).toHaveCount(1);
    await right
      .getByRole("button", { name: "Fullscreen", exact: true })
      .click();
    await expect(right).toHaveAttribute("data-fullscreen", "true");
    await right
      .getByRole("button", { name: "Exit fullscreen", exact: true })
      .click();
    await right.getByRole("button", { name: "Collapse right sidebar" }).click();
    await expect(right).toHaveCount(0);
    await expandRight.click();
    await expect
      .poll(() => right.evaluate((el) => el.clientWidth))
      .toBe(initialWidth + 140);
    const left = page.locator("aside.pane-left");
    const pluginsDialog = page.getByRole("dialog", {
      name: "Plugins",
      exact: true,
    });
    for (const pane of ["left", "right"]) {
      await page
        .getByRole("button", { name: `More ${pane} pane options` })
        .click();
      const menu = page.getByRole("menu", { name: `${pane} pane plugins` });
      await expect(menu.getByRole("menuitem")).toHaveCount(1);
      await menu
        .getByRole("menuitem", { name: "Browse other plugins" })
        .click();
      await expect(
        pluginsDialog.getByText(/^Installed \([1-9]\d*\)$/),
      ).toBeVisible();
      await pluginsDialog
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    await left.getByRole("button", { name: "plugins", exact: true }).click();
    await expect(
      pluginsDialog.getByRole("searchbox", { name: "Search Deck plugins" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pluginsDialog).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await page
      .getByRole("button", { name: "Default (example)", exact: true })
      .click();
    const picker = page.getByRole("listbox", { name: "Model", exact: true });
    await expect(
      picker.getByRole("option", { name: "Listed first-model" }),
    ).toBeVisible();
    await picker
      .getByRole("button", { name: "Fetch models from provider" })
      .click();
    await picker
      .getByRole("option", { name: "Listed refreshed-model" })
      .click();
    await input.fill("First question");
    await input.press("Enter");
    // Block mode exposes individual reasoning blocks when compact rails are enabled.
    const textMode = page.getByRole("button", {
      name: "Text Mode",
      exact: true,
    });
    if (await textMode.isVisible()) await textMode.click();
    const thinking = page.getByRole("button", { name: /^thinking/i });
    await thinking.click();
    await expect(
      page.getByText("Checking the route.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Received 1 messages")).toHaveCount(0);
    releaseAnswer();
    await expect(page.getByText("Received 1 messages")).toBeVisible();
    const id = await page.getByTitle("Conversation ID").textContent();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: app.baseURL,
    });
    await page.getByRole("button", { name: "Copy ID", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    await page
      .getByRole("button", { name: "Search this conversation" })
      .click();
    await page
      .getByRole("searchbox", { name: "Search conversation" })
      .fill("question");
    await expect(
      page.getByRole("button", { name: "Next search result" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Close search" }).click();

    const second = await context.newPage();
    await second.goto(app.baseURL, { waitUntil: "domcontentloaded" });
    await second.getByRole("button", { name: /^Codex home:/ }).click();
    await second.getByRole("menuitemradio", { name: /Test provider/ }).click();
    await second
      .getByRole("navigation", { name: "Conversation history" })
      .getByRole("button", { name: "First question" })
      .click();
    await expect(second.getByTitle("Conversation ID")).toHaveText(id!);
    const secondTextMode = second.getByRole("button", {
      name: "Text Mode",
      exact: true,
    });
    if (await secondTextMode.isVisible()) await secondTextMode.click();
    await second.getByRole("button", { name: /^thinking/i }).click();
    await expect(
      second.getByText("Checking the route.", { exact: true }),
    ).toBeVisible();
    const followup = second.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await second
      .getByRole("button", { name: "Default (example)", exact: true })
      .click();
    const customPicker = second.getByRole("listbox", {
      name: "Model",
      exact: true,
    });
    await expect(customPicker.getByRole("alert")).toContainText("HTTP 403");
    await customPicker
      .getByRole("textbox", { name: "Model", exact: true })
      .fill("vendor/custom-model");
    await customPicker
      .getByRole("option", { name: "Use custom value: vendor/custom-model" })
      .click();
    await second
      .getByRole("button", { name: "Effort: medium (default)" })
      .click();
    await second.getByRole("option", { name: "high", exact: true }).click();
    await followup.fill("Follow up");
    await followup.press("Enter");
    await expect(second.getByText("Received 3 messages")).toBeVisible();
    expect(efforts).toEqual(["medium", "high"]);
    expect(sentModels).toEqual(["refreshed-model", "vendor/custom-model"]);
    await page.bringToFront();
    await expect(page.getByText("Received 3 messages")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      right.getByRole("button", { name: "More right pane options" }),
    ).toBeInViewport();
    await right
      .getByRole("button", { name: "More right pane options" })
      .click();
    await page.getByRole("menuitem", { name: "Browse other plugins" }).click();
    await pluginsDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await right.getByRole("button", { name: "Collapse right sidebar" }).click();
    await expect(
      left.getByRole("button", { name: "Codex Deck settings" }),
    ).toBeInViewport();
    await left.getByRole("button", { name: "Collapse left pane" }).click();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Conversation history" })
      .selectOption(id!);
    await expect(page.getByText("Received 3 messages")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 960 });
    await left
      .getByRole("button", { name: "Expand left pane", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Codex Deck settings", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Codex homes", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Edit Test provider", exact: true })
      .click();
    await expect(settings.getByLabel("API key (optional)")).toHaveValue("");
    await expect(settings.getByLabel("OpenAI-compatible API URL")).toHaveValue(
      /\/v1\/chat\/completions$/,
    );
    await settings.getByLabel("Provider name").fill("Renamed provider");
    await settings
      .getByRole("button", { name: "Save provider", exact: true })
      .click();
    await expect(selector).toHaveAccessibleName("Codex home: Renamed provider");
    await expect(
      second.getByRole("button", {
        name: "Codex home: Renamed provider",
        exact: true,
      }),
    ).toBeVisible();
    await settings
      .getByRole("button", { name: "Remove Renamed provider", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Remove provider", exact: true })
      .click();
    await expect(selector).toHaveAccessibleName("Codex home: Main");
    await expect(
      second.getByRole("button", { name: "Codex home: Main", exact: true }),
    ).toBeVisible();
    await selector.click();
    await expect(
      page.getByRole("menuitemradio", { name: /Renamed provider/ }),
    ).toHaveCount(0);
  } finally {
    releaseAnswer();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
