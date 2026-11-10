import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { responseItemMessageLine } from "../unit/test-utils";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("user message rail previews and navigates across virtual pages, follows scrolling, and receives live prompts", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 60 }, (_, index) =>
      [
        responseItemMessageLine("user", `Navigator prompt ${index + 2}`),
        ...Array.from({ length: 5 }, (_, step) =>
          responseItemMessageLine(
            "assistant",
            `Response ${index + 2}, step ${step + 1}`,
          ),
        ),
      ].join("\n"),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const nav = page.getByRole("navigation", { name: "User message navigation" });
  await expect(nav).toBeVisible();
  await expect(page.locator("[data-total-messages]")).toHaveText("363");
  const active = nav.locator('[aria-current="true"]');
  await expect(active).toHaveCount(1);
  expect(await nav.getByRole("button").count()).toBeLessThan(45);

  // Keyboard navigation can reach marks outside the rail's rendered window.
  await active.focus();
  await active.press("Home");
  const first = nav.getByRole("button", {
    name: "Jump to user message 1",
    exact: true,
  });
  await expect(first).toBeFocused();
  await expect(nav.getByRole("tooltip")).toContainText(
    "Review the launch checklist",
  );
  await first.press("Enter");
  await expect(
    page.locator('[data-conversation-message="1"]'),
  ).toBeInViewport();
  await expect(first).toHaveAttribute("aria-current", "true");
  await first.press("ArrowDown");
  const second = nav.getByRole("button", {
    name: "Jump to user message 2",
    exact: true,
  });
  await expect(second).toBeFocused();
  await expect(nav.getByRole("tooltip")).toContainText("Navigator prompt 2");
  await second.press("Escape");
  await expect(nav.getByRole("tooltip")).toHaveCount(0);

  // Hover and click a prompt on a different virtual page.
  await second.press("End");
  const last = nav.getByRole("button", {
    name: "Jump to user message 61",
    exact: true,
  });
  await expect(last).toBeFocused();
  await last.hover();
  await expect(nav.getByRole("tooltip")).toContainText("Navigator prompt 61");
  await page.screenshot({ path: testInfo.outputPath("navigator-history.png") });
  await last.click();
  await expect(
    page.locator('[data-conversation-message="358"]'),
  ).toBeInViewport();

  for (let index = 0; index < 16; index += 1)
    await page.keyboard.press("ArrowUp");
  const middle = nav.getByRole("button", {
    name: "Jump to user message 45",
    exact: true,
  });
  await expect(middle).toBeFocused();
  await middle.press("Enter");
  await expect(
    page.locator('[data-conversation-message="262"]'),
  ).toBeInViewport();
  await expect(middle).toHaveAttribute("aria-current", "true");

  // Ordinary transcript scrolling updates the current marker too.
  await page
    .locator("[data-conversation-scroll]")
    .click({ position: { x: 10, y: 10 } });
  await page.locator('[data-conversation-message="268"]').evaluate((node) => {
    const container = node.closest<HTMLElement>("[data-conversation-scroll]")!;
    container.scrollTop +=
      node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await expect(active).toHaveAttribute("aria-label", "Jump to user message 46");

  await app.appendSessionMessage(
    "alpha",
    "user",
    "A live navigator prompt\n\n" +
      "A paragraph of a tall final prompt.\n\n".repeat(80),
  );
  await expect(page.locator("[data-total-messages]")).toHaveText("364");
  await active.focus();
  await active.press("End");
  const live = nav.getByRole("button", {
    name: "Jump to user message 62",
    exact: true,
  });
  await expect(live).toBeFocused();
  await expect(nav.getByRole("tooltip")).toContainText(
    "A live navigator prompt",
  );
  await live.press("Enter");
  await expect(
    page.locator('[data-conversation-message="364"]'),
  ).toBeInViewport();
  await expect(page.locator("[data-conversation-position]")).toHaveAttribute(
    "data-current-message",
    "364",
  );

  await ui.selectSession("Summarize the beta release notes");
  await expect(page.locator("[data-total-messages]")).toHaveText("2");
  await expect(nav).toHaveCount(0);
});

test("user message navigation uses the pane width and theme colors", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await app.appendSessionMessage(
    "alpha",
    "user",
    "Check the release documentation",
  );
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    "The release documentation is ready.",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const nav = page.getByRole("navigation", { name: "User message navigation" });
  await expect(nav).toBeVisible();
  const first = nav.getByRole("button", {
    name: "Jump to user message 1",
    exact: true,
  });
  const colors: string[] = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await first.hover();
    const tooltip = nav.getByRole("tooltip");
    await expect(tooltip).toContainText("Review the launch checklist");
    colors.push(
      await tooltip.evaluate((node) => getComputedStyle(node).backgroundColor),
    );
    await page.screenshot({
      path: testInfo.outputPath(`navigator-${theme}.png`),
    });
  }
  expect(colors[0]).not.toBe(colors[1]);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(nav).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  await page.setViewportSize({ width: 2000, height: 1000 });
  await expect(nav).toBeVisible();
});

test("consecutive user messages both have navigation marks", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await app.createSession({
    sessionId,
    projectKey: "alpha",
    prompt: "First consecutive navigation prompt",
  });
  await appendFile(
    join(app.rootDir, "sessions", `${sessionId}.jsonl`),
    responseItemMessageLine("user", "Second consecutive navigation prompt") +
      "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Second consecutive navigation prompt");
  const nav = page.getByRole("navigation", { name: "User message navigation" });
  await expect(nav.getByRole("button")).toHaveCount(2);
  await nav
    .getByRole("button", { name: "Jump to user message 1", exact: true })
    .hover();
  await expect(nav.getByRole("tooltip")).toContainText(
    "First consecutive navigation prompt",
  );
  await nav
    .getByRole("button", { name: "Jump to user message 2", exact: true })
    .hover();
  await expect(nav.getByRole("tooltip")).toContainText(
    "Second consecutive navigation prompt",
  );
});
