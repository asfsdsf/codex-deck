import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";

test("fresh plan handoff keeps the proposal retryable and opens the implementation on success", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const markdown = "## Launch plan\n\nUpdate the launch checklist.";
  const freshId = "42424242-4242-4242-4242-424242424242";
  await app.appendSessionMessage(
    "alpha",
    "assistant",
    `<proposed_plan>\n${markdown}\n</proposed_plan>`,
  );
  let requests = 0;
  await page.route(
    `**/api/codex/threads/${app.sessions.alpha}/implement-plan`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({ markdown });
      if (++requests === 1) {
        await route.fulfill({
          status: 400,
          json: { error: "Codex could not prepare the plan." },
        });
        return;
      }
      await app.createSession({
        sessionId: freshId,
        projectKey: "alpha",
        prompt: "Implement the launch plan",
        assistantReply: "Beginning fresh implementation.",
      });
      await route.fulfill({
        json: {
          thread: {
            threadId: freshId,
            name: "Launch implementation",
            preview: "Implement the launch plan",
            cwd: app.projects.alpha,
            status: "idle",
          },
          turnId: "fresh-turn",
        },
      });
    },
  );

  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession("Review the launch checklist");
  const fresh = page.getByRole("button", {
    name: "Implement in a new conversation",
  });
  await fresh.click();
  await expect(
    page.getByText("Codex could not prepare the plan.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Launch plan", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Implement here" }),
  ).toBeEnabled();
  await fresh.click();
  await expect(
    page.getByText("Beginning fresh implementation.", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(2);
});
