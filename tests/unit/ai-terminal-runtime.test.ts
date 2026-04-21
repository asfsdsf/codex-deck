import assert from "node:assert/strict";
import test from "node:test";
import type {
  TerminalCommandResponse,
  TerminalInputResponse,
  TerminalPersistMessageActionResponse,
} from "@codex-deck/api";
import {
  cleanLiveAiTerminalExecutionOutput,
  runApprovedAiTerminalStepInTerminal,
} from "../../web/ai-terminal-runtime";

test("cleanLiveAiTerminalExecutionOutput drops wrapper echo noise before visible output", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-1",
      command: "pwd",
      cwd: "/repo",
    },
    ["(base) codex-deck » pwd", "/repo", "(base) codex-deck »"].join("\n"),
  );

  assert.equal(cleaned, "/repo");
});

test("cleanLiveAiTerminalExecutionOutput preserves literal marker-like output", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-3",
      command: "cat build.log",
      cwd: "/repo",
    },
    [
      "(base) codex-deck » cat build.log",
      "__CODEX_DECK_AI_RESULT__ should stay visible now",
      "(base) codex-deck »",
    ].join("\n"),
  );

  assert.equal(cleaned, "__CODEX_DECK_AI_RESULT__ should stay visible now");
});

test("cleanLiveAiTerminalExecutionOutput keeps meaningful output after prompt fragments", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-2",
      command: "find . -maxdepth 1 -type f",
      cwd: "/repo",
    },
    [
      "(base) codex-deck » find . -maxdepth 1 -type f",
      "README.md",
      "package.json",
      "(base) codex-deck »",
    ].join("\n"),
  );

  assert.equal(cleaned, "README.md\npackage.json");
});

test("runApprovedAiTerminalStepInTerminal sends the approved command and persists approval", async () => {
  const calls: string[] = [];

  const result = await runApprovedAiTerminalStepInTerminal(
    {
      sessionId: "session-1",
      terminalId: "terminal-1",
      messageKey: "message-1",
      step: {
        stepId: "step-1",
        command: "pnpm test",
      },
    },
    {
      createClientId: () => "client-1",
      sendTerminalInput: async (terminalId, request, clientId) => {
        calls.push(
          `send:${terminalId}:${request.input.replace("\n", "\\n")}:${clientId ?? "none"}`,
        );
        return {
          ok: true,
          startSeq: 12,
          startOffset: 4,
        } as TerminalInputResponse;
      },
      claimTerminalWrite: async () => {
        calls.push("claim");
        return { ok: true } as TerminalCommandResponse;
      },
      releaseTerminalWrite: async () => {
        calls.push("release");
        return { ok: true } as TerminalCommandResponse;
      },
      persistTerminalMessageAction: async (terminalId, request) => {
        calls.push(
          `persist:${terminalId}:${request.sessionId}:${request.messageKey}:${request.stepId}:${request.decision}:${request.reason ?? "null"}`,
        );
        return {
          terminalId,
          sessionId: request.sessionId,
          messageKey: request.messageKey,
          stepActions: [],
        } as TerminalPersistMessageActionResponse;
      },
    },
  );

  assert.equal(result.actionPersistError, null);
  assert.deepEqual(calls, [
    "send:terminal-1:pnpm test\r:client-1",
    "persist:terminal-1:session-1:message-1:step-1:approved:null",
  ]);
});

test("runApprovedAiTerminalStepInTerminal reuses the active terminal client id when provided", async () => {
  const calls: string[] = [];

  const result = await runApprovedAiTerminalStepInTerminal(
    {
      sessionId: "session-active-client",
      terminalId: "terminal-active-client",
      messageKey: "message-active-client",
      clientId: "terminal-pane-client",
      step: {
        stepId: "step-active-client",
        command: "pwd",
      },
    },
    {
      createClientId: () => {
        throw new Error(
          "createClientId should not be used when clientId is provided",
        );
      },
      sendTerminalInput: async (terminalId, request, clientId) => {
        calls.push(
          `send:${terminalId}:${request.input.replace("\n", "\\n")}:${clientId ?? "none"}`,
        );
        return {
          ok: true,
          startSeq: 18,
          startOffset: 0,
        } as TerminalInputResponse;
      },
      claimTerminalWrite: async () => {
        calls.push("claim");
        return { ok: true } as TerminalCommandResponse;
      },
      releaseTerminalWrite: async () => {
        calls.push("release");
        return { ok: true } as TerminalCommandResponse;
      },
      persistTerminalMessageAction: async (terminalId, request) => {
        calls.push(`persist:${terminalId}:${request.decision}`);
        return {
          terminalId,
          sessionId: request.sessionId,
          messageKey: request.messageKey,
          stepActions: [],
        } as TerminalPersistMessageActionResponse;
      },
    },
  );

  assert.equal(result.actionPersistError, null);
  assert.deepEqual(calls, [
    "send:terminal-active-client:pwd\r:terminal-pane-client",
    "persist:terminal-active-client:approved",
  ]);
});

test("runApprovedAiTerminalStepInTerminal claims and releases terminal write when required", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const result = await runApprovedAiTerminalStepInTerminal(
    {
      sessionId: "session-2",
      terminalId: "terminal-2",
      messageKey: "message-2",
      step: {
        stepId: "step-2",
        command: "git status",
      },
    },
    {
      createClientId: () => "client-2",
      sendTerminalInput: async (terminalId, request, clientId) => {
        attempts += 1;
        calls.push(
          `send:${attempts}:${terminalId}:${request.input.replace("\n", "\\n")}:${clientId ?? "none"}`,
        );
        if (attempts === 1) {
          throw new Error("another client owns terminal write");
        }
        return {
          ok: true,
          startSeq: 20,
          startOffset: 0,
        } as TerminalInputResponse;
      },
      claimTerminalWrite: async (terminalId, clientId) => {
        calls.push(`claim:${terminalId}:${clientId}`);
        return { ok: true } as TerminalCommandResponse;
      },
      releaseTerminalWrite: async (terminalId, clientId) => {
        calls.push(`release:${terminalId}:${clientId}`);
        return { ok: true } as TerminalCommandResponse;
      },
      persistTerminalMessageAction: async (terminalId, request) => {
        calls.push(`persist:${terminalId}:${request.decision}`);
        return {
          terminalId,
          sessionId: request.sessionId,
          messageKey: request.messageKey,
          stepActions: [],
        } as TerminalPersistMessageActionResponse;
      },
    },
  );

  assert.equal(result.actionPersistError, null);
  assert.deepEqual(calls, [
    "send:1:terminal-2:git status\r:client-2",
    "claim:terminal-2:client-2",
    "send:2:terminal-2:git status\r:client-2",
    "release:terminal-2:client-2",
    "persist:terminal-2:approved",
  ]);
});

test("runApprovedAiTerminalStepInTerminal brackets approved paste input when the terminal supports it", async () => {
  const calls: string[] = [];

  const result = await runApprovedAiTerminalStepInTerminal(
    {
      sessionId: "session-3",
      terminalId: "terminal-3",
      messageKey: "message-3",
      bracketedPasteMode: true,
      step: {
        stepId: "step-3",
        command:
          "find . -type f -exec stat -f '%z %N' {} + | sort -nr | head -n 100\"\"",
      },
    },
    {
      createClientId: () => "client-3",
      sendTerminalInput: async (terminalId, request, clientId) => {
        calls.push(`send:${terminalId}:${request.input}:${clientId ?? "none"}`);
        return {
          ok: true,
          startSeq: 30,
          startOffset: 0,
        } as TerminalInputResponse;
      },
      claimTerminalWrite: async () => {
        assert.fail(
          "approved bracketed paste should not need claim in this test",
        );
      },
      releaseTerminalWrite: async () => {
        assert.fail(
          "approved bracketed paste should not need release in this test",
        );
      },
      persistTerminalMessageAction: async (terminalId, request) => {
        calls.push(`persist:${terminalId}:${request.decision}`);
        return {
          terminalId,
          sessionId: request.sessionId,
          messageKey: request.messageKey,
          stepActions: [],
        } as TerminalPersistMessageActionResponse;
      },
    },
  );

  assert.equal(result.actionPersistError, null);
  assert.deepEqual(calls, [
    "send:terminal-3:\u001b[200~find . -type f -exec stat -f '%z %N' {} + | sort -nr | head -n 100\"\"\u001b[201~\r:client-3",
    "persist:terminal-3:approved",
  ]);
});
