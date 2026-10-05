import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
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
async function publish(page: Page, app: IntegrationAppFixture) {
  const directory = join(app.rootDir, "source-guide");
  await run("python3", [
    join(process.cwd(), "skills/codex-deck-diff/tests/create_fixture.py"),
    "--output",
    directory,
    "--omit-source",
  ]);
  const repo = join(directory, "repo");
  const store = new DiffGuideStore(app.rootDir);
  await store.write({
    sessionId: app.sessions.alpha,
    parentSessionId: app.sessions.beta,
    requestId: "source-fixture",
    projectRoot: repo,
    prompt: "",
    thread: { threadId: app.sessions.alpha, cwd: repo, name: null },
    turnId: null,
    status: "generating",
    error: null,
  });
  for (const name of ["guide.json", "snapshot.json", "diff-tour.html"])
    await copyFile(
      join(directory, name),
      join(store.directory(app.sessions.alpha), name),
    );
  const original = await readFile(join(directory, "diff-tour.html"), "utf8");
  // The viewer must reconstruct the captured code even when current files are gone.
  await writeFile(join(repo, "main.py"), "later working-tree content\n");
  await writeFile(join(repo, "helper.py"), "later definition\n");
  return { directory, repo, store, original };
}
async function open(page: Page, app: IntegrationAppFixture) {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  // Finish home selection before opening a viewer keyed to that home.
  await expect(
    page.getByRole("combobox", { name: "Codex home" }),
  ).toBeEnabled();
  await ui.selectSession("Review the launch checklist");
  await page.getByRole("button", { name: "Diff guide", exact: true }).click();
  const frame = page.frameLocator(frameSelector);
  await expect(frame.locator("#step-heading")).toBeVisible();
  await expect(frame.locator("#diff-body tr").first()).toBeAttached();
  return frame;
}

test("source-free guide loads captured full files, gaps, definitions, references and comments from Git", async ({
  page,
  app,
}) => {
  const fixture = await publish(page, app);
  const errors: string[] = [],
    calls: URL[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes(`/diff-guides/${app.sessions.alpha}/source?`))
      calls.push(new URL(request.url()));
  });
  await page.route("**/api/translate", (route) =>
    route.fulfill({ json: { translatedText: "中文翻译" } }),
  );
  const frame = await open(page, app);
  expect(calls).toHaveLength(0);
  const capturedData = await frame.locator("#guide-data").textContent();
  await frame.locator("#show-context").click();
  await expect(frame.locator("#diff-body tr[data-line]")).toHaveCount(140);
  await expect(frame.locator('tr[data-line="10"] .code-cell')).toHaveText(
    "limit = 10",
  );
  expect(
    calls.some((url) => url.searchParams.get("path") === "main.py"),
  ).toBeTruthy();
  await frame.locator("#diff-view").selectOption("split");
  await expect(frame.locator(".diff-table")).toHaveAttribute(
    "data-view",
    "split",
  );
  await expect(frame.locator("#diff-body tr[data-line]")).toHaveCount(140);
  await frame.locator("#show-context").click();
  await frame.locator(".gap-button").first().click();
  await expect(frame.locator('tr[data-line="1"]')).toBeVisible();
  await expect(frame.locator('tr[data-line="1"] .symbol-link')).toHaveCount(1);
  await frame.locator("#diff-view").selectOption("unified");
  await frame.locator('tr[data-line="66"] .symbol-link').click();
  await expect(frame.locator("#definition-body")).toContainText(
    "class Token(Base):",
  );
  expect(
    calls.some((url) => url.searchParams.get("path") === "helper.py"),
  ).toBeTruthy();
  await frame.locator("#definition-body .symbol-link").click();
  await expect(frame.locator("#definition-title")).toHaveText("Base");
  await expect(frame.locator("#definition-body")).toContainText("class Base:");
  await frame.locator("#definition-back").click();
  await expect(frame.locator("#definition-body")).toContainText(
    "class Token(Base):",
  );
  await frame.locator("#definition-close").click();
  await frame.locator(".reference summary").click();
  await expect(frame.locator(".reference pre")).toContainText(
    "4  class Token(Base):",
  );
  await frame.locator(".transition-evidence summary").click();
  await expect(frame.locator(".transition-code")).toContainText(
    "66  result = Token()",
  );
  await frame.locator("#source-link").click();
  await expect(frame.locator("#source-body tr")).toHaveCount(140);
  await expect(frame.locator("#source-body")).not.toContainText(
    "later working-tree",
  );
  await frame.locator("#source-close").click();
  await frame.locator('[data-translation-kind="main"]').click();
  await expect(frame.locator("#step-heading")).toHaveText("中文翻译");

  await frame.locator("#review-add").click();
  await frame.locator('tr[data-line="66"] .line-new button').click();
  await frame.locator("#review-write").click();
  await frame
    .locator("#review-text")
    .fill("Retain captured-source validation.");
  await frame.locator("#review-save").click();
  await expect(frame.locator("#review-open")).toContainText("(1)");
  const downloadPromise = page.waitForEvent("download");
  await frame.locator("#review-download").click();
  const download = await downloadPromise;
  const path = await download.path();
  const comments = JSON.parse(await readFile(path!, "utf8"));
  expect(comments.comments[0].code).toBe("result = Token()");
  await frame.locator("#review-close").click();
  await frame.locator('.nav-step[data-step="2"]').click();
  await frame.locator("#source-link").click();
  await expect(frame.locator("#source-body")).toContainText("Old response");
  expect(
    calls.some(
      (url) =>
        url.searchParams.get("path") === "removed.txt" &&
        url.searchParams.get("side") === "left",
    ),
  ).toBeTruthy();
  expect(await frame.locator("#guide-data").textContent()).toBe(capturedData);
  expect(
    await readFile(
      join(fixture.store.directory(app.sessions.alpha), "diff-tour.html"),
      "utf8",
    ),
  ).toBe(fixture.original);
  expect(errors).toEqual([]);
});

test("source failures are visible and retryable, and late results cannot change another step or refreshed frame", async ({
  page,
  app,
}) => {
  await publish(page, app);
  let fail = true,
    delay = false;
  const releases: (() => Promise<void>)[] = [];
  await page.route("**/api/diff-guides/*/source?*", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 404,
        json: { error: "Baseline commit is unavailable" },
      });
      return;
    }
    if (delay) {
      await new Promise<void>((resolve) =>
        releases.push(async () => {
          await route.continue();
          resolve();
        }),
      );
      return;
    }
    await route.continue();
  });
  const frame = await open(page, app);
  await frame.locator("#show-context").click();
  await expect(frame.locator("#deck-diff-source-status")).toContainText(
    "Baseline commit is unavailable",
  );
  expect(await frame.locator("#diff-body tr[data-line]").count()).toBeLessThan(
    140,
  );
  fail = false;
  await frame.locator("#deck-diff-source-status button").click();
  await expect(frame.locator("#diff-body tr[data-line]")).toHaveCount(140);
  delay = true;
  await frame.locator('tr[data-line="66"] .symbol-link').click();
  await expect.poll(() => releases.length).toBe(1);
  await frame.locator("#definition-close").click();
  await frame.locator('.nav-step[data-step="1"]').click();
  await releases.shift()!();
  await expect(frame.locator("#definition-dialog")).not.toBeVisible();
  await expect(frame.locator("#step-heading")).not.toHaveText(
    "The result now has an explicit type",
  );
  await frame.locator("#source-link").click();
  await expect.poll(() => releases.length).toBe(1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(frame.locator("#source-dialog")).not.toBeVisible();
  await releases.shift()!();
  await expect(frame.locator("#source-dialog")).not.toBeVisible();
});

test("comment import, export and line navigation load hidden source from Git", async ({
  page,
  app,
}) => {
  await publish(page, app);
  const frame = await open(page, app);
  const data = JSON.parse((await frame.locator("#guide-data").textContent())!);
  const now = new Date().toISOString();
  const saved = {
    schemaVersion: 1,
    kind: "codex-deck-diff-review",
    repositoryId: data.comparison.repositoryId,
    snapshot: data.comparison.fingerprint,
    comments: [
      {
        id: "hidden-comment",
        path: "main.py",
        side: "right",
        source: data.comparison.fingerprint,
        startLine: 50,
        endLine: 50,
        code: "value_50 = 50",
        body: "Comment on captured unchanged code.",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const commentsButton = frame.locator("#review-open");
  await commentsButton.evaluate((button) =>
    button.scrollIntoView({ block: "center" }),
  );
  await commentsButton.click();
  await expect(frame.locator("#review-dialog")).toBeVisible();
  await frame.locator("#review-import-open").click();
  await frame.locator("#review-import-text").fill(JSON.stringify(saved));
  await frame.locator("#review-import-check").click();
  await expect(frame.locator("#review-import-preview")).toBeVisible();
  await frame.locator("#review-import-apply").click();
  await expect(frame.locator("#review-open")).toContainText("(1)");
  const downloadPromise = page.waitForEvent("download");
  await frame.locator("#review-download").click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.comments[0].code).toBe("value_50 = 50");
  await frame.locator(".review-location").click();
  await expect(frame.locator('tr[data-line="50"]')).toBeVisible();
  await expect(frame.locator('tr[data-line="50"] .code-cell')).toHaveText(
    "value_50 = 50",
  );
});

test("mobile source loading preserves layout and source controls in light and dark themes", async ({
  page,
  app,
}, testInfo) => {
  await publish(page, app);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("codex-deck:theme:v1"))
      localStorage.setItem("codex-deck:theme:v1", "light");
  });
  let frame = await open(page, app);
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await page.evaluate(() =>
        localStorage.setItem("codex-deck:theme:v1", "dark"),
      );
      await page.reload();
      await page
        .getByRole("button", { name: /Review the launch checklist/ })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Diff guide", exact: true })
        .click();
      frame = page.frameLocator(frameSelector);
    }
    const note = frame.locator('.note-button[data-note="1"]');
    await note.evaluate((button) => button.scrollIntoView({ block: "center" }));
    await note.click();
    await expect(frame.locator("#code-pane")).toBeVisible();
    await frame.locator("#code-menu-toggle").click();
    await frame.locator("#show-context").click();
    await expect(frame.locator("#diff-body tr[data-line]")).toHaveCount(140);
    await frame.locator("#code-menu-toggle").click();
    await frame.locator("#mobile-source-link").click();
    await expect(frame.locator("#source-body tr")).toHaveCount(140);
    await expect(frame.locator("#source-dialog")).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(255, 255, 255)" : "rgb(24, 24, 27)",
    );
    expect(
      await frame
        .locator("body")
        .evaluate((body) => body.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await testInfo.attach(`mobile-source-${theme}`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`mobile-source-${theme}.png`),
      }),
      contentType: "image/png",
    });
    await frame.locator("#source-close").click();
  }
});
