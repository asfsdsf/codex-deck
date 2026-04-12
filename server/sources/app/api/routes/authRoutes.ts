import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createRemoteOpaqueRegistrationResponse,
  finishRemoteOpaqueServerLogin,
  RemoteAuthErrorCode,
  startRemoteOpaqueServerLogin,
} from "@codex-deck/wire";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import {
  auth,
  type AuthClientKind,
  type AuthTokenExtras,
} from "@/app/auth/auth";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { parseCookieHeader, serializeCookie } from "@/app/auth/httpCookies";
import {
  createRemoteSetupToken,
  deleteRemoteSetupToken,
  findRemoteSetupToken,
  getOrInitializeRemoteAuthConfig,
  getRemoteBootstrapConfig,
  getRemoteOpaqueServerSetup,
  listRemoteSetupTokens,
  markRemoteSetupTokenUsed,
  regenerateRemoteSetupToken,
  rotateRemoteAdminPassword,
  updateRemoteSetupToken,
  verifyRemoteAdminPassword,
} from "@/app/auth/remoteAuthState";
import {
  REMOTE_ADMIN_SESSION_COOKIE,
  REMOTE_BROWSER_SESSION_COOKIE,
} from "@/app/auth/remoteAuthConstants";

const REMOTE_OPAQUE_REGISTER_STATE_PREFIX = "remote-opaque-register:";
const REMOTE_OPAQUE_LOGIN_STATE_PREFIX = "remote-opaque-login:";
const REMOTE_OPAQUE_RECORD_PREFIX = "remote-opaque-record:";
const REMOTE_OPAQUE_STATE_TTL_MS = 5 * 60 * 1000;
const REMOTE_ACCOUNT_NOT_FOUND_ERROR =
  "Remote account not found. Start the CLI first.";
const REMOTE_ACCOUNT_NOT_FOUND_CODE = RemoteAuthErrorCode.accountNotFound;
const REMOTE_ACCOUNT_MISMATCH_ERROR =
  "This login does not match the registered CLI account.";
const REMOTE_ACCOUNT_MISMATCH_CODE = RemoteAuthErrorCode.accountMismatch;
const REMOTE_SETUP_TOKENS_MISSING_ERROR =
  "Remote setup tokens are not configured on the server.";
const REMOTE_SETUP_TOKENS_MISSING_CODE = RemoteAuthErrorCode.setupTokensMissing;
const REMOTE_SETUP_TOKEN_INVALID_ERROR = "Invalid setup token.";
const REMOTE_SETUP_TOKEN_INVALID_CODE = RemoteAuthErrorCode.setupTokenInvalid;
const REMOTE_LOGIN_ALREADY_BOUND_ERROR =
  "This remote login is already bound to a different machine or password.";
const REMOTE_LOGIN_ALREADY_BOUND_CODE = RemoteAuthErrorCode.loginAlreadyBound;
const REMOTE_MACHINE_ALREADY_BOUND_ERROR =
  "This machine is already bound to a different remote login.";
const REMOTE_MACHINE_ALREADY_BOUND_CODE =
  RemoteAuthErrorCode.machineAlreadyBound;
const INVALID_REMOTE_LOGIN_ERROR = "Invalid remote login.";
const INVALID_REMOTE_LOGIN_CODE = RemoteAuthErrorCode.invalidLogin;
const INVALID_REMOTE_REGISTER_ERROR =
  "Invalid or expired remote registration attempt.";
const INVALID_REMOTE_REGISTER_CODE = RemoteAuthErrorCode.invalidRegister;
const INVALID_REMOTE_LOGIN_STATE_ERROR =
  "Invalid or expired remote login attempt.";
const INVALID_REMOTE_LOGIN_STATE_CODE = RemoteAuthErrorCode.invalidLoginState;
const INVALID_ADMIN_PASSWORD_ERROR = "Invalid admin password.";
const INVALID_ADMIN_PASSWORD_CODE = RemoteAuthErrorCode.adminPasswordInvalid;
const RETIRED_PASSWORD_AUTH_ERROR =
  "Raw password auth has been removed. Use the remote login flow in the web app and the current CLI remote registration flow.";
const RETIRED_QR_AUTH_ERROR =
  "QR authentication has been removed. Use the remote login flow in the web app and the current CLI remote registration flow.";
const REMOTE_AUTH_UPGRADE_ERROR =
  "Legacy remote auth has been removed. Re-register the CLI with the current codex-deck version.";
const REMOTE_AUTH_UPGRADE_CODE = RemoteAuthErrorCode.authUpgradeRequired;

const AuthErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

function sendAuthError(
  reply: any,
  statusCode: number,
  error: string,
  code: string,
) {
  return reply.code(statusCode).send({
    error,
    code,
  });
}

const AuthClientKindSchema = z.enum(["browser", "cli", "api"]);
const LoginHandleSchema = z.string().trim().min(1).max(256);
const SetupTokenSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable(),
});

const RemoteOpaqueRegistrationStateSchema = z.object({
  setupTokenId: z.string(),
  loginHandle: LoginHandleSchema,
  machineId: z.string().min(1),
  expiresAt: z.number(),
});
const RemoteOpaqueLoginStateSchema = z.object({
  loginHandle: LoginHandleSchema,
  clientKind: AuthClientKindSchema,
  machineId: z.string().nullable(),
  serverLoginState: z.string().min(1),
  expiresAt: z.number(),
});
const RemoteOpaqueRecordSchema = z.object({
  registrationRecord: z.string().min(1),
  updatedAt: z.number(),
});

type RemoteAccountBinding = NonNullable<
  Awaited<ReturnType<typeof findRemoteAccountByHandle>>
>;
type RemoteOpaqueRegistrationState = z.infer<
  typeof RemoteOpaqueRegistrationStateSchema
>;
type RemoteOpaqueLoginState = z.infer<typeof RemoteOpaqueLoginStateSchema>;

function buildTokenExtras(
  clientKind: AuthClientKind,
  issuedVia: "setup-token" | "signature" | "opaque",
  machineId?: string,
): AuthTokenExtras {
  return {
    clientKind,
    issuedVia,
    ...(machineId ? { machineId } : {}),
  };
}

function getClientBindingError(clientKind: AuthClientKind, machineId?: string) {
  if (clientKind === "cli" && !machineId) {
    return "machineId is required for CLI authentication";
  }
  if (clientKind !== "cli" && machineId) {
    return "machineId is only valid for CLI authentication";
  }
  return null as string | null;
}

async function issueAccountToken(
  userId: string,
  clientKind: AuthClientKind,
  issuedVia: "setup-token" | "signature" | "opaque",
  machineId?: string,
) {
  return auth.createToken(
    userId,
    buildTokenExtras(clientKind, issuedVia, machineId),
  );
}

function normalizeLoginHandle(loginHandle: string): string {
  return loginHandle.trim().toLowerCase();
}

function buildOpaqueRegisterStateKey(registrationId: string): string {
  return `${REMOTE_OPAQUE_REGISTER_STATE_PREFIX}${registrationId}`;
}

function buildOpaqueLoginStateKey(loginId: string): string {
  return `${REMOTE_OPAQUE_LOGIN_STATE_PREFIX}${loginId}`;
}

function buildOpaqueRecordKey(loginHandle: string): string {
  return `${REMOTE_OPAQUE_RECORD_PREFIX}${normalizeLoginHandle(loginHandle)}`;
}

function buildOpaquePlaceholderPublicKey(registrationRecord: string): string {
  return `opaque-v2:${createHash("sha256").update(registrationRecord).digest("hex")}`;
}

async function readJsonCache<T>(
  key: string,
  schema: z.ZodSchema<T>,
): Promise<T | null> {
  const entry = await db.simpleCache.findUnique({
    where: { key },
    select: { value: true },
  });
  if (!entry) {
    return null;
  }

  try {
    return schema.parse(JSON.parse(entry.value));
  } catch {
    return null;
  }
}

async function readRawJsonCache(key: string): Promise<string | null> {
  const entry = await db.simpleCache.findUnique({
    where: { key },
    select: { value: true },
  });
  return entry?.value ?? null;
}

async function writeJsonCache(key: string, value: unknown): Promise<void> {
  await db.simpleCache.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  });
}

async function deleteJsonCache(key: string, value?: string): Promise<number> {
  const result = await db.simpleCache.deleteMany({
    where: value ? { key, value } : { key },
  });
  return result.count;
}

function isSecureCookie(): boolean {
  const publicUrl = process.env.PUBLIC_URL || "";
  return publicUrl.startsWith("https://");
}

function buildBrowserSessionCookie(token: string, remember: boolean): string {
  return serializeCookie(REMOTE_BROWSER_SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    maxAgeSeconds: remember ? 30 * 24 * 60 * 60 : undefined,
  });
}

function clearBrowserSessionCookie(): string {
  return serializeCookie(REMOTE_BROWSER_SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    expires: new Date(0),
    maxAgeSeconds: 0,
  });
}

function buildAdminSessionCookie(token: string): string {
  return serializeCookie(REMOTE_ADMIN_SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
  });
}

function clearAdminSessionCookie(): string {
  return serializeCookie(REMOTE_ADMIN_SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    expires: new Date(0),
    maxAgeSeconds: 0,
  });
}

function qrAuthRemoved(_request: unknown, reply: any) {
  return reply.code(410).send({
    error: RETIRED_QR_AUTH_ERROR,
  });
}

function passwordAuthRemoved(_request: unknown, reply: any) {
  return reply.code(410).send({
    error: RETIRED_PASSWORD_AUTH_ERROR,
  });
}

function remoteAuthUpgradeRequired(_request: unknown, reply: any) {
  return sendAuthError(
    reply,
    410,
    REMOTE_AUTH_UPGRADE_ERROR,
    REMOTE_AUTH_UPGRADE_CODE,
  );
}

async function findRemoteAccountByHandle(loginHandle: string) {
  return db.account.findUnique({
    where: { remoteLoginHandle: normalizeLoginHandle(loginHandle) },
    select: {
      id: true,
      publicKey: true,
      remoteLoginHandle: true,
      remoteMachineId: true,
      authVersion: true,
    },
  });
}

async function findRemoteAccountByMachine(machineId: string) {
  return db.account.findUnique({
    where: { remoteMachineId: machineId },
    select: {
      id: true,
      publicKey: true,
      remoteLoginHandle: true,
      remoteMachineId: true,
      authVersion: true,
    },
  });
}

async function getRemoteOpaqueRegistrationRecord(
  loginHandle: string,
): Promise<string | null> {
  const record = await readJsonCache(
    buildOpaqueRecordKey(loginHandle),
    RemoteOpaqueRecordSchema,
  );
  return record?.registrationRecord ?? null;
}

async function storeRemoteOpaqueRegistrationRecord(
  loginHandle: string,
  registrationRecord: string,
): Promise<void> {
  await writeJsonCache(buildOpaqueRecordKey(loginHandle), {
    registrationRecord,
    updatedAt: Date.now(),
  });
}

async function deleteRemoteOpaqueRegistrationRecord(
  loginHandle: string,
): Promise<void> {
  await deleteJsonCache(buildOpaqueRecordKey(loginHandle));
}

function resolveRemoteRegistrationAccount(
  existingByHandle: RemoteAccountBinding | null,
  existingByMachine: RemoteAccountBinding | null,
  machineId: string,
): {
  conflictError: string | null;
  account: RemoteAccountBinding | null;
} {
  if (existingByHandle && existingByHandle.remoteMachineId !== machineId) {
    return {
      conflictError: REMOTE_LOGIN_ALREADY_BOUND_ERROR,
      account: null,
    };
  }

  if (
    existingByHandle &&
    existingByMachine &&
    existingByHandle.id !== existingByMachine.id
  ) {
    return {
      conflictError: REMOTE_MACHINE_ALREADY_BOUND_ERROR,
      account: null,
    };
  }

  return {
    conflictError: null,
    account: existingByMachine ?? existingByHandle ?? null,
  };
}

function toSetupTokenSummary(record: {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}) {
  return {
    id: record.id,
    label: record.label,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

async function authenticateAdminRequest(request: any, reply: any) {
  const cookieToken = parseCookieHeader(request.headers.cookie)[
    REMOTE_ADMIN_SESSION_COOKIE
  ];
  if (!cookieToken) {
    return reply.code(401).send({ error: "Missing admin session" });
  }

  const verified = await auth.verifyAdminSessionToken(cookieToken);
  if (!verified) {
    return reply.code(401).send({ error: "Invalid admin session" });
  }

  const config = await getOrInitializeRemoteAuthConfig();
  if (verified.authVersion !== config.adminAuthVersion) {
    return reply.code(401).send({ error: "Invalid admin session" });
  }
}

export function authRoutes(app: Fastify) {
  app.get(
    "/v1/auth/bootstrap",
    {
      schema: {
        response: {
          200: z.object({
            remoteAuthVersion: z.literal(2),
            realmId: z.string(),
            opaqueServerPublicKey: z.string(),
            browserPersistence: z.enum(["session", "remember"]),
          }),
        },
      },
    },
    async (_request, reply) => {
      return reply.send(await getRemoteBootstrapConfig());
    },
  );

  app.get(
    "/v1/auth/session",
    {
      schema: {
        response: {
          200: z.object({
            authenticated: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const cookieToken = parseCookieHeader(request.headers.cookie)[
        REMOTE_BROWSER_SESSION_COOKIE
      ];
      if (!cookieToken) {
        return reply.send({ authenticated: false });
      }
      const verified = await auth.verifyBrowserSessionToken(cookieToken);
      return reply.send({ authenticated: !!verified });
    },
  );

  app.post(
    "/v1/auth/opaque/register/start",
    {
      schema: {
        body: z.object({
          setupToken: z.string().min(1).max(1024),
          loginHandle: LoginHandleSchema,
          machineId: z.string().min(1),
          registrationRequest: z.string().min(1),
        }),
        response: {
          200: z.object({
            registrationId: z.string(),
            registrationResponse: z.string(),
          }),
          401: AuthErrorResponseSchema,
          409: AuthErrorResponseSchema,
          503: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const setupToken = await findRemoteSetupToken(request.body.setupToken);
      if (!setupToken) {
        const configuredTokens = await listRemoteSetupTokens();
        if (configuredTokens.length === 0) {
          return sendAuthError(
            reply,
            503,
            REMOTE_SETUP_TOKENS_MISSING_ERROR,
            REMOTE_SETUP_TOKENS_MISSING_CODE,
          );
        }
        return sendAuthError(
          reply,
          401,
          REMOTE_SETUP_TOKEN_INVALID_ERROR,
          REMOTE_SETUP_TOKEN_INVALID_CODE,
        );
      }

      const loginHandle = normalizeLoginHandle(request.body.loginHandle);
      const existingByHandle = await findRemoteAccountByHandle(loginHandle);
      const existingByMachine = await findRemoteAccountByMachine(
        request.body.machineId,
      );
      const registrationTarget = resolveRemoteRegistrationAccount(
        existingByHandle,
        existingByMachine,
        request.body.machineId,
      );

      if (registrationTarget.conflictError) {
        return sendAuthError(
          reply,
          409,
          registrationTarget.conflictError,
          registrationTarget.conflictError === REMOTE_LOGIN_ALREADY_BOUND_ERROR
            ? REMOTE_LOGIN_ALREADY_BOUND_CODE
            : REMOTE_MACHINE_ALREADY_BOUND_CODE,
        );
      }

      const serverSetup = await getRemoteOpaqueServerSetup();
      const { registrationResponse } =
        await createRemoteOpaqueRegistrationResponse({
          serverSetup,
          loginHandle,
          registrationRequest: request.body.registrationRequest,
        });
      const registrationId = randomKeyNaked(24);
      await writeJsonCache(buildOpaqueRegisterStateKey(registrationId), {
        setupTokenId: setupToken.id,
        loginHandle,
        machineId: request.body.machineId,
        expiresAt: Date.now() + REMOTE_OPAQUE_STATE_TTL_MS,
      } satisfies RemoteOpaqueRegistrationState);

      return reply.send({
        registrationId,
        registrationResponse,
      });
    },
  );

  app.post(
    "/v1/auth/opaque/register/finish",
    {
      schema: {
        body: z.object({
          registrationId: z.string().min(1),
          registrationRecord: z.string().min(1),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            token: z.string(),
          }),
          401: AuthErrorResponseSchema,
          409: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const stateKey = buildOpaqueRegisterStateKey(request.body.registrationId);
      const rawState = await readRawJsonCache(stateKey);
      if (!rawState) {
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_REGISTER_ERROR,
          INVALID_REMOTE_REGISTER_CODE,
        );
      }

      let registrationState: RemoteOpaqueRegistrationState;
      try {
        registrationState = RemoteOpaqueRegistrationStateSchema.parse(
          JSON.parse(rawState),
        );
      } catch {
        await deleteJsonCache(stateKey);
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_REGISTER_ERROR,
          INVALID_REMOTE_REGISTER_CODE,
        );
      }

      if (registrationState.expiresAt < Date.now()) {
        await deleteJsonCache(stateKey, rawState);
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_REGISTER_ERROR,
          INVALID_REMOTE_REGISTER_CODE,
        );
      }

      const deleted = await deleteJsonCache(stateKey, rawState);
      if (deleted !== 1) {
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_REGISTER_ERROR,
          INVALID_REMOTE_REGISTER_CODE,
        );
      }

      const existingByHandle = await findRemoteAccountByHandle(
        registrationState.loginHandle,
      );
      const existingByMachine = await findRemoteAccountByMachine(
        registrationState.machineId,
      );
      const registrationTarget = resolveRemoteRegistrationAccount(
        existingByHandle,
        existingByMachine,
        registrationState.machineId,
      );

      if (registrationTarget.conflictError) {
        return sendAuthError(
          reply,
          409,
          registrationTarget.conflictError,
          registrationTarget.conflictError === REMOTE_LOGIN_ALREADY_BOUND_ERROR
            ? REMOTE_LOGIN_ALREADY_BOUND_CODE
            : REMOTE_MACHINE_ALREADY_BOUND_CODE,
        );
      }

      const nextPublicKey = buildOpaquePlaceholderPublicKey(
        request.body.registrationRecord,
      );
      if (registrationTarget.account) {
        const accountId = registrationTarget.account.id;
        const previousLoginHandle =
          registrationTarget.account.remoteLoginHandle;
        await db.account.update({
          where: { id: accountId },
          data: {
            publicKey: nextPublicKey,
            remoteLoginHandle: registrationState.loginHandle,
            remoteMachineId: registrationState.machineId,
            authVersion: {
              increment: 1,
            },
          },
        });
        if (
          previousLoginHandle &&
          previousLoginHandle !== registrationState.loginHandle
        ) {
          await deleteRemoteOpaqueRegistrationRecord(previousLoginHandle);
        }
      } else {
        const account = await db.account.create({
          data: {
            publicKey: nextPublicKey,
            remoteLoginHandle: registrationState.loginHandle,
            remoteMachineId: registrationState.machineId,
          },
          select: {
            id: true,
          },
        });
        await storeRemoteOpaqueRegistrationRecord(
          registrationState.loginHandle,
          request.body.registrationRecord,
        );
        await markRemoteSetupTokenUsed(registrationState.setupTokenId);

        return reply.send({
          success: true,
          token: await issueAccountToken(
            account.id,
            "cli",
            "setup-token",
            registrationState.machineId,
          ),
        });
      }

      await storeRemoteOpaqueRegistrationRecord(
        registrationState.loginHandle,
        request.body.registrationRecord,
      );
      await markRemoteSetupTokenUsed(registrationState.setupTokenId);

      return reply.send({
        success: true,
        token: await issueAccountToken(
          registrationTarget.account.id,
          "cli",
          "setup-token",
          registrationState.machineId,
        ),
      });
    },
  );

  app.post(
    "/v1/auth/opaque/login/start",
    {
      schema: {
        body: z.object({
          loginHandle: LoginHandleSchema,
          clientKind: AuthClientKindSchema.default("browser"),
          machineId: z.string().optional(),
          startLoginRequest: z.string().min(1),
        }),
        response: {
          200: z.object({
            loginId: z.string(),
            loginResponse: z.string(),
          }),
          400: z.object({
            error: z.string(),
          }),
          409: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const clientValidationError = getClientBindingError(
        request.body.clientKind,
        request.body.machineId,
      );
      if (clientValidationError) {
        return reply.code(400).send({ error: clientValidationError });
      }

      const loginHandle = normalizeLoginHandle(request.body.loginHandle);
      const account = await findRemoteAccountByHandle(loginHandle);
      if (!account) {
        return sendAuthError(
          reply,
          409,
          REMOTE_ACCOUNT_NOT_FOUND_ERROR,
          REMOTE_ACCOUNT_NOT_FOUND_CODE,
        );
      }
      if (
        request.body.clientKind === "cli" &&
        account.remoteMachineId !== request.body.machineId
      ) {
        return sendAuthError(
          reply,
          409,
          REMOTE_ACCOUNT_MISMATCH_ERROR,
          REMOTE_ACCOUNT_MISMATCH_CODE,
        );
      }

      const registrationRecord =
        await getRemoteOpaqueRegistrationRecord(loginHandle);
      if (!registrationRecord) {
        return sendAuthError(
          reply,
          409,
          REMOTE_AUTH_UPGRADE_ERROR,
          REMOTE_AUTH_UPGRADE_CODE,
        );
      }

      const serverSetup = await getRemoteOpaqueServerSetup();
      const config = await getOrInitializeRemoteAuthConfig();
      const { loginResponse, serverLoginState } =
        await startRemoteOpaqueServerLogin({
          serverSetup,
          registrationRecord,
          startLoginRequest: request.body.startLoginRequest,
          loginHandle,
          realmId: config.realmId,
        });
      const loginId = randomKeyNaked(24);
      await writeJsonCache(buildOpaqueLoginStateKey(loginId), {
        loginHandle,
        clientKind: request.body.clientKind,
        machineId: request.body.machineId ?? null,
        serverLoginState,
        expiresAt: Date.now() + REMOTE_OPAQUE_STATE_TTL_MS,
      } satisfies RemoteOpaqueLoginState);

      return reply.send({
        loginId,
        loginResponse,
      });
    },
  );

  app.post(
    "/v1/auth/opaque/login/finish",
    {
      schema: {
        body: z.object({
          loginId: z.string().min(1),
          finishLoginRequest: z.string().min(1),
          remember: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            token: z.string(),
          }),
          401: AuthErrorResponseSchema,
          409: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const stateKey = buildOpaqueLoginStateKey(request.body.loginId);
      const rawState = await readRawJsonCache(stateKey);
      if (!rawState) {
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_LOGIN_STATE_ERROR,
          INVALID_REMOTE_LOGIN_STATE_CODE,
        );
      }

      let loginState: RemoteOpaqueLoginState;
      try {
        loginState = RemoteOpaqueLoginStateSchema.parse(JSON.parse(rawState));
      } catch {
        await deleteJsonCache(stateKey);
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_LOGIN_STATE_ERROR,
          INVALID_REMOTE_LOGIN_STATE_CODE,
        );
      }

      if (loginState.expiresAt < Date.now()) {
        await deleteJsonCache(stateKey, rawState);
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_LOGIN_STATE_ERROR,
          INVALID_REMOTE_LOGIN_STATE_CODE,
        );
      }

      const deleted = await deleteJsonCache(stateKey, rawState);
      if (deleted !== 1) {
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_LOGIN_STATE_ERROR,
          INVALID_REMOTE_LOGIN_STATE_CODE,
        );
      }

      const account = await findRemoteAccountByHandle(loginState.loginHandle);
      if (!account) {
        return sendAuthError(
          reply,
          409,
          REMOTE_ACCOUNT_NOT_FOUND_ERROR,
          REMOTE_ACCOUNT_NOT_FOUND_CODE,
        );
      }

      const config = await getOrInitializeRemoteAuthConfig();
      try {
        await finishRemoteOpaqueServerLogin({
          serverLoginState: loginState.serverLoginState,
          finishLoginRequest: request.body.finishLoginRequest,
          loginHandle: loginState.loginHandle,
          realmId: config.realmId,
        });
      } catch {
        return sendAuthError(
          reply,
          401,
          INVALID_REMOTE_LOGIN_ERROR,
          INVALID_REMOTE_LOGIN_CODE,
        );
      }

      if (loginState.clientKind === "browser") {
        const remember = request.body.remember === true;
        const browserToken = await auth.createBrowserSessionToken(
          account.id,
          remember,
        );
        reply.header(
          "Set-Cookie",
          buildBrowserSessionCookie(browserToken, remember),
        );
        return reply.send({
          success: true,
          token: browserToken,
        });
      }

      return reply.send({
        success: true,
        token: await issueAccountToken(
          account.id,
          loginState.clientKind,
          "opaque",
          loginState.machineId || undefined,
        ),
      });
    },
  );

  app.post(
    "/v1/auth/logout",
    {
      schema: {
        response: {
          200: z.object({
            success: z.literal(true),
          }),
        },
      },
    },
    async (_request, reply) => {
      reply.header("Set-Cookie", clearBrowserSessionCookie());
      return reply.send({ success: true });
    },
  );

  app.post(
    "/v1/auth/challenge",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
            code: z.string().optional(),
          }),
        },
      },
    },
    remoteAuthUpgradeRequired,
  );

  app.post(
    "/v1/auth",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
            code: z.string().optional(),
          }),
        },
      },
    },
    remoteAuthUpgradeRequired,
  );

  app.post(
    "/v1/auth/machine",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
            code: z.string().optional(),
          }),
        },
      },
    },
    remoteAuthUpgradeRequired,
  );

  app.post(
    "/v1/admin/auth/login",
    {
      schema: {
        body: z.object({
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
          }),
          401: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const valid = await verifyRemoteAdminPassword(request.body.password);
      if (!valid) {
        return sendAuthError(
          reply,
          401,
          INVALID_ADMIN_PASSWORD_ERROR,
          INVALID_ADMIN_PASSWORD_CODE,
        );
      }

      const config = await getOrInitializeRemoteAuthConfig();
      const adminToken = await auth.createAdminSessionToken(
        config.adminAuthVersion,
      );
      reply.header("Set-Cookie", buildAdminSessionCookie(adminToken));
      return reply.send({ success: true });
    },
  );

  app.post(
    "/v1/admin/auth/logout",
    {
      schema: {
        response: {
          200: z.object({
            success: z.literal(true),
          }),
        },
      },
    },
    async (_request, reply) => {
      reply.header("Set-Cookie", clearAdminSessionCookie());
      return reply.send({ success: true });
    },
  );

  app.post(
    "/v1/admin/password",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        body: z.object({
          oldPassword: z.string().min(1),
          newPassword: z.string().min(1),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
          }),
          401: AuthErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const valid = await verifyRemoteAdminPassword(request.body.oldPassword);
      if (!valid) {
        return sendAuthError(
          reply,
          401,
          INVALID_ADMIN_PASSWORD_ERROR,
          INVALID_ADMIN_PASSWORD_CODE,
        );
      }
      const config = await rotateRemoteAdminPassword(request.body.newPassword);
      const adminToken = await auth.createAdminSessionToken(
        config.adminAuthVersion,
      );
      reply.header("Set-Cookie", buildAdminSessionCookie(adminToken));
      return reply.send({ success: true });
    },
  );

  app.get(
    "/v1/admin/setup-tokens",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        response: {
          200: z.object({
            tokens: z.array(SetupTokenSummarySchema),
          }),
        },
      },
    },
    async (_request, reply) => {
      const tokens = await listRemoteSetupTokens();
      return reply.send({
        tokens: tokens.map((token) => toSetupTokenSummary(token)),
      });
    },
  );

  app.post(
    "/v1/admin/setup-tokens",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        body: z.object({
          label: z.string().optional(),
        }),
        response: {
          200: z.object({
            token: SetupTokenSummarySchema,
            rawToken: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const created = await createRemoteSetupToken(request.body.label || "");
      return reply.send({
        token: toSetupTokenSummary(created.record),
        rawToken: created.rawToken,
      });
    },
  );

  app.patch(
    "/v1/admin/setup-tokens/:id",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        params: z.object({
          id: z.string(),
        }),
        body: z.object({
          label: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            token: SetupTokenSummarySchema,
          }),
          404: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const updated = await updateRemoteSetupToken(
        request.params.id,
        request.body,
      );
      if (!updated) {
        return reply.code(404).send({ error: "Setup token not found" });
      }
      return reply.send({
        success: true,
        token: toSetupTokenSummary(updated),
      });
    },
  );

  app.post(
    "/v1/admin/setup-tokens/:id/regenerate",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            token: SetupTokenSummarySchema,
            rawToken: z.string(),
          }),
          404: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const regenerated = await regenerateRemoteSetupToken(request.params.id);
      if (!regenerated) {
        return reply.code(404).send({ error: "Setup token not found" });
      }
      return reply.send({
        token: toSetupTokenSummary(regenerated.record),
        rawToken: regenerated.rawToken,
      });
    },
  );

  app.delete(
    "/v1/admin/setup-tokens/:id",
    {
      preHandler: authenticateAdminRequest,
      schema: {
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
          }),
          404: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteRemoteSetupToken(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "Setup token not found" });
      }
      return reply.send({ success: true });
    },
  );

  app.post(
    "/v1/auth/cli",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    passwordAuthRemoved,
  );

  app.get(
    "/v1/auth/password/status",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    passwordAuthRemoved,
  );

  app.post(
    "/v1/auth/password",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    passwordAuthRemoved,
  );

  app.post(
    "/v1/auth/password/rotate",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    passwordAuthRemoved,
  );

  app.post(
    "/v1/auth/request",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    qrAuthRemoved,
  );

  app.get(
    "/v1/auth/request/status",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    qrAuthRemoved,
  );

  app.post(
    "/v1/auth/response",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    qrAuthRemoved,
  );

  app.post(
    "/v1/auth/account/request",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    qrAuthRemoved,
  );

  app.post(
    "/v1/auth/account/response",
    {
      schema: {
        response: {
          410: z.object({
            error: z.string(),
          }),
        },
      },
    },
    qrAuthRemoved,
  );
}
