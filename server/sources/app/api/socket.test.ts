import { AddressInfo } from "node:net";
import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  io as createSocketClient,
  Socket as ClientSocket,
} from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fastify } from "./types";
import { REMOTE_BROWSER_SESSION_COOKIE } from "@/app/auth/remoteAuthConstants";

type MachineRecord = {
  id: string;
  accountId: string;
  metadata: string;
  metadataVersion: number;
  daemonState: string | null;
  daemonStateVersion: number;
  active: boolean;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const {
  state,
  resetState,
  seedMachine,
  authMock,
  activityCacheMock,
  eventRouterMock,
  metricsModuleMock,
  dbMock,
} = vi.hoisted(() => {
  const state = {
    machines: [] as MachineRecord[],
    nextSeq: 0,
    nextTimeMs: 1700000000000,
  };

  const resetState = () => {
    state.machines = [];
    state.nextSeq = 0;
    state.nextTimeMs = 1700000000000;
  };

  const seedMachine = (
    input: Partial<MachineRecord> & Pick<MachineRecord, "id" | "accountId">,
  ) => {
    const createdAt = new Date(state.nextTimeMs++);
    state.machines.push({
      id: input.id,
      accountId: input.accountId,
      metadata: input.metadata ?? "enc-metadata",
      metadataVersion: input.metadataVersion ?? 0,
      daemonState: input.daemonState ?? null,
      daemonStateVersion: input.daemonStateVersion ?? 0,
      active: input.active ?? false,
      lastActiveAt: input.lastActiveAt ?? createdAt,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    });
  };

  const selectFields = <T extends Record<string, unknown>>(
    row: T,
    select?: Record<string, boolean>,
  ) => {
    if (!select) {
      return { ...row };
    }

    const picked: Record<string, unknown> = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) {
        picked[key] = row[key];
      }
    }
    return picked;
  };

  const findMachine = (where: any) =>
    state.machines.find(
      (machine) =>
        (!where?.accountId || machine.accountId === where.accountId) &&
        (!where?.id || machine.id === where.id),
    );

  const dbMock = {
    machine: {
      findFirst: vi.fn(async (args: any) => {
        const machine = findMachine(args?.where);
        if (!machine) {
          return null;
        }
        return selectFields(
          machine as unknown as Record<string, unknown>,
          args?.select,
        );
      }),
      updateMany: vi.fn(async (args: any) => {
        const machine = state.machines.find((item) => {
          if (
            args?.where?.accountId &&
            item.accountId !== args.where.accountId
          ) {
            return false;
          }
          if (args?.where?.id && item.id !== args.where.id) {
            return false;
          }
          if (
            typeof args?.where?.metadataVersion === "number" &&
            item.metadataVersion !== args.where.metadataVersion
          ) {
            return false;
          }
          if (
            typeof args?.where?.daemonStateVersion === "number" &&
            item.daemonStateVersion !== args.where.daemonStateVersion
          ) {
            return false;
          }
          return true;
        });

        if (!machine) {
          return { count: 0 };
        }

        if (
          Object.prototype.hasOwnProperty.call(args?.data ?? {}, "metadata")
        ) {
          machine.metadata = args.data.metadata;
        }
        if (typeof args?.data?.metadataVersion === "number") {
          machine.metadataVersion = args.data.metadataVersion;
        }
        if (
          Object.prototype.hasOwnProperty.call(args?.data ?? {}, "daemonState")
        ) {
          machine.daemonState = args.data.daemonState;
        }
        if (typeof args?.data?.daemonStateVersion === "number") {
          machine.daemonStateVersion = args.data.daemonStateVersion;
        }
        if (typeof args?.data?.active === "boolean") {
          machine.active = args.data.active;
        }
        if (args?.data?.lastActiveAt instanceof Date) {
          machine.lastActiveAt = args.data.lastActiveAt;
        }
        machine.updatedAt = new Date(state.nextTimeMs++);

        return { count: 1 };
      }),
    },
  };

  const authMock = {
    verifyToken: vi.fn(async (token: string) => {
      if (token === "cli-token") {
        return {
          userId: "account-1",
          authVersion: 0,
          extras: {
            clientKind: "cli",
            machineId: "machine-a",
          },
        };
      }
      if (token === "browser-token") {
        return {
          userId: "account-1",
          authVersion: 0,
          extras: {
            clientKind: "browser",
          },
        };
      }
      return null;
    }),
    verifyBrowserSessionToken: vi.fn(async () => null),
  };

  const activityCacheMock = {
    isMachineValid: vi.fn(async (machineId: string, userId: string) =>
      state.machines.some(
        (machine) => machine.id === machineId && machine.accountId === userId,
      ),
    ),
    queueMachineUpdate: vi.fn(),
  };

  const eventRouterMock = {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    emitEphemeral: vi.fn(),
    emitUpdate: vi.fn(),
  };

  const metricsModuleMock = {
    websocketEventsCounter: {
      inc: vi.fn(),
    },
    machineAliveEventsCounter: {
      inc: vi.fn(),
    },
    incrementWebSocketConnection: vi.fn(),
    decrementWebSocketConnection: vi.fn(),
  };

  return {
    state,
    resetState,
    seedMachine,
    authMock,
    activityCacheMock,
    eventRouterMock,
    metricsModuleMock,
    dbMock,
  };
});

vi.mock("@/app/auth/auth", () => ({
  auth: authMock,
}));

vi.mock("@/storage/db", () => ({
  db: dbMock,
}));

vi.mock("@/app/presence/sessionCache", () => ({
  activityCache: activityCacheMock,
}));

vi.mock("@/app/events/eventRouter", () => ({
  eventRouter: eventRouterMock,
  buildMachineActivityEphemeral: vi.fn(
    (machineId: string, active: boolean, time: number) => ({
      machineId,
      active,
      time,
    }),
  ),
  buildUpdateMachineUpdate: vi.fn(
    (
      machineId: string,
      seq: number,
      updateId: string,
      metadataUpdate?: unknown,
      daemonStateUpdate?: unknown,
    ) => ({
      id: updateId,
      seq,
      machineId,
      metadataUpdate,
      daemonStateUpdate,
    }),
  ),
}));

vi.mock("@/storage/seq", () => ({
  allocateUserSeq: vi.fn(async () => {
    state.nextSeq += 1;
    return state.nextSeq;
  }),
}));

vi.mock("@/utils/randomKeyNaked", () => ({
  randomKeyNaked: vi.fn(() => "update-id"),
}));

vi.mock("../monitoring/metrics2", () => metricsModuleMock);
vi.mock("@/app/monitoring/metrics2", () => metricsModuleMock);

vi.mock("@/utils/shutdown", () => ({
  onShutdown: vi.fn(),
}));

vi.mock("./socket/usageHandler", () => ({
  usageHandler: vi.fn(),
}));

vi.mock("./socket/sessionUpdateHandler", () => ({
  sessionUpdateHandler: vi.fn(),
}));

vi.mock("./socket/pingHandler", () => ({
  pingHandler: vi.fn(),
}));

vi.mock("./socket/artifactUpdateHandler", () => ({
  artifactUpdateHandler: vi.fn(),
}));

vi.mock("./socket/accessKeyHandler", () => ({
  accessKeyHandler: vi.fn(),
}));

import { remoteRoutes } from "./routes/remoteRoutes";
import { startSocket } from "./socket";

async function waitFor(delayMs = 25) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

describe("socket authorization", () => {
  let app: Fastify;
  let baseUrl: string;
  let sockets: ClientSocket[] = [];

  beforeEach(async () => {
    resetState();
    authMock.verifyToken.mockClear();
    authMock.verifyBrowserSessionToken.mockClear();
    activityCacheMock.isMachineValid.mockClear();
    activityCacheMock.queueMachineUpdate.mockClear();
    eventRouterMock.addConnection.mockClear();
    eventRouterMock.removeConnection.mockClear();
    eventRouterMock.emitEphemeral.mockClear();
    eventRouterMock.emitUpdate.mockClear();
    metricsModuleMock.websocketEventsCounter.inc.mockClear();
    metricsModuleMock.machineAliveEventsCounter.inc.mockClear();
    metricsModuleMock.incrementWebSocketConnection.mockClear();
    metricsModuleMock.decrementWebSocketConnection.mockClear();
    dbMock.machine.findFirst.mockClear();
    dbMock.machine.updateMany.mockClear();

    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    app = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    app.decorate("authenticate", async (request: any, reply: any) => {
      const authHeader = request.headers.authorization;
      if (authHeader === "Bearer browser-token") {
        request.userId = "account-1";
        request.authContext = {
          authVersion: 0,
          clientKind: "browser",
        };
        return;
      }
      if (authHeader === "Bearer cli-token") {
        request.userId = "account-1";
        request.authContext = {
          authVersion: 0,
          clientKind: "cli",
          machineId: "machine-a",
        };
        return;
      }
      return reply.code(401).send({ error: "Unauthorized" });
    });

    remoteRoutes(app);
    startSocket(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all(
      sockets.map(async (socket) => {
        if (!socket.connected) {
          socket.close();
          return;
        }
        await new Promise<void>((resolve) => {
          socket.once("disconnect", () => resolve());
          socket.disconnect();
        });
      }),
    );
    sockets = [];

    if (app) {
      await app.close();
    }
  });

  async function connectSocket(
    auth: Record<string, unknown>,
    options: { cookie?: string } = {},
  ): Promise<ClientSocket> {
    const socket = createSocketClient(baseUrl, {
      path: "/v1/updates",
      transports: ["websocket"],
      auth,
      reconnection: false,
      ...(options.cookie
        ? {
            extraHeaders: {
              cookie: options.cookie,
            },
          }
        : {}),
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
    });

    return socket;
  }

  it("allows a machine-scoped CLI socket to update its own machine state", async () => {
    seedMachine({
      id: "machine-a",
      accountId: "account-1",
    });

    const machineSocket = await connectSocket({
      token: "cli-token",
      clientType: "machine-scoped",
      machineId: "machine-a",
    });

    eventRouterMock.emitUpdate.mockClear();

    const answer = await machineSocket
      .timeout(500)
      .emitWithAck("machine-update-state", {
        machineId: "machine-a",
        daemonState: "enc-daemon-state",
        expectedVersion: 0,
      });

    expect(answer).toEqual({
      result: "success",
      version: 1,
      daemonState: "enc-daemon-state",
    });
    expect(state.machines[0]?.daemonState).toBe("enc-daemon-state");
    expect(state.machines[0]?.daemonStateVersion).toBe(1);
    expect(eventRouterMock.emitUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects machine updates that target a different machine id", async () => {
    seedMachine({
      id: "machine-a",
      accountId: "account-1",
    });
    seedMachine({
      id: "machine-b",
      accountId: "account-1",
    });

    const machineSocket = await connectSocket({
      token: "cli-token",
      clientType: "machine-scoped",
      machineId: "machine-a",
    });

    eventRouterMock.emitUpdate.mockClear();

    const answer = await machineSocket
      .timeout(500)
      .emitWithAck("machine-update-state", {
        machineId: "machine-b",
        daemonState: "enc-daemon-state",
        expectedVersion: 0,
      });

    expect(answer).toEqual({
      result: "error",
      message: "Machine ID mismatch",
    });
    expect(
      state.machines.find((machine) => machine.id === "machine-b")
        ?.daemonStateVersion,
    ).toBe(0);
    expect(eventRouterMock.emitUpdate).not.toHaveBeenCalled();
  });

  it("does not accept machine events from a user-scoped browser socket", async () => {
    seedMachine({
      id: "machine-a",
      accountId: "account-1",
    });

    const browserSocket = await connectSocket({
      token: "browser-token",
      clientType: "user-scoped",
    });

    eventRouterMock.emitEphemeral.mockClear();
    eventRouterMock.emitUpdate.mockClear();
    activityCacheMock.isMachineValid.mockClear();
    activityCacheMock.queueMachineUpdate.mockClear();

    browserSocket.emit("machine-alive", {
      machineId: "machine-a",
      time: Date.now(),
    });

    await waitFor();

    await expect(
      browserSocket.timeout(150).emitWithAck("machine-update-state", {
        machineId: "machine-a",
        daemonState: "browser-forged-state",
        expectedVersion: 0,
      }),
    ).rejects.toBeTruthy();

    expect(activityCacheMock.isMachineValid).not.toHaveBeenCalled();
    expect(activityCacheMock.queueMachineUpdate).not.toHaveBeenCalled();
    expect(eventRouterMock.emitEphemeral).not.toHaveBeenCalled();
    expect(eventRouterMock.emitUpdate).not.toHaveBeenCalled();
    expect(state.machines[0]?.daemonStateVersion).toBe(0);
  });

  it("keeps remote http bound to the machine-scoped socket", async () => {
    seedMachine({
      id: "machine-a",
      accountId: "account-1",
    });

    const machineSocket = await connectSocket({
      token: "cli-token",
      clientType: "machine-scoped",
      machineId: "machine-a",
    });
    const browserSocket = await connectSocket({
      token: "browser-token",
      clientType: "user-scoped",
    });

    let machineRpcCalls = 0;
    let browserRpcCalls = 0;

    machineSocket.on("rpc-request", (_data, callback) => {
      machineRpcCalls += 1;
      callback({
        result: "machine-response",
        signature: "machine-signature",
        signerPublicKey: "machine-pk",
        signatureVersion: 1,
      });
    });
    browserSocket.on("rpc-request", (_data, callback) => {
      browserRpcCalls += 1;
      callback({
        result: "browser-response",
        signature: "browser-signature",
        signerPublicKey: "browser-pk",
        signatureVersion: 1,
      });
    });

    browserSocket.emit("rpc-register", {
      method: "machine-a:http",
    });
    await waitFor();

    const response = await app.inject({
      method: "POST",
      url: "/v1/remote/http/machine-a",
      headers: {
        authorization: "Bearer browser-token",
      },
      payload: {
        params: "encrypted-request",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      result: "machine-response",
      signature: "machine-signature",
      signerPublicKey: "machine-pk",
      signatureVersion: 1,
    });
    expect(machineRpcCalls).toBe(1);
    expect(browserRpcCalls).toBe(0);
  });

  it("accepts user-scoped websocket auth via cookie when bearer token is stale", async () => {
    (authMock.verifyBrowserSessionToken as any)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async (token: string) => {
        if (token === "browser-cookie-token") {
          return {
            userId: "account-1",
            authVersion: 0,
            extras: {
              clientKind: "browser",
              session: "browser-cookie",
            },
          };
        }
        return null;
      });

    const socket = await connectSocket(
      {
        token: "stale-browser-token",
        clientType: "user-scoped",
      },
      {
        cookie: `${REMOTE_BROWSER_SESSION_COOKIE}=browser-cookie-token`,
      },
    );

    expect(socket.connected).toBe(true);
    expect(authMock.verifyToken).toHaveBeenCalledWith("stale-browser-token");
    expect(authMock.verifyBrowserSessionToken).toHaveBeenNthCalledWith(
      1,
      "stale-browser-token",
    );
    expect(authMock.verifyBrowserSessionToken).toHaveBeenNthCalledWith(
      2,
      "browser-cookie-token",
    );
  });
});
