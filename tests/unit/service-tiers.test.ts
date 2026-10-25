import assert from "node:assert/strict";
import test from "node:test";
import {
  modelServiceTiers,
  constrainServiceTiers,
  serviceTierAvailable,
  serviceTierOverride,
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

test("speed selection explicitly requests default for empty or unavailable choices", () => {
  const model = { serviceTiers: tiers };
  assert.equal(serviceTierOverride(model, "ultrafast"), "ultrafast");
  assert.equal(serviceTierOverride(model, "default"), "default");
  assert.equal(serviceTierOverride(model, ""), null);
  assert.equal(serviceTierOverride(model, "unavailable"), null);
});

test("default speed overwrites a persisted tier with the configured, catalog, or standard default", async (t) => {
  for (const scenario of [
    { configured: null, catalog: null, expected: "default" },
    { configured: null, catalog: "flex", expected: "flex" },
    { configured: "priority", catalog: "flex", expected: "priority" },
  ]) {
    await t.test(JSON.stringify(scenario), async () => {
      const client = new __TEST_ONLY__.CodexAppServerClient();
      let persistedTier: unknown;
      const turns: unknown[] = [];
      client.listModels = async () => [
        {
          id: "model",
          displayName: "Model",
          description: "",
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          serviceTiers: tiers,
          defaultServiceTier: scenario.catalog,
        },
      ];
      (
        client as unknown as {
          request(
            method: string,
            params: Record<string, unknown>,
          ): Promise<unknown>;
        }
      ).request = async (method, params) => {
        if (method === "config/read")
          return {
            config: { model: "model", model_service_tier: scenario.configured },
          };
        if (method === "thread/settings/update") {
          persistedTier = params.serviceTier;
          return {};
        }
        assert.equal(method, "turn/start");
        // Match upstream: omission leaves the previous thread override active.
        if (params.serviceTier !== undefined)
          persistedTier = params.serviceTier;
        turns.push(persistedTier);
        return { turn: { id: `turn-${turns.length}` } };
      };
      try {
        await client.sendMessage({
          threadId: "thread",
          text: "Fast turn",
          serviceTier: serviceTierOverride(
            { serviceTiers: tiers },
            "ultrafast",
          ),
        });
        await client.sendMessage({
          threadId: "thread",
          text: "Default turn",
          serviceTier: serviceTierOverride({ serviceTiers: tiers }, ""),
        });
        assert.deepEqual(turns, ["ultrafast", scenario.expected]);
        assert.equal(persistedTier, scenario.expected);
      } finally {
        await client.close();
      }
    });
  }
});
