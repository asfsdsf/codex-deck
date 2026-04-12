import { describe, expect, it } from "vitest";
import {
  RemoteMachineDescriptionSchema,
  RemoteRpcEnvelopeSchema,
  RemoteRpcResultEnvelopeSchema,
} from "./remote-protocol";

describe("remote-protocol", () => {
  it("parses remote RPC envelopes", () => {
    const parsed = RemoteRpcEnvelopeSchema.parse({
      requestId: "req-1",
      body: {
        method: "GET",
        path: "/api/projects",
      },
    });

    expect(parsed.requestId).toBe("req-1");
  });

  it("parses success and error RPC results", () => {
    const success = RemoteRpcResultEnvelopeSchema.parse({
      ok: true,
      requestId: "req-1",
      body: { status: 200 },
    });
    const failure = RemoteRpcResultEnvelopeSchema.parse({
      ok: false,
      requestId: "req-2",
      error: "boom",
    });

    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });

  it("parses remote machine descriptions", () => {
    const parsed = RemoteMachineDescriptionSchema.parse({
      id: "machine-a",
      metadata: {
        machineId: "machine-a",
        label: "MacBook",
        host: "macbook.local",
        platform: "darwin",
        codexDir: "/Users/test/.codex",
        cliVersion: "0.3.0",
        rpcSigningPublicKey: "pk",
      },
      state: {
        status: "running",
        connectedAt: 1,
        lastHeartbeatAt: 2,
        localWebUrl: null,
      },
      active: true,
      activeAt: 2,
    });

    expect(parsed.metadata.platform).toBe("darwin");
  });
});
