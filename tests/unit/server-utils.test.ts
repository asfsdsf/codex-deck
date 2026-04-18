import assert from "node:assert/strict";
import test from "node:test";
import { waitForAbortableTimeout } from "../../api/server/utils";

test("waitForAbortableTimeout resolves promptly after abort", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const waitPromise = waitForAbortableTimeout(5_000, controller.signal);

  setTimeout(() => {
    controller.abort();
  }, 20);

  await waitPromise;

  assert.ok(
    Date.now() - start < 500,
    "expected abortable timeout to resolve without waiting for the full delay",
  );
});
