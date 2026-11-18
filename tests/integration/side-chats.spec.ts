import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemMessageLine, sessionMetaLine } from "../unit/test-utils";

for (const colorScheme of ["light", "dark"] as const) {
  test(`side chat labels, visibility, and view mode in ${colorScheme}`, async ({
    app,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    const threads = [];
    const startedAt = Date.now();
    for (const [id, title] of [
      ["42424242-4242-4242-4242-424242424242", "First side chat"],
      ["52525252-5252-5252-5252-525252525252", "Second side chat"],
    ]) {
      const timestamp = startedAt - threads.length * 1000;
      const messageTimestamp = new Date(timestamp).toISOString();
      const meta = JSON.parse(
        sessionMetaLine(id, app.projects.alpha, timestamp),
      );
      Object.assign(meta.payload, {
        attached_thread: true,
        forked_from_id: app.sessions.alpha,
        thread_source: "tui_side_chat",
        history_mode: "paginated",
        history_base: {
          thread_id: app.sessions.alpha,
          end_ordinal_exclusive: 1,
          end_byte_offset: 100,
        },
      });
      await writeFile(
        join(app.rootDir, "sessions", `${id}.jsonl`),
        [
          JSON.stringify(meta),
          responseItemMessageLine("user", title, messageTimestamp),
          responseItemMessageLine(
            "assistant",
            `Answer for ${title}`,
            messageTimestamp,
          ),
          "",
        ].join("\n"),
      );
      threads.push({
        threadId: id,
        name: "Launch notes",
        attachedToThreadId: app.sessions.alpha,
        source: "tui_side_chat",
        cwd: app.projects.alpha,
        status: "idle",
      });
    }
    await page.route(
      `**/api/codex/threads/${app.sessions.alpha}/side`,
      (route) => route.fulfill({ json: { threads } }),
    );
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    await page.getByRole("button", { name: "Collapse left pane" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      colorScheme,
    );

    const tabs = page.getByRole("navigation", { name: "Side chats" });
    const main = tabs.getByRole("button", { name: "Main conversation" });
    const filter = tabs.getByRole("button", { name: "Filter side chats" });
    const add = tabs.getByRole("button", { name: "New side chat" });
    const visibility = tabs.getByRole("group", {
      name: "Side chat visibility",
    });
    const first = tabs.getByTitle("Launch notes", { exact: true });
    const second = tabs.getByTitle("Launch notes (1)", { exact: true });
    const firstVisibility = visibility.getByRole("button", {
      name: "Launch notes",
      exact: true,
    });
    const secondVisibility = visibility.getByRole("button", {
      name: "Launch notes (1)",
    });
    const hideFirst = tabs.getByRole("button", {
      name: "Hide Launch notes",
      exact: true,
    });
    const deleteFirst = tabs.getByRole("button", {
      name: "Delete Launch notes",
      exact: true,
    });
    const deleteSecond = tabs.getByRole("button", {
      name: "Delete Launch notes (1)",
    });
    const firstAnswer = page.getByText("Answer for First side chat", {
      exact: true,
    });
    const secondAnswer = page.getByText("Answer for Second side chat", {
      exact: true,
    });
    const transparent = "rgba(0, 0, 0, 0)";

    await expect(main).toHaveAttribute("aria-current", "page");
    await expect(main).not.toHaveCSS("background-color", transparent);
    await expect(first).toHaveText("Launch notes");
    await expect(second).toHaveText("Launch notes (1)");
    await expect(deleteFirst).toHaveCount(0);
    await expect(deleteSecond).toHaveCount(0);
    await filter.click();
    await expect(firstVisibility).toHaveAttribute("aria-pressed", "true");
    await expect(secondVisibility).toHaveAttribute("aria-pressed", "true");
    await first.click();
    await expect(visibility).toBeHidden();
    await expect(main).toHaveCSS("background-color", transparent);
    await expect(firstAnswer).toBeVisible();
    await expect(secondAnswer).toHaveCount(0);
    await expect(deleteFirst).toBeVisible();
    await expect(deleteSecond).toHaveCount(0);

    await hideFirst.click();
    await expect(main).toHaveAttribute("aria-current", "page");
    await expect(first).toHaveCount(0);
    await expect(second).toHaveText("Launch notes (1)");
    await filter.press("Enter");
    await expect(firstVisibility).toHaveAttribute("aria-pressed", "false");
    await expect(firstVisibility).toHaveCSS("background-color", transparent);
    await expect(secondVisibility).toHaveAttribute("aria-pressed", "true");
    await expect(secondVisibility).not.toHaveCSS(
      "background-color",
      transparent,
    );
    await secondVisibility.click();
    await expect(second).toHaveCount(0);
    await expect(secondVisibility).toHaveAttribute("aria-pressed", "false");
    await firstVisibility.click();
    await expect(first).toBeVisible();
    await expect(main).toHaveAttribute("aria-current", "page");
    const [tabEnd, filterBounds, addBounds] = await Promise.all([
      hideFirst.boundingBox(),
      filter.boundingBox(),
      add.boundingBox(),
    ]);
    if (!tabEnd || !filterBounds || !addBounds) {
      throw new Error("Side chat controls have no bounds");
    }
    expect(filterBounds.y).toBeCloseTo(tabEnd.y);
    expect(filterBounds.x - (tabEnd.x + tabEnd.width)).toBeCloseTo(5);
    expect(addBounds.x - (filterBounds.x + filterBounds.width)).toBeCloseTo(4);
    await firstVisibility.press("Escape");
    await expect(filter).toBeFocused();
    await expect(visibility).toBeHidden();

    await first.click();
    await firstAnswer.dblclick();
    await expect(page.locator("[data-conversation-view-mode]")).toHaveCount(1);
    await expect(tabs).toBeHidden();
    await expect(firstAnswer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tabs).toBeVisible();
    await expect(first).toHaveAttribute("aria-current", "page");
    await expect(second).toHaveCount(0);

    await filter.click();
    await secondVisibility.click();
    await second.click();
    await expect(secondAnswer).toBeVisible();
    await expect(deleteFirst).toHaveCount(0);
    await deleteSecond.click();
    const deleteDialog = page
      .getByRole("dialog")
      .filter({ hasText: "Delete this session?" });
    await expect(deleteDialog).toContainText("Launch notes");
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(second).toHaveAttribute("aria-current", "page");
  });
}
