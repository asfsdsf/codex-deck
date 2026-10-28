import assert from "node:assert/strict";
import test from "node:test";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import {
  MAX_OUTPUT_SCHEMA_BYTES,
  parseOutputSchemaInput,
} from "../../api/codex-output-schema";
import {
  parseOutputSchemaDraft,
  summarizeOutputSchema,
} from "../../web/output-schema";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

test("the send-message route accepts only a JSON object output schema", () => {
  assert.deepEqual(parseOutputSchemaInput(undefined), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(parseOutputSchemaInput(null), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(parseOutputSchemaInput(schema), {
    ok: true,
    value: schema,
  });
  for (const invalid of ["{}", 3, true, [schema]]) {
    assert.deepEqual(parseOutputSchemaInput(invalid), {
      ok: false,
      error: "outputSchema must be a JSON object",
    });
  }
  assert.equal(
    parseOutputSchemaInput({ big: "x".repeat(MAX_OUTPUT_SCHEMA_BYTES) }).ok,
    false,
  );
});

test("the composer validates and summarizes an attached schema", () => {
  assert.equal(parseOutputSchemaDraft("  ").ok, false);
  const invalidJson = parseOutputSchemaDraft("{ type: object }");
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.ok ? "" : invalidJson.error, /^Invalid JSON/);
  assert.deepEqual(parseOutputSchemaDraft("[1]"), {
    ok: false,
    error: "The schema must be a JSON object.",
  });
  assert.deepEqual(parseOutputSchemaDraft(JSON.stringify(schema)), {
    ok: true,
    value: schema,
  });
  assert.equal(summarizeOutputSchema(schema), "object · 1 property");
  assert.equal(
    summarizeOutputSchema({ title: "Report", type: "object", properties: {} }),
    "Report · object · 0 properties",
  );
  assert.equal(summarizeOutputSchema({}), "custom schema");
});

test("turn/start carries outputSchema and a schema send never steers", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const harness = client as unknown as Record<string, unknown>;
  harness.readActiveConfig = async () => ({
    model: null,
    serviceTier: null,
    reasoningEffort: null,
  });
  harness.reloadProviderIfChanged = async () => {};
  harness.applyDaybreakToTurn = async () => {};
  harness.reloadAuthIfChanged = async () => {};
  harness.updateThreadSettingsForTurn = async () => {};
  harness.steerActiveTurn = async () => {
    throw new Error("must not steer");
  };
  harness.request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { turn: { id: "turn-1" } };
  };
  const result = await client.sendMessage({
    threadId: "thread-1",
    input: [{ type: "text", text: "summarize" }],
    steerActiveTurn: true,
    outputSchema: schema,
  });
  assert.equal(result.turnId, "turn-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.outputSchema, schema);

  calls.length = 0;
  await client.sendMessage({
    threadId: "thread-1",
    input: [{ type: "text", text: "plain" }],
  });
  assert.equal("outputSchema" in calls[0].params, false);
  await client.close();
});
