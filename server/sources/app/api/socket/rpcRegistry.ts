import type { Socket } from "socket.io";
import { log } from "@/utils/log";

type UserMethodRegistry = Map<string, Socket>;

export interface RegisteredRpcResponse {
  result: string;
  signature: string;
  signerPublicKey: string;
  signatureVersion: 1;
}

const rpcListenersByUser = new Map<string, UserMethodRegistry>();
const REMOTE_RPC_TIMING_LOG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.CODEXDECK_REMOTE_RPC_TIMING_LOG ?? "",
);

function getUserRegistry(userId: string): UserMethodRegistry {
  let registry = rpcListenersByUser.get(userId);
  if (!registry) {
    registry = new Map<string, Socket>();
    rpcListenersByUser.set(userId, registry);
  }
  return registry;
}

export function registerRpcMethod(
  userId: string,
  method: string,
  socket: Socket,
): void {
  getUserRegistry(userId).set(method, socket);
}

export function unregisterRpcMethod(
  userId: string,
  method: string,
  socket: Socket,
): void {
  const registry = rpcListenersByUser.get(userId);
  if (!registry) {
    return;
  }
  if (registry.get(method) !== socket) {
    return;
  }
  registry.delete(method);
  if (registry.size === 0) {
    rpcListenersByUser.delete(userId);
  }
}

export function unregisterSocket(userId: string, socket: Socket): void {
  const registry = rpcListenersByUser.get(userId);
  if (!registry) {
    return;
  }
  for (const [method, registeredSocket] of registry.entries()) {
    if (registeredSocket === socket) {
      registry.delete(method);
    }
  }
  if (registry.size === 0) {
    rpcListenersByUser.delete(userId);
  }
}

export async function callRegisteredRpc(
  userId: string,
  method: string,
  params: string,
): Promise<RegisteredRpcResponse> {
  const registry = rpcListenersByUser.get(userId);
  const targetSocket = registry?.get(method);

  if (!targetSocket || !targetSocket.connected) {
    throw new Error("RPC method not available");
  }

  const startedAt = Date.now();
  const response = await targetSocket
    .timeout(30000)
    .emitWithAck("rpc-request", {
      method,
      params,
    });
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    typeof (response as { result?: unknown }).result !== "string" ||
    typeof (response as { signature?: unknown }).signature !== "string" ||
    typeof (response as { signerPublicKey?: unknown }).signerPublicKey !==
      "string" ||
    (response as { signatureVersion?: unknown }).signatureVersion !== 1
  ) {
    throw new Error("Invalid RPC response envelope");
  }
  const parsedResponse = response as RegisteredRpcResponse;
  if (REMOTE_RPC_TIMING_LOG_ENABLED) {
    log(
      {
        module: "remote-rpc-timing",
        phase: "socket-ack",
        userId,
        method,
        ackMs: Date.now() - startedAt,
        requestBytes: params.length,
        responseBytes: parsedResponse.result.length,
      },
      "Remote RPC ack received",
    );
  }
  return parsedResponse;
}
