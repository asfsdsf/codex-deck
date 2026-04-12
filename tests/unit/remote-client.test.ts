import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteOpaqueRegistrationResponse,
  createRemoteOpaqueServerSetup,
  decryptRemotePayload,
  encryptRemotePayload,
  finishRemoteOpaqueRegistration,
  generateRemoteRpcSigningKeyPair,
  getRemoteOpaqueServerPublicKey,
  signRemoteRpcResult,
  startRemoteOpaqueRegistration,
  startRemoteOpaqueServerLogin,
} from "@codex-deck/wire";
import { RemoteClient } from "../../web/remote-client";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("RemoteClient.callRemote accepts cookie-backed browser sessions after refresh", async () => {
  const client = new RemoteClient();
  const relayKey = new Uint8Array(32).fill(7);
  const mutableClient = client as unknown as {
    serverUrl: string | null;
    relayKey: Uint8Array | null;
    selectedMachineId: string | null;
    token: string | null;
    machineSigningPublicKeys: Record<string, string>;
  };
  const signing = generateRemoteRpcSigningKeyPair();

  mutableClient.serverUrl = "https://server.example.com";
  mutableClient.relayKey = relayKey;
  mutableClient.selectedMachineId = "machine-a";
  mutableClient.token = null;
  mutableClient.machineSigningPublicKeys = {
    "machine-a": signing.publicKey,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://server.example.com/v1/remote/http/machine-a",
    );
    assert.equal(init?.credentials, "include");

    const headers = new Headers(init?.headers);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.get("Content-Type"), "application/json");

    const requestBody = JSON.parse(String(init?.body)) as { params: string };
    const remoteRequest = await decryptRemotePayload<{
      requestId: string;
      body: { action: string };
    }>(relayKey, requestBody.params);

    assert.deepEqual(remoteRequest.body, { action: "ping" });
    const encryptedResult = await encryptRemotePayload(relayKey, {
      ok: true,
      requestId: remoteRequest.requestId,
      body: { pong: true },
    });

    return jsonResponse({
      ok: true,
      result: encryptedResult,
      signature: signRemoteRpcResult({
        machineId: "machine-a",
        requestId: remoteRequest.requestId,
        encryptedResult,
        secretKey: signing.secretKey,
      }),
      signerPublicKey: signing.publicKey,
      signatureVersion: 1,
    });
  }) as typeof globalThis.fetch;

  try {
    const response = await client.callRemote<{ pong: boolean }>("http", {
      action: "ping",
    });
    assert.deepEqual(response, { pong: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteClient.authenticateBrowser explains when the password no longer matches the registered CLI", async () => {
  const realmId = "realm-a";
  const loginHandle = "login-handle-a";
  const serverSetup = await createRemoteOpaqueServerSetup();
  const bootstrap = {
    remoteAuthVersion: 2 as const,
    realmId,
    opaqueServerPublicKey: await getRemoteOpaqueServerPublicKey(serverSetup),
    browserPersistence: "session" as const,
  };

  const registrationStart = await startRemoteOpaqueRegistration(
    "correct horse battery staple",
  );
  const registrationResponse = await createRemoteOpaqueRegistrationResponse({
    serverSetup,
    loginHandle,
    registrationRequest: registrationStart.registrationRequest,
  });
  const registrationFinish = await finishRemoteOpaqueRegistration({
    password: "correct horse battery staple",
    clientRegistrationState: registrationStart.clientRegistrationState,
    registrationResponse: registrationResponse.registrationResponse,
    loginHandle,
    realmId,
    expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
  });

  const client = new RemoteClient() as unknown as {
    serverUrl: string | null;
    authenticateBrowser: (
      password: string,
      loginHandle: string,
      bootstrap: {
        remoteAuthVersion: 2;
        realmId: string;
        opaqueServerPublicKey: string;
        browserPersistence: "session" | "remember";
      },
      remember: boolean,
    ) => Promise<{
      token: string;
      exportKey: string;
      relayKey: Uint8Array;
    }>;
  };
  client.serverUrl = "https://server.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://server.example.com/v1/auth/opaque/login/start",
    );
    const body = JSON.parse(String(init?.body)) as {
      startLoginRequest: string;
    };
    const loginStart = await startRemoteOpaqueServerLogin({
      serverSetup,
      registrationRecord: registrationFinish.registrationRecord,
      startLoginRequest: body.startLoginRequest,
      loginHandle,
      realmId,
    });
    return jsonResponse({
      loginId: "login-1",
      loginResponse: loginStart.loginResponse,
    });
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      client.authenticateBrowser(
        "wrong password",
        loginHandle,
        bootstrap,
        false,
      ),
      /incorrect password for this remote username/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteClient latency logging toggle updates runtime state", () => {
  const client = new RemoteClient();
  assert.equal(client.isLatencyLoggingEnabled(), false);
  client.setLatencyLoggingEnabled(true);
  assert.equal(client.isLatencyLoggingEnabled(), true);
  client.setLatencyLoggingEnabled(false);
  assert.equal(client.isLatencyLoggingEnabled(), false);
});

test("RemoteClient.fetchBootstrap rejects pinned OPAQUE key mismatches", async () => {
  const client = new RemoteClient() as unknown as {
    fetchBootstrap: (
      serverUrl: string,
      pins?: { realmId?: string | null; opaqueServerPublicKey?: string | null },
    ) => Promise<{
      remoteAuthVersion: 2;
      realmId: string;
      opaqueServerPublicKey: string;
      browserPersistence: "session" | "remember";
    }>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({
      remoteAuthVersion: 2,
      realmId: "realm-a",
      opaqueServerPublicKey: "server-pk-a",
      browserPersistence: "session",
    })) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      client.fetchBootstrap("https://server.example.com", {
        opaqueServerPublicKey: "server-pk-b",
      }),
      /OPAQUE server public key mismatch/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
