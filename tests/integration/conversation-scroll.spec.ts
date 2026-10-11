import type { Page } from "@playwright/test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  responseItemMessageLine,
  responseItemRawLine,
} from "../unit/test-utils";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

async function pageWindow(page: Page) {
  return page.locator("[data-conversation-scroll]").evaluate((container) => {
    const viewport = container.getBoundingClientRect();
    const pages = Array.from(
      container.querySelectorAll<HTMLElement>("[data-conversation-page]"),
    );
    return {
      cached: pages.map((node) => Number(node.dataset.conversationPage)),
      visible: pages
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
          );
        })
        .map((node) => Number(node.dataset.conversationPage)),
    };
  });
}

async function topVisibleMessage(page: Page) {
  return page.locator("[data-conversation-scroll]").evaluate((container) => {
    const viewport = container.getBoundingClientRect();
    const first = Array.from(
      container.querySelectorAll<HTMLElement>("[data-conversation-message]"),
    ).find((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.height > 0 &&
        rect.bottom > viewport.top + 0.5 &&
        rect.top < viewport.bottom
      );
    });
    return Number(first?.dataset.conversationMessage);
  });
}

async function expectPositionMatchesViewport(page: Page) {
  await expect
    .poll(async () => {
      const expected = await topVisibleMessage(page);
      return (
        Number(
          await page
            .locator("[data-conversation-position]")
            .getAttribute("data-current-message"),
        ) === expected
      );
    })
    .toBe(true);
}

async function expectNavigationAtBottom(page: Page, total: number) {
  await expect
    .poll(() =>
      page
        .locator("[data-conversation-scroll]")
        .evaluate(
          (container) =>
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight,
        ),
    )
    .toBeLessThanOrEqual(1);
  const lastMessage = page.locator(`[data-conversation-message="${total}"]`);
  await expect(lastMessage).toBeInViewport();
  await expect
    .poll(() =>
      lastMessage.evaluate((node) => {
        const container = node.closest<HTMLElement>(
          "[data-conversation-scroll]",
        )!;
        const gap =
          container.getBoundingClientRect().bottom -
          node.getBoundingClientRect().bottom;
        return gap >= -1 && gap <= 64;
      }),
    )
    .toBe(true);
  const top = await topVisibleMessage(page);
  await expectPositionMatchesViewport(page);
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  return top;
}

async function jumpToMessage(page: Page, number: number) {
  const current = await topVisibleMessage(page);
  const total = Number(
    await page.locator("[data-total-messages]").textContent(),
  );
  const input = page.getByRole("textbox", { name: "Page number" });
  await input.fill(String(Math.floor(number / 100)));
  await input.press("Enter");
  const target = Math.max(
    1,
    Math.min(total, Math.floor(number / 100) * 100 + (current % 100)),
  );
  await expect.poll(() => topVisibleMessage(page)).toBe(target);
  // Set up an exact scroll position independently of the prefix-only editor.
  await page
    .locator(`[data-conversation-message="${number}"]`)
    .evaluate((node) => {
      const container = node.closest<HTMLElement>(
        "[data-conversation-scroll]",
      )!;
      container.scrollTop +=
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top;
    });
  await expect.poll(() => topVisibleMessage(page)).toBe(number);
  await expectPositionMatchesViewport(page);
}

async function jumpToPage(page: Page, number: number) {
  await jumpToMessage(page, (number - 1) * 100 + 1);
}

async function centerPageBoundary(page: Page, number: number) {
  await page
    .locator(`[data-conversation-page="${number}"]`)
    .evaluate((node) => {
      const container = node.closest<HTMLElement>(
        "[data-conversation-scroll]",
      )!;
      container.scrollTop +=
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        container.clientHeight / 2;
    });
}

async function expectBoundedWindow(page: Page, totalPages: number) {
  await expect
    .poll(async () => {
      const { cached, visible } = await pageWindow(page);
      if (visible.length === 0) return false;
      const first = Math.max(1, visible[0] - 1);
      const last = Math.min(totalPages, visible[visible.length - 1] + 1);
      return (
        JSON.stringify(cached) ===
        JSON.stringify(
          Array.from({ length: last - first + 1 }, (_, index) => first + index),
        )
      );
    })
    .toBe(true);
}

for (const kind of ["assistant", "tool"] as const) {
  test(`keeps the latest ${kind} blocks visible while a long history backfills`, async ({
    page,
    app,
  }) => {
    await appendFile(
      join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
      Array.from({ length: 639 }, (_, index) =>
        kind === "assistant"
          ? responseItemMessageLine(
              "assistant",
              `Backfill message ${index + 4}\n\n<!-- ${"x".repeat(6000)} -->`,
            )
          : [
              responseItemRawLine({
                type: "function_call",
                call_id: `backfill-${index}`,
                name: "exec_command",
                arguments: JSON.stringify({ cmd: "true" }),
              }),
              responseItemRawLine({
                type: "function_call_output",
                call_id: `backfill-${index}`,
                output: "x".repeat(6000),
              }),
            ].join("\n"),
      ).join("\n") + "\n",
    );
    // Keep history loading long enough to observe frames after the tail paints.
    let backfillComplete = false;
    page.on("response", async (response) => {
      if (!response.url().includes("/messages?beforeSequence=")) return;
      const window = await response.json();
      backfillComplete = window.historyStartSequence === 0;
    });
    await page.route("**/messages?beforeSequence=*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.continue();
    });
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await page.evaluate(() => {
      const samples: {
        visible: boolean;
        bottom: number;
        connected: boolean;
      }[] = [];
      const state = { samples, started: false, done: false };
      (
        window as typeof window & { backfillFrames?: typeof state }
      ).backfillFrames = state;
      let retained: HTMLElement | null = null;
      const sample = () => {
        if (state.done) return;
        const container = document.querySelector("[data-conversation-scroll]");
        const block = document.querySelector<HTMLElement>(
          '[data-conversation-message="642"]',
        );
        if (container && block) {
          const viewport = container.getBoundingClientRect();
          const rect = block.getBoundingClientRect();
          const visible =
            rect.bottom > viewport.top && rect.top < viewport.bottom;
          if (visible) state.started = true;
          if (state.started) {
            retained ??= block;
            samples.push({
              visible,
              bottom: rect.bottom,
              connected: retained.isConnected,
            });
          }
        } else if (state.started) {
          samples.push({ visible: false, bottom: 0, connected: false });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await ui.selectSession("Review the launch checklist");
    await expect(
      page.locator('[data-conversation-message="642"]'),
    ).toBeInViewport();
    await expect.poll(() => backfillComplete).toBe(true);
    const samples = await page.evaluate(() => {
      const state = (
        window as typeof window & {
          backfillFrames?: {
            done: boolean;
            samples: { visible: boolean; bottom: number; connected: boolean }[];
          };
        }
      ).backfillFrames!;
      state.done = true;
      return state.samples;
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(
      samples.filter((sample) => !sample.visible || !sample.connected),
    ).toEqual([]);
    // Tool renderers can resize as their content initializes. Static text
    // should also hold its position, in addition to staying mounted/visible.
    if (kind === "assistant") {
      expect(
        Math.max(...samples.map((sample) => sample.bottom)) -
          Math.min(...samples.map((sample) => sample.bottom)),
      ).toBeLessThan(2);
    }
    await jumpToPage(page, 1);
    await expect(
      page.getByText("The deployment steps are ready.", { exact: true }),
    ).toBeVisible();
  });
}

test("scrolls across page boundaries and evicts distant message elements", async ({
  page,
  app,
}) => {
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 997 }, (_, index) =>
      responseItemMessageLine(
        "assistant",
        `Scroll history message ${index + 4}`,
      ),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(
    page.getByText("Scroll history message 1000", { exact: true }),
  ).toBeVisible();

  await jumpToPage(page, 5);
  await expectBoundedWindow(page, 10);
  await page.locator('[data-conversation-page="5"]').evaluate((node) => {
    (window as typeof window & { retainedPage?: Element }).retainedPage = node;
  });
  await centerPageBoundary(page, 5);
  await expect
    .poll(() => pageWindow(page))
    .toEqual({ cached: [3, 4, 5, 6], visible: [4, 5] });
  await expectPositionMatchesViewport(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { retainedPage?: Element }).retainedPage
          ?.isConnected,
    ),
  ).toBe(true);
  const boundaryTop = await page
    .locator('[data-conversation-page="5"]')
    .evaluate((node) => node.getBoundingClientRect().top);
  await page.locator("[data-conversation-scroll]").hover();
  await page.mouse.wheel(0, -120);
  await expect
    .poll(async () => {
      const top = await page
        .locator('[data-conversation-page="5"]')
        .evaluate((node) => node.getBoundingClientRect().top);
      return top - boundaryTop;
    })
    .toBeCloseTo(120, 0);
  await expectBoundedWindow(page, 10);
  await page
    .locator('[data-conversation-page="4"] [data-search-entry]')
    .first()
    .evaluate((node) => {
      (window as typeof window & { evictedMessage?: Element }).evictedMessage =
        node;
    });

  // Scroll downward through the next boundary, without using the pager.
  await page.locator('[data-conversation-page="6"]').evaluate((node) => {
    const container = node.closest<HTMLElement>("[data-conversation-scroll]")!;
    container.scrollTop +=
      node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await expectPositionMatchesViewport(page);
  await expectBoundedWindow(page, 10);
  await expect(page.locator('[data-conversation-page="4"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { evictedMessage?: Element }).evictedMessage
          ?.isConnected,
    ),
  ).toBe(false);

  // A tall viewport can intersect more than two pages. Shrinking evicts them again.
  const pageHeight = await page
    .locator('[data-conversation-page="6"]')
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.setViewportSize({
    width: 1440,
    height: Math.ceil(pageHeight * 2.5 + 200),
  });
  await expect
    .poll(async () => (await pageWindow(page)).visible.length)
    .toBeGreaterThan(2);
  await expectBoundedWindow(page, 10);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expectBoundedWindow(page, 10);

  await jumpToPage(page, 1);
  await expect(
    page.getByText("Search launch references before shipping.", {
      exact: true,
    }),
  ).toBeVisible();
  await expectBoundedWindow(page, 10);
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expect(
    page.getByText("Scroll history message 1000", { exact: true }),
  ).toBeVisible();
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    "Live message on the next page",
  );
  await expect(
    page.getByText("Live message on the next page", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-total-messages]")).toHaveText("1001");
  await expectPositionMatchesViewport(page);
  await expectBoundedWindow(page, 11);
});

test("search jumps between virtual pages on a mobile viewport without following live output", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 597 }, (_, index) =>
      responseItemMessageLine(
        "assistant",
        `Mobile history ${index + 4}${index === 145 || index === 545 ? " unique-scroll-search" : ""}`,
      ),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "Collapse left pane" }).click();
  await expect(
    page.getByText("Mobile history 600", { exact: true }),
  ).toBeVisible();
  await ui.openConversationSearch();
  await ui.searchConversation("unique-scroll-search");
  await expectPositionMatchesViewport(page);
  await expect(page.locator(".conversation-search-match-active")).toHaveCount(
    1,
  );
  await expect(
    page.locator(".conversation-search-match-active"),
  ).toBeInViewport();
  await expectBoundedWindow(page, 6);
  await page.getByRole("button", { name: "Next search result" }).click();
  await expectPositionMatchesViewport(page);
  await expect(
    page.locator(".conversation-search-match-active"),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Previous search result" }).click();
  await expectPositionMatchesViewport(page);
  const positionBeforeAppend = await page
    .locator("[data-conversation-position]")
    .getAttribute("data-current-message");
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    "Background live message",
  );
  await expect(page.locator("[data-total-messages]")).toHaveText("601");
  await expect(page.locator("[data-conversation-position]")).toHaveAttribute(
    "data-current-message",
    positionBeforeAppend!,
  );
  await expectPositionMatchesViewport(page);
  await expect(
    page.locator(".conversation-search-match-active"),
  ).toBeInViewport();
});

test("steps exactly 100 messages from the topmost block and styles the message counter", async ({
  page,
  app,
}) => {
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 608 }, (_, index) =>
      responseItemMessageLine(
        "assistant",
        `Position message ${index + 4}${index % 7 === 0 ? "\n" + "variable height content ".repeat(30) : ""}`,
      ),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(page.locator("[data-total-messages]")).toHaveText("611");
  await jumpToMessage(page, 342);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(442);
  await expect(page.locator("[data-conversation-position]")).toHaveAttribute(
    "data-current-message",
    "442",
  );
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(342);
  await expectPositionMatchesViewport(page);
  await expectBoundedWindow(page, 7);

  const position = page.locator("[data-conversation-position]");
  await expect(position.locator("[data-message-number-suffix]")).toHaveText([
    "42",
    "11",
  ]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const styles = await position
      .locator("[data-total-messages]")
      .evaluate((node) => {
        const leading = getComputedStyle(node.children[0]);
        const suffix = getComputedStyle(node.children[1]);
        return {
          leadingSize: Number.parseFloat(leading.fontSize),
          suffixSize: Number.parseFloat(suffix.fontSize),
          leadingColor: leading.color,
          suffixColor: suffix.color,
        };
      });
    expect(styles.suffixSize).toBeLessThan(styles.leadingSize);
    expect(styles.suffixColor).not.toBe(styles.leadingColor);
  }

  // Ordinary scrolling updates the counter per message, including a partly clipped block.
  await page.locator('[data-conversation-message="342"]').evaluate((node) => {
    const container = node.closest<HTMLElement>("[data-conversation-scroll]")!;
    container.scrollTop += node.getBoundingClientRect().height / 2;
  });
  await expect.poll(() => topVisibleMessage(page)).toBe(342);
  await expectPositionMatchesViewport(page);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(442);
  await page.locator('[data-conversation-message="443"]').evaluate((node) => {
    const container = node.closest<HTMLElement>("[data-conversation-scroll]")!;
    container.scrollTop +=
      node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await expect(page.locator("[data-conversation-position]")).toHaveAttribute(
    "data-current-message",
    "443",
  );
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(543);

  // The final step stops at the natural bottom with earlier messages still visible.
  await page.getByRole("button", { name: "Next page" }).click();
  const bottomTop = await expectNavigationAtBottom(page, 611);
  expect(bottomTop).toBeLessThan(611);
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(bottomTop - 100);
  await jumpToMessage(page, 42);
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(1);
  await expect(
    page.getByRole("button", { name: "Previous page" }),
  ).toBeDisabled();
  await expectBoundedWindow(page, 7);
});

test("edits only the leading digits, preserves the offset, and clamps oversized jumps", async ({
  page,
  app,
}) => {
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 8608 }, (_, index) =>
      responseItemMessageLine("assistant", `Prefix message ${index + 4}`),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(page.locator("[data-total-messages]")).toHaveText("8611");
  await jumpToMessage(page, 6353);
  const input = page.getByRole("textbox", { name: "Page number" });
  const position = page.locator("[data-conversation-position]");
  const suffix = position.locator("[data-message-number-suffix]").first();
  await expect(input).toHaveValue("63");
  await expect(suffix).toHaveText("53");
  await input.fill("84");
  await expect(input).toHaveValue("84");
  await expect(suffix).toHaveText("53");

  // Scrolling during editing must not silently change the preserved two digits.
  await page.locator('[data-conversation-message="6354"]').evaluate((node) => {
    const container = node.closest<HTMLElement>("[data-conversation-scroll]")!;
    container.scrollTop +=
      node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await expect(position).toHaveAttribute("data-current-message", "6354");
  await expect(suffix).toHaveText("53");
  await input.press("Enter");
  await expect.poll(() => topVisibleMessage(page)).toBe(8453);
  await expect(position).toHaveAttribute("data-current-message", "8453");
  await expect(input).toHaveValue("84");
  await expect(suffix).toHaveText("53");

  await input.fill("63");
  await input.press("Tab");
  await expect.poll(() => topVisibleMessage(page)).toBe(6353);
  await expect(input).toHaveValue("63");
  await input.fill("84");
  await input.press("Escape");
  await expect(input).toHaveValue("63");
  await expect(position).toHaveAttribute("data-current-message", "6353");

  await input.fill("999999999999999999999999999999");
  await input.press("Enter");
  const bottomTop = await expectNavigationAtBottom(page, 8611);
  expect(bottomTop).toBeLessThan(8611);
  await expect(position).toHaveAttribute(
    "data-current-message",
    String(bottomTop),
  );
  await expect(input).toHaveValue(String(bottomTop).slice(0, -2));
  await expect(suffix).toHaveText(String(bottomTop).slice(-2));
  await expectBoundedWindow(page, 87);

  // A prefix of zero reaches the first hundred without making the suffix editable.
  await input.fill("0");
  await input.press("Enter");
  const target = Math.max(1, bottomTop % 100);
  await expect.poll(() => topVisibleMessage(page)).toBe(target);
  await expect(suffix).toHaveText(String(target));
  await expectPositionMatchesViewport(page);
});

test("page steps and numeric jumps stop at the bottom of a 542-message conversation", async ({
  page,
  app,
}) => {
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 539 }, (_, index) =>
      responseItemMessageLine("assistant", `Bottom limit message ${index + 4}`),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(page.locator("[data-total-messages]")).toHaveText("542");
  for (const { width, height, theme } of [
    { width: 1440, height: 960, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    if (width < 500)
      await page.getByRole("button", { name: "Collapse left pane" }).click();
    await jumpToMessage(page, 442);
    await page.getByRole("button", { name: "Next page" }).click();
    const bottomTop = await expectNavigationAtBottom(page, 542);
    expect(bottomTop).toBeLessThan(542);
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect.poll(() => topVisibleMessage(page)).toBe(bottomTop - 100);
    await expect(page.getByRole("button", { name: "Next page" })).toBeEnabled();

    await jumpToMessage(page, 442);
    const input = page.getByRole("textbox", { name: "Page number" });
    await input.fill("5");
    await input.press("Enter");
    await expectNavigationAtBottom(page, 542);
    await expectBoundedWindow(page, 6);

    await page.getByRole("button", { name: "Previous page" }).click();
    await input.fill("99");
    await input.press("Enter");
    await expectNavigationAtBottom(page, 542);
  }
});

test("page navigation is disabled when the whole conversation fits in the viewport", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(page.locator("[data-total-messages]")).toHaveText("3");
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Previous page" }),
  ).toBeDisabled();
  const input = page.getByRole("textbox", { name: "Page number" });
  await input.fill("99");
  await input.press("Enter");
  await expect.poll(() => topVisibleMessage(page)).toBe(1);
  await expectPositionMatchesViewport(page);
  expect(
    await page
      .locator("[data-conversation-scroll]")
      .evaluate((container) => container.scrollTop),
  ).toBe(0);
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
});

test("an oversized page jump reaches the end of a final message taller than the viewport", async ({
  page,
  app,
}) => {
  const finalText = Array.from(
    { length: 100 },
    (_, index) => `Long final message paragraph ${index + 1}`,
  ).join("\n\n");
  await appendFile(
    join(app.rootDir, "sessions", `${app.sessions.alpha}.jsonl`),
    Array.from({ length: 539 }, (_, index) =>
      responseItemMessageLine(
        "assistant",
        index === 538 ? finalText : `Long-tail message ${index + 4}`,
      ),
    ).join("\n") + "\n",
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await expect(page.locator("[data-total-messages]")).toHaveText("542");
  await jumpToMessage(page, 442);
  await page.getByRole("button", { name: "Next page" }).click();
  await expectNavigationAtBottom(page, 542);
  await expect(
    page.getByText("Long final message paragraph 100", { exact: true }),
  ).toBeInViewport();

  await page.getByRole("button", { name: "Previous page" }).click();
  await expect.poll(() => topVisibleMessage(page)).toBe(442);
  const input = page.getByRole("textbox", { name: "Page number" });
  await input.fill("99");
  await input.press("Enter");
  await expectNavigationAtBottom(page, 542);
  await expect(
    page.getByText("Long final message paragraph 100", { exact: true }),
  ).toBeInViewport();
});
