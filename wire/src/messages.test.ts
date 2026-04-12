import { describe, expect, it } from "vitest";
import {
  CoreUpdateContainerSchema,
  MessageContentSchema,
  SessionProtocolMessageSchema,
  UpdateMachineBodySchema,
  UpdateNewMessageBodySchema,
  UpdateSessionBodySchema,
} from "./messages";

describe("shared wire message schemas", () => {
  it("parses a new-message update", () => {
    const parsed = UpdateNewMessageBodySchema.safeParse({
      t: "new-message",
      sid: "session-1",
      message: {
        id: "msg-1",
        seq: 10,
        localId: null,
        content: {
          t: "encrypted",
          c: "ZmFrZS1lbmNyeXB0ZWQ=",
        },
        createdAt: 123,
        updatedAt: 124,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("parses update-session with nullable agentState value", () => {
    const parsed = UpdateSessionBodySchema.safeParse({
      t: "update-session",
      id: "session-1",
      metadata: {
        version: 2,
        value: "abc",
      },
      agentState: {
        version: 3,
        value: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("parses update-machine with optional activity fields", () => {
    const parsed = UpdateMachineBodySchema.safeParse({
      t: "update-machine",
      machineId: "machine-1",
      metadata: {
        version: 1,
        value: "abc",
      },
      daemonState: {
        version: 2,
        value: "def",
      },
      active: true,
      activeAt: 12345,
    });

    expect(parsed.success).toBe(true);
  });

  it("parses container updates for all shared update variants", () => {
    const examples = [
      {
        id: "upd-1",
        seq: 1,
        body: {
          t: "new-message",
          sid: "session-1",
          message: {
            id: "msg-1",
            seq: 1,
            localId: null,
            content: { t: "encrypted", c: "x" },
            createdAt: 1,
            updatedAt: 1,
          },
        },
        createdAt: 1,
      },
      {
        id: "upd-2",
        seq: 2,
        body: {
          t: "update-session",
          id: "session-1",
          metadata: null,
          agentState: {
            version: 1,
            value: null,
          },
        },
        createdAt: 2,
      },
      {
        id: "upd-3",
        seq: 3,
        body: {
          t: "update-machine",
          machineId: "machine-1",
          metadata: null,
          daemonState: null,
        },
        createdAt: 3,
      },
    ];

    for (const sample of examples) {
      expect(CoreUpdateContainerSchema.safeParse(sample).success).toBe(true);
    }
  });

  it("parses modern session protocol wrapper payload", () => {
    const parsed = SessionProtocolMessageSchema.safeParse({
      role: "session",
      content: {
        id: "msg-1",
        time: 1000,
        role: "agent",
        turn: "turn-1",
        ev: {
          t: "text",
          text: "hello",
        },
      },
      meta: {
        sentFrom: "cli",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("parses top-level message content only for session protocol payloads", () => {
    const modernParsed = MessageContentSchema.safeParse({
      role: "session",
      content: {
        id: "msg-2",
        time: 2000,
        role: "agent",
        turn: "turn-2",
        ev: {
          t: "text",
          text: "hello from session protocol",
        },
      },
    });
    const legacyParsed = MessageContentSchema.safeParse({
      role: "user",
      content: {
        type: "text",
        text: "hello from user",
      },
    });

    expect(modernParsed.success).toBe(true);
    expect(legacyParsed.success).toBe(false);
  });
});
