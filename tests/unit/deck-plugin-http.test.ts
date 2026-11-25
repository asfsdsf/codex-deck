import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { pluginHttpRequest } from "../../api/deck-plugin-http";

test("plugin HTTP uses the daemon proxy and preserves non-streaming Responses payloads", async (t) => {
  let target = "";
  let body = "";
  let authorization = "";
  const server = createServer(async (req, res) => {
    target = req.url!;
    authorization = req.headers.authorization!;
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"completed"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await pluginHttpRequest(
    {
      url: "http://provider.invalid/v1/responses",
      headers: {
        Authorization: "Bearer mock-only",
        "Content-Type": "application/json",
      },
      body: { stream: false, model: "mock" },
    },
    {
      httpProxy: `http://127.0.0.1:${address.port}`,
      noProxy: "unrelated.test",
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"status":"completed"}');
  assert.equal(target, "http://provider.invalid/v1/responses");
  assert.equal(authorization, "Bearer mock-only");
  assert.deepEqual(JSON.parse(body), { stream: false, model: "mock" });
});

test("plugin HTTP rejects credentials in URLs and aborts requests without exposing secrets", async () => {
  assert.throws(
    () => pluginHttpRequest({ url: "https://user:secret@example.test" }),
    /without credentials/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    pluginHttpRequest(
      {
        url: "http://provider.invalid/responses",
        headers: { Authorization: "Bearer mock-never-exposed" },
      },
      undefined,
      abort.signal,
    ),
    (error: Error) => !error.message.includes("mock-never-exposed"),
  );
});
