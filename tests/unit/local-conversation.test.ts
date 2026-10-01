import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationStreamBatch } from "../../web/transport/types";
import { subscribeLocalConversation } from "../../web/transport/local-conversation";
import { responseItemMessageLine, waitFor } from "./test-utils";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  emit(name: string, payload: unknown) {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data: JSON.stringify(payload) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

function windowResponse(
  text: string,
  startSequence: number,
  fileId = "file-1",
) {
  const payload = JSON.parse(text.trim()).payload;
  return new Response(
    JSON.stringify({
      messages: [
        {
          type: payload.role,
          sequence: startSequence || 1,
          messageNumber: startSequence || 1,
          revision: 1,
          uuid: `message-${startSequence || 1}`,
          message: { role: payload.role, content: payload.content },
        },
      ],
      historyStartSequence: startSequence,
      nextOffset: 1,
      done: true,
      fileId,
      totalMessages: startSequence || 1,
    }),
  );
}

function installMocks(fetch: typeof globalThis.fetch) {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  globalThis.fetch = fetch;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  return () => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  };
}

test("local conversations show the tail first and receive live updates during history backfill", async () => {
  const older = `${responseItemMessageLine("user", "Older question")}\n`;
  const latest = `${responseItemMessageLine("assistant", "Recent answer")}\n`;
  const tailStart = Buffer.byteLength(older);
  const batches: ConversationStreamBatch[] = [];
  let resolveBackfill: ((response: Response) => void) | undefined;
  const restore = installMocks(async (input) => {
    const url = String(input);
    if (!url.includes("beforeSequence="))
      return windowResponse(latest, tailStart);
    assert.ok(url.includes(`beforeSequence=${tailStart}`));
    return new Promise<Response>((resolve) => {
      resolveBackfill = resolve;
    });
  });
  const unsubscribe = subscribeLocalConversation(
    "session-1",
    {
      onMessages: (_, batch) => {
        if (batch) batches.push(batch);
      },
    },
    {},
  );
  try {
    await waitFor(() => resolveBackfill !== undefined);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.phase, "bootstrap");
    assert.equal(batches[0]?.done, true);
    assert.equal(batches[0]?.historyStartSequence, tailStart);
    const stream = MockEventSource.instances[0]!;
    assert.ok(stream.url.includes("offset=1&numbered=true"));
    assert.ok(stream.url.includes("fileId=file-1"));
    stream.emit("messages", {
      messages: [{ type: "assistant", uuid: "live-message" }],
      nextOffset: 1000,
      done: true,
      fileId: "file-1",
    });
    assert.equal(batches[1]?.insertion, "append");
    stream.emit("messages", {
      messages: [],
      nextOffset: 900,
      done: true,
      fileId: "file-1",
    });
    assert.equal(batches[2]?.nextOffset, 1000);
    resolveBackfill!(windowResponse(older, 0));
    await waitFor(() => batches.length === 4);
    assert.equal(batches[3]?.insertion, "prepend");
    assert.equal(batches[3]?.historyStartSequence, 0);
    assert.equal(batches[3]?.nextOffset, 1000);
    assert.equal(batches[3]?.messages.length, 1);
  } finally {
    unsubscribe();
    restore();
  }
});

test("local conversation cleanup aborts and ignores a pending bootstrap", async () => {
  let resolveRequest: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const restore = installMocks(async (_, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
  });
  try {
    const unsubscribe = subscribeLocalConversation(
      "session-1",
      {
        onMessages: () => {
          calls += 1;
        },
      },
      {},
    );
    unsubscribe();
    assert.equal(signal?.aborted, true);
    resolveRequest!(
      windowResponse(
        `${responseItemMessageLine("user", "Late response")}\n`,
        0,
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(MockEventSource.instances.length, 0);
  } finally {
    restore();
  }
});

test("local conversations resume unfinished backfill from the saved history cursor", async () => {
  const older = `${responseItemMessageLine("user", "Older question")}\n`;
  const batches: ConversationStreamBatch[] = [];
  const restore = installMocks(async (input) => {
    assert.ok(String(input).includes("beforeSequence=200"));
    return windowResponse(older, 0);
  });
  const unsubscribe = subscribeLocalConversation(
    "session-1",
    {
      onMessages: (_, batch) => {
        if (batch) batches.push(batch);
      },
    },
    {
      initialOffset: 1000,
      initialHistoryStartSequence: 200,
      initialFileId: "file-1",
    },
  );
  try {
    assert.equal(MockEventSource.instances.length, 1);
    await waitFor(() => batches.length === 1);
    assert.equal(batches[0]?.phase, "incremental");
    assert.equal(batches[0]?.nextOffset, 1000);
    assert.equal(batches[0]?.historyStartSequence, 0);
  } finally {
    unsubscribe();
    restore();
  }
});

test("a file replacement discards stale backfill and bootstraps the new conversation", async () => {
  const tail = `${responseItemMessageLine("assistant", "Recent answer")}\n`;
  let resolveBackfill: ((response: Response) => void) | undefined;
  let tailRequests = 0;
  let resets = 0;
  const batches: ConversationStreamBatch[] = [];
  const restore = installMocks(async (input) => {
    if (String(input).includes("beforeSequence="))
      return new Promise<Response>((resolve) => {
        resolveBackfill = resolve;
      });
    tailRequests += 1;
    return windowResponse(
      tail,
      tailRequests === 1 ? 500 : 0,
      `file-${tailRequests}`,
    );
  });
  const unsubscribe = subscribeLocalConversation(
    "session-1",
    {
      onMessages: (_, batch) => {
        if (batch) batches.push(batch);
      },
      onReset: () => {
        resets += 1;
      },
    },
    {},
  );
  try {
    await waitFor(() => resolveBackfill !== undefined);
    MockEventSource.instances[0]!.emit("reset", {});
    await waitFor(() => batches.length === 2);
    resolveBackfill!(windowResponse(tail, 0, "file-1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resets, 1);
    assert.equal(batches.length, 2);
    assert.equal(batches[1]?.fileId, "file-2");
    assert.equal(MockEventSource.instances[0]?.closed, true);
  } finally {
    unsubscribe();
    restore();
  }
});
