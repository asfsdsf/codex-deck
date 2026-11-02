import { test, expect } from "./helpers/codex-deck-fixture";
import { mockStreamingTranslations } from "./helpers/translation-stream";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemRawLine } from "../unit/test-utils";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

test("messages and structured plans display translation output before completion", async ({
  page,
  app,
}) => {
  const source = "Review the launch checklist";
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    responseItemRawLine({
      type: "function_call",
      call_id: "stream-plan",
      name: "update_plan",
      arguments: JSON.stringify({
        plan: [{ step: "Inspect streaming", status: "in_progress" }],
      }),
    }) + "\n",
  );
  const stream = await mockStreamingTranslations(page);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession(source);
  try {
    await page
      .getByRole("button", { name: "Translate message to Chinese" })
      .first()
      .click();
    await expect(
      page.getByText(`部分：${source}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Translate plan to Chinese" })
      .click();
    await expect(
      page.getByText("部分：Inspect streaming", { exact: true }),
    ).toBeVisible();
    stream.release();
    await expect(
      page.getByText(`完整：${source}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("完整：Inspect streaming", { exact: true }),
    ).toBeVisible();
  } finally {
    stream.release();
  }
});

test("composer displays partial translations and restores the original draft on toggle", async ({
  page,
  app,
}) => {
  const stream = await mockStreamingTranslations(page);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const input = page.getByPlaceholder("Message Codex...");
  const source = "请检查流式翻译";
  await input.fill(source);
  try {
    const button = page.getByRole("button", {
      name: "Translate to English",
      exact: true,
    });
    await button.click();
    await expect(input).toHaveValue(`部分：${source}`);
    await expect(button).toBeDisabled();
    stream.release();
    await expect(input).toHaveValue(`完整：${source}`);
    await page
      .getByRole("button", { name: "Show original", exact: true })
      .click();
    await expect(input).toHaveValue(source);
  } finally {
    stream.release();
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`message tables retain their formatting through translation and toggling in ${theme} mode`, async ({
    page,
    app,
  }) => {
    if (theme === "light")
      await page.setViewportSize({ width: 390, height: 844 });
    const source = [
      "### Release status",
      "",
      "| **Feature** | State |",
      "| :--- | ---: |",
      "| [Launch](https://example.com/launch) | Ready |",
      "| `pnpm test` | Pending |",
    ].join("\n");
    await app.appendSessionMessage("alpha", "assistant", source);
    const requests: string[] = [];
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/translate", async (route) => {
      const { text } = route.request().postDataJSON();
      const translationId = String(requests.push(text) - 1);
      await route.fulfill({
        json: { translationId, translatedText: "", done: false },
      });
    });
    await page.route("**/api/translations/**", async (route) => {
      const url = new URL(route.request().url());
      const translationId = url.pathname.split("/")[3];
      const text = requests[Number(translationId)];
      if (url.pathname.endsWith("/stream")) {
        await route.fulfill({
          contentType: "text/event-stream",
          body: `event: translation\ndata: ${JSON.stringify({ translationId, translatedText: `部分：${text} | **文字**`, done: false })}\n\n`,
        });
      } else {
        await completed;
        await route.fulfill({
          json: {
            translationId,
            translatedText: `译文：${text} | 文字`,
            done: true,
          },
        });
      }
    });
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    await ui.selectSession("Review the launch checklist");
    const message = page.locator("[data-conversation-message]").filter({
      has: page.getByRole("table"),
    });
    const table = message.getByRole("table");
    const translate = message.getByRole("button", {
      name: "Translate message to Chinese",
    });
    const tableStructure = () =>
      table.evaluate((element) =>
        Array.from(element.querySelectorAll("*"), (child) => ({
          tag: child.tagName,
          class: child.className,
        })),
      );
    await expect(table).toBeVisible();
    const original = await tableStructure();
    try {
      await translate.click();
      await expect(
        message.getByText("部分：Release status | **文字**", { exact: true }),
      ).toBeVisible();
      expect(await tableStructure()).toEqual(original);
      release();
      const translatedTable = page.getByRole("table").filter({
        has: page.getByText("译文：Feature | 文字", { exact: true }),
      });
      await expect(
        translatedTable.getByRole("cell", {
          name: "译文：Ready | 文字",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await translatedTable.evaluate((element) =>
          Array.from(element.querySelectorAll("*"), (child) => ({
            tag: child.tagName,
            class: child.className,
          })),
        ),
      ).toEqual(original);
      await expect(translatedTable.getByRole("link")).toHaveAttribute(
        "href",
        "https://example.com/launch",
      );
      await expect(translatedTable.locator("code")).toHaveText("pnpm test");
      await message.getByRole("button", { name: "Show original" }).click();
      await expect(
        table.getByRole("cell", { name: "Ready", exact: true }),
      ).toBeVisible();
      expect(await tableStructure()).toEqual(original);
      const requestCount = requests.length;
      await translate.click();
      await expect(translatedTable).toBeVisible();
      expect(requests.length).toBe(requestCount);
    } finally {
      release();
    }
  });
}
