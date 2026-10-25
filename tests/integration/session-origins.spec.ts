import { SIDE_CONVERSATION_BOUNDARY_PROMPT } from "../../api/session-origins";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemMessageLine } from "../unit/test-utils";

for (const kind of ["review", "side"] as const) {
  test(`existing ${kind} sessions show their badge and origin without Deck metadata`, async ({
    page,
    app,
  }) => {
    const childId = "55555555-5555-5555-5555-555555555555";
    const sourcePath = join(
      app.rootDir,
      "sessions",
      `${app.sessions.alpha}.jsonl`,
    );
    const path = join(app.rootDir, "sessions", `${childId}.jsonl`);
    const [first] = (await readFile(sourcePath, "utf8")).split("\n");
    const meta = JSON.parse(first);
    Object.assign(meta.payload, {
      id: childId,
      originator: "codex-tui",
      ...(kind === "review"
        ? {
            source: { subagent: "review" },
            thread_source: "subagent",
            parent_thread_id: app.sessions.beta,
          }
        : {
            forked_from_id: app.sessions.beta,
          }),
    });
    await writeFile(
      path,
      [
        JSON.stringify(meta),
        ...(kind === "side"
          ? [responseItemMessageLine("user", SIDE_CONVERSATION_BOUNDARY_PROMPT)]
          : []),
        responseItemMessageLine("user", `Existing ${kind} of the changes`),
        responseItemMessageLine("assistant", `Existing ${kind} complete.`),
        "",
      ].join("\n"),
    );
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    const badge = page.getByLabel(
      kind === "review" ? "Review session" : "Side session",
      { exact: true },
    );
    await expect(badge).toBeVisible();
    await badge.click();
    const origin = page.getByRole("button", {
      name: "Origin session",
      exact: true,
    });
    await expect(origin).toBeVisible();
    await page.reload();
    await badge.click();
    await expect(origin).toBeVisible();
    await origin.click();
    await expect(
      page
        .locator("[data-conversation-scroll]")
        .getByText("Beta release notes are ready.", { exact: true }),
    ).toBeVisible();
  });
}

for (const kind of ["review", "side"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`${kind} sessions show a badge and sticky origin navigation in ${theme} mode`, async ({
      page,
      context,
      app,
    }, testInfo) => {
      await context.addInitScript(
        (value) => localStorage.setItem("codex-deck:theme:v1", value),
        theme,
      );
      await context.route("**/api/codex/**", (route) =>
        route.fulfill({
          status: 503,
          json: { error: "Codex metadata unavailable" },
        }),
      );
      const childId = "44444444-4444-4444-4444-444444444444";
      await context.route(
        `**/api/codex/threads/${app.sessions.alpha}/${kind}`,
        async (route) => {
          await app.createSession({
            sessionId: childId,
            projectKey: "alpha",
            prompt: `A ${kind} conversation`,
            assistantReply: Array.from(
              { length: 60 },
              (_, index) => `Conversation detail ${index}.`,
            ).join("\n\n"),
          });
          const path = join(app.rootDir, "sessions", `${childId}.jsonl`);
          const [first, ...rest] = (await readFile(path, "utf8")).split("\n");
          const meta = JSON.parse(first);
          if (kind === "review") {
            // Model the metadata written by native review/start itself.
            Object.assign(meta.payload, {
              source: { subagent: "review" },
              parent_thread_id: app.sessions.alpha,
            });
          } else {
            Object.assign(meta.payload, {
              forked_from_id: app.sessions.alpha,
            });
            rest.unshift(
              responseItemMessageLine(
                "user",
                SIDE_CONVERSATION_BOUNDARY_PROMPT,
              ),
            );
          }
          await writeFile(path, [JSON.stringify(meta), ...rest].join("\n"));
          await route.fulfill({
            json:
              kind === "review"
                ? { threadId: childId, turnId: null }
                : {
                    thread: {
                      threadId: childId,
                      name: null,
                      preview: `A ${kind} conversation`,
                      cwd: app.projects.alpha,
                      agentNickname: null,
                      agentRole: null,
                      parentThreadId: app.sessions.alpha,
                      canAcceptDirectInput: true,
                      agentPath: null,
                      source: null,
                      status: "idle",
                      updatedAt: Date.now(),
                    },
                    parentThreadId: app.sessions.alpha,
                  },
          });
        },
      );

      const ui = new CodexDeckPage(page);
      await ui.goto(app.baseURL);
      await ui.selectSession("Review the launch checklist");
      const otherPage = await context.newPage();
      await otherPage.goto(app.baseURL);
      await expect(otherPage.getByPlaceholder("Search...")).toBeVisible();
      await page.bringToFront();
      await page.getByPlaceholder("Message Codex...").fill(`/${kind}`);
      await page.getByRole("button", { name: "Run", exact: true }).click();
      if (kind === "review") {
        await page
          .getByRole("button", { name: "Start review", exact: true })
          .click();
      }
      const badgeLabel = kind === "review" ? "Review session" : "Side session";
      await expect(page.getByLabel(badgeLabel, { exact: true })).toBeVisible();
      await otherPage.bringToFront();
      await expect(
        otherPage.getByLabel(badgeLabel, { exact: true }),
      ).toBeVisible();
      await otherPage.close();
      await page.bringToFront();

      if (theme === "light") {
        await page.setViewportSize({ width: 390, height: 844 });
        const collapse = page.getByRole("button", {
          name: "Collapse left pane",
        });
        if (await collapse.isVisible()) await collapse.click();
      }
      const conversation = page.locator("[data-conversation-scroll]");
      const origin = conversation.getByRole("button", {
        name: "Origin session",
        exact: true,
      });
      await expect(origin).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Return", exact: true }),
      ).toHaveCount(0);
      await conversation.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(origin).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-${theme}.png`),
      });
      await page.reload();
      const expand = page.getByRole("button", { name: "Expand left pane" });
      if (await expand.isVisible()) await expand.click();
      await page.getByLabel(badgeLabel, { exact: true }).click();
      if (theme === "light") {
        const collapse = page.getByRole("button", {
          name: "Collapse left pane",
        });
        if (await collapse.isVisible()) await collapse.click();
      }
      await expect(origin).toBeVisible();
      await origin.click();
      await expect(origin).toHaveCount(0);
      await expect(
        conversation.getByText("The deployment steps are ready.", {
          exact: true,
        }),
      ).toBeVisible();
    });
  }
}
