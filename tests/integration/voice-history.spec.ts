import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("saved voice history reopens without media and keeps its pagination snapshot", async ({
  app,
  page,
}) => {
  const event = {
    kind: "transcript",
    role: "user",
    text: "Update the labels",
    realtimeSessionId: "voice-1",
    eventId: "speech-1",
    position: 2,
    observedAtMs: 1730000000000,
  };
  let nextRequests = 0;
  await page.route(
    `**/api/codex/threads/${app.sessions.alpha}/realtime/history*`,
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const next = params.has("cursor");
      if (next) {
        expect(params.get("cursor")).toBe("page-two");
        expect(params.get("snapshotEnd")).toBe("20");
        nextRequests += 1;
      }
      await route.fulfill({
        json: {
          coverage: "ready",
          snapshotEnd: 20,
          projectedThroughItemIndex: 20,
          nextCursor: next ? null : "page-two",
          data: next
            ? [
                {
                  ...event,
                  kind: "handoff",
                  mode: "steer",
                  eventId: "handoff",
                  position: 4,
                },
                {
                  ...event,
                  kind: "saved",
                  eventId: "saved",
                  position: 9,
                  text: "One more thought",
                },
              ]
            : [event],
        },
      });
    },
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  await page.reload();
  await ui.selectSession("Review the launch checklist");
  await page.getByText("Saved voice history", { exact: true }).click();
  await expect(
    page.getByText("Update the labels", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more voice history" }).click();
  await expect(page.getByText("Steered a turn", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Saved when voice ended", { exact: true }),
  ).toBeVisible();
  expect(nextRequests).toBe(1);
});
