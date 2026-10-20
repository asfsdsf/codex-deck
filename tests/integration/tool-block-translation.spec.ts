import type { CodexUserInputRequest } from "../../api/storage";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { responseItemRawLine } from "../unit/test-utils";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

const translated = (text: string) => `中文：${text}`;

for (const theme of ["dark", "light"] as const) {
  for (const placement of ["inline", "pending"] as const) {
    test(`plan and ${placement} question controls preserve structured content in ${theme} mode`, async ({
      page,
      context,
      app,
    }, testInfo) => {
      if (theme === "light")
        await page.setViewportSize({ width: 390, height: 844 });
      await context.addInitScript(
        (value) => localStorage.setItem("codex-deck:theme:v1", value),
        theme,
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      // These UI checks do not need a real Codex app-server or its plugin setup.
      await page.route("**/api/codex/**", (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Codex metadata unavailable" },
        }),
      );
      const request: CodexUserInputRequest = {
        requestId: "translate-question",
        threadId: app.sessions.alpha,
        turnId: "turn-1",
        itemId: "translate-question-item",
        isBlocking: false,
        questions: [
          {
            id: "audience",
            header: "Audience",
            question: "Who is the report for?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Engineers", description: "Technical details" },
              { label: "Executives", description: "High-level results" },
            ],
          },
          {
            id: "requirements",
            header: "Requirements",
            question: "Any other requirements?",
            isOther: true,
            isSecret: false,
            options: [],
          },
        ],
      };
      let requests = [request];
      const answers: unknown[] = [];
      await page.route(
        "**/api/codex/threads/*/requests/user-input**",
        async (route) => {
          if (route.request().method() === "GET") {
            await route.fulfill({ json: { requests } });
          } else {
            answers.push(route.request().postDataJSON());
            requests = [];
            await route.fulfill({ json: { ok: true } });
          }
        },
      );
      const calls: string[] = [];
      let failNextPlanTranslation = true;
      await page.route("**/api/translate", async (route) => {
        const body = route.request().postDataJSON();
        expect(body.inputLang).toBe("en");
        expect(body.outputLang).toBe("zh");
        calls.push(body.text);
        if (body.text === "Run focused tests" && failNextPlanTranslation) {
          failNextPlanTranslation = false;
          await route.fulfill({ status: 503, json: { error: "Try again" } });
        } else {
          await route.fulfill({
            json: { translatedText: translated(body.text) },
          });
        }
      });
      const records = [
        responseItemRawLine({
          type: "function_call",
          call_id: "translation-plan",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "Inspect the existing code", status: "completed" },
              { step: "Implement the controls", status: "in_progress" },
              { step: "Run focused tests", status: "pending" },
            ],
          }),
        }),
        ...(placement === "inline"
          ? [
              responseItemRawLine({
                type: "function_call",
                call_id: request.itemId,
                name: "request_user_input",
                arguments: JSON.stringify({ questions: request.questions }),
              }),
            ]
          : []),
      ];
      await appendFile(
        join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
        records.join("\n") + "\n",
      );
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (theme === "light")
        await page.getByRole("button", { name: "Collapse left pane" }).click();

      const translatePlan = page.getByRole("button", {
        name: "Translate plan to Chinese",
      });
      await page
        .getByRole("button", { name: "Copy plan", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(
          "- [x] Inspect the existing code\n- [ ] Implement the controls (in progress)\n- [ ] Run focused tests",
        );
      await translatePlan.click();
      await expect(
        page.getByRole("status").filter({ hasText: "Translation failed" }),
      ).toBeVisible();
      await translatePlan.click();
      await expect(
        page.getByText(translated("Inspect the existing code"), {
          exact: true,
        }),
      ).toHaveClass(/line-through/);
      await expect(
        page.getByText(translated("Implement the controls"), { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(translated("Implement the controls"), { exact: true }),
      ).toHaveClass(/text-amber-200/);
      const planCalls = calls.length;
      await page
        .getByRole("button", { name: "Show original", exact: true })
        .click();
      await translatePlan.click();
      expect(calls).toHaveLength(planCalls);

      const answer = page.getByRole("textbox", {
        name: "Any other requirements?",
        exact: true,
      });
      await answer.fill("Keep my draft while translating.");
      const translateQuestions = page.getByRole("button", {
        name: "Translate questions to Chinese",
      });
      await translateQuestions.click();
      await expect(
        page.getByText(translated("Who is the report for?"), { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(translated("Technical details"), { exact: true }),
      ).toBeVisible();
      await expect(answer).toHaveValue("Keep my draft while translating.");
      await page
        .getByRole("button", { name: "Copy questions", exact: true })
        .click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(translated("Who is the report for?"));
      expect(copied).toContain(
        `- ${translated("Engineers")}: ${translated("Technical details")}`,
      );
      expect(copied).not.toContain("Keep my draft while translating.");
      expect(calls).not.toContain("Keep my draft while translating.");
      expect(calls).not.toContain("audience");
      const questionCalls = calls.length;
      const questionActions = page.locator(
        '[data-text-block-actions="questions"]',
      );
      await questionActions
        .getByRole("button", { name: "Show original", exact: true })
        .click();
      await expect(answer).toHaveValue("Keep my draft while translating.");
      await translateQuestions.click();
      expect(calls).toHaveLength(questionCalls);
      await answer.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`controls-${theme}-${placement}.png`),
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", {
          name: `${translated("Engineers")} ${translated("Technical details")}`,
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Submit answers", exact: true })
        .click();
      await expect
        .poll(() => answers)
        .toEqual([
          {
            answers: {
              audience: { answers: ["Engineers"] },
              requirements: { answers: ["Keep my draft while translating."] },
            },
          },
        ]);
    });
  }
}
