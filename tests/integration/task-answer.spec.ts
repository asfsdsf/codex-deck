import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { mockStreamingTranslations } from "./helpers/translation-stream";
import { CodexDeckPage } from "./pages/codex-deck-page";
import {
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
} from "../unit/test-utils";

test("one click translates every paragraph in the answer and copies the whole translation", async ({
  page,
  context,
  app,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const firstAnswer =
    "The deployment steps are ready.\n\nSearch launch references before shipping.";
  const answer =
    "First answer paragraph.\n\n**Second answer paragraph.**\n\n```ts\nconst result = true;\n```\n\nFinal answer paragraph.";
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    [
      eventMsgLine({ type: "task_complete", turn_id: "turn-1" }),
      eventMsgLine({ type: "task_started", turn_id: "turn-2" }),
      responseItemMessageLine("user", "Check the next task"),
      responseItemMessageLine("assistant", "First answer paragraph."),
      responseItemRawLine({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Private reasoning" }],
      }),
      responseItemRawLine({
        type: "function_call",
        call_id: "answer-tool",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "pnpm test" }),
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "answer-tool",
        output: "Every test passed.",
      }),
      responseItemRawLine({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "**Second answer paragraph.**\n\n```ts\nconst result = true;\n```",
          },
          { type: "output_text", text: "Final answer paragraph." },
        ],
      }),
      eventMsgLine({ type: "task_complete", turn_id: "turn-2" }),
    ].join("\n") + "\n",
  );
  const stream = await mockStreamingTranslations(page);
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const actions = page.getByRole("group", { name: "Completed task actions" });
  await expect(actions).toHaveCount(2);
  await actions
    .first()
    .getByRole("button", { name: "Copy entire answer", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(firstAnswer);
  await actions
    .last()
    .getByRole("button", { name: "Copy entire answer", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(answer);
  try {
    await actions
      .last()
      .getByRole("button", {
        name: "Translate entire answer to Chinese",
        exact: true,
      })
      .click();
    await expect.poll(() => stream.sources).toEqual([answer]);
    const translated = page.getByRole("region", { name: "Translated answer" });
    await expect(translated).toContainText("部分：");
    const copyTranslation = page.getByRole("button", {
      name: "Copy entire translation",
      exact: true,
    });
    await expect(copyTranslation).toBeDisabled();
    stream.release();
    await expect(translated).toHaveAttribute("aria-busy", "false");
    await expect(translated).toContainText("First answer paragraph.");
    await expect(translated).toContainText("Final answer paragraph.");
    await expect(translated).not.toContainText("Codex conversation");
    await expect(translated).not.toContainText("Check the next task");
    await expect(translated).not.toContainText("Every test passed.");
    await copyTranslation.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`完整：${answer}`);
    await actions
      .last()
      .getByRole("button", { name: "Hide answer translation", exact: true })
      .click();
    await expect(translated).toBeHidden();
    await actions
      .last()
      .getByRole("button", {
        name: "Translate entire answer to Chinese",
        exact: true,
      })
      .click();
    await expect(translated).toBeVisible();
    expect(stream.sources).toEqual([answer]);
  } finally {
    stream.release();
  }
});

test("answer controls appear live on completion and stay hidden for interrupted work", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Investigate the stalled turn");
  const actions = page.getByRole("group", { name: "Completed task actions" });
  await expect(actions).toHaveCount(0);
  const path = join(app.rootDir, "sessions", `${app.sessions.dangling}.jsonl`);
  await appendFile(
    path,
    eventMsgLine({ type: "turn_aborted", turn_id: "turn-stalled-1" }) + "\n",
  );
  await expect(
    page.getByText(/user interrupted the previous turn/).first(),
  ).toBeVisible();
  await expect(actions).toHaveCount(0);
  await appendFile(
    path,
    [
      eventMsgLine({ type: "task_started", turn_id: "turn-retry" }),
      responseItemMessageLine("user", "Try again"),
      responseItemMessageLine("assistant", "The retry succeeded."),
      eventMsgLine({ type: "task_complete", turn_id: "turn-retry" }),
    ].join("\n") + "\n",
  );
  await expect(actions).toHaveCount(1);
  await expect(
    actions.getByRole("button", { name: "Copy entire answer", exact: true }),
  ).toBeVisible();
});

test("mobile answer controls support both themes, clipboard fallback, and retries", async ({
  page,
  context,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addInitScript(() => {
    localStorage.setItem("codex-deck:theme:v1", "light");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    document.execCommand = (command: string) => {
      if (command !== "copy") return false;
      const area = document.activeElement;
      if (area instanceof HTMLTextAreaElement)
        (window as unknown as { copiedAnswer: string }).copiedAnswer =
          area.value;
      return true;
    };
  });
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    eventMsgLine({ type: "task_complete", turn_id: "turn-1" }) + "\n",
  );
  let failCopy = true;
  await page.route(
    `**/api/conversation/${app.sessions.alpha}`,
    async (route) => {
      if (failCopy) {
        failCopy = false;
        await route.fulfill({
          status: 503,
          json: { error: "History temporarily unavailable" },
        });
      } else await route.continue();
    },
  );
  const chinese = "第一段的完整翻译。\n\n第二段的完整翻译。";
  let failTranslation = true;
  await page.route("**/api/translate", async (route) => {
    await route.fulfill(
      failTranslation
        ? {
            status: 503,
            json: { error: "Translation temporarily unavailable" },
          }
        : { json: { translatedText: chinese } },
    );
    failTranslation = false;
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "Collapse left pane" }).click();
  const actions = page.getByRole("group", { name: "Completed task actions" });
  const copy = actions.getByRole("button", {
    name: "Copy entire answer",
    exact: true,
  });
  await copy.click();
  await expect(page.getByRole("alert")).toContainText(
    "History temporarily unavailable",
  );
  await copy.click();
  await expect(copy).toHaveText("Copied!");
  expect(
    await page.evaluate(
      () => (window as unknown as { copiedAnswer: string }).copiedAnswer,
    ),
  ).toBe(
    "The deployment steps are ready.\n\nSearch launch references before shipping.",
  );
  const translate = actions.getByRole("button", {
    name: "Translate entire answer to Chinese",
    exact: true,
  });
  await translate.click();
  await expect(page.getByRole("alert")).toContainText(
    "Translation temporarily unavailable",
  );
  await translate.click();
  await expect(
    page.getByRole("region", { name: "Translated answer" }),
  ).toContainText("第二段的完整翻译。");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Copy entire translation", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { copiedAnswer: string }).copiedAnswer,
    ),
  ).toBe(chinese);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.style.colorScheme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, theme);
    await actions.scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", {
        name: "Copy entire translation",
        exact: true,
      }),
    ).toBeVisible();
    const box = await actions.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath(`answer-translation-mobile-${theme}.png`),
    });
  }
});

test("long multi-paragraph answers translate through the real API and copy completely", async ({
  page,
  context,
  app,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const first = "First answer paragraph 中文 😀. ".repeat(1000).trim();
  const last =
    "**Final answer paragraph.**\n\n```ts\nconst done = true;\n```\n\nEND-OF-ANSWER";
  const answer = `${first}\n\n${last}`;
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    [
      eventMsgLine({ type: "task_started", turn_id: "long-answer" }),
      responseItemMessageLine("user", "Explain the result"),
      responseItemMessageLine("assistant", first),
      responseItemRawLine({
        type: "function_call",
        call_id: "large-tool",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "echo tool-output" }),
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "large-tool",
        output: "Tool output, not part of the answer.\n".repeat(5000),
      }),
      responseItemMessageLine("assistant", last),
      eventMsgLine({ type: "task_complete", turn_id: "long-answer" }),
    ].join("\n") + "\n",
  );
  const configuration = await (
    await page.request.get(`${app.baseURL}/api/codex-deck/config`)
  ).json();
  const configured = await page.request.post(
    `${app.baseURL}/api/codex-deck/config`,
    {
      data: {
        content: "translation_command = \"printf '%s' $PROMPT\"\n",
        revision: configuration.revision,
      },
    },
  );
  expect(configured.ok()).toBe(true);
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/translate")
      chunks.push(request.postDataJSON().text);
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const actions = page.getByRole("group", { name: "Completed task actions" });
  await actions
    .getByRole("button", {
      name: "Translate entire answer to Chinese",
      exact: true,
    })
    .click();
  const translated = page.getByRole("region", { name: "Translated answer" });
  await expect(translated).toHaveAttribute("aria-busy", "false");
  await expect(translated).toContainText("END-OF-ANSWER");
  await expect(translated).not.toContainText(
    "Tool output, not part of the answer.",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("").replace(/\s/g, "")).toBe(answer.replace(/\s/g, ""));
  await page
    .getByRole("button", { name: "Copy entire translation", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(answer);
});

test("the greeting translates every answer paragraph and copies both Chinese paragraphs", async ({
  page,
  context,
  app,
}) => {
  const first = "I'm Codex, OpenAI's coding assistant.";
  const second = "I can help you understand, write, review, and debug code.";
  const chinese =
    "我是 Codex，OpenAI 的编程助手。\n\n我可以帮助你理解、编写、审查和调试代码。";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    [
      eventMsgLine({ type: "task_started", turn_id: "greeting" }),
      responseItemMessageLine("user", "Hello, who are you?"),
      responseItemMessageLine("assistant", first),
      responseItemMessageLine("assistant", second),
      eventMsgLine({ type: "task_complete", turn_id: "greeting" }),
    ].join("\n") + "\n",
  );
  const sources: string[] = [];
  await page.route("**/api/translate", async (route) => {
    sources.push(route.request().postDataJSON().text);
    await route.fulfill({ json: { translatedText: chinese } });
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const actions = page.getByRole("group", { name: "Completed task actions" });
  await actions
    .getByRole("button", {
      name: "Translate entire answer to Chinese",
      exact: true,
    })
    .click();
  const translated = page.getByRole("region", { name: "Translated answer" });
  await expect(translated).toContainText("我是 Codex，OpenAI 的编程助手。");
  await expect(translated).toContainText(
    "我可以帮助你理解、编写、审查和调试代码。",
  );
  expect(sources).toEqual([`${first}\n\n${second}`]);
  await page
    .getByRole("button", { name: "Copy entire translation", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(chinese);
  await actions
    .getByRole("button", { name: "Hide answer translation", exact: true })
    .click();
  await actions
    .getByRole("button", {
      name: "Translate entire answer to Chinese",
      exact: true,
    })
    .click();
  await expect(translated).toBeVisible();
  expect(sources).toEqual([`${first}\n\n${second}`]);
});

test("copy and translation preserve the answer and commands but exclude exec wrappers and execution output", async ({
  page,
  context,
  app,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const first =
    "# Answer\n\nThe requested fix is ready.\n\n## Commands\n\n```sh\npnpm test\npnpm build\n```";
  const second = "## Result\n\nThe full answer remains readable.";
  const answer = `${first}\n\n${second}`;
  const chinese =
    "# 回答\n\n所需的修复已完成。\n\n## 命令\n\n```sh\npnpm test\npnpm build\n```\n\n## 结果\n\n完整回答可供阅读。";
  const wrapper =
    'const results = await Promise.allSettled([tools.view_image({path:"/private/tmp/answer-light.png"}),tools.view_image({path:"/private/tmp/answer-dark.png"})]); for (const r of results) if(r.status === "fulfilled") image(r.value.image_url);';
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    [
      eventMsgLine({ type: "task_started", turn_id: "clean-answer" }),
      responseItemMessageLine("user", "Explain the fix and include commands"),
      responseItemRawLine({
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: "Checking execution details and screenshots.",
          },
        ],
      }),
      responseItemRawLine({
        type: "custom_tool_call",
        name: "exec",
        call_id: "image-checks",
        input: wrapper,
      }),
      responseItemRawLine({
        type: "custom_tool_call_output",
        call_id: "image-checks",
        output:
          "Script completed\nWall time 0.0 seconds\nOutput:\nReturned image\nReturned image",
      }),
      ...[first, second].map((text) =>
        responseItemRawLine({
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        }),
      ),
      eventMsgLine({ type: "task_complete", turn_id: "clean-answer" }),
    ].join("\n") + "\n",
  );
  const sources: string[] = [];
  await page.route("**/api/translate", async (route) => {
    sources.push(route.request().postDataJSON().text);
    await route.fulfill({ json: { translatedText: chinese } });
  });
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const actions = page.getByRole("group", { name: "Completed task actions" });
  await expect(
    actions.getByRole("button", { name: "Copy entire answer", exact: true }),
  ).toHaveText("Copy answer");
  await actions
    .getByRole("button", { name: "Copy entire answer", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(answer);
  await actions
    .getByRole("button", {
      name: "Translate entire answer to Chinese",
      exact: true,
    })
    .click();
  const translated = page.getByRole("region", { name: "Translated answer" });
  await expect(translated).toHaveAttribute("aria-busy", "false");
  expect(sources).toEqual([answer]);
  const copyTranslation = actions.getByRole("button", {
    name: "Copy entire translation",
    exact: true,
  });
  await expect(copyTranslation).toHaveText("Copy translation");
  await copyTranslation.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(chinese);
  await expect(translated).not.toContainText("Script completed");
  await expect(translated).not.toContainText("Checking execution details");
});
