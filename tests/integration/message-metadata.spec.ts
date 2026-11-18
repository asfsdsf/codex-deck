import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./helpers/codex-deck-fixture";
import { CodexDeckPage } from "./pages/codex-deck-page";
import {
  eventMsgLine,
  responseItemMessageLine,
  sessionMetaLine,
} from "../unit/test-utils";

test("a restricted answer stays out of the conversation and session search after reload", async ({
  app,
  page,
  request,
}) => {
  const id = "65656565-6565-6565-6565-656565656565";
  const original = "RestrictedFixtureText873";
  const publicReply = "VisibleFixtureReply873";
  const prompt = "Check the metadata fixture";
  await writeFile(
    join(app.rootDir, "sessions", `${id}.jsonl`),
    [
      sessionMetaLine(id, app.projects.alpha, Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn-1" }),
      responseItemMessageLine("user", prompt),
      eventMsgLine({
        type: "item_completed",
        turn_id: "turn-1",
        started_at_ms: 1730000001000,
        completed_at_ms: 1730000003000,
        content_token_count: 8,
        item: {
          type: "AgentMessage",
          id: "blocked-answer",
          content: [{ type: "Text", text: original }],
          phase: "final_answer",
          moderation: {
            moderated: true,
            display: {
              version: 1,
              mode: "block",
              reason: { kind: "protection", protectionType: "fixture" },
            },
          },
        },
      }),
      responseItemMessageLine("assistant", original),
      responseItemMessageLine("assistant", publicReply),
      eventMsgLine({ type: "task_complete", turn_id: "turn-1" }),
      "",
    ].join("\n"),
  );
  const ui = new CodexDeckPage(page);
  await ui.goto(app.baseURL);
  await ui.selectSession(prompt);
  await page.reload();
  await ui.selectSession(prompt);
  await expect(
    page.getByText("Codex blocked this answer.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(publicReply, { exact: true })).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toHaveCount(0);

  const apiRoot = `${app.baseURL}/api`;
  const raw = await request.get(`${apiRoot}/conversation/${id}/raw-chunk`);
  expect(raw.status()).toBe(409);
  const parsed = await request.get(`${apiRoot}/conversation/${id}`);
  expect(await parsed.text()).not.toContain(original);
  const search = await request.get(
    `${apiRoot}/sessions/search?query=${original}`,
  );
  expect((await search.json()).sessionIds).not.toContain(id);
  const visibleSearch = await request.get(
    `${apiRoot}/sessions/search?query=${publicReply}`,
  );
  expect((await visibleSearch.json()).sessionIds).toContain(id);
});
