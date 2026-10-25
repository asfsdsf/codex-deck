import assert from "node:assert/strict";
import test from "node:test";
import { RecapManager, recapHistory } from "../../api/codex-recap";

test("recap history is bounded on UTF-8 boundaries and excludes tool output", () => {
  const text = recapHistory([
    { type: "user", message: { role: "user", content: "Opening goal" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_result", content: "secret tool output" },
          { type: "text", text: "中文".repeat(20000) },
        ],
      },
    },
    { type: "user", message: { role: "user", content: "Latest correction" } },
  ]);
  assert.ok(Buffer.byteLength(text) <= 28000);
  assert.match(text, /^user: Opening goal/);
  assert.match(text, /Latest correction$/);
  assert.doesNotMatch(text, /secret tool output|�/);
});

test("recaps deduplicate, isolate temporary threads, handle early completion, and clean up", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const updates: string[] = [];
  const manager = new RecapManager(
    async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/resume")
        return { model: "model", modelProvider: "provider", cwd: "/repo" };
      if (method === "config/read")
        return {
          config: { mcp_servers: { dangerous: { command: "external" } } },
        };
      if (method === "thread/start")
        return { thread: { id: "temporary" }, sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        manager.handleNotification("item/completed", {
          threadId: "temporary",
          turnId: "turn",
          item: {
            type: "agentMessage",
            text: JSON.stringify({
              summary: "Implemented and tested the fix.",
              next_action: "Deploy the update.",
            }),
          },
        });
        manager.handleNotification("turn/completed", {
          threadId: "temporary",
          turn: { id: "turn", status: "completed" },
        });
        return { turn: { id: "turn" } };
      }
      return {};
    },
    (id) => updates.push(id),
  );
  const first = manager.start("source", "History");
  assert.equal(manager.start("source", "History").requestId, first.requestId);
  for (
    let index = 0;
    index < 20 && manager.get("source")?.status === "generating";
    index++
  )
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    manager.get("source")?.summary,
    "Implemented and tested the fix.",
  );
  assert.equal(manager.get("source")?.nextAction, "Deploy the update.");
  const start = calls.find((call) => call.method === "thread/start")!.params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.threadSource, "system");
  assert.equal(start.sandbox, "read-only");
  assert.deepEqual((start.config as Record<string, unknown>).mcp_servers, {
    dangerous: { enabled: false },
  });
  assert.equal(
    (start.config as Record<string, unknown>)["features.shell_tool"],
    false,
  );
  assert.ok(calls.some((call) => call.method === "thread/unsubscribe"));
  assert.ok(updates.length >= 3);
});

test("recap failures are visible and permission mismatches never start a turn", async () => {
  let turns = 0,
    detached = 0;
  const manager = new RecapManager(
    async (method) => {
      if (method === "thread/resume")
        return { model: "model", modelProvider: "provider", cwd: "/repo" };
      if (method === "config/read") return { config: {} };
      if (method === "thread/start")
        return {
          thread: { id: "temporary" },
          sandbox: { type: "dangerFullAccess" },
        };
      if (method === "turn/start") turns++;
      if (method === "thread/unsubscribe") detached++;
      return {};
    },
    () => {},
  );
  assert.throws(() => manager.start("empty", ""), /no conversation history/);
  manager.start("source", "History");
  for (
    let index = 0;
    index < 20 && manager.get("source")?.status === "generating";
    index++
  )
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.get("source")?.status, "failed");
  assert.match(manager.get("source")?.error || "", /permission restrictions/);
  assert.equal(turns, 0);
  assert.equal(detached, 1);
});
