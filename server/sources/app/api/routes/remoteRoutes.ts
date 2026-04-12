import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { callRegisteredRpc } from "@/app/api/socket/rpcRegistry";
import { log } from "@/utils/log";

const REMOTE_RPC_TIMING_LOG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.CODEXDECK_REMOTE_RPC_TIMING_LOG ?? "",
);

export function remoteRoutes(app: Fastify) {
  app.post(
    "/v1/remote/http/:machineId",
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({
          machineId: z.string(),
        }),
        body: z.object({
          params: z.string(),
        }),
        response: {
          200: z.object({
            ok: z.literal(true),
            result: z.string(),
            signature: z.string(),
            signerPublicKey: z.string(),
            signatureVersion: z.literal(1),
          }),
          404: z.object({
            ok: z.literal(false),
            error: z.string(),
          }),
          503: z.object({
            ok: z.literal(false),
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { machineId } = request.params;
      const requestStartedAt = Date.now();
      const requestBytes =
        typeof request.body.params === "string"
          ? request.body.params.length
          : 0;

      const lookupStartedAt = Date.now();
      const machine = await db.machine.findFirst({
        where: {
          accountId: request.userId,
          id: machineId,
        },
        select: { id: true },
      });
      const lookupMs = Date.now() - lookupStartedAt;
      if (!machine) {
        if (REMOTE_RPC_TIMING_LOG_ENABLED) {
          log(
            {
              module: "remote-rpc-timing",
              phase: "machine-lookup",
              userId: request.userId,
              machineId,
              lookupMs,
              totalMs: Date.now() - requestStartedAt,
              requestBytes,
              status: 404,
            },
            "Remote relay rejected unknown machine",
          );
        }
        return reply.code(404).send({
          ok: false,
          error: "Machine not found",
        });
      }

      try {
        const rpcStartedAt = Date.now();
        const result = await callRegisteredRpc(
          request.userId,
          `${machineId}:http`,
          request.body.params,
        );
        const rpcMs = Date.now() - rpcStartedAt;
        if (REMOTE_RPC_TIMING_LOG_ENABLED) {
          log(
            {
              module: "remote-rpc-timing",
              phase: "relay-success",
              userId: request.userId,
              machineId,
              lookupMs,
              rpcMs,
              totalMs: Date.now() - requestStartedAt,
              requestBytes,
              responseBytes: result.result.length,
              status: 200,
            },
            "Remote relay completed",
          );
        }
        return reply.send({
          ok: true,
          result: result.result,
          signature: result.signature,
          signerPublicKey: result.signerPublicKey,
          signatureVersion: result.signatureVersion,
        });
      } catch (error) {
        if (REMOTE_RPC_TIMING_LOG_ENABLED) {
          log(
            {
              module: "remote-rpc-timing",
              phase: "relay-failure",
              userId: request.userId,
              machineId,
              lookupMs,
              totalMs: Date.now() - requestStartedAt,
              requestBytes,
              status: 503,
              error: error instanceof Error ? error.message : String(error),
            },
            "Remote relay failed",
          );
        }
        return reply.code(503).send({
          ok: false,
          error:
            error instanceof Error ? error.message : "Remote RPC unavailable",
        });
      }
    },
  );
}
