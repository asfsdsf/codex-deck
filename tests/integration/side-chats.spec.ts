import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import { responseItemMessageLine, sessionMetaLine } from "../unit/test-utils";

test("attached side chats open separately and can be closed and reopened", async ({
  app,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const threads = [];
  for (const [id, title] of [
    ["42424242-4242-4242-4242-424242424242", "First side chat"],
    ["52525252-5252-5252-5252-525252525252", "Second side chat"],
  ]) {
    const meta = JSON.parse(
      sessionMetaLine(id, app.projects.alpha, Date.now()),
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
        responseItemMessageLine("user", title),
        responseItemMessageLine("assistant", `Answer for ${title}`),
        "",
      ].join("\n"),
    );
    threads.push({
      threadId: id,
      name: title,
      attachedToThreadId: app.sessions.alpha,
      source: "tui_side_chat",
      cwd: app.projects.alpha,
      status: "idle",
    });
  }
  await page.route(`**/api/codex/threads/${app.sessions.alpha}/side`, (route) =>
    route.fulfill({ json: { threads } }),
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");

  const tabs = page.getByRole("navigation", { name: "Side chats" });
  const first = tabs.getByRole("button", {
    name: "First side chat",
    exact: true,
  });
  await first.click();
  await expect(
    page.getByText("Answer for First side chat", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Answer for Second side chat", { exact: true }),
  ).toHaveCount(0);
  await tabs.getByRole("button", { name: "Close First side chat" }).click();
  await expect(
    tabs.getByRole("button", { name: "Main conversation" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(first).toHaveCount(0);
  await tabs
    .getByRole("combobox", { name: "Reopen side chat" })
    .selectOption({ label: "First side chat" });
  await expect(first).toHaveAttribute("aria-current", "page");
  await tabs
    .getByRole("button", { name: "Second side chat", exact: true })
    .click();
  await expect(
    page.getByText("Answer for Second side chat", { exact: true }),
  ).toBeVisible();
});
