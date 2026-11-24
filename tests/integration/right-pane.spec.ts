import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL });

test("conversation file links open the preview with the file tree closed", async ({
  page,
  app,
}) => {
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    "[Open the launch checklist source](src/main.ts#L2)",
  );

  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");

  const link = page.getByRole("link", {
    name: "Open the launch checklist source",
  });
  await link.click();

  const pane = page.locator(".pane-right");
  const tree = pane.getByRole("tree", { name: "Workspace files" });
  const toggle = pane.getByRole("button", { name: "File tree panel" });
  await expect(
    pane.getByRole("tab", { name: "main.ts Close" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    pane.getByText("review launch notes", { exact: false }),
  ).toBeVisible();
  await expect(tree).toBeHidden();

  await toggle.click();
  await expect(tree).toBeVisible();

  await link.click();
  await expect(tree).toBeHidden();
});

for (const theme of ["light", "dark"] as const) {
  test(`right pane renders documents and keeps native tab controls usable in ${theme} mode`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await mkdir(join(app.projects.alpha, "documents"), { recursive: true });
    await writeFile(
      join(app.projects.alpha, "documents", "guide.md"),
      `# Workspace guide

<p align="center"><strong>HTML content</strong></p>

| Feature | State |
| --- | --- |
| Markdown | Ready |

- [x] Tested

\`\`\`ts
const answer = 42;
\`\`\`

[Next document](next.md)

<script>window.untrustedMarkdown = true</script>
`,
    );
    await writeFile(
      join(app.projects.alpha, "documents", "next.md"),
      "# Second document\n\nOpened from a relative link.\n",
    );
    const ui = new CodexDeckPage(page);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    await page
      .getByRole("button", { name: "Expand right pane", exact: true })
      .click();
    const pane = page.locator(".pane-right");
    await pane.evaluate((element) => (element.style.width = "648px"));
    await pane.locator('[data-right-pane-guide-entry="files"]').click();
    await pane
      .getByRole("treeitem", { name: "documents", exact: true })
      .click();
    await pane.getByRole("treeitem", { name: "guide.md", exact: true }).click();
    await expect(
      pane.getByRole("heading", { name: "Workspace guide", exact: true }),
    ).toBeVisible();
    await expect(pane.locator("table")).toBeVisible();
    await expect(pane.getByText("HTML content", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { untrustedMarkdown?: boolean })
            .untrustedMarkdown,
      ),
    ).toBeUndefined();
    await pane.getByRole("button", { name: "Wrap lines", exact: true }).click();
    await expect(
      pane.locator(".right-pane-document__code-block pre"),
    ).toHaveAttribute("data-wrap", "false");
    await pane
      .getByRole("link", { name: "Next document", exact: true })
      .click();
    await expect(
      pane.getByRole("heading", { name: "Second document", exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("tab", { name: "guide.md Close", exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("tab", { name: "guide.md Close", exact: true })
      .hover();
    await pane
      .getByRole("tab", { name: "guide.md Close", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      pane.getByRole("heading", { name: "Second document", exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(
      pane.locator('[data-right-pane-guide-entry="tasks"]'),
    ).toBeVisible();
    await pane.locator('[data-right-pane-guide-entry="tasks"]').click();
    await pane.getByRole("button", { name: "Split", exact: true }).click();
    await expect(pane.locator(".right-pane__dock")).toHaveCount(2);
    await pane
      .locator(".right-pane__dock")
      .last()
      .locator('[data-right-pane-guide-entry="files"]')
      .click();
    await expect(
      pane
        .locator(".right-pane__dock")
        .first()
        .getByText("No subagents", { exact: true }),
    ).toBeVisible();
    await expect(
      pane
        .locator(".right-pane__dock")
        .last()
        .getByRole("tree", { name: "Workspace files" }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(pane).toHaveAttribute("data-fullscreen", "true");
    await pane
      .getByRole("button", { name: "Exit fullscreen", exact: true })
      .click();
    await expect(pane).toHaveAttribute("data-fullscreen", "false");
  });
}

test("file edits save explicitly, detect conflicting disk changes, and reload safely", async ({
  page,
  app,
}) => {
  const path = join(app.projects.alpha, "editable.md");
  await writeFile(path, "# Original\n");
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page
    .getByRole("button", { name: "Expand right pane", exact: true })
    .click();
  const pane = page.locator(".pane-right");
  await pane.locator('[data-right-pane-guide-entry="files"]').click();
  await pane
    .getByRole("treeitem", { name: "editable.md", exact: true })
    .click();
  await expect(
    pane.getByRole("heading", { name: "Original", exact: true }),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Edit", exact: true }).click();
  await pane
    .getByRole("textbox", { name: "Edit file", exact: true })
    .fill("# Saved from editor\n");
  expect(await readFile(path, "utf8")).toBe("# Original\n");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFile(path, "utf8")).toBe("# Saved from editor\n");
  await pane
    .getByRole("textbox", { name: "Edit file", exact: true })
    .fill("# Local draft\n");
  await writeFile(path, "# Changed externally\n");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pane.getByRole("alert")).toContainText("changed on disk");
  expect(await readFile(path, "utf8")).toBe("# Changed externally\n");
  page.once("dialog", (dialog) => dialog.accept());
  await pane.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    pane.getByRole("textbox", { name: "Edit file", exact: true }),
  ).toHaveValue("# Changed externally\n");
});

test("workspace saves refresh every connected browser page", async ({
  page,
  context,
  app,
}) => {
  const path = join(app.projects.alpha, "shared.md");
  await writeFile(path, "# Shared original\n");
  const other = await context.newPage();
  for (const target of [page, other]) {
    const ui = new CodexDeckPage(target);
    await ui.goto(app.baseURL);
    await ui.selectSession("Review the launch checklist");
    await target
      .getByRole("button", { name: "Expand right pane", exact: true })
      .click();
    await target.locator('[data-right-pane-guide-entry="files"]').click();
    await target
      .getByRole("treeitem", { name: "shared.md", exact: true })
      .click();
    await expect(
      target.getByRole("heading", { name: "Shared original", exact: true }),
    ).toBeVisible();
  }
  const pane = page.locator(".pane-right");
  await pane.getByRole("button", { name: "Edit", exact: true }).click();
  await pane
    .getByRole("textbox", { name: "Edit file", exact: true })
    .fill("# Shared update\n");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    other.getByRole("heading", { name: "Shared update", exact: true }),
  ).toBeVisible();
  await other.close();
});

test("narrow panes keep header buttons and upload actions inside the pane", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page
    .getByRole("button", { name: "Expand right pane", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = page.locator(".pane-right");
  await pane.locator('[data-right-pane-guide-entry="files"]').click();
  for (const label of [
    "New tab",
    "Fullscreen",
    "Collapse right sidebar",
    "Upload files",
    "Upload folder",
    "Sort",
  ]) {
    const control = pane.getByRole("button", { name: label, exact: true });
    await expect(control).toBeVisible();
    const [bounds, container] = await Promise.all([
      control.boundingBox(),
      pane.boundingBox(),
    ]);
    expect(bounds!.x).toBeGreaterThanOrEqual(container!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      container!.x + container!.width + 1,
    );
  }
  await pane
    .getByLabel("Upload file selection", { exact: true })
    .setInputFiles({
      name: "uploaded.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Uploaded from browser\n"),
    });
  await expect(
    pane.getByRole("treeitem", { name: "uploaded.md", exact: true }),
  ).toBeVisible();
  expect(await readFile(join(app.projects.alpha, "uploaded.md"), "utf8")).toBe(
    "# Uploaded from browser\n",
  );
});
