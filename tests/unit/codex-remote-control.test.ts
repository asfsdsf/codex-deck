import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { CodexAppServerRpcError } from "../../api/codex-app-server";
import { CodexOrganizationService } from "../../api/codex-organization";
import {
  RemoteControlService,
  parseRemoteControlStatus,
} from "../../api/codex-remote-control";
import { registerOrganizationRoutes } from "../../api/server/organization-routes";
import { describeRemoteClient } from "../../web/components/codex-remote-control";
import {
  getOrganizationDialogForCommand,
  getOrganizationDialogTitle,
} from "../../web/components/organization-dialog";

const status = (value: string, environmentId: string | null = "env-1") => ({
  status: value,
  serverName: "host",
  installationId: "install",
  environmentId,
});

test("remote-control status parsing rejects unknown states", () => {
  assert.equal(
    parseRemoteControlStatus(status("connected")).status,
    "connected",
  );
  assert.throws(() => parseRemoteControlStatus(status("paused")), /Invalid/);
});

test("remote-control snapshot lists paired clients and degrades on unsupported servers", async () => {
  const calls: [string, unknown][] = [];
  const service = new RemoteControlService(
    async (method, params) => {
      calls.push([method, params]);
      if (method === "remoteControl/status/read") return status("connected");
      if (method === "remoteControl/client/list")
        return {
          data: [
            {
              clientId: "c1",
              displayName: null,
              deviceModel: "Phone",
              platform: "iOS",
              lastSeenAt: 1_700_000_000,
            },
          ],
          nextCursor: null,
        };
      throw new Error(`unexpected ${method}`);
    },
    () => undefined,
  );
  const snapshot = await service.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.clients[0].clientId, "c1");
  assert.equal(snapshot.clients[0].lastSeenAt, 1_700_000_000);
  assert.equal(calls[0][1], undefined, "status read sends no params");
  assert.equal((calls[1][1] as Record<string, unknown>).environmentId, "env-1");
  assert.equal(describeRemoteClient(snapshot.clients[0]), "Phone · iOS");

  const legacy = new RemoteControlService(
    async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    },
    () => undefined,
  );
  const unavailable = await legacy.snapshot();
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, null);

  const failingClients = new RemoteControlService(
    async (method) => {
      if (method === "remoteControl/status/read") return status("connected");
      throw new Error("relay offline");
    },
    () => undefined,
  );
  assert.equal((await failingClients.snapshot()).clientsError, "relay offline");
});

test("remote-control mutations retry without params for older servers and broadcast", async () => {
  const calls: [string, unknown][] = [];
  let notified = 0;
  const service = new RemoteControlService(
    async (method, params) => {
      calls.push([method, params]);
      if (method === "remoteControl/enable" && params)
        throw new CodexAppServerRpcError(-32602, "Invalid params");
      if (method === "remoteControl/enable") return status("connecting");
      if (method === "remoteControl/disable") return status("disabled");
      if (method === "remoteControl/pairing/start")
        return {
          pairingCode: "opaque",
          manualPairingCode: "ABCD-EFGH",
          environmentId: "env-1",
          expiresAt: 1_700_000_100,
        };
      if (method === "remoteControl/pairing/status") return { claimed: true };
      if (method === "remoteControl/client/revoke") return {};
      throw new Error(`unexpected ${method}`);
    },
    () => {
      notified += 1;
    },
  );
  assert.equal((await service.setEnabled(true, true)).status, "connecting");
  assert.deepEqual(calls.slice(0, 2), [
    ["remoteControl/enable", { ephemeral: true }],
    ["remoteControl/enable", undefined],
  ]);
  assert.equal((await service.setEnabled(false, false)).status, "disabled");
  assert.deepEqual(calls[2], ["remoteControl/disable", undefined]);
  const pairing = await service.startPairing();
  assert.equal(pairing.manualPairingCode, "ABCD-EFGH");
  assert.deepEqual(calls[3][1], { manualCode: true });
  assert.deepEqual(await service.pairingStatus({ pairingCode: "opaque" }), {
    claimed: true,
  });
  await service.revokeClient("env-1", "c1");
  assert.deepEqual(calls.at(-1), [
    "remoteControl/client/revoke",
    { environmentId: "env-1", clientId: "c1" },
  ]);
  assert.equal(notified, 4, "enable, disable, claimed pairing, revoke");
});

test("remote-control status notifications refresh every client", () => {
  const events: unknown[] = [];
  const organization = new CodexOrganizationService({
    rpc: async () => ({}),
    notify: (scope, threadId) => events.push([scope, threadId]),
  });
  assert.equal(
    organization.handleNotification(
      "remoteControl/status/changed",
      status("connected"),
    ),
    true,
  );
  assert.deepEqual(events, [["remoteControl", null]]);
});

test("remote-control routes validate pairing codes and revocation targets", async () => {
  const seen: unknown[] = [];
  const app = new Hono();
  registerOrganizationRoutes(app, {
    getService: () =>
      ({
        remoteControl: {
          snapshot: async () => ({ available: true }),
          setEnabled: async (...args: unknown[]) => {
            seen.push(["toggle", ...args]);
            return status("connected");
          },
          startPairing: async () => ({ pairingCode: "p" }),
          pairingStatus: async (input: unknown) => {
            seen.push(["pairing", input]);
            return { claimed: false };
          },
          revokeClient: async (...args: unknown[]) => {
            seen.push(["revoke", ...args]);
          },
        },
      }) as never,
  });
  const post = (path: string, body: unknown) =>
    app.request(`/api/codex/remote-control${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  assert.equal((await app.request("/api/codex/remote-control")).status, 200);
  assert.equal((await post("/enable", { ephemeral: "yes" })).status, 400);
  assert.equal((await post("/disable", {})).status, 200);
  assert.equal((await post("/pairing/status", {})).status, 400);
  assert.equal(
    (await post("/pairing/status", { manualPairingCode: "ABCD" })).status,
    200,
  );
  assert.equal((await post("/clients/revoke", { clientId: "c" })).status, 400);
  assert.equal(
    (await post("/clients/revoke", { environmentId: "e", clientId: "c" }))
      .status,
    200,
  );
  assert.deepEqual(seen, [
    ["toggle", false, false],
    ["pairing", { pairingCode: null, manualPairingCode: "ABCD" }],
    ["revoke", "e", "c"],
  ]);
  const readOnly = new Hono();
  registerOrganizationRoutes(readOnly, {
    getService: () => ({ readState: {} }) as never,
  });
  assert.equal(
    (await readOnly.request("/api/codex/remote-control")).status,
    501,
  );
});

test("remote-control slash command opens its own dialog", () => {
  assert.equal(
    getOrganizationDialogForCommand("/remote-control"),
    "remote-control",
  );
  assert.equal(
    getOrganizationDialogTitle("remote-control"),
    "Codex remote control",
  );
  assert.equal(getOrganizationDialogForCommand("/mcp"), null);
});
