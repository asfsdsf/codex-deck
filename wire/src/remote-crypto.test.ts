import { describe, expect, it } from "vitest";
import {
  createRemoteOpaqueRegistrationResponse,
  createRemoteOpaqueServerSetup,
  decodeBase64,
  decryptRemotePayload,
  deriveRemoteLoginHandle,
  deriveRemoteRelayKeyFromExportKey,
  encryptRemotePayload,
  finishRemoteOpaqueLogin,
  finishRemoteOpaqueRegistration,
  finishRemoteOpaqueServerLogin,
  generateRemoteRpcSigningKeyPair,
  getRemoteOpaqueServerPublicKey,
  signRemoteRpcResult,
  startRemoteOpaqueLogin,
  startRemoteOpaqueRegistration,
  startRemoteOpaqueServerLogin,
  verifyRemoteRpcResultSignature,
} from "./remote-crypto";

describe("remote-crypto", () => {
  const username = "alice";
  const password = "correct horse battery staple";
  const realmId = "realm-a";

  it("derives a stable opaque login handle", async () => {
    const first = await deriveRemoteLoginHandle(username, realmId);
    const second = await deriveRemoteLoginHandle(username, realmId);
    expect(first).toBe(second);
  });

  it("completes opaque registration and login with a stable export key", async () => {
    const serverSetup = await createRemoteOpaqueServerSetup();
    const serverPublicKey = await getRemoteOpaqueServerPublicKey(serverSetup);
    const loginHandle = await deriveRemoteLoginHandle(username, realmId);

    const registrationStart = await startRemoteOpaqueRegistration(password);
    const { registrationResponse } =
      await createRemoteOpaqueRegistrationResponse({
        serverSetup,
        loginHandle,
        registrationRequest: registrationStart.registrationRequest,
      });
    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse,
      loginHandle,
      realmId,
      expectedServerPublicKey: serverPublicKey,
    });

    const loginStart = await startRemoteOpaqueLogin(password);
    const loginResponse = await startRemoteOpaqueServerLogin({
      serverSetup,
      registrationRecord: registrationFinish.registrationRecord,
      startLoginRequest: loginStart.startLoginRequest,
      loginHandle,
      realmId,
    });
    const loginFinish = await finishRemoteOpaqueLogin({
      password,
      clientLoginState: loginStart.clientLoginState,
      loginResponse: loginResponse.loginResponse,
      loginHandle,
      realmId,
      expectedServerPublicKey: serverPublicKey,
    });

    expect(loginFinish).not.toBeNull();
    expect(loginFinish?.exportKey).toBe(registrationFinish.exportKey);
    expect(Array.from(loginFinish?.relayKey || [])).toEqual(
      Array.from(registrationFinish.relayKey),
    );

    const serverFinish = await finishRemoteOpaqueServerLogin({
      serverLoginState: loginResponse.serverLoginState,
      finishLoginRequest: loginFinish!.finishLoginRequest,
      loginHandle,
      realmId,
    });
    expect(serverFinish.sessionKey).toMatch(/\S+/);
    expect(loginFinish?.sessionKey).toMatch(/\S+/);
  });

  it("rejects opaque login with the wrong password", async () => {
    const serverSetup = await createRemoteOpaqueServerSetup();
    const loginHandle = await deriveRemoteLoginHandle(username, realmId);

    const registrationStart = await startRemoteOpaqueRegistration(password);
    const { registrationResponse } =
      await createRemoteOpaqueRegistrationResponse({
        serverSetup,
        loginHandle,
        registrationRequest: registrationStart.registrationRequest,
      });
    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse,
      loginHandle,
      realmId,
    });

    const loginStart = await startRemoteOpaqueLogin("wrong password");
    const loginResponse = await startRemoteOpaqueServerLogin({
      serverSetup,
      registrationRecord: registrationFinish.registrationRecord,
      startLoginRequest: loginStart.startLoginRequest,
      loginHandle,
      realmId,
    });
    const loginFinish = await finishRemoteOpaqueLogin({
      password: "wrong password",
      clientLoginState: loginStart.clientLoginState,
      loginResponse: loginResponse.loginResponse,
      loginHandle,
      realmId,
    });

    expect(loginFinish).toBeNull();
  });

  it("derives a stable relay key from an export key", async () => {
    const serverSetup = await createRemoteOpaqueServerSetup();
    const loginHandle = await deriveRemoteLoginHandle(username, realmId);

    const registrationStart = await startRemoteOpaqueRegistration(password);
    const { registrationResponse } =
      await createRemoteOpaqueRegistrationResponse({
        serverSetup,
        loginHandle,
        registrationRequest: registrationStart.registrationRequest,
      });
    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse,
      loginHandle,
      realmId,
    });

    const derived = await deriveRemoteRelayKeyFromExportKey(
      registrationFinish.exportKey,
    );
    expect(Array.from(derived)).toEqual(
      Array.from(registrationFinish.relayKey),
    );
  });

  it("decodes opaque base64url export keys", async () => {
    const serverSetup = await createRemoteOpaqueServerSetup();
    const loginHandle = await deriveRemoteLoginHandle(username, realmId);

    const registrationStart = await startRemoteOpaqueRegistration(password);
    const { registrationResponse } =
      await createRemoteOpaqueRegistrationResponse({
        serverSetup,
        loginHandle,
        registrationRequest: registrationStart.registrationRequest,
      });
    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse,
      loginHandle,
      realmId,
    });

    expect(registrationFinish.exportKey).toMatch(/[-_]/);
    expect(decodeBase64(registrationFinish.exportKey)).toHaveLength(64);
  });

  it("encrypts and decrypts relay payloads with an opaque-derived relay key", async () => {
    const serverSetup = await createRemoteOpaqueServerSetup();
    const loginHandle = await deriveRemoteLoginHandle(username, realmId);

    const registrationStart = await startRemoteOpaqueRegistration(password);
    const { registrationResponse } =
      await createRemoteOpaqueRegistrationResponse({
        serverSetup,
        loginHandle,
        registrationRequest: registrationStart.registrationRequest,
      });
    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse,
      loginHandle,
      realmId,
    });

    const encrypted = await encryptRemotePayload(registrationFinish.relayKey, {
      requestId: "req-1",
      body: {
        path: "/api/sessions",
        method: "GET",
      },
    });

    const decrypted = await decryptRemotePayload<{
      requestId: string;
      body: { path: string; method: string };
    }>(registrationFinish.relayKey, encrypted);

    expect(decrypted).toEqual({
      requestId: "req-1",
      body: {
        path: "/api/sessions",
        method: "GET",
      },
    });
  });

  it("signs and verifies remote RPC result payloads", () => {
    const keyPair = generateRemoteRpcSigningKeyPair();
    const signature = signRemoteRpcResult({
      machineId: "machine-a",
      requestId: "req-1",
      encryptedResult: "ciphertext",
      secretKey: keyPair.secretKey,
    });

    expect(
      verifyRemoteRpcResultSignature({
        machineId: "machine-a",
        requestId: "req-1",
        encryptedResult: "ciphertext",
        signature,
        publicKey: keyPair.publicKey,
      }),
    ).toBe(true);
    expect(
      verifyRemoteRpcResultSignature({
        machineId: "machine-a",
        requestId: "req-1",
        encryptedResult: "tampered",
        signature,
        publicKey: keyPair.publicKey,
      }),
    ).toBe(false);
  });
});
