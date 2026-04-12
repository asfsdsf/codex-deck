import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDetailResponse, WorkflowSummary } from "@codex-deck/api";
import { createLocalTransport } from "../../web/transport/local";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

class ManualTimerController {
  private nextId = 1;
  private readonly callbacks = new Map<
    number,
    { callback: () => void; delay: number }
  >();

  public install(): () => void {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const id = this.nextId++;
      const actualDelay =
        typeof delay === "number" && Number.isFinite(delay) ? delay : 0;
      this.callbacks.set(id, {
        delay: actualDelay,
        callback: () => {
          this.callbacks.delete(id);
          if (typeof callback === "function") {
            callback();
          }
        },
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((timeoutId: ReturnType<typeof setTimeout>) => {
      this.callbacks.delete(Number(timeoutId));
    }) as typeof globalThis.clearTimeout;

    return () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      this.callbacks.clear();
    };
  }

  public minPendingDelay(): number | null {
    let minDelay: number | null = null;
    for (const { delay } of this.callbacks.values()) {
      if (minDelay === null || delay < minDelay) {
        minDelay = delay;
      }
    }
    return minDelay;
  }
}

class MockEventSource {
  public static instances: MockEventSource[] = [];

  public readonly url: string;
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent) => void>
  >();

  public constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  public addEventListener(
    eventName: string,
    handler: (event: MessageEvent) => void,
  ): void {
    const handlers = this.listeners.get(eventName) ?? [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
  }

  public close(): void {}

  public emit(eventName: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler(event);
    }
  }
}

function installMockEventSource(): () => void {
  const originalEventSource = globalThis.EventSource;
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

  return () => {
    MockEventSource.instances = [];
    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    } else {
      delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
    }
  };
}

function createWorkflowSummary(
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    key: "workflow-key",
    workflowPath: "/repo/.codex-deck/workflow-key.json",
    id: "workflow-key",
    title: "Workflow Title",
    status: "running",
    projectRoot: "/repo",
    projectName: "repo",
    targetBranch: "main",
    updatedAt: "2026-03-16T00:00:00.000Z",
    createdAt: "2026-03-15T00:00:00.000Z",
    request: "Ship the feature",
    boundSessionId: "session-1",
    schedulerRunning: true,
    schedulerPendingTrigger: false,
    schedulerLastSessionId: "session-1",
    schedulerThreadId: "thread-1",
    schedulerLastReason: "manual",
    schedulerLastRunAt: "2026-03-16T00:00:00.000Z",
    schedulerLastTurnStatus: "completed",
    maxParallel: 2,
    mergePolicy: "squash",
    taskCounts: {
      total: 2,
      cancelled: 0,
      failed: 0,
      pending: 1,
      running: 1,
      success: 0,
    },
    recentOutcomes: [],
    ...overrides,
  };
}

function createWorkflowDetail(
  summary: WorkflowSummary,
  overrides: Partial<WorkflowDetailResponse> = {},
): WorkflowDetailResponse {
  return {
    summary,
    boundSessionId: summary.boundSessionId,
    settings: {
      codexHome: "/tmp/codex-home",
      codexCliPath: "/usr/bin/codex",
      maxParallel: summary.maxParallel,
      mergePolicy: summary.mergePolicy,
      stopSignal: null,
    },
    scheduler: {
      running: summary.schedulerRunning,
      pendingTrigger: summary.schedulerPendingTrigger,
      lastRunAt: summary.schedulerLastRunAt,
      lastSessionId: summary.schedulerLastSessionId,
      threadId: summary.schedulerThreadId,
      lastTurnId: "turn-1",
      lastTurnStatus: summary.schedulerLastTurnStatus,
      lastReason: summary.schedulerLastReason,
      controllerMode: "plan",
      controller: {},
      builtInPrompt: null,
      lastComposedPrompt: null,
      controlMessages: [],
    },
    tasks: [],
    history: [],
    raw: {},
    ...overrides,
  };
}

test("local workflow summary updates wake selected workflow detail immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreEventSource = installMockEventSource();
  const transport = createLocalTransport();
  const initialSummary = createWorkflowSummary();
  const updatedSummary = createWorkflowSummary({
    updatedAt: "2026-03-16T00:05:00.000Z",
    schedulerRunning: false,
    schedulerLastSessionId: "session-9",
    schedulerThreadId: "thread-9",
  });
  const detailResponses = [
    createWorkflowDetail(initialSummary),
    createWorkflowDetail(updatedSummary),
  ];
  let detailRequestIndex = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "GET"
    ) {
      const response =
        detailResponses[
          Math.min(detailRequestIndex, detailResponses.length - 1)
        ] ?? detailResponses[detailResponses.length - 1]!;
      detailRequestIndex += 1;
      return jsonResponse(response);
    }
    throw new Error(`Unexpected local workflow request: ${url}`);
  };

  const sessionIds: Array<string | null> = [];

  try {
    const unsubscribeDetail = transport.subscribeWorkflowDetailStream(
      "workflow-key",
      {
        onWorkflowDetail: (detail) => {
          sessionIds.push(detail.scheduler.lastSessionId);
        },
      },
    );
    const unsubscribeWorkflows = transport.subscribeWorkflowsStream({
      onWorkflows: () => {},
    });

    await flushAsyncWork();
    assert.deepEqual(sessionIds, ["session-1"]);
    assert.equal(timerController.minPendingDelay(), 3000);

    const eventSource = MockEventSource.instances[0];
    assert.ok(eventSource);
    assert.equal(eventSource.url, "/api/workflows/stream");
    eventSource.emit("workflowsUpdate", [updatedSummary]);

    await flushAsyncWork();
    assert.deepEqual(sessionIds, ["session-1", "session-9"]);

    unsubscribeWorkflows();
    unsubscribeDetail();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEventSource();
    restoreTimers();
  }
});
