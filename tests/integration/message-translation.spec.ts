import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

const plan = (text: string) => `<proposed_plan>\n## ${text}\n</proposed_plan>`;
const review = (text: string) =>
  JSON.stringify({
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: text,
    overall_confidence_score: 1,
  });

for (const scenario of [
  {
    name: "preserves a matching plan format",
    source: plan("Source plan"),
    sourceText: "Source plan",
    translated: plan("翻译后的计划"),
    translatedText: "翻译后的计划",
    originalKind: "plan",
    translatedKind: "plan",
  },
  {
    name: "falls back to markdown when a plan format is lost",
    source: plan("Source plan"),
    sourceText: "Source plan",
    translated: "## 翻译后的普通消息",
    translatedText: "翻译后的普通消息",
    originalKind: "plan",
    translatedKind: "markdown",
  },
  {
    name: "detects a new special type in the translation",
    source: review("Source review"),
    sourceText: "Source review",
    translated: plan("翻译后的计划"),
    translatedText: "翻译后的计划",
    originalKind: "review",
    translatedKind: "plan",
  },
  {
    name: "preserves a matching review format",
    source: review("Source review"),
    sourceText: "Source review",
    translated: review("翻译后的审查"),
    translatedText: "翻译后的审查",
    originalKind: "review",
    translatedKind: "review",
  },
]) {
  test(`message translation ${scenario.name}`, async ({ page, app }) => {
    await app.appendSessionMessage("alpha", "assistant", scenario.source);
    let requests = 0;
    await page.route("**/api/translate", async (route) => {
      expect(route.request().postDataJSON().text).toBe(scenario.source);
      requests += 1;
      await route.fulfill({ json: { translatedText: scenario.translated } });
    });
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    const message = page
      .getByText(scenario.sourceText, { exact: true })
      .locator("xpath=ancestor::div[contains(@class, 'group relative')][1]");
    await expect(message).toBeVisible();
    // Keep the locator stable when the source text is replaced.
    const messages = page.locator("div.group.relative");
    const index = await messages.evaluateAll(
      (elements, source) =>
        elements.findIndex((element) => element.textContent?.includes(source)),
      scenario.sourceText,
    );
    const block = messages.nth(index);
    const planLabel = block.getByText("Plan Proposal", { exact: true });
    const reviewCard = block.getByRole("region", { name: "Code review" });
    await expect(planLabel).toHaveCount(
      scenario.originalKind === "plan" ? 1 : 0,
    );
    await expect(reviewCard).toHaveCount(
      scenario.originalKind === "review" ? 1 : 0,
    );

    await block.hover();
    await block
      .getByRole("button", { name: "Translate message to Chinese" })
      .click();
    await expect(
      block.getByText(scenario.translatedText, { exact: true }),
    ).toBeVisible();
    await expect(planLabel).toHaveCount(
      scenario.translatedKind === "plan" ? 1 : 0,
    );
    await expect(reviewCard).toHaveCount(
      scenario.translatedKind === "review" ? 1 : 0,
    );
    await expect(
      block.getByText(scenario.sourceText, { exact: true }),
    ).toHaveCount(0);

    await block
      .getByRole("button", { name: "Show original", exact: true })
      .click();
    await expect(
      block.getByText(scenario.sourceText, { exact: true }),
    ).toBeVisible();
    await expect(planLabel).toHaveCount(
      scenario.originalKind === "plan" ? 1 : 0,
    );
    await expect(reviewCard).toHaveCount(
      scenario.originalKind === "review" ? 1 : 0,
    );
    await block
      .getByRole("button", { name: "Translate message to Chinese" })
      .click();
    await expect(
      block.getByText(scenario.translatedText, { exact: true }),
    ).toBeVisible();
    expect(requests).toBe(1);
  });
}
