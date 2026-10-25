import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let baseURL: string;
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import OperationalNotices from "/web/components/operational-notices.tsx";
import HookExecutionProgress from "/web/components/hook-execution-progress.tsx";
import { publishCodexRuntimeEvent } from "/web/codex-runtime-events.ts";
window.publish = publishCodexRuntimeEvent;
const panel = new URLSearchParams(location.search).get("panel");
createRoot(document.getElementById("root")).render(React.createElement(
  panel === "hooks" ? HookExecutionProgress : OperationalNotices,
  {threadId:"thread"},
));
`;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "runtime-snapshot-fixture",
        resolveId(id) {
          if (id === "/runtime-fixture.js") return "\0runtime-fixture.js";
        },
        load(id) {
          if (id === "\0runtime-fixture.js") return entry;
        },
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url === "/" || req.url?.startsWith("/?")) {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<html><div id="root"></div><script type="module" src="/runtime-fixture.js"></script></html>',
              );
            } else next();
          });
        },
      },
    ],
    server: { port: 0, host: "127.0.0.1" },
  });
  await server.listen();
  baseURL = server.resolvedUrls!.local[0];
});
test.afterAll(async () => {
  await server?.close();
});

async function publish(
  page: Page,
  panel: string,
  text: string,
  remember = false,
) {
  await page.evaluate(
    ({ panel, text, remember }) => {
      const target = window as unknown as {
        publish(event: unknown): void;
        retainedPayload?: WeakRef<object>;
      };
      const event =
        panel === "hooks"
          ? {
              type: "hook_run",
              threadId: "thread",
              turnId: "turn",
              run: {
                id: "run",
                eventName: "preToolUse",
                handlerType: "command",
                executionMode: "async",
                scope: "turn",
                sourcePath: "/hooks",
                source: "project",
                displayOrder: 0,
                status: "running",
                startedAt: 1,
                completedAt: null,
                durationMs: null,
                statusMessage: text,
                entries: [{ kind: "feedback", text }],
              },
            }
          : {
              type: "operational_notification",
              threadId: "thread",
              notification: {
                id: text,
                timestamp: Date.now(),
                method: "item/mcpToolCall/progress",
                threadId: "thread",
                turnId: "turn",
                itemId: "item",
                summary: text,
                details: { message: text },
              },
            };
      if (remember)
        target.retainedPayload = new WeakRef(
          panel === "hooks" ? event : event.notification!,
        );
      target.publish(event);
    },
    { panel, text, remember },
  );
  await expect(page.locator("body")).toContainText(text);
}
async function expectPayloadReleased(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await expect
      .poll(async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        return page.evaluate(
          () =>
            !(
              window as unknown as { retainedPayload: WeakRef<object> }
            ).retainedPayload.deref(),
        );
      })
      .toBe(true);
  } finally {
    await cdp.detach();
  }
}

for (const panel of ["hooks", "notices"]) {
  for (const succeeds of [true, false]) {
    test(`${panel} reconciles in-flight events and releases payloads after snapshot ${succeeds ? "success" : "failure"}`, async ({
      page,
    }) => {
      let release!: () => void, requested!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const endpoint =
        panel === "hooks"
          ? "**/api/codex/threads/thread/hook-runs"
          : "**/api/codex/notifications?threadId=thread";
      await page.route(endpoint, async (route) => {
        requested();
        await pending;
        await route.fulfill({
          status: succeeds ? 200 : 503,
          json: succeeds
            ? panel === "hooks"
              ? { runs: [] }
              : { notifications: [] }
            : { error: "snapshot unavailable" },
        });
      });
      try {
        await page.goto(`${baseURL}?panel=${panel}`);
        await started;
        // Warm up React's eager state path before tracking a later payload.
        await publish(page, panel, "warmup");
        await publish(page, panel, "during-snapshot-first", true);
        for (let i = 0; i < 5; i++)
          await publish(page, panel, `during-snapshot-${i}`);
        // Pending snapshots also coalesce updates instead of retaining every payload.
        await expectPayloadReleased(page);
        release();
        if (succeeds)
          await expect(page.locator("body")).toContainText("during-snapshot-4");
        else
          await expect(page.locator("body")).toContainText(
            "snapshot unavailable",
          );
        // Let the snapshot promise settle before testing ongoing live traffic.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await publish(page, panel, "after-snapshot-first", true);
        for (let i = 0; i < 10; i++)
          await publish(page, panel, `after-snapshot-${i}`);
        await expectPayloadReleased(page);
        await expect(page.locator("body")).toContainText("after-snapshot-9");
        await expect(page.locator("body")).not.toContainText(
          "after-snapshot-first",
        );
      } finally {
        release();
      }
    });
  }
}
