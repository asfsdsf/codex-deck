import { parseArgs } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, basename, relative, isAbsolute } from "node:path";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    reference: { type: "string", default: "http://127.0.0.1:3080/" },
    deck: { type: "string", default: "http://127.0.0.1:12002/" },
    auth: { type: "string" },
    workspace: { type: "string" },
    output: { type: "string", default: "artifacts/right-pane-parity" },
    surface: { type: "string" },
  },
});
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
});
const metrics = values.surface
  ? await readFile(resolve(output, "metrics.json"), "utf8")
      .then((value) =>
        JSON.parse(value).filter((entry) => entry.surface !== values.surface),
      )
      .catch(() => [])
  : [];
try {
  for (const theme of ["light", "dark"])
    for (const surface of values.surface
      ? [values.surface]
      : ["start", "files", "preview", "git", "tasks"]) {
      for (const app of ["reference", "codex"]) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: theme,
          ...(app === "reference" && values.auth
            ? { storageState: resolve(values.auth) }
            : {}),
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // Both panes show the same workspace fixture when one is provided. No
        // server files/settings or reference sessions are changed by this script.
        if (app === "codex" && values.workspace) {
          const workspace = resolve(values.workspace);
          await page.route(
            /\/api\/sessions\/[^/]+\/file-tree\/nodes\?/,
            async (route) => {
              const url = new URL(route.request().url());
              const dir = url.searchParams.get("dir") || "";
              const target = resolve(workspace, dir);
              const local = relative(workspace, target);
              if (
                local === ".." ||
                local.startsWith("../") ||
                isAbsolute(local)
              )
                return route.fulfill({
                  status: 403,
                  json: { error: "Fixture path is outside its workspace" },
                });
              const entries = await readdir(target, {
                withFileTypes: true,
              });
              await route.fulfill({
                json: {
                  sessionId: "comparison",
                  projectPath: workspace,
                  dir,
                  nodes: entries.map((entry) => ({
                    name: entry.name,
                    path: [dir, entry.name].filter(Boolean).join("/"),
                    isDirectory: entry.isDirectory(),
                  })),
                  nextCursor: null,
                  unavailableReason: null,
                },
              });
            },
          );
          await page.route(
            /\/api\/sessions\/[^/]+\/file-content\?/,
            async (route) => {
              const path =
                new URL(route.request().url()).searchParams.get("path") ||
                "README.md";
              const target = resolve(workspace, path);
              const local = relative(workspace, target);
              if (
                local === ".." ||
                local.startsWith("../") ||
                isAbsolute(local)
              )
                return route.fulfill({
                  status: 403,
                  json: { error: "Fixture path is outside its workspace" },
                });
              const file = await readFile(target);
              const image = /\.(png|jpg|jpeg|svg|webp)$/i.exec(path)?.[1];
              await route.fulfill({
                json: {
                  sessionId: "comparison",
                  projectPath: workspace,
                  path,
                  content: image ? "" : file.toString("utf8"),
                  page: 1,
                  totalPages: 1,
                  paginationMode: "lines",
                  lineStart: 1,
                  lineEnd: 1,
                  isBinary: Boolean(image),
                  previewKind: image ? "image" : null,
                  previewMediaType: image
                    ? `image/${image === "svg" ? "svg+xml" : image}`
                    : null,
                  previewDataUrl: image
                    ? `data:image/${image === "svg" ? "svg+xml" : image};base64,${file.toString("base64")}`
                    : null,
                  previewUnavailableReason: null,
                  unavailableReason: null,
                },
              });
            },
          );
        }
        await page.goto(values[app === "reference" ? "reference" : "deck"]);
        await page
          .getByRole("button", {
            name:
              app === "reference" ? "Open right sidebar" : "Expand right pane",
            exact: true,
          })
          .click();
        const pane = page
          .locator(
            app === "reference"
              ? "[data-sidebar-right-open] [data-dockkit-pane]"
              : ".pane-right",
          )
          .first();
        if (app === "codex")
          await pane.evaluate((element) => (element.style.width = "648px"));
        if (surface === "start" && app === "reference") {
          await pane.locator("[data-sidebar-right-guide]").evaluate((guide) => {
            for (const entry of guide.children) {
              const buttons = [...entry.querySelectorAll("button")];
              if (
                buttons.length &&
                !buttons.some((button) =>
                  ["Files", "Git", "Tasks"].includes(button.textContent.trim()),
                )
              )
                entry.style.display = "none";
            }
          });
        }
        if (surface !== "start") {
          const name = ["files", "preview"].includes(surface)
            ? "files"
            : surface;
          if (app === "reference")
            await pane
              .getByRole("button", { name: new RegExp(`^${name}$`, "i") })
              .click();
          else
            await pane
              .locator(`[data-right-pane-guide-entry="${name}"]`)
              .click();
        }
        if (surface === "preview") {
          if (app === "reference")
            await pane
              .getByRole("button", { name: "README.md", exact: true })
              .click();
          else
            await pane.locator('[role="treeitem"][title="README.md"]').click();
          await pane
            .locator(
              app === "reference"
                ? '[class*="_markdown_"] h1'
                : ".right-pane-document h1",
            )
            .first()
            .waitFor();
          await pane
            .locator("img")
            .evaluateAll((images) =>
              Promise.all(
                images.map((image) => image.decode().catch(() => {})),
              ),
            );
        }
        if (surface === "git")
          await pane.getByText("Changes", { exact: true }).first().waitFor();
        await page.mouse.move(4, 880);
        await page.waitForTimeout(1000);
        const file = `${app}-${theme}-${surface}.png`;
        await pane.screenshot({ path: resolve(output, file) });
        const bounds = await pane.boundingBox();
        const controls = await pane
          .locator('button,input,[role="tab"]')
          .evaluateAll((elements) =>
            elements
              .map((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  label:
                    element.getAttribute("aria-label") ||
                    element.getAttribute("placeholder") ||
                    element.textContent.trim().slice(0, 70),
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  font: style.font,
                  color: style.color,
                };
              })
              .filter((entry) => entry.width > 0),
          );
        metrics.push({ app, theme, surface, file, bounds, controls, errors });
        console.log(
          `${app} ${theme} ${surface}: ${bounds.width}×${bounds.height}; ${errors.length} page errors`,
        );
        await context.close();
      }
    }
} finally {
  await browser.close();
}
await writeFile(
  resolve(output, "metrics.json"),
  JSON.stringify(metrics, null, 2),
);
const sections = ["light", "dark"].flatMap((theme) =>
  ["start", "files", "preview", "git", "tasks"].map(
    (surface) =>
      `<section><h2>${theme} · ${surface}</h2><div><figure><figcaption>DeepSeek Harness + plugins</figcaption><img src="reference-${theme}-${surface}.png"></figure><figure><figcaption>Codex Deck</figcaption><img src="codex-${theme}-${surface}.png"></figure></div></section>`,
  ),
);
await writeFile(
  resolve(output, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Right pane comparison</title><style>body{font:14px system-ui;background:#e8e8e8;margin:20px}section{margin-bottom:40px}section>div{display:flex;gap:16px}figure{margin:0;flex:1;min-width:0}figcaption{margin-bottom:8px}img{display:block;width:100%;border:1px solid #ccc}</style><h1>Right pane comparison</h1><p>1440×900 viewport; 648px pane. Start reference shows only Files, Git and Tasks to match the requested scope. ${values.workspace ? `Files/Markdown use the same ${basename(values.workspace)} workspace fixture.` : "Workspace data may differ."} Git data comes from each app's selected workspace.</p>${sections.join("")}`,
);
