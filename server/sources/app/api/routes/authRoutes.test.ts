import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fastify } from "../types";
import {
  deriveRemoteLoginHandle,
  finishRemoteOpaqueLogin,
  finishRemoteOpaqueRegistration,
  RemoteAuthErrorCode,
  startRemoteOpaqueLogin,
  startRemoteOpaqueRegistration,
} from "@zuoyehaoduoa/wire";

type AccountRecord = {
  id: string;
  publicKey: string;
  remoteLoginHandle: string | null;
  remoteMachineId: string | null;
  authVersion: number;
  createdAt: Date;
};

const { state, resetState, authMock } = vi.hoisted(() => {
  const state = {
    accounts: [] as AccountRecord[],
    simpleCache: new Map<string, string>(),
    nextAccountId: 1,
  };

  const resetState = () => {
    state.accounts = [];
    state.simpleCache = new Map<string, string>();
    state.nextAccountId = 1;
  };

  const authMock = {
    createToken: vi.fn(
      async (userId: string, extras?: Record<string, unknown>) => {
        const clientKind =
          typeof extras?.clientKind === "string"
            ? extras.clientKind
            : "browser";
        const machineId =
          typeof extras?.machineId === "string" ? extras.machineId : "none";
        const issuedVia =
          typeof extras?.issuedVia === "string" ? extras.issuedVia : "none";
        return `token:${userId}:${clientKind}:${machineId}:${issuedVia}`;
      },
    ),
    createBrowserSessionToken: vi.fn(
      async (userId: string, remember: boolean) => {
        const account = state.accounts.find((item) => item.id === userId);
        const authVersion = account?.authVersion ?? 0;
        return `browser-session:${userId}:${remember ? "remember" : "session"}:${authVersion}`;
      },
    ),
    createAdminSessionToken: vi.fn(
      async (authVersion: number) => `admin-session:${authVersion}`,
    ),
    verifyAdminSessionToken: vi.fn(async (token: string) => {
      const match = /^admin-session:(\d+)$/.exec(token);
      if (!match) {
        return null;
      }
      return { authVersion: Number.parseInt(match[1] || "0", 10) };
    }),
    verifyBrowserSessionToken: vi.fn(async (token: string) => {
      const match =
        /^browser-session:(account-\d+):(remember|session):(\d+)$/.exec(token);
      if (!match) {
        return null;
      }
      const account = state.accounts.find((item) => item.id === match[1]);
      const authVersion = Number.parseInt(match[3] || "0", 10);
      if (!account || account.authVersion !== authVersion) {
        return null;
      }
      return {
        userId: match[1]!,
        authVersion,
        extras: {
          clientKind: "browser",
          issuedVia: "opaque",
        },
      };
    }),
  };

  return { state, resetState, authMock };
});

function selectFields<T extends Record<string, unknown>>(
  input: T,
  select: Record<string, boolean> | undefined,
): Partial<T> {
  if (!select) {
    return { ...input };
  }
  const selected: Partial<T> = {};
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) {
      selected[key as keyof T] = input[key as keyof T];
    }
  }
  return selected;
}

vi.mock("@/storage/db", () => ({
  db: {
    account: {
      findUnique: vi.fn(async (args: any) => {
        const where = args?.where ?? {};
        const account = state.accounts.find((item) => {
          if (where.id) {
            return item.id === where.id;
          }
          if (where.publicKey) {
            return item.publicKey === where.publicKey;
          }
          if (where.remoteLoginHandle) {
            return item.remoteLoginHandle === where.remoteLoginHandle;
          }
          if (where.remoteMachineId) {
            return item.remoteMachineId === where.remoteMachineId;
          }
          return false;
        });
        if (!account) {
          return null;
        }
        return selectFields(account, args?.select);
      }),
      create: vi.fn(async (args: any) => {
        const account: AccountRecord = {
          id: `account-${state.nextAccountId}`,
          publicKey: args.data.publicKey,
          remoteLoginHandle: args.data.remoteLoginHandle ?? null,
          remoteMachineId: args.data.remoteMachineId ?? null,
          authVersion: args.data.authVersion ?? 0,
          createdAt: new Date(state.nextAccountId * 1000),
        };
        state.nextAccountId += 1;
        state.accounts.push(account);
        return selectFields(account, args?.select);
      }),
      update: vi.fn(async (args: any) => {
        const index = state.accounts.findIndex(
          (item) => item.id === args?.where?.id,
        );
        if (index < 0) {
          throw new Error(`Account not found: ${args?.where?.id}`);
        }
        const current = state.accounts[index]!;
        const next: AccountRecord = {
          ...current,
          publicKey: args?.data?.publicKey ?? current.publicKey,
          remoteLoginHandle:
            args?.data?.remoteLoginHandle ?? current.remoteLoginHandle,
          remoteMachineId:
            args?.data?.remoteMachineId ?? current.remoteMachineId,
          authVersion:
            typeof args?.data?.authVersion?.increment === "number"
              ? current.authVersion + args.data.authVersion.increment
              : (args?.data?.authVersion ?? current.authVersion),
        };
        state.accounts[index] = next;
        return selectFields(next, args?.select);
      }),
    },
    simpleCache: {
      upsert: vi.fn(async (args: any) => {
        state.simpleCache.set(
          args.where.key,
          args.create?.value ?? args.update?.value ?? "",
        );
        return null;
      }),
      findUnique: vi.fn(async (args: any) => {
        const value = state.simpleCache.get(args.where.key);
        if (value === undefined) {
          return null;
        }
        if (args?.select?.value) {
          return { value };
        }
        return { key: args.where.key, value };
      }),
      deleteMany: vi.fn(async (args: any) => {
        const key = args.where.key;
        const existing = state.simpleCache.get(key);
        if (existing === undefined) {
          return { count: 0 };
        }
        if (
          typeof args.where.value === "string" &&
          args.where.value !== existing
        ) {
          return { count: 0 };
        }
        state.simpleCache.delete(key);
        return { count: 1 };
      }),
    },
  },
}));

vi.mock("@/app/auth/auth", () => ({
  auth: authMock,
}));

import { authRoutes } from "./authRoutes";

describe("authRoutes", () => {
  let app: Fastify;

  beforeEach(async () => {
    resetState();
    authMock.createToken.mockClear();
    authMock.createBrowserSessionToken.mockClear();
    authMock.createAdminSessionToken.mockClear();
    authMock.verifyAdminSessionToken.mockClear();
    authMock.verifyBrowserSessionToken.mockClear();

    process.env.CODEXDECK_REMOTE_ADMIN_PASSWORD = "admin-secret";
    process.env.CODEXDECK_REMOTE_SETUP_TOKENS = "setup-a,setup-b";
    process.env.CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE = "remember";

    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    app = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    app.decorate("authenticate", async function (_request: any, _reply: any) {
      return;
    });
    authRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.CODEXDECK_REMOTE_ADMIN_PASSWORD;
    delete process.env.CODEXDECK_REMOTE_SETUP_TOKENS;
    delete process.env.CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE;
    await app.close();
  });

  async function bootstrapAuth() {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/bootstrap",
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      remoteAuthVersion: 2;
      realmId: string;
      opaqueServerPublicKey: string;
      browserPersistence: "session" | "remember";
    };
  }

  async function registerCli({
    machineId = "machine-a",
    username = "alice",
    password = "correct horse battery staple",
  }: {
    machineId?: string;
    username?: string;
    password?: string;
  } = {}) {
    const bootstrap = await bootstrapAuth();
    const loginHandle = await deriveRemoteLoginHandle(
      username,
      bootstrap.realmId,
    );
    const registrationStart = await startRemoteOpaqueRegistration(password);

    const startResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/register/start",
      payload: {
        setupToken: "setup-a",
        loginHandle,
        machineId,
        registrationRequest: registrationStart.registrationRequest,
      },
    });
    expect(startResponse.statusCode).toBe(200);
    const startBody = startResponse.json() as {
      registrationId: string;
      registrationResponse: string;
    };

    const registrationFinish = await finishRemoteOpaqueRegistration({
      password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse: startBody.registrationResponse,
      loginHandle,
      realmId: bootstrap.realmId,
      expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
    });

    const finishResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/register/finish",
      payload: {
        registrationId: startBody.registrationId,
        registrationRecord: registrationFinish.registrationRecord,
      },
    });

    return {
      bootstrap,
      loginHandle,
      registrationFinish,
      finishResponse,
    };
  }

  async function loginBrowser({
    username = "alice",
    password = "correct horse battery staple",
    remember = true,
  }: {
    username?: string;
    password?: string;
    remember?: boolean;
  } = {}) {
    const bootstrap = await bootstrapAuth();
    const loginHandle = await deriveRemoteLoginHandle(
      username,
      bootstrap.realmId,
    );
    const loginStart = await startRemoteOpaqueLogin(password);

    const startResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/login/start",
      payload: {
        loginHandle,
        clientKind: "browser",
        startLoginRequest: loginStart.startLoginRequest,
      },
    });

    if (startResponse.statusCode !== 200) {
      return {
        bootstrap,
        loginHandle,
        startResponse,
      };
    }

    const startBody = startResponse.json() as {
      loginId: string;
      loginResponse: string;
    };
    const loginFinish = await finishRemoteOpaqueLogin({
      password,
      clientLoginState: loginStart.clientLoginState,
      loginResponse: startBody.loginResponse,
      loginHandle,
      realmId: bootstrap.realmId,
      expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
    });

    return {
      bootstrap,
      loginHandle,
      startResponse,
      finishResponse: await app.inject({
        method: "POST",
        url: "/v1/auth/opaque/login/finish",
        payload: {
          loginId: startBody.loginId,
          finishLoginRequest: loginFinish!.finishLoginRequest,
          remember,
        },
      }),
    };
  }

  it("returns remote bootstrap configuration", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/bootstrap",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      remoteAuthVersion: 2,
      browserPersistence: "remember",
    });
    expect(
      (
        response.json() as {
          realmId: string;
          opaqueServerPublicKey: string;
        }
      ).realmId,
    ).toMatch(/\S+/);
    expect(
      (
        response.json() as {
          realmId: string;
          opaqueServerPublicKey: string;
        }
      ).opaqueServerPublicKey,
    ).toMatch(/\S+/);
  });

  it("registers a machine with a valid setup token and opaque login handle", async () => {
    const { loginHandle, finishResponse } = await registerCli();

    expect(finishResponse.statusCode).toBe(200);
    expect(finishResponse.json()).toEqual({
      success: true,
      token: "token:account-1:cli:machine-a:setup-token",
    });
    expect(state.accounts).toEqual([
      expect.objectContaining({
        id: "account-1",
        remoteLoginHandle: loginHandle,
        remoteMachineId: "machine-a",
      }),
    ]);
  });

  it("re-registers the same machine with a new password and invalidates old browser sessions", async () => {
    await registerCli({
      machineId: "machine-a",
      username: "alice",
      password: "correct horse battery staple",
    });
    const initialBrowserLogin = await loginBrowser({
      username: "alice",
      password: "correct horse battery staple",
    });
    expect(initialBrowserLogin.finishResponse?.statusCode).toBe(200);

    const rebindResponse = await registerCli({
      machineId: "machine-a",
      username: "alice",
      password: "even better battery staple",
    });

    expect(rebindResponse.finishResponse.statusCode).toBe(200);
    expect(rebindResponse.finishResponse.json()).toEqual({
      success: true,
      token: "token:account-1:cli:machine-a:setup-token",
    });
    expect(state.accounts).toEqual([
      expect.objectContaining({
        id: "account-1",
        remoteLoginHandle: rebindResponse.loginHandle,
        remoteMachineId: "machine-a",
        authVersion: 1,
      }),
    ]);

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        cookie: String(
          initialBrowserLogin.finishResponse?.headers["set-cookie"],
        ),
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toEqual({ authenticated: false });

    const updatedBrowserLogin = await loginBrowser({
      username: "alice",
      password: "even better battery staple",
    });
    expect(updatedBrowserLogin.finishResponse?.statusCode).toBe(200);
    expect(updatedBrowserLogin.finishResponse?.json()).toEqual({
      success: true,
      token: "browser-session:account-1:remember:1",
    });
  });

  it("re-registers the same machine with a new login handle", async () => {
    const initial = await registerCli({
      machineId: "machine-a",
      username: "alice",
    });
    const rebound = await registerCli({
      machineId: "machine-a",
      username: "bob",
      password: "correct horse battery staple",
    });

    expect(rebound.finishResponse.statusCode).toBe(200);
    expect(rebound.finishResponse.json()).toEqual({
      success: true,
      token: "token:account-1:cli:machine-a:setup-token",
    });
    expect(state.accounts).toEqual([
      expect.objectContaining({
        id: "account-1",
        remoteLoginHandle: rebound.loginHandle,
        remoteMachineId: "machine-a",
        authVersion: 1,
      }),
    ]);

    const oldLoginResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/login/start",
      payload: {
        loginHandle: initial.loginHandle,
        clientKind: "browser",
        startLoginRequest: (
          await startRemoteOpaqueLogin("correct horse battery staple")
        ).startLoginRequest,
      },
    });
    expect(oldLoginResponse.statusCode).toBe(409);
    expect(oldLoginResponse.json()).toEqual({
      code: RemoteAuthErrorCode.accountNotFound,
      error: "Remote account not found. Start the CLI first.",
    });
  });

  it("rejects reusing the same login handle for a different machine", async () => {
    const { loginHandle } = await registerCli({ machineId: "machine-a" });
    const bootstrap = await bootstrapAuth();
    const registrationStart = await startRemoteOpaqueRegistration(
      "correct horse battery staple",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/register/start",
      payload: {
        setupToken: "setup-a",
        loginHandle,
        machineId: "machine-b",
        registrationRequest: registrationStart.registrationRequest,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: RemoteAuthErrorCode.loginAlreadyBound,
      error:
        "This remote login is already bound to a different machine or password.",
    });
    expect(bootstrap.opaqueServerPublicKey).toMatch(/\S+/);
  });

  it("rejects taking an already-bound machine with another account handle", async () => {
    await registerCli({ machineId: "machine-a", username: "alice" });
    const { loginHandle } = await registerCli({
      machineId: "machine-b",
      username: "bob",
    });
    const registrationStart = await startRemoteOpaqueRegistration(
      "correct horse battery staple",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/register/start",
      payload: {
        setupToken: "setup-a",
        loginHandle,
        machineId: "machine-a",
        registrationRequest: registrationStart.registrationRequest,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: RemoteAuthErrorCode.loginAlreadyBound,
      error:
        "This remote login is already bound to a different machine or password.",
    });
  });

  it("authenticates the browser with a registered remote login handle", async () => {
    await registerCli();
    const authResponse = (await loginBrowser()).finishResponse;

    expect(authResponse?.statusCode).toBe(200);
    expect(authResponse?.json()).toEqual({
      success: true,
      token: "browser-session:account-1:remember:0",
    });
    expect(authResponse?.headers["set-cookie"]).toContain(
      "codexdeck_remote_session=",
    );
  });

  it("rejects browser login requests for unknown remote logins", async () => {
    const bootstrap = await bootstrapAuth();
    const loginHandle = await deriveRemoteLoginHandle(
      "alice",
      bootstrap.realmId,
    );
    const loginStart = await startRemoteOpaqueLogin(
      "correct horse battery staple",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/login/start",
      payload: {
        loginHandle,
        clientKind: "browser",
        startLoginRequest: loginStart.startLoginRequest,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: RemoteAuthErrorCode.accountNotFound,
      error: "Remote account not found. Start the CLI first.",
    });
  });

  it("logs in to the admin API and lists setup tokens", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: {
        password: "admin-secret",
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    const cookieHeader = loginResponse.headers["set-cookie"];
    expect(cookieHeader).toContain("codexdeck_admin_session=");

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/setup-tokens",
      headers: {
        cookie: String(cookieHeader),
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({
      tokens: [
        expect.objectContaining({ label: "token-1", enabled: true }),
        expect.objectContaining({ label: "token-2", enabled: true }),
      ],
    });
  });

  it("allows remote auth bootstrap without seeded setup tokens", async () => {
    delete process.env.CODEXDECK_REMOTE_SETUP_TOKENS;

    const bootstrap = await bootstrapAuth();
    expect(bootstrap.remoteAuthVersion).toBe(2);

    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: {
        password: "admin-secret",
      },
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookieHeader = loginResponse.headers["set-cookie"];

    const initialListResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/setup-tokens",
      headers: {
        cookie: String(cookieHeader),
      },
    });
    expect(initialListResponse.statusCode).toBe(200);
    expect(initialListResponse.json()).toEqual({
      tokens: [],
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/setup-tokens",
      headers: {
        cookie: String(cookieHeader),
      },
      payload: {
        label: "later-token",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toEqual({
      token: expect.objectContaining({
        label: "later-token",
        enabled: true,
      }),
      rawToken: expect.any(String),
    });

    const nextListResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/setup-tokens",
      headers: {
        cookie: String(cookieHeader),
      },
    });
    expect(nextListResponse.statusCode).toBe(200);
    expect(nextListResponse.json()).toEqual({
      tokens: [
        expect.objectContaining({ label: "later-token", enabled: true }),
      ],
    });
  });

  it("returns setupTokensMissing when CLI registration starts before any token exists", async () => {
    delete process.env.CODEXDECK_REMOTE_SETUP_TOKENS;

    const bootstrap = await bootstrapAuth();
    const loginHandle = await deriveRemoteLoginHandle(
      "alice",
      bootstrap.realmId,
    );
    const registrationStart = await startRemoteOpaqueRegistration(
      "correct horse battery staple",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/opaque/register/start",
      payload: {
        setupToken: "setup-a",
        loginHandle,
        machineId: "machine-a",
        registrationRequest: registrationStart.registrationRequest,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: RemoteAuthErrorCode.setupTokensMissing,
      error: "Remote setup tokens are not configured on the server.",
    });
  });

  it("rotates the admin password only when the old password matches", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: {
        password: "admin-secret",
      },
    });
    const cookieHeader = loginResponse.headers["set-cookie"];

    const rejectedRotate = await app.inject({
      method: "POST",
      url: "/v1/admin/password",
      headers: {
        cookie: String(cookieHeader),
      },
      payload: {
        oldPassword: "wrong-password",
        newPassword: "new-admin-secret",
      },
    });
    expect(rejectedRotate.statusCode).toBe(401);
    expect(rejectedRotate.json()).toEqual({
      code: RemoteAuthErrorCode.adminPasswordInvalid,
      error: "Invalid admin password.",
    });

    const rotateResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/password",
      headers: {
        cookie: String(cookieHeader),
      },
      payload: {
        oldPassword: "admin-secret",
        newPassword: "new-admin-secret",
      },
    });
    expect(rotateResponse.statusCode).toBe(200);

    const oldLoginResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: {
        password: "admin-secret",
      },
    });
    expect(oldLoginResponse.statusCode).toBe(401);

    const newLoginResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: {
        password: "new-admin-secret",
      },
    });
    expect(newLoginResponse.statusCode).toBe(200);
  });

  it("returns 410 for retired raw password auth routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      payload: {
        password: "unused",
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error:
        "Raw password auth has been removed. Use the remote login flow in the web app and the current CLI remote registration flow.",
    });
  });

  it("returns 410 for the legacy machine bootstrap endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/machine",
      payload: {
        setupToken: "setup-a",
        loginHandle: "legacy",
        machineId: "machine-a",
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      code: RemoteAuthErrorCode.authUpgradeRequired,
      error:
        "Legacy remote auth has been removed. Re-register the CLI with the current codex-deck version.",
    });
  });
});
