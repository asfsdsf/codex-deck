import * as z from "zod";

export const RemoteRpcEnvelopeSchema = z.object({
  requestId: z.string(),
  body: z.unknown(),
});
export type RemoteRpcEnvelope = z.infer<typeof RemoteRpcEnvelopeSchema>;

export const RemoteRpcResultEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    requestId: z.string(),
    body: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: z.string(),
    error: z.string(),
  }),
]);
export type RemoteRpcResultEnvelope = z.infer<
  typeof RemoteRpcResultEnvelopeSchema
>;

export const RemoteMachineMetadataSchema = z.object({
  machineId: z.string(),
  label: z.string(),
  host: z.string(),
  platform: z.string(),
  codexDir: z.string(),
  cliVersion: z.string(),
  rpcSigningPublicKey: z.string().min(1),
});
export type RemoteMachineMetadata = z.infer<typeof RemoteMachineMetadataSchema>;

export const RemoteMachineStateSchema = z.object({
  status: z.enum(["running", "offline", "error"]),
  connectedAt: z.number(),
  lastHeartbeatAt: z.number(),
  localWebUrl: z.string().nullable().optional(),
});
export type RemoteMachineState = z.infer<typeof RemoteMachineStateSchema>;

export const RemoteMachineDescriptionSchema = z.object({
  id: z.string(),
  metadata: RemoteMachineMetadataSchema,
  state: RemoteMachineStateSchema.nullable(),
  active: z.boolean(),
  activeAt: z.number(),
});
export type RemoteMachineDescription = z.infer<
  typeof RemoteMachineDescriptionSchema
>;
