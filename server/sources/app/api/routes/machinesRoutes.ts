import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import {
  buildNewMachineUpdate,
  buildUpdateMachineUpdate,
} from "@/app/events/eventRouter";

function encodeDataEncryptionKey(
  dataEncryptionKey: Uint8Array | null,
): string | null {
  return dataEncryptionKey
    ? Buffer.from(dataEncryptionKey).toString("base64")
    : null;
}

function toMachineResponse(machine: {
  id: string;
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
}) {
  return {
    id: machine.id,
    metadata: machine.metadata,
    metadataVersion: machine.metadataVersion,
    daemonState: machine.daemonState,
    daemonStateVersion: machine.daemonStateVersion,
    dataEncryptionKey: encodeDataEncryptionKey(machine.dataEncryptionKey),
    seq: machine.seq,
    active: machine.active,
    activeAt: machine.lastActiveAt.getTime(),
    createdAt: machine.createdAt.getTime(),
    updatedAt: machine.updatedAt.getTime(),
  };
}

export function machinesRoutes(app: Fastify) {
  app.post(
    "/v1/machines",
    {
      preHandler: app.authenticate,
      schema: {
        body: z.object({
          id: z.string(),
          metadata: z.string(), // Encrypted metadata
          daemonState: z.string().optional(), // Encrypted daemon state
          dataEncryptionKey: z.string().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.userId;
      const { id, metadata, daemonState, dataEncryptionKey } = request.body;
      const hasDataEncryptionKey = Object.prototype.hasOwnProperty.call(
        request.body,
        "dataEncryptionKey",
      );
      const decodedDataEncryptionKey = hasDataEncryptionKey
        ? dataEncryptionKey
          ? new Uint8Array(Buffer.from(dataEncryptionKey, "base64"))
          : null
        : undefined;

      if (
        request.authContext?.clientKind === "cli" &&
        request.authContext.machineId &&
        request.authContext.machineId !== id
      ) {
        return reply
          .code(403)
          .send({ error: "CLI token is bound to a different machine" });
      }

      // Check if machine exists (like sessions do)
      const machine = await db.machine.findFirst({
        where: {
          accountId: userId,
          id: id,
        },
      });

      if (machine) {
        // Machine exists - refresh encrypted fields so re-registered CLIs do
        // not leave stale ciphertext behind on the server.
        log(
          { module: "machines", machineId: id, userId },
          "Refreshing existing machine",
        );
        const refreshedMachine = await db.machine.update({
          where: { id: machine.id },
          data: {
            metadata,
            metadataVersion: {
              increment: 1,
            },
            ...(daemonState !== undefined
              ? {
                  daemonState,
                  daemonStateVersion: {
                    increment: 1,
                  },
                  active: true,
                  lastActiveAt: new Date(),
                }
              : {}),
            ...(hasDataEncryptionKey
              ? {
                  dataEncryptionKey: decodedDataEncryptionKey ?? null,
                }
              : {}),
          },
        });

        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildUpdateMachineUpdate(
          refreshedMachine.id,
          updSeq,
          randomKeyNaked(12),
          {
            value: refreshedMachine.metadata,
            version: refreshedMachine.metadataVersion,
          },
          daemonState !== undefined && refreshedMachine.daemonState
            ? {
                value: refreshedMachine.daemonState,
                version: refreshedMachine.daemonStateVersion,
              }
            : undefined,
        );
        eventRouter.emitUpdate({
          userId,
          payload: updatePayload,
          recipientFilter: {
            type: "machine-scoped-only",
            machineId: refreshedMachine.id,
          },
        });

        return reply.send({
          machine: toMachineResponse(refreshedMachine),
        });
      } else {
        // Create new machine
        log(
          { module: "machines", machineId: id, userId },
          "Creating new machine",
        );

        const newMachine = await db.machine.create({
          data: {
            id,
            accountId: userId,
            metadata,
            metadataVersion: 1,
            daemonState: daemonState || null,
            daemonStateVersion: daemonState ? 1 : 0,
            dataEncryptionKey: decodedDataEncryptionKey,
            // Default to offline - in case the user does not start daemon
            active: false,
            // lastActiveAt and activeAt defaults to now() in schema
          },
        });

        // Emit both new-machine and update-machine events for backward compatibility
        const updSeq1 = await allocateUserSeq(userId);
        const updSeq2 = await allocateUserSeq(userId);

        // Emit new-machine event with all data including dataEncryptionKey
        const newMachinePayload = buildNewMachineUpdate(
          newMachine,
          updSeq1,
          randomKeyNaked(12),
        );
        eventRouter.emitUpdate({
          userId,
          payload: newMachinePayload,
          recipientFilter: { type: "user-scoped-only" },
        });

        // Emit update-machine event for backward compatibility (without dataEncryptionKey)
        const machineMetadata = {
          version: 1,
          value: metadata,
        };
        const updatePayload = buildUpdateMachineUpdate(
          newMachine.id,
          updSeq2,
          randomKeyNaked(12),
          machineMetadata,
        );
        eventRouter.emitUpdate({
          userId,
          payload: updatePayload,
          recipientFilter: {
            type: "machine-scoped-only",
            machineId: newMachine.id,
          },
        });

        return reply.send({
          machine: toMachineResponse(newMachine),
        });
      }
    },
  );

  // Machines API
  app.get(
    "/v1/machines",
    {
      preHandler: app.authenticate,
    },
    async (request, reply) => {
      const userId = request.userId;

      const machines = await db.machine.findMany({
        where: { accountId: userId },
        orderBy: { lastActiveAt: "desc" },
      });

      return machines.map((m) => toMachineResponse(m));
    },
  );

  // GET /v1/machines/:id - Get single machine by ID
  app.get(
    "/v1/machines/:id",
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({
          id: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const userId = request.userId;
      const { id } = request.params;

      const machine = await db.machine.findFirst({
        where: {
          accountId: userId,
          id: id,
        },
      });

      if (!machine) {
        return reply.code(404).send({ error: "Machine not found" });
      }

      return {
        machine: toMachineResponse(machine),
      };
    },
  );
}
