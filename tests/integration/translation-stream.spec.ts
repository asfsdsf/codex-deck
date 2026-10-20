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
