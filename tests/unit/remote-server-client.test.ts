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
  RemoteAuthErrorCode,
  verifyRemoteRpcResultSignature,
  startRemoteOpaqueRegistration,
  startRemoteOpaqueServerLogin,
} from "@codex-deck/wire";
import { INTERNAL_REMOTE_PROXY_ACCESS_HEADER } from "../../api/remote/internal-proxy";
import { RemoteServerClient } from "../../api/remote/remote-server-client";

type RpcHandler = (
  data: { method: string; params: string },
  callback: (response: {
    result: string;
    signature: string;
    signerPublicKey: string;
    signatureVersion: 1;
  }) => void,
) => void;

interface SocketLike {
  on: (event: string, handler: RpcHandler) => void;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createClient(
  password: string,
  options?: {
    internalProxyAccessToken?: string | null;
    appFetch?: (request: Request) => Promise<Response>;
    pinnedRealmId?: string | null;
    pinnedOpaqueServerPublicKey?: string | null;
  },
) {
  const client = new RemoteServerClient({
    serverUrl: "https://server.example.com",
    username: "alice",
    password,
    setupToken: "setup-a",
    machineId: "machine-a",
    codexDir: "/tmp/codex",
    localPort: 12001,
    appFetch: options?.appFetch ?? (async () => jsonResponse({ ok: true })),
    internalProxyAccessToken: options?.internalProxyAccessToken ?? null,
    pinnedRealmId: options?.pinnedRealmId ?? null,
    pinnedOpaqueServerPublicKey: options?.pinnedOpaqueServerPublicKey ?? null,
  });

  return client as unknown as {
    authenticateCli: (
      bootstrap: {
        remoteAuthVersion: 2;
        realmId: string;
        opaqueServerPublicKey: string;
      },
      loginHandle: string,
    ) => Promise<{ token: string; relayKey: Uint8Array }>;
  };
}

test("RemoteServerClient.fetchBootstrap rejects pinned realm mismatches", async () => {
  const client = createClient("correct horse battery staple", {
    pinnedRealmId: "realm-b",
  }) as unknown as {
    fetchBootstrap: () => Promise<{
      remoteAuthVersion: 2;
      realmId: string;
      opaqueServerPublicKey: string;
    }>;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({
      remoteAuthVersion: 2,
      realmId: "realm-a",
      opaqueServerPublicKey: "pk-a",
    })) as typeof globalThis.fetch;

  try {
    await assert.rejects(client.fetchBootstrap(), /realm mismatch/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteServerClient.authenticateCli fails with a clear hint when password is wrong", async () => {
  const loginHandle = "login-handle-a";
  const realmId = "realm-a";
  const originalPassword = "correct horse battery staple";
  const rotatedPassword = "even better battery staple";
  const serverSetup = await createRemoteOpaqueServerSetup();
  const bootstrap = {
    remoteAuthVersion: 2 as const,
    realmId,
    opaqueServerPublicKey: await getRemoteOpaqueServerPublicKey(serverSetup),
  };

  const originalRegistrationStart =
    await startRemoteOpaqueRegistration(originalPassword);
  const originalRegistrationResponse =
    await createRemoteOpaqueRegistrationResponse({
      serverSetup,
      loginHandle,
      registrationRequest: originalRegistrationStart.registrationRequest,
    });
  const originalRegistrationFinish = await finishRemoteOpaqueRegistration({
    password: originalPassword,
    clientRegistrationState: originalRegistrationStart.clientRegistrationState,
    registrationResponse: originalRegistrationResponse.registrationResponse,
    loginHandle,
    realmId,
    expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
  });

  let loginStartCalls = 0;
  let loginFinishCalls = 0;
  let registerStartCalls = 0;
  let registerFinishCalls = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (
      url.pathname === "/v1/auth/opaque/login/start" &&
      init?.method === "POST"
    ) {
      loginStartCalls += 1;
      const loginStart = await startRemoteOpaqueServerLogin({
        serverSetup,
        registrationRecord: originalRegistrationFinish.registrationRecord,
        startLoginRequest: String(body?.startLoginRequest || ""),
        loginHandle,
        realmId,
      });
      return jsonResponse({
        loginId: "login-1",
        loginResponse: loginStart.loginResponse,
      });
    }

    if (
      url.pathname === "/v1/auth/opaque/login/finish" &&
      init?.method === "POST"
    ) {
      loginFinishCalls += 1;
      return jsonResponse({ error: "unexpected login finish" }, 500);
    }

    if (
      url.pathname === "/v1/auth/opaque/register/start" &&
      init?.method === "POST"
    ) {
      registerStartCalls += 1;
      const registrationResponse = await createRemoteOpaqueRegistrationResponse(
        {
          serverSetup,
          loginHandle,
          registrationRequest: String(body?.registrationRequest || ""),
        },
      );
      return jsonResponse({
        registrationId: "registration-1",
        registrationResponse: registrationResponse.registrationResponse,
      });
    }

    if (
      url.pathname === "/v1/auth/opaque/register/finish" &&
      init?.method === "POST"
    ) {
      registerFinishCalls += 1;
      assert.match(String(body?.registrationRecord || ""), /\S+/);
      return jsonResponse({
        success: true,
        token: "cli-token",
      });
    }

    return jsonResponse({ error: `Unexpected request: ${url.pathname}` }, 404);
  }) as typeof globalThis.fetch;

  try {
    const client = createClient(rotatedPassword);
    await assert.rejects(
      client.authenticateCli(bootstrap, loginHandle),
      /Remote password is incorrect for this registered CLI account/i,
    );
    assert.equal(loginStartCalls, 1);
    assert.equal(loginFinishCalls, 0);
    assert.equal(registerStartCalls, 0);
    assert.equal(registerFinishCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteServerClient.authenticateCli does not re-register a login owned by another machine", async () => {
  let registerStartCalls = 0;
  let registerFinishCalls = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(String(input));

    if (
      url.pathname === "/v1/auth/opaque/login/start" &&
      init?.method === "POST"
    ) {
      return jsonResponse(
        {
          error: "This login does not match the registered CLI account.",
          code: RemoteAuthErrorCode.accountMismatch,
        },
        409,
      );
    }

    if (
      url.pathname === "/v1/auth/opaque/register/start" &&
      init?.method === "POST"
    ) {
      registerStartCalls += 1;
    }

    if (
      url.pathname === "/v1/auth/opaque/register/finish" &&
      init?.method === "POST"
    ) {
      registerFinishCalls += 1;
    }

    return jsonResponse({ error: `Unexpected request: ${url.pathname}` }, 404);
  }) as typeof globalThis.fetch;

  try {
    const client = createClient("correct horse battery staple");
    await assert.rejects(
      client.authenticateCli(
        {
          remoteAuthVersion: 2,
          realmId: "realm-a",
          opaqueServerPublicKey: "unused",
        },
        "login-handle-a",
      ),
      /bound to a different machine/i,
    );
    assert.equal(registerStartCalls, 0);
    assert.equal(registerFinishCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteServerClient proxy requests include the internal access token", async () => {
  const relayKey = new Uint8Array(32).fill(7);
  let observedHeader: string | null = null;
  const client = createClient("correct horse battery staple", {
    internalProxyAccessToken: "proxy-token-a",
    appFetch: async (request) => {
      observedHeader = request.headers.get(INTERNAL_REMOTE_PROXY_ACCESS_HEADER);
      return jsonResponse({ ok: true });
    },
  }) as unknown as {
    relayKey: Uint8Array | null;
    rpcSigningPublicKey: string | null;
    rpcSigningSecretKey: string | null;
    registerRpcHandlers: (socket: Pick<SocketLike, "on">) => void;
  };

  client.relayKey = relayKey;
  const signingKeyPair = generateRemoteRpcSigningKeyPair();
  client.rpcSigningPublicKey = signingKeyPair.publicKey;
  client.rpcSigningSecretKey = signingKeyPair.secretKey;

  const handlers = new Map<string, RpcHandler>();
  client.registerRpcHandlers({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  });

  const handler = handlers.get("rpc-request");
  assert.ok(handler);

  const params = await encryptRemotePayload(relayKey, {
    requestId: "request-a",
    body: {
      method: "GET",
      path: "/api/workflows",
    },
  });

  const signedResponse = await new Promise<{
    result: string;
    signature: string;
    signerPublicKey: string;
    signatureVersion: 1;
  }>((resolve) => {
    handler?.(
      {
        method: "machine-a:http",
        params,
      },
      resolve,
    );
  });
  assert.equal(signedResponse.signatureVersion, 1);
  assert.equal(signedResponse.signerPublicKey, signingKeyPair.publicKey);
  assert.equal(
    verifyRemoteRpcResultSignature({
      machineId: "machine-a",
      requestId: "request-a",
      encryptedResult: signedResponse.result,
      signature: signedResponse.signature,
      publicKey: signingKeyPair.publicKey,
    }),
    true,
  );

  const response = await decryptRemotePayload<{
    ok: boolean;
    requestId: string;
    body?: { status?: number; body?: { ok?: boolean } };
  }>(relayKey, signedResponse.result);

  assert.equal(observedHeader, "proxy-token-a");
  assert.equal(response.ok, true);
  assert.equal(response.requestId, "request-a");
  assert.equal(response.body?.status, 200);
  assert.equal(response.body?.body?.ok, true);
});
