import { execFile } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { DiffGuideStore } from "../../api/diff-guide-store";
import {
  test,
  expect,
  type IntegrationAppFixture,
} from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

const run = promisify(execFile);
const frameSelector = 'iframe[title="Generated Git diff guide"]';
const mainHeading = "The result now has an explicit type";
const noteTitle = "Set the limit";
const noteBody = "The request uses a limit of ten results.";
const secondNoteTitle = "Return a Token";
const secondNoteBody =
  "The result is constructed as a Token, which derives from Base.";
const translated = (text: string) => `中文：${text}`;

async function publishGuide(app: IntegrationAppFixture) {
  const output = join(app.rootDir, "translation-guide");
  // Read the skill's existing fixture generator; do not edit or regenerate the skill.
  await run("python3", [
    join(process.cwd(), "skills/codex-deck-diff/tests/create_fixture.py"),
    "--output",
    output,
  ]);
  const store = new DiffGuideStore(app.rootDir);
  await store.write({
    sessionId: app.sessions.alpha,
    parentSessionId: app.sessions.beta,
    requestId: "translation-fixture",
    projectRoot: app.projects.alpha,
    prompt: "",
    thread: {
      threadId: app.sessions.alpha,
      cwd: app.projects.alpha,
      name: null,
    },
    turnId: null,
    status: "generating",
    error: null,
  });
  for (const name of ["guide.json", "snapshot.json", "diff-tour.html"])
    await copyFile(
      join(output, name),
      join(store.directory(app.sessions.alpha), name),
    );
  return {
    original: await readFile(join(output, "diff-tour.html"), "utf8"),
    store,
  };
}

async function openGuide(page: Page, app: IntegrationAppFixture) {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await expect(
    page.getByRole("combobox", { name: "Codex home" }),
  ).toBeEnabled();
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "Diff guide", exact: true }).click();
  const frame = page.frameLocator(frameSelector);
  await expect(frame.locator('[data-translation-kind="main"]')).toBeVisible();
  return frame;
}

test("embedded guide toggles each description independently, preserves navigation, and retries failed groups", async ({
  page,
  app,
}, testInfo) => {
  const { original, store } = await publishGuide(app);
  const calls: string[] = [];
  let failNote = true;
  await page.route("**/api/translate", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.inputLang).toBe("en");
    expect(body.outputLang).toBe("zh");
    calls.push(body.text);
    if (body.text === secondNoteBody && failNote) {
      failNote = false;
      await route.fulfill({
        status: 503,
        json: { error: "Fixture translation unavailable" },
      });
    } else
      await route.fulfill({ json: { translatedText: translated(body.text) } });
  });
  const frame = await openGuide(page, app);
  const layout = await frame.locator("#guide").evaluate((guide) => {
    const blocks = [
      ...guide.ownerDocument.querySelectorAll(".deck-diff-translation-block"),
    ];
    return blocks.map((block) => {
      const card = block.querySelector(".nav-step, .note-button, h2")!;
      const control = block.querySelector(".deck-diff-translate")!;
      const cardRect = card.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      return {
        contained:
          controlRect.left >= cardRect.left &&
          controlRect.right <= cardRect.right &&
          controlRect.top >= cardRect.top &&
          controlRect.bottom <= cardRect.bottom,
        fullWidth:
          Math.abs(cardRect.width - block.getBoundingClientRect().width) < 1,
        bodyFullWidth:
          !block.querySelector(".note-body") ||
          block.querySelector(".note-body")!.getBoundingClientRect().width >=
            cardRect.width - 28,
      };
    });
  });
  expect(layout.length).toBeGreaterThan(0);
  for (const block of layout)
    expect(block).toEqual({
      contained: true,
      fullWidth: true,
      bodyFullWidth: true,
    });
  await expect(
    frame.locator(".deck-diff-translation-block button button"),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("translation-controls-desktop.png"),
  });
  const dataBefore = await frame.locator("#guide-data").textContent();
  const codeBefore = await frame.locator("#diff-body").innerHTML();
  const firstStep = frame.locator(".deck-diff-step").first();
  const stepToggle = firstStep.locator('[data-translation-kind="step"]');
  const originalStepTitle = await firstStep.locator(".nav-title").textContent();
  await stepToggle.click();
  await expect(firstStep.locator(".nav-title")).toHaveText(
    translated(originalStepTitle!),
  );
  await stepToggle.click();
  await expect(firstStep.locator(".nav-title")).toHaveText(originalStepTitle!);
  const countAfterStepTranslation = calls.length;
  await stepToggle.click();
  await expect(stepToggle).toHaveAttribute("aria-pressed", "true");
  expect(calls.length).toBe(countAfterStepTranslation);

  // Translating another step must not select it.
  await frame
    .locator('.deck-diff-step [data-translation-kind="step"]')
    .nth(1)
    .click();
  await expect(frame.locator('.nav-step[aria-current="step"]')).toHaveAttribute(
    "data-step",
    "0",
  );
  const main = frame.locator('[data-translation-kind="main"]');
  const originalWhy = await frame.locator(".why").textContent();
  await main.click();
  await expect(frame.locator("#step-heading")).toHaveText(
    translated(mainHeading),
  );
  await expect(frame.locator(".why")).toHaveText(translated(originalWhy!));

  await frame.locator('.note-button[data-note="1"]').click();
  await expect(frame.locator('tr.focus[data-line="66"]')).toHaveCount(1);
  const firstNote = frame.locator(".deck-diff-note").first();
  await firstNote.locator('[data-translation-kind="note"]').click();
  await expect(firstNote.locator(".note-title")).toHaveText(
    translated(noteTitle),
  );
  await expect(firstNote.locator(".note-body")).toHaveText(
    translated(noteBody),
  );
  await expect(frame.locator('tr.focus[data-line="66"]')).toHaveCount(1);
  await expect(frame.locator('.note-button[data-note="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const secondNote = frame.locator(".deck-diff-note").nth(1);
  const secondToggle = secondNote.locator('[data-translation-kind="note"]');
  await secondToggle.click();
  await expect(
    secondNote.locator(".deck-diff-translation-error"),
  ).toContainText("Fixture translation unavailable");
  await expect(secondNote.locator(".note-title")).toHaveText(secondNoteTitle);
  await expect(secondNote.locator(".note-body")).toHaveText(secondNoteBody);
  await secondToggle.click();
  await expect(secondNote.locator(".note-title")).toHaveText(
    translated(secondNoteTitle),
  );
  await expect(secondNote.locator(".note-body")).toHaveText(
    translated(secondNoteBody),
  );
  expect(calls.filter((text) => text === secondNoteTitle)).toHaveLength(1);

  await frame.locator('.nav-step[data-step="1"]').click();
  await expect(frame.locator("#step-heading")).not.toHaveText(
    translated(mainHeading),
  );
  await frame.locator('.nav-step[data-step="0"]').click();
  await expect(frame.locator("#step-heading")).toHaveText(
    translated(mainHeading),
  );
  await expect(
    frame.locator('.note-button[data-note="0"] .note-title'),
  ).toHaveText(translated(noteTitle));
  await expect(frame.locator('[data-translation-kind="main"]')).toHaveCount(1);
  await expect(frame.locator('[data-translation-kind="note"]')).toHaveCount(2);
  await main.click();
  await expect(frame.locator("#step-heading")).toHaveText(mainHeading);
  await expect(frame.locator(".why")).toHaveText(originalWhy!);
  expect(await frame.locator("#guide-data").textContent()).toBe(dataBefore);
  // Restore the original focus before comparing the frozen code rendering.
  expect(await frame.locator("#diff-body").innerHTML()).toBe(codeBefore);
  expect(
    await readFile(
      join(store.directory(app.sessions.alpha), "diff-tour.html"),
      "utf8",
    ),
  ).toBe(original);
  await expect(page.locator(frameSelector)).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-downloads",
  );
});

test("mobile controls mirror sidebar state, support keyboard toggling, and wrap long translations in both themes", async ({
  page,
  app,
}, testInfo) => {
  await publishGuide(app);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("codex-deck:theme:v1"))
      localStorage.setItem("codex-deck:theme:v1", "light");
  });
  await page.route("**/api/translate", async (route) => {
    const { text } = route.request().postDataJSON();
    await route.fulfill({
      json: { translatedText: "这是较长的中文翻译说明。".repeat(8) + text },
    });
  });
  let frame = await openGuide(page, app);
  await expect(frame.locator("#sidebar")).not.toBeVisible();
  const mobile = frame.locator('[data-translation-kind="mobile-step"]');
  const selectorLayout = await mobile.evaluate((button) => {
    const select = button
      .parentElement!.querySelector("select")!
      .getBoundingClientRect();
    const icon = button.getBoundingClientRect();
    return (
      icon.left >= select.left &&
      icon.right <= select.right &&
      icon.top >= select.top &&
      icon.bottom <= select.bottom
    );
  });
  expect(selectorLayout).toBeTruthy();
  await mobile.focus();
  await mobile.press("Enter");
  await expect(mobile).toHaveAttribute("aria-pressed", "true");
  await expect(
    frame.locator('.deck-diff-step [data-translation-kind="step"]').first(),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(frame.locator("#step-select option").first()).toContainText(
    "这是较长的中文翻译说明。",
  );
  await mobile.press("Enter");
  await expect(mobile).toHaveAttribute("aria-pressed", "false");
  await frame.locator('[data-translation-kind="main"]').click();
  await expect(frame.locator("#step-heading")).toContainText(
    "这是较长的中文翻译说明。",
  );
  const noteToggle = frame.locator('[data-translation-kind="note"]').first();
  // Center the control after expansion, avoiding Chromium's iframe-edge hit testing.
  await noteToggle.evaluate((button) =>
    button.scrollIntoView({ block: "center" }),
  );
  await noteToggle.click();
  await expect(frame.locator(".note-body").first()).toContainText(
    "这是较长的中文翻译说明。",
  );
  await page.screenshot({
    path: testInfo.outputPath("translation-controls-mobile-light.png"),
  });
  await noteToggle.click();
  await expect(frame.locator(".note-body").first()).toHaveText(noteBody);
  const dimensions = await frame
    .locator("body")
    .evaluate((body) => ({ width: body.scrollWidth, viewport: innerWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  await expect(frame.locator('[data-translation-kind="main"]')).toHaveCSS(
    "min-height",
    "44px",
  );
  await expect(frame.locator(".guide")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.evaluate(() =>
    localStorage.setItem("codex-deck:theme:v1", "dark"),
  );
  await page.reload();
  await page
    .getByRole("button", { name: /Review the launch checklist/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Diff guide", exact: true }).click();
  frame = page.frameLocator(frameSelector);
  await expect(frame.locator('[data-translation-kind="main"]')).toBeVisible();
  await expect(frame.locator(".guide")).toHaveCSS(
    "background-color",
    "rgb(24, 24, 27)",
  );
  await frame.locator('[data-translation-kind="main"]').click();
  await expect(frame.locator("#step-heading")).toContainText(
    "这是较长的中文翻译说明。",
  );
  await expect(frame.locator('[data-translation-kind="main"]')).toHaveCSS(
    "color",
    "rgb(147, 180, 255)",
  );
  await page.screenshot({
    path: testInfo.outputPath("translation-controls-mobile-dark.png"),
  });
});

test("loading groups survive step changes and stale responses cannot affect refreshed or closed viewers", async ({
  page,
  app,
}) => {
  await publishGuide(app);
  const releases: (() => Promise<void>)[] = [];
  let delay = true;
  await page.route("**/api/translate", async (route) => {
    const body = route.request().postDataJSON();
    if (!delay) {
      await route.fulfill({ json: { translatedText: translated(body.text) } });
      return;
    }
    await new Promise<void>((resolve) => {
      releases.push(async () => {
        await route.fulfill({
          json: { translatedText: translated(body.text) },
        });
        resolve();
      });
    });
  });
  const frame = await openGuide(page, app);
  await frame.locator('[data-translation-kind="main"]').click();
  await expect(frame.locator('[data-translation-kind="main"]')).toBeDisabled();
  await expect.poll(() => releases.length).toBe(2);
  await frame.locator('.nav-step[data-step="1"]').click();
  for (const release of releases.splice(0)) await release();
  await expect(frame.locator("#step-heading")).not.toHaveText(
    translated(mainHeading),
  );
  await frame.locator('.nav-step[data-step="0"]').click();
  await expect(frame.locator("#step-heading")).toHaveText(
    translated(mainHeading),
  );

  await frame.locator('[data-translation-kind="note"]').first().click();
  await expect.poll(() => releases.length).toBe(2);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    frame.locator('[data-translation-kind="note"]').first(),
  ).toHaveAttribute("aria-pressed", "false");
  for (const release of releases.splice(0)) await release();
  await expect(
    frame.locator('.note-button[data-note="0"] .note-title'),
  ).toHaveText(noteTitle);
  // A cached result from the old frame may be reused only after a new explicit click.
  await frame.locator('[data-translation-kind="note"]').first().click();
  await expect(
    frame.locator('.note-button[data-note="0"] .note-title'),
  ).toHaveText(translated(noteTitle));

  await frame.locator('[data-translation-kind="note"]').nth(1).click();
  await expect.poll(() => releases.length).toBe(2);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  for (const release of releases.splice(0)) await release();
  delay = false;
  await page.getByRole("button", { name: "Diff guide", exact: true }).click();
  await expect(
    frame.locator('.note-button[data-note="1"] .note-title'),
  ).toHaveText(secondNoteTitle);
  await expect(
    frame.locator('[data-translation-kind="note"]').nth(1),
  ).toHaveAttribute("aria-pressed", "false");
});
