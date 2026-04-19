import assert from "node:assert/strict";
import test from "node:test";
import type {
  TerminalCommandResponse,
  TerminalStreamEvent,
} from "@codex-deck/api";
import {
  connectTerminalSession,
  createBufferedTerminalInputController,
  createTerminalClientId,
} from "../../web/terminal-session-client";

test("createTerminalClientId returns a UUID-like client id", () => {
  assert.match(
    createTerminalClientId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
});

test("buffered terminal input controller blocks input in read-only mode", async () => {
  let sentInput = false;
  let readOnlyAttempts = 0;
  const controller = createBufferedTerminalInputController({
    terminalId: "terminal-1",
    clientId: "client-a",
    isDisposed: () => false,
    getWriteOwnerId: () => "other-client",
    setError: () => {
      assert.fail("read-only attempts should not set an error");
    },
    onReadOnlyAttempt: () => {
      readOnlyAttempts += 1;
    },
    sendInput: async () => {
      sentInput = true;
      return { ok: true } as TerminalCommandResponse;
    },
  });

  controller.queueInput("pwd\n");
  await controller.flush();

  assert.equal(readOnlyAttempts, 1);
  assert.equal(sentInput, false);
});

test("buffered terminal input controller sends immediately when terminal is unowned", async () => {
  const sentInputs: string[] = [];
  let writeOwnerId: string | null = null;
  const controller = createBufferedTerminalInputController({
    terminalId: "terminal-1",
    clientId: "client-a",
    isDisposed: () => false,
    getWriteOwnerId: () => writeOwnerId,
    setError: () => {
      assert.fail("unowned terminal input should not error");
    },
    sendInput: async (_terminalId, request) => {
      sentInputs.push(request.input);
      return { ok: true } as TerminalCommandResponse;
    },
  });

  controller.queueInput("pwd\n");
  await controller.flush();

  assert.deepEqual(sentInputs, ["pwd\n"]);
});

test("buffered terminal input controller reports send failures without replaying stale input", async () => {
  const sentInputs: string[] = [];
  const seenErrors: string[] = [];
  let attempts = 0;
  const controller = createBufferedTerminalInputController({
    terminalId: "terminal-1",
    clientId: "client-a",
    isDisposed: () => false,
    getWriteOwnerId: () => "client-a",
    setError: (message) => {
      seenErrors.push(message);
    },
    sendInput: async (_terminalId, request) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("send failed");
      }
      sentInputs.push(request.input);
      return { ok: true } as TerminalCommandResponse;
    },
  });

  controller.queueInput("ls\n");
  await controller.flush();

  assert.equal(attempts, 1);
  assert.deepEqual(seenErrors, ["send failed"]);
  assert.deepEqual(sentInputs, []);
});

test("connectTerminalSession hydrates from bootstrap stream event and forwards incremental events", async () => {
  const connectedStates: boolean[] = [];
  const seenErrors: Array<string | null> = [];
  const seenEvents: TerminalStreamEvent[] = [];
  let streamHandlers: {
    onEvent: (event: TerminalStreamEvent) => void;
    onError: () => void;
  } | null = null;
  let cleanedUp = false;

  const cleanup = await connectTerminalSession({
    terminalId: "terminal-1",
    clientId: "client-a",
    isDisposed: () => false,
    onBootstrap: (event) => {
      seenEvents.push(event);
    },
    onEvent: (event) => {
      seenEvents.push(event);
    },
    onConnectedChange: (connected) => {
      connectedStates.push(connected);
    },
    onError: (message) => {
      seenErrors.push(message);
    },
    subscribe: ((handlers, options) => {
      streamHandlers = handlers;
      assert.deepEqual(options, {
        terminalId: "terminal-1",
        clientId: "client-a",
        bootstrap: true,
      });
      return () => {
        cleanedUp = true;
      };
    }) as typeof import("../../web/api").subscribeTerminalStream,
  });

  streamHandlers?.onEvent({
    terminalId: "terminal-1",
    seq: 7,
    type: "bootstrap",
    snapshot: {
      id: "terminal-1",
      terminalId: "terminal-1",
      running: true,
      cwd: "/repo",
      shell: "zsh",
      output: "prompt> ",
      seq: 7,
      writeOwnerId: null,
    },
    artifacts: null,
  });

  assert.deepEqual(connectedStates, [true, true]);

  streamHandlers?.onEvent({
    terminalId: "terminal-1",
    seq: 8,
    type: "output",
    chunk: "ok\n",
  });
  streamHandlers?.onError();

  assert.deepEqual(seenErrors, [null, null]);
  assert.deepEqual(seenEvents, [
    {
      terminalId: "terminal-1",
      seq: 7,
      type: "bootstrap",
      snapshot: {
        id: "terminal-1",
        terminalId: "terminal-1",
        running: true,
        cwd: "/repo",
        shell: "zsh",
        output: "prompt> ",
        seq: 7,
        writeOwnerId: null,
      },
      artifacts: null,
    },
    {
      terminalId: "terminal-1",
      seq: 8,
      type: "output",
      chunk: "ok\n",
    },
  ]);
  assert.deepEqual(connectedStates, [true, true, true, false]);

  cleanup();
  assert.equal(cleanedUp, true);
});

test("connectTerminalSession reports stream subscription failures", async () => {
  const connectedStates: boolean[] = [];
  const seenErrors: Array<string | null> = [];

  await connectTerminalSession({
    terminalId: "terminal-1",
    clientId: "client-a",
    isDisposed: () => false,
    onBootstrap: () => {
      assert.fail("bootstrap failure should not emit an event");
    },
    onEvent: () => {
      assert.fail("bootstrap failure should not subscribe");
    },
    onConnectedChange: (connected) => {
      connectedStates.push(connected);
    },
    onError: (message) => {
      seenErrors.push(message);
    },
    subscribe: () => {
      throw new Error("offline");
    },
  });

  assert.deepEqual(connectedStates, [false]);
  assert.deepEqual(seenErrors, ["offline"]);
});
