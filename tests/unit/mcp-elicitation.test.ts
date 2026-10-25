import assert from "node:assert/strict";
import test from "node:test";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import {
  elicitationFields,
  elicitationFormContent,
  elicitationUrl,
  parseElicitationRequest,
  validateElicitationResponse,
} from "../../api/mcp-elicitation";
import type { CodexAppServerEvent } from "../../api/storage";

const schema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email", minLength: 3, maxLength: 40 },
    count: { type: "integer", minimum: 1, maximum: 5 },
    allowed: { type: "boolean" },
    choice: {
      type: "string",
      oneOf: [
        { const: "a", title: "Alpha" },
        { const: "b", title: "Beta" },
      ],
    },
    colors: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: "red", title: "Red" },
          { const: "blue", title: "Blue" },
        ],
      },
    },
  },
  required: ["email", "count", "allowed", "colors"],
};
const params = {
  threadId: "thread",
  turnId: null,
  serverName: "example",
  mode: "form",
  message: "Configure",
  requestedSchema: schema,
};
const request = parseElicitationRequest("1", params)!;
const content = {
  email: "test@example.com",
  count: 2,
  allowed: false,
  choice: "a",
  colors: ["red"],
};

test("MCP form submission preserves empty string choices without converting blank numbers to zero", () => {
  const request = parseElicitationRequest("empty", {
    ...params,
    requestedSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        choice: { type: "string", enum: ["", "other"], default: "" },
        count: { type: "number" },
      },
      required: ["name", "choice"],
    },
  })!;
  const response = {
    action: "accept",
    content: elicitationFormContent(
      elicitationFields(request.requestedSchema),
      { choice: "", count: "" },
    ),
  };
  assert.deepEqual(response.content, { name: "", choice: "" });
  validateElicitationResponse(request, response);
});

test("MCP forms reject unsupported rules inside enum choices and array items", () => {
  for (const field of [
    { type: "array", items: { type: "string", enum: ["a"], pattern: "^b$" } },
    { type: "string", oneOf: [{ const: "a", minLength: 2 }] },
    { type: "string", enum: ["a"], oneOf: [{ const: "b" }] },
    { type: "boolean", enum: ["yes"] },
    { type: "array", items: { type: "number", enum: ["a"] } },
  ]) {
    assert.throws(
      () =>
        validateElicitationResponse(
          parseElicitationRequest("unsupported", {
            ...params,
            requestedSchema: { type: "object", properties: { field } },
          })!,
          { action: "accept", content: {} },
        ),
      /Invalid elicitation response/,
    );
  }
});

test("MCP forms validate required values, primitive types, constraints and enum arrays", () => {
  assert.equal(elicitationFields(schema).length, 5);
  validateElicitationResponse(request, { action: "accept", content });
  validateElicitationResponse(request, { action: "decline", content: null });
  validateElicitationResponse(request, { action: "cancel" });
  for (const patch of [
    { email: "invalid" },
    { count: 1.1 },
    { count: 6 },
    { allowed: "true" },
    { colors: [] },
    { colors: ["red", "red"] },
    { choice: "c" },
    { extra: "field" },
  ]) {
    assert.throws(
      () =>
        validateElicitationResponse(request, {
          action: "accept",
          content: { ...content, ...patch },
        }),
      /Invalid elicitation response/,
    );
  }
  assert.throws(
    () =>
      validateElicitationResponse(request, { action: "accept", content: {} }),
    /required/,
  );
  assert.throws(
    () => validateElicitationResponse(request, { action: "decline", content }),
    /must not include content/,
  );
  assert.throws(
    () => validateElicitationResponse(request, { action: "approve" }),
    /action/,
  );
  assert.throws(
    () =>
      elicitationFields({
        type: "object",
        properties: { nested: { type: "object" } },
      }),
    /Unsupported field/,
  );
  assert.throws(
    () => elicitationFields({ ...schema, allOf: [] }),
    /unsupported validation/,
  );
  for (const mode of ["openai/form", "openaiForm"])
    validateElicitationResponse(
      parseElicitationRequest("2", { ...params, mode })!,
      { action: "accept", content },
    );
});

test("MCP authorization only permits HTTP links and cannot fabricate native verification", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///secret",
    "data:text/html,hi",
    "https://user:pass@example.com",
  ])
    assert.equal(elicitationUrl(url), null);
  assert.equal(
    elicitationUrl("https://example.com/auth"),
    "https://example.com/auth",
  );
  const urlRequest = parseElicitationRequest("url", {
    ...params,
    mode: "url",
    url: "https://example.com/auth",
    elicitationId: "e-1",
  })!;
  validateElicitationResponse(urlRequest, { action: "accept" });
  assert.throws(
    () =>
      validateElicitationResponse(
        { ...urlRequest, url: "javascript:alert(1)" },
        { action: "accept" },
      ),
    /not supported/,
  );
  const verification = parseElicitationRequest("v", {
    ...params,
    mode: "openai/userVerification",
    title: "Verify",
    description: "Use a device",
    challenge: "secret-challenge",
  })!;
  assert.doesNotMatch(JSON.stringify(verification), /secret-challenge/);
  validateElicitationResponse(verification, { action: "decline" });
  assert.throws(
    () =>
      validateElicitationResponse(verification, {
        action: "accept",
        content: { proof: "fake" },
      }),
    /verification is unavailable/,
  );
});

test("MCP requests share pending state, reject duplicate submissions, resolve and clean up", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    handleStdoutMessage(message: Record<string, unknown>): void;
    handleServerNotification(method: string, params: unknown): void;
    handleProcessExit(reason: string): void;
    respondToServerRequest(
      id: string | number,
      response: unknown,
    ): Promise<void>;
  };
  const first: CodexAppServerEvent[] = [];
  const second: CodexAppServerEvent[] = [];
  client.subscribeAppServerEvents((event) => first.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  const send = (id: number, threadId = "thread") =>
    internal.handleStdoutMessage({
      id,
      method: "mcpServer/elicitation/request",
      params: { ...params, threadId },
    });
  let release!: () => void;
  const responses: unknown[] = [];
  internal.respondToServerRequest = async (id, response) => {
    responses.push({ id, response });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    send(1);
    send(2, "other");
    assert.equal(client.listPendingElicitations("thread").length, 1);
    assert.equal(client.listPendingElicitations("other").length, 1);
    const copy = client.listPendingElicitations("thread")[0];
    copy.message = "modified by caller";
    assert.equal(
      client.listPendingElicitations("thread")[0].message,
      "Configure",
    );
    await assert.rejects(
      client.submitElicitation("other", "1", { action: "cancel" }),
      /not found/,
    );
    await assert.rejects(
      client.submitElicitation("thread", "1", {
        action: "accept",
        content: {},
      }),
      /required/,
    );
    const submission = client.submitElicitation("thread", "1", {
      action: "accept",
      content,
    });
    await assert.rejects(
      client.submitElicitation("thread", "1", { action: "cancel" }),
      /already in progress/,
    );
    release();
    await submission;
    assert.deepEqual(
      [...responses],
      [{ id: 1, response: { action: "accept", content, _meta: null } }],
    );
    assert.equal(client.listPendingElicitations("thread").length, 0);
    await assert.rejects(
      client.submitElicitation("thread", "1", { action: "cancel" }),
      /not found/,
    );
    internal.handleServerNotification("serverRequest/resolved", {
      requestId: 2,
    });
    assert.equal(client.listPendingElicitations("other").length, 0);
    send(3);
    internal.respondToServerRequest = async () => {
      throw new Error("temporary send failure");
    };
    await assert.rejects(
      client.submitElicitation("thread", "3", { action: "cancel" }),
      /temporary/,
    );
    assert.equal(client.listPendingElicitations("thread").length, 1);
    internal.respondToServerRequest = async (id, response) => {
      responses.push({ id, response });
    };
    await client.submitElicitation("thread", "3", { action: "cancel" });
    assert.equal(client.listPendingElicitations("thread").length, 0);
    send(4);
    internal.handleProcessExit("disconnect");
    assert.equal(client.listPendingElicitations("thread").length, 0);
    send(5);
    await client.close();
    assert.equal(client.listPendingElicitations("thread").length, 0);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.flatMap((e) =>
        e.type === "elicitation_requests_changed" ? [e.pending] : [],
      ),
      [true, true, false, false, true, false, true, false, true, false],
    );
  } finally {
    await client.close();
  }
});
