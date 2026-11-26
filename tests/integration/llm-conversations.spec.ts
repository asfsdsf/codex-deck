import { createServer } from "node:http";
import { once } from "node:events";
import { test, expect } from "./helpers/codex-deck-fixture";

test("add a provider, continue chat from another tab, and switch back to Codex", async ({
  page,
  context,
  app,
}) => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
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
    await expect(settings.getByText("No LLM providers")).toBeVisible();
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
    await page.getByRole("menuitem", { name: "Add LLM provider" }).click();
    await settings.getByLabel("Provider name").fill("Test provider");
    await settings
      .getByLabel("OpenAI-compatible API URL")
      .fill("http://127.0.0.1:" + address.port + "/v1");
    await settings.getByLabel("Model ID").fill("example");
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
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("First question");
    await input.press("Enter");
    await expect(page.getByText("Received 1 messages")).toBeVisible();
    const id = await page.getByTitle("Conversation ID").textContent();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const second = await context.newPage();
    await second.goto(app.baseURL, { waitUntil: "domcontentloaded" });
    await second.getByRole("button", { name: /^Codex home:/ }).click();
    await second.getByRole("menuitemradio", { name: /Test provider/ }).click();
    await second
      .getByRole("navigation", { name: "Conversation history" })
      .getByRole("button", { name: "First question" })
      .click();
    await expect(second.getByTitle("Conversation ID")).toHaveText(id!);
    const followup = second.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await followup.fill("Follow up");
    await followup.press("Enter");
    await expect(second.getByText("Received 3 messages")).toBeVisible();
    await page.bringToFront();
    await expect(page.getByText("Received 3 messages")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Conversation history" })
      .selectOption(id!);
    await expect(page.getByText("Received 3 messages")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 960 });
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
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
