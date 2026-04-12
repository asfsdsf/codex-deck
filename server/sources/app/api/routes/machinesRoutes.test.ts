import fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fastify } from "../types";

type MachineRecord = {
  id: string;
  accountId: string;
  metadata: string;
  metadataVersion: number;
  daemonState: string | null;
  daemonStateVersion: number;
  dataEncryptionKey: Uint8Array | null;
  seq: number;
  active: boolean;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const { state, resetState, seedMachine, eventRouterMock, dbMock } = vi.hoisted(
  () => {
    const state = {
      machines: [] as MachineRecord[],
      nextSeq: 1,
      nextTimeMs: 1700000000000,
    };

    const resetState = () => {
      state.machines = [];
      state.nextSeq = 1;
      state.nextTimeMs = 1700000000000;
    };

    const seedMachine = (
      input: Partial<MachineRecord> & Pick<MachineRecord, "id" | "accountId">,
    ) => {
      const createdAt = new Date(state.nextTimeMs++);
      const machine: MachineRecord = {
        id: input.id,
        accountId: input.accountId,
        metadata: input.metadata ?? "enc-metadata-old",
        metadataVersion: input.metadataVersion ?? 1,
        daemonState: input.daemonState ?? "enc-daemon-old",
        daemonStateVersion: input.daemonStateVersion ?? 1,
        dataEncryptionKey: input.dataEncryptionKey ?? null,
        seq: input.seq ?? 0,
        active: input.active ?? false,
        lastActiveAt: input.lastActiveAt ?? createdAt,
        createdAt,
        updatedAt: input.updatedAt ?? createdAt,
      };
      state.machines.push(machine);
      return machine;
    };

    const cloneMachine = (machine: MachineRecord): MachineRecord => ({
      ...machine,
      dataEncryptionKey: machine.dataEncryptionKey
        ? new Uint8Array(machine.dataEncryptionKey)
        : null,
      lastActiveAt: new Date(machine.lastActiveAt.getTime()),
      createdAt: new Date(machine.createdAt.getTime()),
      updatedAt: new Date(machine.updatedAt.getTime()),
    });

    const dbMock = {
      machine: {
        findFirst: vi.fn(async (args: any) => {
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
            return true;
          });
          return machine ? cloneMachine(machine) : null;
        }),
        create: vi.fn(async (args: any) => {
          const now = new Date(state.nextTimeMs++);
          const machine: MachineRecord = {
            id: args.data.id,
            accountId: args.data.accountId,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 0,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            seq: args.data.seq ?? 0,
            active: args.data.active ?? true,
            lastActiveAt: args.data.lastActiveAt ?? now,
            createdAt: now,
            updatedAt: now,
          };
          state.machines.push(machine);
          return cloneMachine(machine);
        }),
        update: vi.fn(async (args: any) => {
          const machine = state.machines.find(
            (item) => item.id === args?.where?.id,
          );
          if (!machine) {
            throw new Error(`Machine not found: ${args?.where?.id}`);
          }

          if (typeof args?.data?.metadata === "string") {
            machine.metadata = args.data.metadata;
          }
          if (typeof args?.data?.metadataVersion?.increment === "number") {
            machine.metadataVersion += args.data.metadataVersion.increment;
          }
          if (
            Object.prototype.hasOwnProperty.call(
              args?.data ?? {},
              "daemonState",
            )
          ) {
            machine.daemonState = args.data.daemonState;
          }
          if (typeof args?.data?.daemonStateVersion?.increment === "number") {
            machine.daemonStateVersion +=
              args.data.daemonStateVersion.increment;
          }
          if (
            Object.prototype.hasOwnProperty.call(
              args?.data ?? {},
              "dataEncryptionKey",
            )
          ) {
            machine.dataEncryptionKey = args.data.dataEncryptionKey;
          }
          if (typeof args?.data?.active === "boolean") {
            machine.active = args.data.active;
          }
          if (args?.data?.lastActiveAt instanceof Date) {
            machine.lastActiveAt = args.data.lastActiveAt;
          }
          machine.updatedAt = new Date(state.nextTimeMs++);

          return cloneMachine(machine);
        }),
        findMany: vi.fn(async (args: any) => {
          const machines = state.machines
            .filter((item) => item.accountId === args?.where?.accountId)
            .sort(
              (a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime(),
            );
          return machines.map((machine) => cloneMachine(machine));
        }),
      },
    };

    const eventRouterMock = {
      emitUpdate: vi.fn(),
    };

    return {
      state,
      resetState,
      seedMachine,
      eventRouterMock,
      dbMock,
    };
  },
);

vi.mock("@/storage/db", () => ({
  db: dbMock,
}));

vi.mock("@/app/events/eventRouter", () => ({
  eventRouter: eventRouterMock,
  buildNewMachineUpdate: vi.fn(() => ({ type: "new-machine-update" })),
  buildUpdateMachineUpdate: vi.fn(
    (
      machineId: string,
      seq: number,
      updateId: string,
      metadata?: { value: string; version: number },
      daemonState?: { value: string; version: number },
    ) => ({
      id: updateId,
      seq,
      body: {
        t: "update-machine",
        machineId,
        metadata,
        daemonState,
      },
    }),
  ),
}));

vi.mock("@/storage/seq", () => ({
  allocateUserSeq: vi.fn(async () => state.nextSeq++),
}));

vi.mock("@/utils/randomKeyNaked", () => ({
  randomKeyNaked: vi.fn(() => "update-id"),
}));

import { machinesRoutes } from "./machinesRoutes";

describe("machinesRoutes", () => {
  let app: Fastify;

  beforeEach(async () => {
    resetState();
    eventRouterMock.emitUpdate.mockClear();
    dbMock.machine.findFirst.mockClear();
    dbMock.machine.create.mockClear();
    dbMock.machine.update.mockClear();
    dbMock.machine.findMany.mockClear();

    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    app = instance.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    app.decorate("authenticate", async function (request: any) {
      request.userId = "account-1";
      request.authContext = {
        clientKind: "cli",
        machineId: "machine-a",
      };
    });
    machinesRoutes(app);
    await app.ready();
  });

  it("refreshes existing machine ciphertext on re-registration", async () => {
    seedMachine({
      id: "machine-a",
      accountId: "account-1",
      metadata: "enc-metadata-old",
      metadataVersion: 3,
      daemonState: "enc-daemon-old",
      daemonStateVersion: 7,
      active: false,
      lastActiveAt: new Date(1700000000000),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/machines",
      payload: {
        id: "machine-a",
        metadata: "enc-metadata-new",
        daemonState: "enc-daemon-new",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      machine: {
        id: "machine-a",
        metadata: "enc-metadata-new",
        metadataVersion: 4,
        daemonState: "enc-daemon-new",
        daemonStateVersion: 8,
        active: true,
      },
    });

    expect(state.machines).toHaveLength(1);
    expect(state.machines[0]).toMatchObject({
      id: "machine-a",
      metadata: "enc-metadata-new",
      metadataVersion: 4,
      daemonState: "enc-daemon-new",
      daemonStateVersion: 8,
      active: true,
    });
    expect(state.machines[0]!.updatedAt.getTime()).toBeGreaterThan(
      state.machines[0]!.createdAt.getTime(),
    );

    expect(dbMock.machine.update).toHaveBeenCalledTimes(1);
    expect(eventRouterMock.emitUpdate).toHaveBeenCalledTimes(1);
    expect(eventRouterMock.emitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "account-1",
        recipientFilter: {
          type: "machine-scoped-only",
          machineId: "machine-a",
        },
        payload: expect.objectContaining({
          body: {
            t: "update-machine",
            machineId: "machine-a",
            metadata: {
              value: "enc-metadata-new",
              version: 4,
            },
            daemonState: {
              value: "enc-daemon-new",
              version: 8,
            },
          },
        }),
      }),
    );
  });
});
