import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test.describe("codex-deck integration", () => {
  test("loads sessions and filters them by project and search text", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectProject("project-beta");
    await codexDeckPage.expectSessionVisible(
      "Summarize the beta release notes",
    );
    await codexDeckPage.expectSessionHidden("Review the launch checklist");

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.filterSessions("launch");
    await codexDeckPage.expectSessionVisible("Review the launch checklist");
    await codexDeckPage.expectSessionHidden("Summarize the beta release notes");

    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();
  });

  test("searches inside the selected conversation", async ({ page, app }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();
    await codexDeckPage.openConversationSearch();
    await codexDeckPage.searchConversation("launch");

    await expect(page.locator("[data-conversation-search-match]")).toHaveCount(
      2,
    );
    await expect(page.getByText("1/2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Next search result" }).click();
    await expect(page.getByText("2/2", { exact: true })).toBeVisible();
  });

  test("keeps conversation search focused while typing", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();
    await codexDeckPage.openConversationSearch();

    const searchInput = page.getByRole("searchbox", {
      name: "Search conversation",
    });
    await searchInput.click();
    await page.keyboard.type("l");
    await expect(searchInput).toBeFocused();

    await page.keyboard.type("aunch");

    await expect(searchInput).toBeFocused();
    await expect(searchInput).toHaveValue("launch");
    await expect(page.getByText("1/2", { exact: true })).toBeVisible();
  });

  test("resets conversation search when switching sessions", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();
    await codexDeckPage.openConversationSearch();
    await codexDeckPage.searchConversation("launch");

    await expect(page.locator("[data-conversation-search-match]")).toHaveCount(
      2,
    );
    await expect(page.getByText("1/2", { exact: true })).toBeVisible();

    await codexDeckPage.selectSession("Summarize the beta release notes");
    await expect(page.getByText("Beta release notes are ready.")).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search conversation" }),
    ).toBeHidden();
    await expect(page.locator("[data-conversation-search-match]")).toHaveCount(
      0,
    );

    await codexDeckPage.openConversationSearch();
    await expect(
      page.getByRole("searchbox", { name: "Search conversation" }),
    ).toHaveValue("");
    await expect(page.getByText("0/0", { exact: true })).toBeVisible();
  });

  test("updates the session list when a new session is created", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);
    const liveSessionId = "44444444-4444-4444-4444-444444444444";
    const livePrompt = "Triage the production incident timeline";
    const liveReply = "I captured a full timeline with owner handoffs.";

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.expectSessionVisible("Review the launch checklist");

    await app.createSession({
      sessionId: liveSessionId,
      projectKey: "beta",
      prompt: livePrompt,
      assistantReply: liveReply,
    });

    await codexDeckPage.expectSessionVisible(livePrompt);
    await codexDeckPage.selectSession(livePrompt);
    await expect(page.getByText(liveReply)).toBeVisible();
  });

  test("warns for history-only stale sessions without removing them", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);
    const stalePrompt = "History-only session without a rollout file";

    await page.goto(app.baseURL, { waitUntil: "domcontentloaded" });
    await codexDeckPage.expectSessionVisible("Review the launch checklist");
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();

    await app.createHistoryOnlySession({
      sessionId: "99999999-9999-9999-9999-999999999999",
      prompt: stalePrompt,
    });

    await codexDeckPage.expectSessionVisible(stalePrompt);

    const dialogPromise = page.waitForEvent("dialog");
    await codexDeckPage.selectSession(stalePrompt);
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/session does not exist/i);
    await dialog.accept();

    await codexDeckPage.expectSessionVisible(stalePrompt);
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Choose a session from the list to view the conversation",
      ),
    ).toBeHidden();
  });

  test("browses the selected session project files in the file tree", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await codexDeckPage.chooseRightPaneMode("File tree");
    await codexDeckPage.openProjectDirectory("src");
    await codexDeckPage.openProjectFile("main.ts");

    await expect(page.getByText("launchChecklist")).toBeVisible();
    await expect(page.getByText("ship docs")).toBeVisible();
  });

  test("deletes a session and keeps the remaining sessions accessible", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();

    await codexDeckPage.requestDeleteSession(app.sessions.alpha);
    await codexDeckPage.expectDeleteSessionPrompt(
      "Review the launch checklist",
    );
    await codexDeckPage.confirmDeleteSession();

    await codexDeckPage.expectSessionHidden("Review the launch checklist");
    await expect(page.getByText("2 sessions", { exact: true })).toBeVisible();

    await codexDeckPage.selectSession("Summarize the beta release notes");
    await expect(page.getByText("Beta release notes are ready.")).toBeVisible();
    await expect(app.readSessionFile("alpha")).rejects.toThrow();
  });

  test("fixes a dangling turn from the session view", async ({ page, app }) => {
    test.slow();
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Investigate the stalled turn");

    await expect(page.getByText("Working...")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Fix dangling" }),
    ).toBeVisible({
      timeout: 12_000,
    });

    await page.getByRole("button", { name: "Fix dangling" }).click();
    await expect(page.getByText("Fix dangling turns?")).toBeVisible();
    await page.getByRole("button", { name: "Proceed" }).click();

    await expect(page.getByText("Working...")).not.toBeVisible();

    const updatedSession = await app.readSessionFile("dangling");
    expect(updatedSession).toContain('"type":"task_complete"');
    expect(updatedSession).toContain(
      "Synthetic completion generated by Fix dangling",
    );
  });

  test("deletes the selected session from the sidebar and clears the view", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();

    await codexDeckPage.requestDeleteSession(app.sessions.alpha);
    await codexDeckPage.expectDeleteSessionConfirmVisible();
    await codexDeckPage.cancelDeleteSession();

    await expect(page.getByText("Delete this session?")).not.toBeVisible();
    await codexDeckPage.expectSessionVisible("Review the launch checklist");
    await expect(
      page.getByText("Search launch references before shipping."),
    ).toBeVisible();

    await codexDeckPage.requestDeleteSession(app.sessions.alpha);
    await codexDeckPage.expectDeleteSessionConfirmVisible();
    await expect(
      page.getByText("This will delete the session rollout file"),
    ).toBeVisible();
    await codexDeckPage.confirmDeleteSession();

    await expect(page.getByText("Delete this session?")).not.toBeVisible();
    await expect(page.getByText("Deleted session.")).toBeVisible();
    await codexDeckPage.expectSessionHidden("Review the launch checklist");
    await codexDeckPage.expectSessionVisible(
      "Summarize the beta release notes",
    );
    await expect(
      page.getByText("Choose a session from the list to view the conversation"),
    ).toBeVisible();

    await expect.poll(() => app.sessionFileExists("alpha")).toBe(false);
    await expect(app.readSessionFile("alpha")).rejects.toThrow(/ENOENT/);
    await expect(app.readSessionFile("alpha")).rejects.toThrow(
      /ENOENT|no such file/i,
    );
    await codexDeckPage.selectSession("Summarize the beta release notes");
    await expect(page.getByText("Beta release notes are ready.")).toBeVisible();
  });

  test("cancels dangling-turn fix without changing the session file", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Investigate the stalled turn");

    const beforeCancel = await app.readSessionFile("dangling");

    await page.getByRole("button", { name: "Fix dangling" }).click();
    await expect(page.getByText("Fix dangling turns?")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByText("Fix dangling turns?")).not.toBeVisible();

    const afterCancel = await app.readSessionFile("dangling");
    expect(afterCancel).toBe(beforeCancel);
    expect(afterCancel).not.toContain('"type":"task_complete"');
    expect(afterCancel).not.toContain(
      "Synthetic completion generated by Fix dangling",
    );
  });

  test("updates the selected conversation when the session file changes", async ({
    page,
    app,
  }) => {
    const codexDeckPage = new CodexDeckPage(page);
    const streamedMessage = "SSE update from an appended session message.";

    await codexDeckPage.goto(app.baseURL);
    await codexDeckPage.selectSession("Review the launch checklist");

    await app.appendSessionMessage("alpha", "assistant", streamedMessage);

    await expect(page.getByText(streamedMessage)).toBeVisible();
  });
});
