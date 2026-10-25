import assert from "node:assert/strict";
import test from "node:test";
import {
  modelServiceTiers,
  constrainServiceTiers,
  serviceTierAvailable,
} from "../../api/service-tiers";
import { __TEST_ONLY__ } from "../../api/codex-app-server";

const tiers = [
  { id: "priority", name: "Fast", description: "Fast generation" },
  { id: "ultrafast", name: "Ultra Fast", description: "Fastest generation" },
  { id: "flex", name: "Flex", description: "Flexible" },
];
test("model catalogs preserve tier metadata and apply independent speed-mode policy gates", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  (client as unknown as { request(method: string): Promise<unknown> }).request =
    async (method) => {
      if (method === "model/list")
        return {
          data: [
            {
              id: "model",
              serviceTiers: tiers,
              defaultServiceTier: "ultrafast",
            },
          ],
        };
      if (method === "config/read")
        return {
          config: { features: { fast_mode: true, ultrafast_mode: true } },
        };
      assert.equal(method, "configRequirements/read");
      return {
        requirements: { featureRequirements: { fast_mode: false } },
        supportsIndependentSpeedModes: true,
      };
    };
  try {
    const [model] = await client.listModels();
    assert.deepEqual(model.serviceTiers, [tiers[1], tiers[2]]);
    assert.equal(model.defaultServiceTier, "ultrafast");
    assert.equal(serviceTierAvailable(model, "priority"), false);
    assert.equal(serviceTierAvailable(model, "ultrafast"), true);
  } finally {
    await client.close();
  }
  assert.deepEqual(
    constrainServiceTiers(
      tiers,
      { config: {} },
      { requirements: { featureRequirements: { fast_mode: false } } },
    ),
    [tiers[2]],
  );
  assert.deepEqual(
    constrainServiceTiers(
      tiers,
      { config: { features: { ultrafast_mode: false } } },
      {},
    ),
    [tiers[0], tiers[2]],
  );
  assert.equal(modelServiceTiers({}), undefined);
  assert.equal(serviceTierAvailable(undefined, "turbo"), false);
  assert.equal(serviceTierAvailable(undefined, "fast"), true);
  assert.equal(serviceTierAvailable({ serviceTiers: [] }, "fast"), false);
  assert.equal(serviceTierAvailable({ serviceTiers: [] }, "default"), true);
});

test("message routes accept catalog tiers and reject unsupported selections", async () => {
  const { createServer } = await import("../../api/server");
  const { setCodexAppServerClientForTests } =
    await import("../../api/codex-app-server");
  const { createTempCodexDir } = await import("./test-utils");
  const { rootDir, cleanup } = await createTempCodexDir("catalog-tier-route");
  const server = createServer({ port: 0, codexDir: rootDir, open: false });
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const sent: unknown[] = [];
  client.listModels = async () => [
    {
      id: "model",
      displayName: "Model",
      description: "",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      serviceTiers: [tiers[1]],
    },
  ];
  client.getThreadSummary = async () =>
    ({ canAcceptDirectInput: true }) as never;
  client.sendMessage = async (input) => {
    sent.push(input.serviceTier);
    return { turnId: "turn" };
  };
  setCodexAppServerClientForTests(client);
  try {
    for (const [serviceTier, status] of [
      ["ultrafast", 200],
      ["priority", 400],
      ["turbo", 400],
      [null, 200],
    ] as const) {
      const response = await server.app.request(
        "/api/codex/threads/thread/messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "hello", model: "model", serviceTier }),
        },
      );
      assert.equal(response.status, status, await response.text());
    }
    assert.deepEqual(sent, ["ultrafast", null]);
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await client.close();
    await cleanup();
  }
});
