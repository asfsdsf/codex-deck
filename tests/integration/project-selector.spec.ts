import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import {
  responseItemMessageLine,
  sessionMetaLine,
  writeSessionFile,
} from "../unit/test-utils";

test("adds a new project to the open selector without reloading", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.expectSessionVisible("Review the launch checklist");
  await page.locator("#select-project").click();
  const listbox = page.getByRole("listbox", { name: "Projects", exact: true });
  await expect(listbox.getByRole("option")).toHaveCount(3);
  await page
    .getByPlaceholder("Type to narrow projects...")
    .fill("project-gamma");
  await expect(page.getByText("No projects match this search.")).toBeVisible();

  const projectRoot = join(app.rootDir, "projects", "project-gamma");
  const sessionId = "44444444-4444-4444-4444-444444444444";
  await mkdir(projectRoot, { recursive: true });
  await writeSessionFile(join(app.rootDir, "sessions"), `${sessionId}.jsonl`, [
    sessionMetaLine(sessionId, projectRoot, Date.now()),
    responseItemMessageLine("user", "Start the new gamma project"),
  ]);

  // The session stream already updates the list; its project must follow too.
  await ui.expectSessionVisible("Start the new gamma project");
  const option = listbox.getByRole("option", { name: /^project-gamma\s/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator("#select-project")).toHaveText("project-gamma");
  await ui.expectSessionVisible("Start the new gamma project");
  await ui.expectSessionHidden("Review the launch checklist");
});

test("New Session adds a .vim project before Codex writes its history file", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  const projectRoot = join(app.rootDir, ".vim");
  const sessionId = "55555555-5555-5555-5555-555555555555";
  const sessionPath = join(app.rootDir, "sessions", `${sessionId}.jsonl`);
  await mkdir(projectRoot, { recursive: true });
  await page.route("**/api/codex/threads", async (route) => {
    expect(route.request().postDataJSON().cwd).toBe(projectRoot);
    await route.fulfill({ json: { threadId: sessionId } });
  });
  await ui.goto(app.baseURL);
  await ui.expectSessionVisible("Review the launch checklist");
  await page.locator("input.project-path-placeholder-tail").fill(projectRoot);
  await page.getByRole("button", { name: "New Session", exact: true }).click();

  // Creation succeeds before the filesystem watcher has anything to discover.
  await expect(
    page.getByRole("button", { name: "New Session", exact: true }),
  ).toBeEnabled();
  await expect(access(sessionPath)).rejects.toThrow(/ENOENT/);
  await page.locator("#select-project").click();
  const listbox = page.getByRole("listbox", { name: "Projects", exact: true });
  const option = listbox.getByRole("option", { name: /^\.vim\s/ });
  await expect(option).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(4);
  await option.click();
  await ui.expectSessionVisible("(new session)");
  await ui.expectSessionHidden("Review the launch checklist");

  // The persisted session replaces the temporary entry without duplicating it.
  await writeSessionFile(join(app.rootDir, "sessions"), `${sessionId}.jsonl`, [
    sessionMetaLine(sessionId, projectRoot, Date.now()),
    responseItemMessageLine("user", "hi from .vim"),
  ]);
  await ui.expectSessionVisible("hi from .vim");
  await ui.expectSessionHidden("(new session)");
  await page.locator("#select-project").click();
  await expect(option).toHaveCount(1);
  await expect(listbox.getByRole("option")).toHaveCount(4);
});

test("a failed New Session request does not add a project", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  const projectRoot = join(app.rootDir, ".vim");
  await page.route("**/api/codex/threads", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "Project path does not exist" },
    }),
  );
  await ui.goto(app.baseURL);
  await ui.expectSessionVisible("Review the launch checklist");
  await page.locator("input.project-path-placeholder-tail").fill(projectRoot);
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(
    page.getByText("Project path does not exist", { exact: true }),
  ).toBeVisible();
  await page.locator("#select-project").click();
  const listbox = page.getByRole("listbox", { name: "Projects", exact: true });
  await expect(listbox.getByRole("option")).toHaveCount(3);
  await expect(listbox.getByRole("option", { name: /^\.vim\s/ })).toHaveCount(
    0,
  );
  await ui.expectSessionVisible("Review the launch checklist");
});

test("New Session preserves session data received before the create response", async ({
  page,
  app,
}) => {
  const ui = new CodexDeckPage(page);
  const projectRoot = join(app.rootDir, ".vim");
  const sessionId = "66666666-6666-6666-6666-666666666666";
  await mkdir(projectRoot, { recursive: true });
  await page.route("**/api/codex/threads", async (route) => {
    await writeSessionFile(
      join(app.rootDir, "sessions"),
      `${sessionId}.jsonl`,
      [
        sessionMetaLine(sessionId, projectRoot, Date.now()),
        responseItemMessageLine("user", "hi from the persisted .vim session"),
      ],
    );
    await ui.expectSessionVisible("hi from the persisted .vim session");
    await route.fulfill({ json: { threadId: sessionId } });
  });
  await ui.goto(app.baseURL);
  await ui.expectSessionVisible("Review the launch checklist");
  await page.locator("input.project-path-placeholder-tail").fill(projectRoot);
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New Session", exact: true }),
  ).toBeEnabled();
  await ui.expectSessionVisible("hi from the persisted .vim session");
  await ui.expectSessionHidden("(new session)");
  await ui.selectProject(".vim");
  await ui.expectSessionVisible("hi from the persisted .vim session");
  await ui.expectSessionHidden("Review the launch checklist");
});
