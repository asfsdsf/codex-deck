import type { CodexUserInputRequest } from "../../api/storage";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { responseItemRawLine } from "../unit/test-utils";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

for (const theme of ["dark", "light"] as const) {
  test(`acknowledged async tool questions send chat replies in ${theme} mode`, async ({
    page,
    context,
    app,
  }, testInfo) => {
    await context.addInitScript(
      (value) => localStorage.setItem("codex-deck:theme:v1", value),
      theme,
    );
    if (theme === "light")
      await page.setViewportSize({ width: 390, height: 844 });
    await appendFile(
      join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
      [
        responseItemRawLine({
          type: "function_call",
          call_id: "async-call",
          name: "request_user_input_async",
          arguments: JSON.stringify({
            questions: [{ title: "Which GPU and checkpoint will you use?" }],
          }),
        }),
        responseItemRawLine({
          type: "function_call_output",
          call_id: "async-call",
          output: '{"accepted":true}',
        }),
        "",
      ].join("\n"),
    );
    await context.route("**/api/codex/threads/*/requests/user-input", (route) =>
      route.fulfill({ json: { requests: [] } }),
    );
    let failNextReply = true;
    const replies: string[] = [];
    await context.route("**/api/codex/threads/*/messages", async (route) => {
      if (failNextReply) {
        failNextReply = false;
        await route.fulfill({
          status: 500,
          json: { error: "Transient failure" },
        });
        return;
      }
      const text = route.request().postDataJSON().input[0].text;
      replies.push(text);
      await app.appendSessionMessage("alpha", "user", text);
      await route.fulfill({ json: { turnId: "reply-turn" } });
    });
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    if (theme === "light")
      await page.getByRole("button", { name: "Collapse left pane" }).click();
    const answer = page.getByRole("textbox", {
      name: "Which GPU and checkpoint will you use?",
      exact: true,
    });
    await expect(answer).toBeEnabled();
    await answer.fill("H100 + Qwen3.5-9B BF16");
    await app.appendSessionMessage(
      "alpha",
      "assistant",
      "Checking the backends while you answer.",
    );
    await expect(
      page.getByText("Checking the backends while you answer.", {
        exact: true,
      }),
    ).toBeVisible();
    // Polling an empty RPC list must not discard a message-based answer draft.
    await page.waitForResponse((response) =>
      response.url().endsWith("/requests/user-input"),
    );
    await expect(answer).toHaveValue("H100 + Qwen3.5-9B BF16");
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not send your answer" }),
    ).toBeVisible();
    await expect(answer).toBeEnabled();
    await expect(answer).toHaveValue("H100 + Qwen3.5-9B BF16");
    await page.screenshot({
      path: testInfo.outputPath(`async-message-${theme}.png`),
    });
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(answer).toBeDisabled();
    expect(replies).toEqual([
      "Question: Which GPU and checkpoint will you use?\nAnswer: H100 + Qwen3.5-9B BF16",
    ]);
    await page.reload();
    await expect(answer).toBeDisabled();
    await expect(answer).toHaveValue("H100 + Qwen3.5-9B BF16");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

for (const placement of ["pending", "inline"] as const) {
  for (const answerKind of ["free-text", "custom"] as const) {
    test(`${answerKind} textarea follows the resize cursor in ${placement} questions`, async ({
      page,
      app,
    }) => {
      const request: CodexUserInputRequest = {
        requestId: "resize",
        threadId: app.sessions.alpha,
        turnId: "turn-1",
        itemId: "resize-question",
        isBlocking: false,
        questions: [
          {
            id: "requirements",
            header: "Requirements",
            question: "Any other requirements?",
            isOther: true,
            isSecret: false,
            options:
              answerKind === "custom"
                ? [
                    {
                      label: "Use defaults",
                      description: "Keep the current settings",
                    },
                  ]
                : [],
          },
        ],
      };
      await app.appendSessionMessage(
        "alpha",
        "assistant",
        Array.from({ length: 40 }, (_, i) => `Progress update ${i + 1}.`).join(
          "\n\n",
        ),
      );
      if (placement === "inline") {
        await appendFile(
          join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
          responseItemRawLine({
            type: "function_call",
            call_id: request.itemId,
            name: "request_user_input_async",
            arguments: JSON.stringify({ questions: request.questions }),
          }) + "\n",
        );
      }
      await page.route("**/api/codex/threads/*/requests/user-input", (route) =>
        route.fulfill({ json: { requests: [request] } }),
      );
      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      if (answerKind === "custom") {
        await page.getByRole("button", { name: /None of the above/ }).click();
      }
      const answer = page.getByRole("textbox", {
        name:
          answerKind === "custom"
            ? "Custom answer: Any other requirements?"
            : "Any other requirements?",
        exact: true,
      });
      await answer.fill("Keep my draft while resizing.");
      const container = page.locator("[data-conversation-scroll]");
      await container.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          container.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(1);
      const start = (await answer.boundingBox())!;
      const handle = (await answer
        .locator("..")
        .getByRole("button", { name: "Resize answer", exact: true })
        .boundingBox())!;
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        for (const delta of [20, 40, 60, 30, -10, 40]) {
          await page.mouse.move(x, y + delta, { steps: 4 });
          await expect(async () => {
            const current = (await answer.boundingBox())!;
            expect(
              Math.abs(current.height - start.height - delta),
            ).toBeLessThanOrEqual(2);
            expect(Math.abs(current.y - start.y)).toBeLessThanOrEqual(2);
          }).toPass({ timeout: 1_000 });
        }
      } finally {
        await page.mouse.up();
      }
      await expect(answer).toHaveValue("Keep my draft while resizing.");
      expect(
        Math.abs((await answer.boundingBox())!.y - start.y),
      ).toBeLessThanOrEqual(2);
      // Releasing the handle restores normal navigation and following new output.
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await expect
        .poll(() =>
          container.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(1);
      await app.appendSessionMessage(
        "alpha",
        "assistant",
        "Progress after resizing.",
      );
      await expect(
        page.getByText("Progress after resizing.", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          container.evaluate(
            (element) =>
              element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect(answer).toHaveValue("Keep my draft while resizing.");
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`async questions stay answerable during progress in ${theme} mode`, async ({
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
    let requests: CodexUserInputRequest[] = [
      {
        requestId: "choice",
        threadId: app.sessions.alpha,
        turnId: "turn-1",
        itemId: "async-message-1",
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
        ],
      },
      {
        requestId: "free-text",
        threadId: app.sessions.alpha,
        turnId: "turn-1",
        itemId: "async-message-2",
        isBlocking: false,
        questions: [
          {
            id: "requirements",
            header: "Requirements",
            question: "Any other requirements?",
            isOther: true,
            isSecret: false,
            options: [],
          },
        ],
      },
    ];
    const answers: Array<{ requestId: string; payload: unknown }> = [];
    let failNextFreeTextAnswer = true;
    await context.route(
      "**/api/codex/threads/*/requests/user-input**",
      async (route) => {
        const request = route.request();
        if (request.method() === "GET") {
          await route.fulfill({ json: { requests } });
          return;
        }
        const requestId = decodeURIComponent(
          new URL(request.url()).pathname.split("/").at(-2)!,
        );
        if (requestId === "free-text" && failNextFreeTextAnswer) {
          failNextFreeTextAnswer = false;
          await route.fulfill({
            status: 500,
            json: { error: "Transient failure" },
          });
          return;
        }
        answers.push({ requestId, payload: request.postDataJSON() });
        requests = requests.filter(
          (pending) => pending.requestId !== requestId,
        );
        await route.fulfill({ json: { ok: true } });
      },
    );
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    if (theme === "light") {
      await page.getByRole("button", { name: "Collapse left pane" }).click();
    }
    const pending = page.getByRole("region", { name: "Pending questions" });
    await expect(
      pending.locator("[data-pending-user-input-request]"),
    ).toHaveCount(2);
    const freeText = pending.getByRole("textbox", {
      name: "Any other requirements?",
    });
    await freeText.fill("Include runnable examples");

    await app.appendSessionMessage(
      "alpha",
      "assistant",
      "I am gathering the implementation details while you answer.",
    );
    await expect(
      page.getByText(
        "I am gathering the implementation details while you answer.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(freeText).toHaveValue("Include runnable examples");
    await expect(
      pending.locator("[data-pending-user-input-request]"),
    ).toHaveCount(2);
    await pending.scrollIntoViewIfNeeded();
    expect(
      await pending.evaluate(
        (element) => element.getBoundingClientRect().width,
      ),
    ).toBeGreaterThan(300);
    await page.screenshot({
      path: testInfo.outputPath(`async-questions-${theme}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // A second browser page answers one request; the first keeps its unrelated draft.
    if (theme === "dark") {
      const second = await context.newPage();
      const other = new CodexDeckPage(second);
      await other.goto(app.baseURL);
      await other.selectSession("Review the launch checklist");
      await second
        .getByRole("region", { name: "Pending questions" })
        .getByRole("button", { name: /Engineers/ })
        .click();
      await page.bringToFront();
      await expect(
        pending.locator("[data-pending-user-input-request]"),
      ).toHaveCount(1);
      await second.close();
    } else {
      await pending.getByRole("button", { name: /Engineers/ }).click();
      await expect(
        pending.locator("[data-pending-user-input-request]"),
      ).toHaveCount(1);
    }
    await expect(freeText).toHaveValue("Include runnable examples");
    await pending.getByRole("button", { name: "Submit answers" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not send your answer" }),
    ).toBeVisible();
    await expect(freeText).toHaveValue("Include runnable examples");
    await pending.getByRole("button", { name: "Submit answers" }).click();
    await expect(pending).toHaveCount(0);
    expect(answers).toEqual([
      {
        requestId: "choice",
        payload: { answers: { audience: { answers: ["Engineers"] } } },
      },
      {
        requestId: "free-text",
        payload: {
          answers: { requirements: { answers: ["Include runnable examples"] } },
        },
      },
    ]);
  });
}
