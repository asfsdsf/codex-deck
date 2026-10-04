/* Run with Node and an installed playwright package. No web server is required. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

async function main() {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-deck-diff-browser-"),
  );
  execFileSync("python3", [
    path.join(__dirname, "create_fixture.py"),
    "--output",
    output,
  ]);
  const url = pathToFileURL(path.join(output, "diff-tour.html")).href;
  const browser = await chromium.launch(
    process.env.DIFF_TOUR_BROWSER_CHANNEL
      ? { channel: process.env.DIFF_TOUR_BROWSER_CHANNEL }
      : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors = [],
    network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  try {
    await page.goto(url);
    await page.locator("#diff-body tr").first().waitFor();
    assert.match(await page.title(), /Git Diff Tour/);
    await page.locator(".note-button").nth(1).click();
    assert.equal(await page.locator("tr.focus[data-line='66']").count(), 1);
    await page.locator("tr[data-line='66'] .symbol-link").click();
    await page.locator("#definition-dialog[open]").waitFor();
    assert.equal(
      await page.locator("#definition-title").textContent(),
      "Token",
    );
    await page.locator("#definition-body .symbol-link").click();
    assert.equal(await page.locator("#definition-title").textContent(), "Base");
    await page.locator("#definition-back").click();
    assert.equal(
      await page.locator("#definition-title").textContent(),
      "Token",
    );
    await page.keyboard.press("Escape");
    await page.locator("#source-link").click();
    await page.locator("#source-dialog[open]").waitFor();
    assert.equal(await page.locator("#source-body tr").count(), 140);
    await page.keyboard.press("Escape");
    await page.locator("#diff-view").selectOption("split");
    assert.equal(
      await page.locator(".diff-table").getAttribute("data-view"),
      "split",
    );
    await page.locator("#show-context").click();
    assert.equal(await page.locator("#diff-body tr[data-line]").count(), 140);
    await page.locator("#show-context").click();
    assert.ok((await page.locator(".gap-button").count()) > 0);
    await page.locator(".gap-button").first().click();
    await page.locator("#diff-view").selectOption("unified");
    await page.locator("#layout-select").selectOption("code-first");
    assert.equal(
      await page.locator("#workspace").getAttribute("data-layout"),
      "code-first",
    );
    await page.locator("#layout-select").selectOption("code-last");

    await page.locator("#review-add").click();
    await page.locator("tr[data-line='66'] .line-new button").click();
    await page.locator("#review-write").click();
    await page.locator("#review-text").fill("Add a test for limit zero.");
    await page.locator("#review-save").click();
    await page.locator("#review-open").filter({ hasText: "(1)" }).waitFor();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#review-download").click();
    const download = await downloadPromise;
    const exportPath = path.join(output, "comments.json");
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    assert.equal(exported.kind, "codex-deck-diff-review");
    assert.equal(exported.comments[0].code, "result = Token()");
    await page.locator("#review-import-open").click();
    await page
      .locator("#review-import-text")
      .fill(JSON.stringify({ ...exported, snapshot: "another-snapshot" }));
    await page.locator("#review-import-check").click();
    assert.match(
      await page.locator("#review-import-error").textContent(),
      /snapshot differs/,
    );
    const incoming = structuredClone(exported);
    incoming.comments[0].body = "Test the boundary before applying the limit.";
    await page.locator("#review-import-text").fill(JSON.stringify(incoming));
    await page.locator("#review-import-check").click();
    await page.locator("#review-import-conflict-options").waitFor();
    await page.locator("#review-import-policy").selectOption("replace");
    await page.locator("#review-import-apply").click();
    await page
      .locator(".review-body")
      .filter({ hasText: "Test the boundary" })
      .waitFor();
    await page.locator("#review-close").click();
    await page.screenshot({ path: path.join(output, "desktop-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(
      await page
        .locator(".guide")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(24, 24, 27)",
    );
    assert.equal(
      await page
        .locator(".pane-resizer")
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(32, 32, 36)",
    );
    await page.screenshot({ path: path.join(output, "desktop-dark.png") });
    await page.locator("#next").click();
    await page.locator("#next").click();
    assert.equal(await page.locator("#file-path").textContent(), "removed.txt");
    await page.locator("#diff-view").selectOption("split");
    assert.ok((await page.locator(".split-row .del").count()) > 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#step-select").selectOption("0");
    await page.locator("#code-tab").click();
    await page.locator("#next").click();
    assert.match(await page.locator("#focus-title").textContent(), /Token/);
    await page.locator("#expand-code").click();
    assert.equal(
      await page.locator("body").getAttribute("data-code-expanded"),
      "true",
    );
    await page.locator("#code-menu-toggle").click();
    await page.locator("#wrap-code").click();
    assert.equal(await page.locator("body").getAttribute("data-wrap"), "true");
    await page.screenshot({ path: path.join(output, "mobile-dark.png") });
    await page.locator("#show-guide").click();
    assert.equal(
      await page.locator("body").getAttribute("data-mobile-pane"),
      "guide",
    );
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: path.join(output, "mobile-light.png") });
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
    console.log(
      JSON.stringify({
        result: "passed",
        output,
        screenshots: 4,
        offline: true,
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
