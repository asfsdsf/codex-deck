import * as opaque from "@serenity-kit/opaque";
import tweetnacl from "tweetnacl";

const PASSWORD_SECRET_SALT = "codexdeck-password-bootstrap-v2";
const PASSWORD_SECRET_ITERATIONS = 200_000;
const PASSWORD_SECRET_LENGTH_BITS = 256;
const TRANSPORT_BUNDLE_VERSION = 0;
const REMOTE_SECRET_LENGTH_BYTES = 32;
const REMOTE_OPAQUE_KEY_STRETCHING = "memory-constrained";
const REMOTE_RELAY_KEY_SALT = "codexdeck:remote-relay-salt:v2";
const REMOTE_RELAY_KEY_INFO = "codexdeck:remote-relay-info:v2";
const REMOTE_OPAQUE_SERVER_IDENTIFIER_PREFIX = "codexdeck:remote-server:v1:";
const REMOTE_RPC_SIGNATURE_VERSION = "codexdeck:remote-rpc-signature:v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isCryptoAvailable(cryptoObject: any): boolean {
  return (
    !!cryptoObject?.subtle && typeof cryptoObject.getRandomValues === "function"
  );
}

let cryptoPromise: Promise<any> | null = null;

async function getCrypto() {
  const cryptoObject = (globalThis as { crypto?: any }).crypto;
  if (isCryptoAvailable(cryptoObject)) {
    return cryptoObject;
  }

  if (!cryptoPromise) {
    cryptoPromise = (async () => {
      const processObject = (
        globalThis as {
          process?: { versions?: { node?: string } };
        }
      ).process;
      if (!processObject?.versions?.node) {
        throw new Error("Web Crypto API is required");
      }
      const nodeCryptoModule = await import("node:crypto");
      if (!isCryptoAvailable(nodeCryptoModule.webcrypto)) {
        throw new Error("Web Crypto API is required");
      }
      return nodeCryptoModule.webcrypto;
    })();
  }

  return cryptoPromise;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function decodeBase64(base64: string): Uint8Array {
  const normalized = base64
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64.length / 4) * 4, "=");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(normalized, "base64"));
  }
  const binary = atob(normalized);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}

async function derivePasswordSecret(password: string): Promise<Uint8Array> {
  const normalized = normalizePassword(password);
  if (normalized.trim().length === 0) {
    throw new Error("Password must not be empty");
  }

  const cryptoObject = await getCrypto();
  const baseKey = await cryptoObject.subtle.importKey(
    "raw",
    encoder.encode(normalized),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await cryptoObject.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(PASSWORD_SECRET_SALT),
      iterations: PASSWORD_SECRET_ITERATIONS,
    },
    baseKey,
    PASSWORD_SECRET_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

function normalizeRealmId(realmId: string): string {
  const normalized = realmId.trim();
  if (!normalized) {
    throw new Error("Realm id must not be empty");
  }
  return normalized;
}

function normalizeCredentialInputs(
  username: string,
  password: string,
  realmId: string,
): { username: string; password: string; realmId: string } {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("Username must not be empty");
  }

  const normalizedPassword = normalizePassword(password);
  if (normalizedPassword.trim().length === 0) {
    throw new Error("Password must not be empty");
  }

  return {
    username: normalizedUsername,
    password: normalizedPassword,
    realmId: normalizeRealmId(realmId),
  };
}

async function deriveCredentialSecret(
  username: string,
  password: string,
  realmId: string,
): Promise<Uint8Array> {
  const normalized = normalizeCredentialInputs(username, password, realmId);

  const cryptoObject = await getCrypto();
  const baseKey = await cryptoObject.subtle.importKey(
    "raw",
    encoder.encode(normalized.password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await cryptoObject.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(
        `${PASSWORD_SECRET_SALT}\n${normalized.realmId}\n${normalized.username}`,
      ),
      iterations: PASSWORD_SECRET_ITERATIONS,
    },
    baseKey,
    PASSWORD_SECRET_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

function normalizeSecretBytes(secret: Uint8Array): Uint8Array {
  if (secret.length !== REMOTE_SECRET_LENGTH_BYTES) {
    throw new Error(
      `Remote secret must be ${REMOTE_SECRET_LENGTH_BYTES} bytes`,
    );
  }
  return Uint8Array.from(secret);
}

function deriveSubkey(secret: Uint8Array, label: string): Uint8Array {
  const digest = tweetnacl.hash(
    concatBytes(secret, encoder.encode(`codexdeck:${label}`)),
  );
  return digest.slice(0, 32);
}

function deriveContentKeyPair(secret: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const seed = deriveSubkey(secret, "content-seed");
  const boxSecretKey = tweetnacl.hash(seed).slice(0, 32);
  const keyPair = tweetnacl.box.keyPair.fromSecretKey(boxSecretKey);
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
  };
}

export interface RemoteAuthMaterial {
  secret: Uint8Array;
  relayKey: Uint8Array;
  authKeyPair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  contentKeyPair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  publicKeyHex: string;
}

export interface RemoteCredentialMaterial extends RemoteAuthMaterial {
  loginHandle: string;
  realmId: string;
}

export interface RemoteOpaqueClientRegistrationStart {
  clientRegistrationState: string;
  registrationRequest: string;
}

export interface RemoteOpaqueRegistrationFinishResult {
  registrationRecord: string;
  exportKey: string;
  relayKey: Uint8Array;
  serverStaticPublicKey: string;
}

export interface RemoteOpaqueClientLoginStart {
  clientLoginState: string;
  startLoginRequest: string;
}

export interface RemoteOpaqueLoginStartResult {
  loginResponse: string;
  serverLoginState: string;
}

export interface RemoteOpaqueLoginFinishResult {
  finishLoginRequest: string;
  sessionKey: string;
  exportKey: string;
  relayKey: Uint8Array;
  serverStaticPublicKey: string;
}

export type RemoteAuthClientKind = "browser" | "cli" | "api";

export interface RemoteAuthChallengeBinding {
  challengeId: string;
  challenge: string;
  clientKind: RemoteAuthClientKind;
  machineId?: string | null;
}

function deriveRemoteMaterialFromSecret(
  secret: Uint8Array,
): RemoteAuthMaterial {
  const normalizedSecret = normalizeSecretBytes(secret);
  const authKeyPair = tweetnacl.sign.keyPair.fromSeed(normalizedSecret);
  const contentKeyPair = deriveContentKeyPair(normalizedSecret);
  const relayKey = deriveSubkey(normalizedSecret, "remote-relay");
  return {
    secret: normalizedSecret,
    relayKey,
    authKeyPair,
    contentKeyPair,
    publicKeyHex: Array.from(authKeyPair.publicKey as Uint8Array)
      .map((value: number) => value.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase(),
  };
}

export function deriveRemoteAuthMaterialFromSecret(
  secret: Uint8Array | string,
): RemoteAuthMaterial {
  const normalizedSecret =
    typeof secret === "string" ? decodeBase64(secret) : secret;
  return deriveRemoteMaterialFromSecret(normalizedSecret);
}

async function digestSha256(input: Uint8Array): Promise<Uint8Array> {
  const cryptoObject = await getCrypto();
  const digest = await cryptoObject.subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

async function ensureOpaqueReady(): Promise<void> {
  await opaque.ready;
}

function normalizeRemoteOpaquePassword(password: string): string {
  const normalized = normalizePassword(password);
  if (normalized.trim().length === 0) {
    throw new Error("Password must not be empty");
  }
  return normalized;
}

function buildRemoteOpaqueIdentifiers(
  loginHandle: string,
  realmId: string,
): {
  client: string;
  server: string;
} {
  return {
    client: normalizeLoginHandle(loginHandle),
    server: `${REMOTE_OPAQUE_SERVER_IDENTIFIER_PREFIX}${normalizeRealmId(realmId)}`,
  };
}

function normalizeLoginHandle(loginHandle: string): string {
  const normalized = loginHandle.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Login handle must not be empty");
  }
  return normalized;
}

export async function deriveRemoteLoginHandle(
  username: string,
  realmId: string,
): Promise<string> {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("Username must not be empty");
  }

  const digest = await digestSha256(
    encoder.encode(
      `codexdeck:remote-login-handle:v1:${normalizeRealmId(realmId)}:${normalizedUsername}`,
    ),
  );
  return Array.from(digest)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function createRemoteOpaqueServerSetup(): Promise<string> {
  await ensureOpaqueReady();
  return opaque.server.createSetup();
}

export async function getRemoteOpaqueServerPublicKey(
  serverSetup: string,
): Promise<string> {
  await ensureOpaqueReady();
  return opaque.server.getPublicKey(serverSetup);
}

export async function deriveRemoteRelayKeyFromExportKey(
  exportKey: Uint8Array | string,
): Promise<Uint8Array> {
  const normalizedExportKey =
    typeof exportKey === "string" ? decodeBase64(exportKey) : exportKey;
  if (normalizedExportKey.length === 0) {
    throw new Error("Export key must not be empty");
  }

  const cryptoObject = await getCrypto();
  const baseKey = await cryptoObject.subtle.importKey(
    "raw",
    normalizedExportKey,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await cryptoObject.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(REMOTE_RELAY_KEY_SALT),
      info: encoder.encode(REMOTE_RELAY_KEY_INFO),
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function startRemoteOpaqueRegistration(
  password: string,
): Promise<RemoteOpaqueClientRegistrationStart> {
  await ensureOpaqueReady();
  return opaque.client.startRegistration({
    password: normalizeRemoteOpaquePassword(password),
  });
}

export async function createRemoteOpaqueRegistrationResponse(params: {
  serverSetup: string;
  loginHandle: string;
  registrationRequest: string;
}): Promise<{ registrationResponse: string }> {
  await ensureOpaqueReady();
  return opaque.server.createRegistrationResponse({
    serverSetup: params.serverSetup,
    userIdentifier: normalizeLoginHandle(params.loginHandle),
    registrationRequest: params.registrationRequest,
  });
}

export async function finishRemoteOpaqueRegistration(params: {
  password: string;
  clientRegistrationState: string;
  registrationResponse: string;
  loginHandle: string;
  realmId: string;
  expectedServerPublicKey?: string;
}): Promise<RemoteOpaqueRegistrationFinishResult> {
  await ensureOpaqueReady();
  const result = opaque.client.finishRegistration({
    password: normalizeRemoteOpaquePassword(params.password),
    clientRegistrationState: params.clientRegistrationState,
    registrationResponse: params.registrationResponse,
    keyStretching: REMOTE_OPAQUE_KEY_STRETCHING,
    identifiers: buildRemoteOpaqueIdentifiers(
      params.loginHandle,
      params.realmId,
    ),
  });
  if (
    params.expectedServerPublicKey &&
    result.serverStaticPublicKey !== params.expectedServerPublicKey
  ) {
    throw new Error("Remote server public key mismatch");
  }
  return {
    ...result,
    relayKey: await deriveRemoteRelayKeyFromExportKey(result.exportKey),
  };
}

export async function startRemoteOpaqueLogin(
  password: string,
): Promise<RemoteOpaqueClientLoginStart> {
  await ensureOpaqueReady();
  return opaque.client.startLogin({
    password: normalizeRemoteOpaquePassword(password),
  });
}

export async function startRemoteOpaqueServerLogin(params: {
  serverSetup: string;
  registrationRecord: string;
  startLoginRequest: string;
  loginHandle: string;
  realmId: string;
}): Promise<RemoteOpaqueLoginStartResult> {
  await ensureOpaqueReady();
  return opaque.server.startLogin({
    serverSetup: params.serverSetup,
    registrationRecord: params.registrationRecord,
    startLoginRequest: params.startLoginRequest,
    userIdentifier: normalizeLoginHandle(params.loginHandle),
    identifiers: buildRemoteOpaqueIdentifiers(
      params.loginHandle,
      params.realmId,
    ),
  });
}

export async function finishRemoteOpaqueLogin(params: {
  password: string;
  clientLoginState: string;
  loginResponse: string;
  loginHandle: string;
  realmId: string;
  expectedServerPublicKey?: string;
}): Promise<RemoteOpaqueLoginFinishResult | null> {
  await ensureOpaqueReady();
  const result = opaque.client.finishLogin({
    password: normalizeRemoteOpaquePassword(params.password),
    clientLoginState: params.clientLoginState,
    loginResponse: params.loginResponse,
    keyStretching: REMOTE_OPAQUE_KEY_STRETCHING,
    identifiers: buildRemoteOpaqueIdentifiers(
      params.loginHandle,
      params.realmId,
    ),
  });
  if (!result) {
    return null;
  }
  if (
    params.expectedServerPublicKey &&
    result.serverStaticPublicKey !== params.expectedServerPublicKey
  ) {
    throw new Error("Remote server public key mismatch");
  }
  return {
    ...result,
    relayKey: await deriveRemoteRelayKeyFromExportKey(result.exportKey),
  };
}

export async function finishRemoteOpaqueServerLogin(params: {
  serverLoginState: string;
  finishLoginRequest: string;
  loginHandle: string;
  realmId: string;
}): Promise<{ sessionKey: string }> {
  await ensureOpaqueReady();
  return opaque.server.finishLogin({
    serverLoginState: params.serverLoginState,
    finishLoginRequest: params.finishLoginRequest,
    identifiers: buildRemoteOpaqueIdentifiers(
      params.loginHandle,
      params.realmId,
    ),
  });
}

export function encodeRemoteStoredSecret(secret: Uint8Array): string {
  return encodeBase64(normalizeSecretBytes(secret));
}

export function decodeRemoteStoredSecret(secret: string): Uint8Array {
  return normalizeSecretBytes(decodeBase64(secret));
}

export async function deriveRemoteStoredAccessMaterial(
  storedSecret: string,
): Promise<RemoteAuthMaterial> {
  return deriveRemoteAuthMaterialFromSecret(
    decodeRemoteStoredSecret(storedSecret),
  );
}

export async function deriveRemoteAccessStorageSecret(
  username: string,
  password: string,
  realmId: string,
): Promise<string> {
  const material = await deriveRemoteAccessMaterial(
    username,
    password,
    realmId,
  );
  return encodeRemoteStoredSecret(material.secret);
}

export async function deriveRemoteAccessMaterial(
  username: string,
  password: string,
  realmId: string,
): Promise<RemoteCredentialMaterial> {
  const normalized = normalizeCredentialInputs(username, password, realmId);
  const secret = await deriveCredentialSecret(
    normalized.username,
    normalized.password,
    normalized.realmId,
  );
  return {
    ...deriveRemoteMaterialFromSecret(secret),
    loginHandle: await deriveRemoteLoginHandle(
      normalized.username,
      normalized.realmId,
    ),
    realmId: normalized.realmId,
  };
}

export async function deriveRemoteAuthMaterial(
  username: string,
  password: string,
  realmId: string,
): Promise<RemoteCredentialMaterial> {
  return deriveRemoteAccessMaterial(username, password, realmId);
}

export function buildRemoteAuthChallengeMessage(
  binding: RemoteAuthChallengeBinding,
): Uint8Array {
  const machineId = binding.machineId?.trim() || "";
  return encoder.encode(
    [
      "codexdeck-auth-v1",
      binding.challengeId,
      binding.challenge,
      binding.clientKind,
      machineId,
    ].join("\n"),
  );
}

export function signRemoteAuthChallenge(
  secretKey: Uint8Array,
  binding: RemoteAuthChallengeBinding,
): string {
  const signature = tweetnacl.sign.detached(
    buildRemoteAuthChallengeMessage(binding),
    secretKey,
  );
  return encodeBase64(signature);
}

export function verifyRemoteAuthChallengeSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  binding: RemoteAuthChallengeBinding,
): boolean {
  return tweetnacl.sign.detached.verify(
    buildRemoteAuthChallengeMessage(binding),
    signature,
    publicKey,
  );
}

function parseSigningPublicKey(publicKey: Uint8Array | string): Uint8Array {
  const parsed =
    typeof publicKey === "string" ? decodeBase64(publicKey) : publicKey;
  if (parsed.length !== tweetnacl.sign.publicKeyLength) {
    throw new Error("Invalid remote RPC signing public key");
  }
  return parsed;
}

function parseSigningSecretKey(secretKey: Uint8Array | string): Uint8Array {
  const parsed =
    typeof secretKey === "string" ? decodeBase64(secretKey) : secretKey;
  if (parsed.length !== tweetnacl.sign.secretKeyLength) {
    throw new Error("Invalid remote RPC signing secret key");
  }
  return parsed;
}

function parseSigningSignature(signature: Uint8Array | string): Uint8Array {
  const parsed =
    typeof signature === "string" ? decodeBase64(signature) : signature;
  if (parsed.length !== tweetnacl.sign.signatureLength) {
    throw new Error("Invalid remote RPC signature");
  }
  return parsed;
}

function buildRemoteRpcSignatureMessage(params: {
  machineId: string;
  requestId: string;
  encryptedResult: string;
}): Uint8Array {
  const machineId = params.machineId.trim();
  const requestId = params.requestId.trim();
  if (!machineId) {
    throw new Error("Remote RPC signature machineId must not be empty");
  }
  if (!requestId) {
    throw new Error("Remote RPC signature requestId must not be empty");
  }
  if (!params.encryptedResult.trim()) {
    throw new Error("Remote RPC signature payload must not be empty");
  }
  return encoder.encode(
    [
      REMOTE_RPC_SIGNATURE_VERSION,
      machineId,
      requestId,
      params.encryptedResult,
    ].join("\n"),
  );
}

export function generateRemoteRpcSigningKeyPair(): {
  publicKey: string;
  secretKey: string;
} {
  const keyPair = tweetnacl.sign.keyPair();
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

export function signRemoteRpcResult(params: {
  machineId: string;
  requestId: string;
  encryptedResult: string;
  secretKey: Uint8Array | string;
}): string {
  const signature = tweetnacl.sign.detached(
    buildRemoteRpcSignatureMessage(params),
    parseSigningSecretKey(params.secretKey),
  );
  return encodeBase64(signature);
}

export function verifyRemoteRpcResultSignature(params: {
  machineId: string;
  requestId: string;
  encryptedResult: string;
  signature: Uint8Array | string;
  publicKey: Uint8Array | string;
}): boolean {
  return tweetnacl.sign.detached.verify(
    buildRemoteRpcSignatureMessage(params),
    parseSigningSignature(params.signature),
    parseSigningPublicKey(params.publicKey),
  );
}

async function importAesKey(key: Uint8Array): Promise<any> {
  const cryptoObject = await getCrypto();
  return cryptoObject.subtle.importKey(
    "raw",
    key,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptRemotePayload(
  key: Uint8Array,
  payload: unknown,
): Promise<string> {
  const cryptoObject = await getCrypto();
  const iv = cryptoObject.getRandomValues(new Uint8Array(12));
  const cryptoKey = await importAesKey(key);
  const encrypted = await cryptoObject.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    cryptoKey,
    encoder.encode(JSON.stringify(payload)),
  );
  const bundle = concatBytes(
    Uint8Array.of(TRANSPORT_BUNDLE_VERSION),
    iv,
    new Uint8Array(encrypted),
  );
  return encodeBase64(bundle);
}

export async function decryptRemotePayload<T>(
  key: Uint8Array,
  encoded: string,
): Promise<T> {
  const bundle = decodeBase64(encoded);
  if (bundle.length < 13 || bundle[0] !== TRANSPORT_BUNDLE_VERSION) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = bundle.slice(1, 13);
  const ciphertext = bundle.slice(13);
  const cryptoKey = await importAesKey(key);
  const cryptoObject = await getCrypto();
  const decrypted = await cryptoObject.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    cryptoKey,
    ciphertext,
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}
