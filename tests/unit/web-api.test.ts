import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationMessage,
  Session,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import { encodeBase64 } from "@zuoyehaoduoa/wire";
import {
  __TEST_ONLY__ as WEB_API_TEST_ONLY,
  applyWorkflowMerge,
  bindWorkflowSession,
  bindTerminalSession,
  cleanSessionBackgroundTerminalRuns,
  compactCodexThread,
  createCodexThread,
  createTerminal,
  executeTerminalCommand,
  createWorkflow,
  deleteWorkflow,
  deleteSession,
  deleteTerminal,
  fixDanglingSession,
  forkCodexThread,
  getCodexConfigDefaults,
  getSystemContext,
  getCodexThreadState,
  getCodexThreadSummaries,
  getConversation,
  getSessionContext,
  getSessionDiff,
  getSessionExists,
  getSessionFileContent,
  getSessionFileTree,
  getWorkflowProjectDiff,
  getWorkflowProjectFileContent,
  getWorkflowProjectFileTreeNodes,
  getWorkflowProjectSkills,
  getSessionTerminalRunOutput,
  getSessionTerminalRuns,
  getTerminalBinding,
  getTerminalFrozenBlocks,
  getTerminalSessionRoles,
  getSessionSkills,
  getTerminalSnapshot,
  getWorkflowDaemonStatus,
  getWorkflowBySession,
  getWorkflowDetail,
  getWorkflowLog,
  getWorkflowSessionRoles,
  setSessionSkillEnabled,
  setWorkflowProjectSkillEnabled,
  interruptCodexThread,
  interruptTerminal,
  listCodexAgentThreads,
  listCodexCollaborationModes,
  listCodexModels,
  listActiveTerminals,
  listCodexApprovalRequests,
  listCodexUserInputRequests,
  listWorkflows,
  launchWorkflowTask,
  previewWorkflowMerge,
  reconcileWorkflow,
  restartTerminal,
  resizeTerminal,
  persistTerminalFrozenBlock,
  persistTerminalMessageAction,
  respondCodexApprovalRequest,
  respondCodexUserInputRequest,
  runInTerminal,
  searchSessionFiles,
  sendTerminalInput,
  sendCodexMessage,
  sendWorkflowControlMessage,
  setCodexThreadName,
  startWorkflowDaemon,
  stopWorkflowProcesses,
  stopWorkflowDaemon,
  subscribeConversationStream,
  subscribeSessionsStream,
  subscribeTerminalStream,
  subscribeWorkflowDaemonStatusStream,
  subscribeWorkflowDetailStream,
  subscribeWorkflowsStream,
  triggerWorkflow,
  validateWorkflow,
} from "../../web/api";
import { RemoteClient } from "../../web/remote-client";
import { responseItemMessageLine } from "./test-utils";

test.afterEach(() => {
  WEB_API_TEST_ONLY.resetApiRequestCaches();
});

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

  public async runNext(): Promise<void> {
    const next = this.callbacks.values().next().value as
      | { callback: () => void; delay: number }
      | undefined;
    assert.ok(next, "expected a pending timer callback");
    next.callback();
    await flushAsyncWork();
  }

  public pendingCount(): number {
    return this.callbacks.size;
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

  public async runImmediate(): Promise<void> {
    const immediateEntry = Array.from(this.callbacks.values()).find(
      ({ delay }) => delay === 0,
    );
    assert.ok(immediateEntry, "expected an immediate timer callback");
    immediateEntry.callback();
    await flushAsyncWork();
  }
}

class MockEventSource {
  public static instances: MockEventSource[] = [];

  public readonly url: string;
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed = false;
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

  public close(): void {
    this.closed = true;
  }

  public emit(eventName: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler(event);
    }
  }

  public open(): void {
    this.onopen?.();
  }

  public fail(): void {
    this.onerror?.();
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

const REMOTE_CONVERSATION_CHUNK_MAX_BYTES = 512 * 1024;
const REMOTE_CONVERSATION_WINDOW_MAX_BYTES = 512 * 1024;
const REMOTE_CONVERSATION_BOOTSTRAP_WINDOW_MAX_BYTES = 128 * 1024;

function mockRemoteConversationRequests(
  responses: Array<{
    messages: ConversationMessage[];
    nextOffset: number;
    done: boolean;
  }>,
): () => void {
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;
  let requestIndex = 0;

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
  ): Promise<T> {
    const response = responses[
      Math.min(requestIndex, responses.length - 1)
    ] ?? {
      messages: [],
      nextOffset: 0,
      done: true,
    };
    requestIndex += 1;

    const rawLines = response.messages
      .filter(
        (
          message,
        ): message is ConversationMessage & { type: "user" | "assistant" } =>
          message.type === "user" || message.type === "assistant",
      )
      .map((message) =>
        responseItemMessageLine(
          message.type,
          message.uuid ?? message.timestamp ?? message.type,
          message.timestamp,
        ),
      )
      .join("\n");

    const bytes = rawLines
      ? new TextEncoder().encode(`${rawLines}\n`)
      : new Uint8Array(0);
    const chunkBase64 = bytes.length > 0 ? encodeBase64(bytes) : "";
    const url = new URL(path, "http://codex-deck.test");
    if (path.startsWith("/api/conversation/remote-session/raw-chunk?")) {
      assert.equal(
        Number.parseInt(url.searchParams.get("maxBytes") ?? "NaN", 10),
        REMOTE_CONVERSATION_CHUNK_MAX_BYTES,
      );
      const requestedOffset = Number.parseInt(
        url.searchParams.get("offset") ?? "0",
        10,
      );
      const safeRequestedOffset =
        Number.isFinite(requestedOffset) && requestedOffset >= 0
          ? requestedOffset
          : 0;

      return {
        chunkBase64,
        nextOffset: safeRequestedOffset + bytes.length,
        done: response.done,
      } as T;
    }

    assert.equal(
      path.startsWith("/api/conversation/remote-session/window?"),
      true,
    );
    const requestedMaxBytes = Number.parseInt(
      url.searchParams.get("maxBytes") ?? "NaN",
      10,
    );
    const requestedBefore = Number.parseInt(
      url.searchParams.get("beforeOffset") ?? "NaN",
      10,
    );
    if (Number.isFinite(requestedBefore) && requestedBefore >= 0) {
      assert.equal(requestedMaxBytes, REMOTE_CONVERSATION_WINDOW_MAX_BYTES);
    } else {
      assert.ok(
        requestedMaxBytes === REMOTE_CONVERSATION_BOOTSTRAP_WINDOW_MAX_BYTES ||
          requestedMaxBytes === REMOTE_CONVERSATION_WINDOW_MAX_BYTES,
      );
    }
    const defaultEndOffset = Math.max(
      response.nextOffset ?? 0,
      bytes.length,
      1,
    );
    const endOffset =
      Number.isFinite(requestedBefore) && requestedBefore >= 0
        ? requestedBefore
        : defaultEndOffset;
    const startOffset = Math.max(0, endOffset - bytes.length);

    return {
      chunkBase64,
      startOffset,
      endOffset,
      fileSize: Math.max(endOffset, response.nextOffset ?? endOffset),
      done: response.done || startOffset <= 0,
    } as T;
  } as typeof RemoteClient.prototype.requestJson;

  return () => {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  };
}

function getMessageIdentifier(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block) => block.type === "text" && typeof block.text === "string",
    );
    if (typeof textBlock?.text === "string") {
      return textBlock.text;
    }
  }
  return message.uuid ?? "";
}

function mockRemoteTerminalEventRequests(
  terminalId: string,
  responses: Array<{
    events: Array<{
      terminalId?: string;
      seq: number;
      type: "output" | "state" | "reset" | "ownership";
      chunk?: string;
      running?: boolean;
      output?: string;
      writeOwnerId?: string | null;
    }>;
    requiresReset: boolean;
    bootstrap?: {
      snapshot: {
        id?: string;
        terminalId?: string;
        running: boolean;
        cwd: string;
        shell: string;
        output: string;
        seq: number;
        writeOwnerId: string | null;
      };
      artifacts: null;
    } | null;
    snapshot: {
      id?: string;
      terminalId?: string;
      running: boolean;
      cwd: string;
      shell: string;
      output: string;
      seq: number;
      writeOwnerId: string | null;
    } | null;
  }>,
): () => void {
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;
  let requestIndex = 0;

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
  ): Promise<T> {
    assert.equal(
      path.startsWith(
        `/api/terminals/${encodeURIComponent(terminalId)}/events?fromSeq=`,
      ),
      true,
    );
    assert.equal(path.includes("waitMs=0"), true);
    const response = responses[
      Math.min(requestIndex, responses.length - 1)
    ] ?? {
      events: [],
      requiresReset: false,
      bootstrap: null,
      snapshot: null,
    };
    requestIndex += 1;
    return response as T;
  } as typeof RemoteClient.prototype.requestJson;

  return () => {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  };
}

function mockRemoteSessionsDeltaRequests(
  responses: Array<{
    version: number;
    isFullSnapshot: boolean;
    sessions: Session[];
    updates: Session[];
    removedSessionIds: string[];
    skillsChangedSessionIds: string[];
  }>,
): () => void {
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;
  let requestIndex = 0;

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
  ): Promise<T> {
    assert.equal(path.startsWith("/api/sessions/delta?"), true);
    assert.equal(path.includes("waitMs=0"), true);
    const response = responses[
      Math.min(requestIndex, responses.length - 1)
    ] ?? {
      version: 1,
      isFullSnapshot: false,
      sessions: [],
      updates: [],
      removedSessionIds: [],
      skillsChangedSessionIds: [],
    };
    requestIndex += 1;
    return response as T;
  } as typeof RemoteClient.prototype.requestJson;

  return () => {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  };
}

function mockRemoteConversationAndSendRequests(
  rawChunkResponses: Array<{
    messages: ConversationMessage[];
    done: boolean;
  }>,
): () => void {
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;
  let rawChunkIndex = 0;

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
  ): Promise<T> {
    if (
      path === "/api/codex/threads/remote-session/messages" ||
      path.startsWith("/api/codex/threads/remote-session/messages?")
    ) {
      return { ok: true, turnId: "turn_123" } as T;
    }

    const response = rawChunkResponses[
      Math.min(rawChunkIndex, rawChunkResponses.length - 1)
    ] ?? {
      messages: [],
      done: true,
    };
    rawChunkIndex += 1;

    const rawLines = response.messages
      .filter(
        (
          message,
        ): message is ConversationMessage & { type: "user" | "assistant" } =>
          message.type === "user" || message.type === "assistant",
      )
      .map((message) =>
        responseItemMessageLine(
          message.type,
          message.uuid ?? message.timestamp ?? message.type,
          message.timestamp,
        ),
      )
      .join("\n");
    const bytes = rawLines
      ? new TextEncoder().encode(`${rawLines}\n`)
      : new Uint8Array(0);
    const chunkBase64 = bytes.length > 0 ? encodeBase64(bytes) : "";
    const url = new URL(path, "http://codex-deck.test");
    if (path.startsWith("/api/conversation/remote-session/raw-chunk?")) {
      const requestedOffset = Number.parseInt(
        url.searchParams.get("offset") ?? "0",
        10,
      );
      const safeRequestedOffset =
        Number.isFinite(requestedOffset) && requestedOffset >= 0
          ? requestedOffset
          : 0;

      return {
        chunkBase64,
        nextOffset: safeRequestedOffset + bytes.length,
        done: response.done,
      } as T;
    }

    assert.equal(
      path.startsWith("/api/conversation/remote-session/window?"),
      true,
    );
    const requestedBefore = Number.parseInt(
      url.searchParams.get("beforeOffset") ?? "NaN",
      10,
    );
    const defaultEndOffset = Math.max(bytes.length, 1);
    const endOffset =
      Number.isFinite(requestedBefore) && requestedBefore >= 0
        ? requestedBefore
        : defaultEndOffset;
    const startOffset = Math.max(0, endOffset - bytes.length);

    return {
      chunkBase64,
      startOffset,
      endOffset,
      fileSize: endOffset,
      done: response.done || startOffset <= 0,
    } as T;
  } as typeof RemoteClient.prototype.requestJson;

  return () => {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  };
}

function mockRemoteWorkflowRequests(options: {
  workflows?: WorkflowSummary[][];
  daemonStatuses?: WorkflowDaemonStatusResponse[];
  details?: WorkflowDetailResponse[];
}): () => void {
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;
  let workflowsIndex = 0;
  let daemonIndex = 0;
  let detailIndex = 0;

  const workflowResponses = options.workflows ?? [[]];
  const daemonResponses = options.daemonStatuses ?? [
    {
      state: "idle",
      pid: null,
      port: null,
      startedAt: null,
      lastHeartbeatAt: null,
      lastRequestAt: null,
      queueDepth: 0,
      activeProjects: [],
      activeWorkflows: [],
      daemonId: null,
      daemonLogPath: null,
    },
  ];
  const detailResponses = options.details ?? [];

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
  ): Promise<T> {
    if (path === "/api/workflows/create") {
      return {
        ok: true,
        command: "create",
        workflowKey: "remote-flow",
        workflowPath: "/tmp/remote-flow.json",
        output: "created",
      } as T;
    }

    if (path === "/api/workflows/daemon-start") {
      return {
        ok: true,
        command: "daemon-start",
        workflowKey: null,
        output: "started",
      } as T;
    }

    if (path === "/api/workflows") {
      const workflows =
        workflowResponses[
          Math.min(workflowsIndex, workflowResponses.length - 1)
        ] ?? [];
      workflowsIndex += 1;
      return { workflows } as T;
    }

    if (path === "/api/workflows/daemon-status") {
      const daemonStatus =
        daemonResponses[Math.min(daemonIndex, daemonResponses.length - 1)] ??
        daemonResponses[daemonResponses.length - 1];
      daemonIndex += 1;
      return daemonStatus as T;
    }

    if (path === "/api/workflows/remote-flow") {
      const detail =
        detailResponses[Math.min(detailIndex, detailResponses.length - 1)] ??
        detailResponses[detailResponses.length - 1];
      detailIndex += 1;
      return detail as T;
    }

    throw new Error(`Unexpected remote workflow request: ${path}`);
  } as typeof RemoteClient.prototype.requestJson;

  return () => {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  };
}

function createWorkflowSummaryFixture() {
  return {
    key: "workflow-key",
    workflowPath: "/repo/.codex-deck/workflow-key.json",
    id: "workflow-key",
    title: "Workflow Title",
    status: "running" as const,
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
  };
}

function createWorkflowDetailFixture() {
  const summary = createWorkflowSummaryFixture();
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
      running: true,
      pendingTrigger: false,
      lastRunAt: summary.schedulerLastRunAt,
      lastSessionId: summary.schedulerLastSessionId,
      threadId: summary.schedulerThreadId,
      lastTurnId: "turn-1",
      lastTurnStatus: "completed",
      lastReason: summary.schedulerLastReason,
      controllerMode: "plan",
      controller: {},
      builtInPrompt: null,
      lastComposedPrompt: null,
      controlMessages: [],
    },
    tasks: [
      {
        id: "task-1",
        name: "Task One",
        prompt: "Do the thing",
        dependsOn: [],
        status: "running" as const,
        sessionId: "session-2",
        branchName: "feature/task-1",
        worktreePath: "/repo/.codex-deck/worktrees/task-1",
        baseCommit: "abc123",
        resultCommit: null,
        startedAt: "2026-03-16T00:00:00.000Z",
        finishedAt: null,
        summary: null,
        failureReason: null,
        noOp: false,
        stopPending: false,
        runnerPid: 1234,
        ready: true,
      },
    ],
    history: [],
    raw: {
      workflow: {
        id: summary.id,
      },
    },
  };
}

test("codex config endpoints return normalized payloads", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).includes("/models")) {
      return jsonResponse({ models: [{ id: "o4-mini" }] });
    }
    if (String(input).includes("/defaults")) {
      return jsonResponse({
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        planModeReasoningEffort: "high",
      });
    }
    return jsonResponse({ modes: "invalid" });
  };

  const models = await listCodexModels();
  const modes = await listCodexCollaborationModes();
  const defaults = await getCodexConfigDefaults();

  assert.deepEqual(models, [{ id: "o4-mini" }]);
  assert.deepEqual(modes, []);
  assert.deepEqual(defaults, {
    model: "gpt-5.4",
    reasoningEffort: "xhigh",
    planModeReasoningEffort: "high",
  });
  assert.deepEqual(calls, [
    "/api/codex/models",
    "/api/codex/collaboration-modes",
    "/api/codex/defaults",
  ]);
});

test("codex config endpoints reuse cached responses within a page", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).includes("/models")) {
      return jsonResponse({ models: [{ id: "gpt-5.4" }] });
    }
    if (String(input).includes("/collaboration-modes")) {
      return jsonResponse({ modes: [{ mode: "default", name: "Default" }] });
    }
    return jsonResponse({
      model: "gpt-5.4",
      reasoningEffort: "high",
      planModeReasoningEffort: "medium",
    });
  };

  await listCodexModels();
  await listCodexModels();
  await listCodexCollaborationModes();
  await listCodexCollaborationModes();
  await getCodexConfigDefaults();
  await getCodexConfigDefaults();

  assert.deepEqual(calls, [
    "/api/codex/models",
    "/api/codex/collaboration-modes",
    "/api/codex/defaults",
  ]);
});

test("createCodexThread and sendCodexMessage send JSON POST payloads", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });

    if (String(input).includes("/messages")) {
      return jsonResponse({ ok: true, turnId: "turn_123" });
    }

    return jsonResponse({ threadId: "thread_123" });
  };

  const created = await createCodexThread({ cwd: "/repo", model: "o4-mini" });
  const sent = await sendCodexMessage("thread/with/slash", {
    text: "hello",
    serviceTier: "fast",
  });

  assert.equal(created.threadId, "thread_123");
  assert.equal(sent.ok, true);
  assert.equal(sent.turnId, "turn_123");

  assert.equal(calls[0].url, "/api/codex/threads");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    calls[1].url,
    "/api/codex/threads/thread%2Fwith%2Fslash/messages",
  );
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body ?? "{}")), {
    text: "hello",
    serviceTier: "fast",
  });
});

test("thread state and request routes encode IDs and include query", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/state")) {
      return jsonResponse({
        threadId: "thread",
        activeTurnId: null,
        isGenerating: false,
        requestedTurnId: "turn_abc",
        requestedTurnStatus: null,
      });
    }

    if (url.endsWith("/requests/user-input")) {
      return jsonResponse({ requests: [{ requestId: "req" }] });
    }

    if (url.endsWith("/requests/approvals")) {
      return jsonResponse({ requests: [{ requestId: "approval-1" }] });
    }

    if (url.includes("/respond")) {
      return jsonResponse({ ok: true });
    }

    if (url.includes("/interrupt")) {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({});
  };

  const state = await getCodexThreadState("thread#1", "  turn_abc  ");
  const requests = await listCodexUserInputRequests("thread#1");
  const approvalRequests = await listCodexApprovalRequests("thread#1");
  const interrupt = await interruptCodexThread("thread#1");
  const response = await respondCodexUserInputRequest("thread#1", "req/1", {
    answers: { q1: { answers: ["yes"] } },
  });
  const approvalResponse = await respondCodexApprovalRequest(
    "thread#1",
    "approval/1",
    {
      decisionId: "accept",
    },
  );

  assert.equal(state.requestedTurnId, "turn_abc");
  assert.deepEqual(requests, [{ requestId: "req" }]);
  assert.deepEqual(approvalRequests, [{ requestId: "approval-1" }]);
  assert.equal(interrupt.ok, true);
  assert.equal(response.ok, true);
  assert.equal(approvalResponse.ok, true);
  assert.deepEqual(calls, [
    "/api/codex/threads/thread%231/state?turnId=turn_abc",
    "/api/codex/threads/thread%231/requests/user-input",
    "/api/codex/threads/thread%231/requests/approvals",
    "/api/codex/threads/thread%231/interrupt",
    "/api/codex/threads/thread%231/requests/user-input/req%2F1/respond",
    "/api/codex/threads/thread%231/requests/approvals/approval%2F1/respond",
  ]);
});

test("thread management routes request expected endpoints", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const url = String(input);

    if (url.includes("/name")) {
      return jsonResponse({ ok: true });
    }
    if (url.includes("/fork")) {
      return jsonResponse({
        thread: {
          threadId: "thread-forked",
          name: "Forked Thread",
          preview: "hello",
          cwd: "/repo",
          agentNickname: null,
          agentRole: null,
          status: "idle",
          updatedAt: Date.now(),
        },
      });
    }
    if (url.includes("/compact")) {
      return jsonResponse({ ok: true });
    }
    if (url.includes("/agent-threads")) {
      return jsonResponse({
        threads: [
          {
            threadId: "thread-agent",
            name: "Agent 1",
            preview: "agent preview",
            cwd: "/repo",
            agentNickname: "agent-1",
            agentRole: "explorer",
            status: "active",
            updatedAt: Date.now(),
          },
        ],
      });
    }
    return jsonResponse({
      threads: [
        {
          threadId: "thread-main",
          name: "Main",
          preview: "main preview",
          cwd: "/repo",
          agentNickname: null,
          agentRole: null,
          status: "idle",
          updatedAt: Date.now(),
        },
      ],
    });
  };

  const renamed = await setCodexThreadName("thread#1", { name: "New Name" });
  const forked = await forkCodexThread("thread#1");
  const compacted = await compactCodexThread("thread#1");
  const agentThreads = await listCodexAgentThreads("thread#1");
  const summaries = await getCodexThreadSummaries({
    threadIds: ["thread#1", "thread#2"],
  });

  assert.equal(renamed.ok, true);
  assert.equal(forked.thread.threadId, "thread-forked");
  assert.equal(compacted.ok, true);
  assert.equal(agentThreads[0]?.threadId, "thread-agent");
  assert.equal(summaries.threads[0]?.threadId, "thread-main");

  assert.equal(calls[0].url, "/api/codex/threads/thread%231/name");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body ?? "{}")), {
    name: "New Name",
  });

  assert.equal(calls[1].url, "/api/codex/threads/thread%231/fork");
  assert.equal(calls[1].init?.method, "POST");
  assert.equal(calls[2].url, "/api/codex/threads/thread%231/compact");
  assert.equal(calls[2].init?.method, "POST");
  assert.equal(calls[3].url, "/api/codex/threads/thread%231/agent-threads");
  assert.equal(calls[4].url, "/api/codex/threads/summaries");
  assert.equal(calls[4].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[4].init?.body ?? "{}")), {
    threadIds: ["thread#1", "thread#2"],
  });
});

test("workflow routes request expected endpoints over local transport", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const summary = createWorkflowSummaryFixture();
  const detail = createWorkflowDetailFixture();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === "/api/workflows") {
      return jsonResponse({ workflows: [summary] });
    }
    if (url === "/api/workflows/daemon-status") {
      return jsonResponse({
        state: "running",
        pid: 123,
        port: 7777,
        startedAt: "2026-03-16T00:00:00.000Z",
        lastHeartbeatAt: "2026-03-16T00:00:01.000Z",
        lastRequestAt: "2026-03-16T00:00:02.000Z",
        queueDepth: 1,
        activeProjects: ["/repo"],
        activeWorkflows: [summary.workflowPath],
        daemonId: "daemon-1",
        daemonLogPath: "/repo/.codex-deck/logs/daemon.log",
      });
    }
    if (
      url === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "GET"
    ) {
      return jsonResponse(detail);
    }
    if (
      url === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "DELETE"
    ) {
      return jsonResponse({
        ok: true,
        command: "delete",
        workflowKey: summary.key,
        output: "deleted",
      });
    }
    if (url === "/api/workflows/by-session/session-2") {
      return jsonResponse({
        match: {
          sessionId: "session-2",
          role: "task",
          taskId: "task-1",
          workflow: summary,
        },
      });
    }
    if (url === "/api/workflows/by-session/session-missing") {
      return jsonResponse({ match: null });
    }
    if (url === "/api/workflows/session-roles") {
      return jsonResponse({
        sessions: [
          {
            sessionId: "session-1",
            role: "scheduler",
            taskId: null,
          },
          {
            sessionId: "session-2",
            role: "task",
            taskId: "task-1",
          },
        ],
      });
    }
    if (url === "/api/workflows/workflow-key/log?scope=task&taskId=task-1") {
      return jsonResponse({
        key: summary.key,
        scope: "task",
        taskId: "task-1",
        path: "/repo/.codex-deck/logs/task-1.log",
        content: "task log",
        unavailableReason: null,
      });
    }
    if (url === "/api/workflows/create") {
      return jsonResponse({
        ok: true,
        command: "create",
        workflowKey: summary.key,
        workflowPath: summary.workflowPath,
        output: summary.workflowPath,
      });
    }
    return jsonResponse({
      ok: true,
      command: "ok",
      workflowKey: summary.key,
      output: "done",
    });
  };

  const listed = await listWorkflows();
  const daemonStatus = await getWorkflowDaemonStatus();
  const loadedDetail = await getWorkflowDetail(summary.key);
  const workflowBySession = await getWorkflowBySession("session-2");
  const missingWorkflowBySession =
    await getWorkflowBySession("session-missing");
  const workflowSessionRoles = await getWorkflowSessionRoles([
    "session-1",
    "session-2",
  ]);
  const loadedLog = await getWorkflowLog(summary.key, {
    scope: "task",
    taskId: "task-1",
  });
  const created = await createWorkflow({
    title: "Workflow Title",
    request: "Ship the feature",
    projectRoot: "/repo",
  });
  const deleted = await deleteWorkflow(summary.key);
  const validated = await validateWorkflow(summary.key);
  const reconciled = await reconcileWorkflow(summary.key);
  const triggered = await triggerWorkflow(summary.key);
  const launched = await launchWorkflowTask(summary.key, "task-1");
  const preview = await previewWorkflowMerge(summary.key);
  const applied = await applyWorkflowMerge(summary.key);
  const bound = await bindWorkflowSession(summary.key, {
    sessionId: "session-2",
  });
  const control = await sendWorkflowControlMessage(summary.key, {
    type: "enqueue-trigger",
    reason: "manual",
    payload: { force: true },
  });
  const stoppedProcesses = await stopWorkflowProcesses(summary.key);
  const started = await startWorkflowDaemon();
  const stopped = await stopWorkflowDaemon();

  assert.equal(listed[0]?.key, summary.key);
  assert.equal(daemonStatus.state, "running");
  assert.equal(loadedDetail.summary.key, summary.key);
  assert.equal(workflowBySession?.role, "task");
  assert.equal(missingWorkflowBySession, null);
  assert.deepEqual(workflowSessionRoles, [
    {
      sessionId: "session-1",
      role: "scheduler",
      taskId: null,
    },
    {
      sessionId: "session-2",
      role: "task",
      taskId: "task-1",
    },
  ]);
  assert.equal(workflowBySession?.taskId, "task-1");
  assert.equal(loadedLog.taskId, "task-1");
  assert.equal(created.workflowKey, summary.key);
  assert.equal(deleted.ok, true);
  assert.equal(validated.ok, true);
  assert.equal(reconciled.ok, true);
  assert.equal(triggered.ok, true);
  assert.equal(launched.ok, true);
  assert.equal(preview.ok, true);
  assert.equal(applied.ok, true);
  assert.equal(bound.ok, true);
  assert.equal(control.ok, true);
  assert.equal(stoppedProcesses.ok, true);
  assert.equal(started.ok, true);
  assert.equal(stopped.ok, true);

  assert.deepEqual(
    calls.map(({ url, init }) => `${url}:${init?.method ?? "GET"}`),
    [
      "/api/workflows:GET",
      "/api/workflows/daemon-status:GET",
      "/api/workflows/workflow-key:GET",
      "/api/workflows/by-session/session-2:GET",
      "/api/workflows/by-session/session-missing:GET",
      "/api/workflows/session-roles:POST",
      "/api/workflows/workflow-key/log?scope=task&taskId=task-1:GET",
      "/api/workflows/create:POST",
      "/api/workflows/workflow-key:DELETE",
      "/api/workflows/workflow-key/validate:POST",
      "/api/workflows/workflow-key/reconcile:POST",
      "/api/workflows/workflow-key/trigger:POST",
      "/api/workflows/workflow-key/launch-task:POST",
      "/api/workflows/workflow-key/merge-preview:POST",
      "/api/workflows/workflow-key/merge-apply:POST",
      "/api/workflows/workflow-key/bound-session:POST",
      "/api/workflows/workflow-key/control-message:POST",
      "/api/workflows/workflow-key/stop-processes:POST",
      "/api/workflows/daemon-start:POST",
      "/api/workflows/daemon-stop:POST",
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[5].init?.body ?? "{}")), {
    sessionIds: ["session-1", "session-2"],
  });
  assert.deepEqual(JSON.parse(String(calls[7].init?.body ?? "{}")), {
    title: "Workflow Title",
    request: "Ship the feature",
    projectRoot: "/repo",
  });
  assert.deepEqual(JSON.parse(String(calls[12].init?.body ?? "{}")), {
    taskId: "task-1",
  });
  assert.deepEqual(JSON.parse(String(calls[15].init?.body ?? "{}")), {
    sessionId: "session-2",
  });
  assert.deepEqual(JSON.parse(String(calls[16].init?.body ?? "{}")), {
    type: "enqueue-trigger",
    reason: "manual",
    payload: { force: true },
  });
});

test("workflow routes delegate to remote transport when connected", async () => {
  const summary = createWorkflowSummaryFixture();
  const detail = createWorkflowDetailFixture();
  const calls: Array<{
    path: string;
    init?: RequestInit;
  }> = [];
  const originalIsConnected = RemoteClient.prototype.isConnected;
  const originalRequestJson = RemoteClient.prototype.requestJson;

  RemoteClient.prototype.isConnected = (() =>
    true) as typeof RemoteClient.prototype.isConnected;
  RemoteClient.prototype.requestJson = async function <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    calls.push({ path, init });

    if (path === "/api/workflows") {
      return { workflows: [summary] } as T;
    }
    if (path === "/api/workflows/daemon-status") {
      return {
        state: "running",
        pid: null,
        port: null,
        startedAt: null,
        lastHeartbeatAt: null,
        lastRequestAt: null,
        queueDepth: 0,
        activeProjects: [],
        activeWorkflows: [],
        daemonId: null,
        daemonLogPath: null,
      } as T;
    }
    if (
      path === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "GET"
    ) {
      return detail as T;
    }
    if (
      path === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "DELETE"
    ) {
      return {
        ok: true,
        command: "delete",
        workflowKey: summary.key,
        output: "deleted",
      } as T;
    }
    if (path === "/api/workflows/by-session/session-2") {
      return {
        match: {
          sessionId: "session-2",
          role: "task",
          taskId: "task-1",
          workflow: summary,
        },
      } as T;
    }
    if (path === "/api/workflows/by-session/session-missing") {
      return {
        match: null,
      } as T;
    }
    if (path === "/api/workflows/session-roles") {
      return {
        sessions: [
          {
            sessionId: "session-1",
            role: "scheduler",
            taskId: null,
          },
          {
            sessionId: "session-2",
            role: "task",
            taskId: "task-1",
          },
        ],
      } as T;
    }
    if (path === "/api/workflows/workflow-key/log?scope=scheduler") {
      return {
        key: summary.key,
        scope: "scheduler",
        taskId: null,
        path: "/repo/.codex-deck/logs/scheduler.log",
        content: "scheduler log",
        unavailableReason: null,
      } as T;
    }
    if (path === "/api/workflows/create") {
      return {
        ok: true,
        command: "create",
        workflowKey: summary.key,
        workflowPath: summary.workflowPath,
        output: summary.workflowPath,
      } as T;
    }
    return {
      ok: true,
      command: "ok",
      workflowKey: summary.key,
      output: "done",
    } as T;
  } as typeof RemoteClient.prototype.requestJson;

  try {
    const listed = await listWorkflows();
    const daemonStatus = await getWorkflowDaemonStatus();
    const loadedDetail = await getWorkflowDetail(summary.key);
    const workflowBySession = await getWorkflowBySession("session-2");
    const missingWorkflowBySession =
      await getWorkflowBySession("session-missing");
    const workflowSessionRoles = await getWorkflowSessionRoles([
      "session-1",
      "session-2",
    ]);
    const loadedLog = await getWorkflowLog(summary.key, {
      scope: "scheduler",
    });
    const created = await createWorkflow({
      title: "Workflow Title",
      request: "Ship the feature",
      projectRoot: "/repo",
    });
    const deleted = await deleteWorkflow(summary.key);
    const launched = await launchWorkflowTask(summary.key, "task-1");
    const bound = await bindWorkflowSession(summary.key, {
      sessionId: "session-2",
    });
    const control = await sendWorkflowControlMessage(summary.key, {
      type: "enqueue-trigger",
      reason: "manual",
      payload: { force: true },
    });
    const stoppedProcesses = await stopWorkflowProcesses(summary.key);
    const started = await startWorkflowDaemon();
    const stopped = await stopWorkflowDaemon();

    assert.equal(listed[0]?.key, summary.key);
    assert.equal(daemonStatus.state, "running");
    assert.equal(loadedDetail.summary.key, summary.key);
    assert.equal(workflowBySession?.role, "task");
    assert.equal(missingWorkflowBySession, null);
    assert.deepEqual(workflowSessionRoles, [
      {
        sessionId: "session-1",
        role: "scheduler",
        taskId: null,
      },
      {
        sessionId: "session-2",
        role: "task",
        taskId: "task-1",
      },
    ]);
    assert.equal(loadedLog.scope, "scheduler");
    assert.equal(created.workflowKey, summary.key);
    assert.equal(deleted.ok, true);
    assert.equal(launched.ok, true);
    assert.equal(bound.ok, true);
    assert.equal(control.ok, true);
    assert.equal(stoppedProcesses.ok, true);
    assert.equal(started.ok, true);
    assert.equal(stopped.ok, true);

    assert.deepEqual(
      calls.map(({ path, init }) => `${path}:${init?.method ?? "GET"}`),
      [
        "/api/workflows:GET",
        "/api/workflows/daemon-status:GET",
        "/api/workflows/workflow-key:GET",
        "/api/workflows/by-session/session-2:GET",
        "/api/workflows/by-session/session-missing:GET",
        "/api/workflows/session-roles:POST",
        "/api/workflows/workflow-key/log?scope=scheduler:GET",
        "/api/workflows/create:POST",
        "/api/workflows/workflow-key:DELETE",
        "/api/workflows/workflow-key/launch-task:POST",
        "/api/workflows/workflow-key/bound-session:POST",
        "/api/workflows/workflow-key/control-message:POST",
        "/api/workflows/workflow-key/stop-processes:POST",
        "/api/workflows/daemon-start:POST",
        "/api/workflows/daemon-stop:POST",
      ],
    );
    assert.deepEqual(JSON.parse(String(calls[5].init?.body ?? "{}")), {
      sessionIds: ["session-1", "session-2"],
    });
    assert.deepEqual(JSON.parse(String(calls[7].init?.body ?? "{}")), {
      title: "Workflow Title",
      request: "Ship the feature",
      projectRoot: "/repo",
    });
    assert.deepEqual(JSON.parse(String(calls[9].init?.body ?? "{}")), {
      taskId: "task-1",
    });
    assert.deepEqual(JSON.parse(String(calls[10].init?.body ?? "{}")), {
      sessionId: "session-2",
    });
    assert.deepEqual(JSON.parse(String(calls[11].init?.body ?? "{}")), {
      type: "enqueue-trigger",
      reason: "manual",
      payload: { force: true },
    });
  } finally {
    RemoteClient.prototype.isConnected = originalIsConnected;
    RemoteClient.prototype.requestJson = originalRequestJson;
  }
});

test("conversation and session routes request expected endpoints", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);

    if (String(input).includes("/context")) {
      return jsonResponse({
        sessionId: "s",
        contextLeftPercent: 88,
        usedTokens: null,
        modelContextWindow: 200000,
        tokenUsage: {
          totalTokens: 12345,
          inputTokens: 8000,
          outputTokens: 4345,
        },
      });
    }

    if (String(input).includes("/exists")) {
      return jsonResponse({
        sessionId: "s",
        exists: true,
      });
    }

    if (
      String(input).includes("/api/sessions/abc?clientId=client-1") &&
      init?.method === "DELETE"
    ) {
      return jsonResponse({
        sessionId: "s",
        removedSessionFilePaths: [],
        removedHistoryEntries: 0,
        removedSessionIndexEntries: 0,
        sqlite: {
          dbPath: null,
          logsDbPath: null,
          threadsDeleted: 0,
          logsDeleted: 0,
          skippedReason: "state db not found",
          warnings: [],
        },
      });
    }

    if (String(input).includes("/fix-dangling")) {
      return jsonResponse({ sessionId: "s", danglingTurnIds: [] });
    }

    if (String(input).includes("/diff")) {
      return jsonResponse({
        sessionId: "s",
        mode: "unstaged",
        projectPath: "/repo",
        turnId: null,
        files: [],
        unavailableReason: null,
      });
    }

    if (String(input).includes("/file-tree")) {
      return jsonResponse({
        sessionId: "s",
        projectPath: "/repo",
        files: ["src/app.ts"],
        unavailableReason: null,
      });
    }

    if (String(input).includes("/file-content")) {
      return jsonResponse({
        sessionId: "s",
        projectPath: "/repo",
        path: "src/app.ts",
        content: "export {};",
        page: 1,
        totalPages: 1,
        paginationMode: "lines",
        lineStart: 1,
        lineEnd: 1,
        isBinary: false,
        unavailableReason: null,
      });
    }

    if (String(input).includes("/file-search")) {
      return jsonResponse({
        sessionId: "s",
        projectPath: "/repo",
        query: "app",
        files: ["src/app.ts"],
        unavailableReason: null,
      });
    }

    if (String(input).includes("/terminal-runs/")) {
      if (String(input).includes("/terminal-runs/clean")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({
        sessionId: "s",
        processId: "1000",
        command: "bash -lc tail -f app.log",
        isRunning: true,
        output: "streaming...\n",
        unavailableReason: null,
      });
    }

    if (String(input).includes("/terminal-runs")) {
      return jsonResponse({
        sessionId: "s",
        runs: [
          {
            processId: "1000",
            callId: "call_bg_1",
            command: "bash -lc tail -f app.log",
            isRunning: true,
            startedAt: null,
            endedAt: null,
            latestActivityAt: null,
          },
        ],
        unavailableReason: null,
      });
    }

    return jsonResponse([{ type: "user" }]);
  };

  const context = await getSessionContext("abc");
  const exists = await getSessionExists("abc");
  const deleted = await deleteSession("abc", "client-1");
  const fixed = await fixDanglingSession("abc");
  const conversation = await getConversation("abc");
  const diff = await getSessionDiff("abc", "unstaged");
  const tree = await getSessionFileTree("abc");
  const search = await searchSessionFiles("abc", "app", 10);
  const content = await getSessionFileContent("abc", "src/app.ts");
  const terminalRuns = await getSessionTerminalRuns("abc");
  const cleaned = await cleanSessionBackgroundTerminalRuns("abc");
  const terminalOutput = await getSessionTerminalRunOutput("abc", "1000");

  assert.equal(context.contextLeftPercent, 88);
  assert.equal(exists.exists, true);
  assert.equal(deleted.sessionId, "s");
  assert.equal((fixed as { sessionId?: string }).sessionId, "s");
  assert.deepEqual(conversation, [{ type: "user" }]);
  assert.equal(diff.mode, "unstaged");
  assert.deepEqual(tree.files, ["src/app.ts"]);
  assert.deepEqual(search.files, ["src/app.ts"]);
  assert.equal(content.path, "src/app.ts");
  assert.equal(terminalRuns.runs[0]?.processId, "1000");
  assert.equal(cleaned.ok, true);
  assert.equal(terminalOutput.processId, "1000");
  assert.deepEqual(calls, [
    "/api/sessions/abc/context:GET",
    "/api/sessions/abc/exists:GET",
    "/api/sessions/abc?clientId=client-1:DELETE",
    "/api/sessions/abc/fix-dangling:POST",
    "/api/conversation/abc:GET",
    "/api/sessions/abc/diff?mode=unstaged:GET",
    "/api/sessions/abc/file-tree:GET",
    "/api/sessions/abc/file-search?query=app&limit=10:GET",
    "/api/sessions/abc/file-content?path=src%2Fapp.ts&page=1:GET",
    "/api/sessions/abc/terminal-runs:GET",
    "/api/sessions/abc/terminal-runs/clean:POST",
    "/api/sessions/abc/terminal-runs/1000:GET",
  ]);
});

test("workflow project routes request expected endpoints", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);

    if (String(input).includes("/skills/config")) {
      return jsonResponse({
        sessionId: "workflow-key",
        path: "/repo/.codex/skills/openai-docs/SKILL.md",
        enabled: false,
        effectiveEnabled: false,
      });
    }

    if (String(input).includes("/skills")) {
      return jsonResponse({
        sessionId: "workflow-key",
        projectPath: "/repo",
        cwd: "/repo",
        skills: [],
        errors: [],
        unavailableReason: null,
      });
    }

    if (String(input).includes("/file-content")) {
      return jsonResponse({
        sessionId: "workflow-key",
        projectPath: "/repo",
        path: "src/app.ts",
        content: "export const x = 1;\n",
        page: 1,
        totalPages: 1,
        paginationMode: "lines",
        lineStart: 1,
        lineEnd: 1,
        isBinary: false,
        unavailableReason: null,
      });
    }

    if (String(input).includes("/file-tree/nodes")) {
      return jsonResponse({
        sessionId: "workflow-key",
        projectPath: "/repo",
        dir: "",
        nodes: [],
        nextCursor: null,
        unavailableReason: null,
      });
    }

    if (String(input).includes("/diff")) {
      return jsonResponse({
        sessionId: "workflow-key",
        mode: "unstaged",
        projectPath: "/repo",
        turnId: null,
        files: [],
        unavailableReason: null,
      });
    }

    return jsonResponse({ ok: true });
  };

  const diff = await getWorkflowProjectDiff("workflow-key", "unstaged");
  const tree = await getWorkflowProjectFileTreeNodes("workflow-key");
  const content = await getWorkflowProjectFileContent(
    "workflow-key",
    "src/app.ts",
  );
  const skills = await getWorkflowProjectSkills("workflow-key");
  const configured = await setWorkflowProjectSkillEnabled("workflow-key", {
    path: "/repo/.codex/skills/openai-docs/SKILL.md",
    enabled: false,
  });

  assert.equal(diff.mode, "unstaged");
  assert.equal(tree.projectPath, "/repo");
  assert.equal(content.path, "src/app.ts");
  assert.equal(skills.skills.length, 0);
  assert.equal(configured.effectiveEnabled, false);
  assert.deepEqual(calls, [
    "/api/workflow-project/workflow-key/diff?mode=unstaged:GET",
    "/api/workflow-project/workflow-key/file-tree/nodes?dir=&cursor=0&limit=500:GET",
    "/api/workflow-project/workflow-key/file-content?path=src%2Fapp.ts&page=1:GET",
    "/api/workflow-project/workflow-key/skills:GET",
    "/api/workflow-project/workflow-key/skills/config:POST",
  ]);
});

test("subscribeConversationStream emits an initial remote snapshot before later deltas", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 10,
      done: true,
    },
    {
      messages: [],
      nextOffset: 10,
      done: true,
    },
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 20,
      done: true,
    },
  ]);

  const messageBatches: ConversationMessage[][] = [];
  let heartbeatCount = 0;

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (messages) => {
        messageBatches.push(messages);
      },
      onHeartbeat: () => {
        heartbeatCount += 1;
      },
    });

    await flushAsyncWork();
    assert.deepEqual(
      messageBatches.map((batch) => batch.map(getMessageIdentifier)),
      [["msg-1"]],
    );
    assert.equal(heartbeatCount, 1);

    await timerController.runNext();
    assert.deepEqual(
      messageBatches.map((batch) => batch.map(getMessageIdentifier)),
      [["msg-1"]],
    );
    assert.equal(heartbeatCount, 2);

    await timerController.runNext();
    assert.deepEqual(
      messageBatches.map((batch) => batch.map(getMessageIdentifier)),
      [["msg-1"], ["msg-2"]],
    );
    assert.equal(heartbeatCount, 3);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeSessionsStream maps local SSE events including skillsChanged", async () => {
  const restoreEventSource = installMockEventSource();

  const sessionsPayloads: string[][] = [];
  const updatesPayloads: string[][] = [];
  const removedPayloads: string[][] = [];
  const skillsPayloads: string[] = [];

  try {
    const unsubscribe = subscribeSessionsStream({
      onSessions: (sessions) => {
        sessionsPayloads.push(sessions.map((session) => session.id));
      },
      onSessionsUpdate: (sessions) => {
        updatesPayloads.push(sessions.map((session) => session.id));
      },
      onSessionsRemoved: (sessionIds) => {
        removedPayloads.push(sessionIds);
      },
      onSkillsChanged: ({ sessionId }) => {
        skillsPayloads.push(sessionId);
      },
    });

    const eventSource = MockEventSource.instances[0];
    assert.ok(eventSource);
    assert.equal(eventSource.url, "/api/sessions/stream");

    eventSource.emit("sessions", [{ id: "session-a" }]);
    eventSource.emit("sessionsUpdate", [{ id: "session-b" }]);
    eventSource.emit("sessionsRemoved", { sessionIds: ["session-c"] });
    eventSource.emit("skillsChanged", { sessionId: "session-d" });

    assert.deepEqual(sessionsPayloads, [["session-a"]]);
    assert.deepEqual(updatesPayloads, [["session-b"]]);
    assert.deepEqual(removedPayloads, [["session-c"]]);
    assert.deepEqual(skillsPayloads, ["session-d"]);

    unsubscribe();
    assert.equal(eventSource.closed, true);
  } finally {
    restoreEventSource();
  }
});

test("subscribeSessionsStream applies remote delta payloads", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteSessionsDeltaRequests([
    {
      version: 2,
      isFullSnapshot: true,
      sessions: [
        {
          id: "session-a",
          display: "A",
          timestamp: 1,
          project: "/repo",
          projectName: "repo",
        },
      ],
      updates: [],
      removedSessionIds: [],
      skillsChangedSessionIds: [],
    },
    {
      version: 3,
      isFullSnapshot: false,
      sessions: [],
      updates: [
        {
          id: "session-b",
          display: "B",
          timestamp: 2,
          project: "/repo",
          projectName: "repo",
        },
      ],
      removedSessionIds: ["session-c"],
      skillsChangedSessionIds: ["session-d"],
    },
  ]);

  const sessionsPayloads: string[][] = [];
  const updatesPayloads: string[][] = [];
  const removedPayloads: string[][] = [];
  const skillsPayloads: string[] = [];

  try {
    const unsubscribe = subscribeSessionsStream({
      onSessions: (sessions) => {
        sessionsPayloads.push(sessions.map((session) => session.id));
      },
      onSessionsUpdate: (sessions) => {
        updatesPayloads.push(sessions.map((session) => session.id));
      },
      onSessionsRemoved: (sessionIds) => {
        removedPayloads.push(sessionIds);
      },
      onSkillsChanged: ({ sessionId }) => {
        skillsPayloads.push(sessionId);
      },
    });

    await flushAsyncWork();
    assert.deepEqual(sessionsPayloads, [["session-a"]]);
    assert.deepEqual(updatesPayloads, []);
    assert.deepEqual(removedPayloads, []);
    assert.deepEqual(skillsPayloads, []);

    await timerController.runNext();
    assert.deepEqual(updatesPayloads, [["session-b"]]);
    assert.deepEqual(removedPayloads, [["session-c"]]);
    assert.deepEqual(skillsPayloads, ["session-d"]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeWorkflowsStream maps local SSE workflow updates and removals", async () => {
  const restoreEventSource = installMockEventSource();
  const snapshots: string[][] = [];

  try {
    const workflowA = createWorkflowSummaryFixture();
    const workflowB = {
      ...createWorkflowSummaryFixture(),
      key: "workflow-b",
      workflowPath: "/repo/.codex-deck/workflow-b.json",
      id: "workflow-b",
      title: "Workflow B",
      schedulerRunning: false,
      updatedAt: "2026-03-15T00:00:00.000Z",
    };

    const unsubscribe = subscribeWorkflowsStream({
      onWorkflows: (workflows) => {
        snapshots.push(workflows.map((workflow) => workflow.key));
      },
    });

    const eventSource = MockEventSource.instances[0];
    assert.ok(eventSource);
    assert.equal(eventSource.url, "/api/sessions/stream");

    eventSource.emit("workflows", [workflowB]);
    eventSource.emit("workflowsUpdate", [workflowA]);
    eventSource.emit("workflowsRemoved", { workflowKeys: ["workflow-b"] });

    assert.deepEqual(snapshots, [
      ["workflow-b"],
      ["workflow-key", "workflow-b"],
      ["workflow-key"],
    ]);

    unsubscribe();
    assert.equal(eventSource.closed, true);
  } finally {
    restoreEventSource();
  }
});

test("subscribeWorkflowsStream ignores duplicate local SSE payloads", async () => {
  const restoreEventSource = installMockEventSource();
  const snapshots: string[][] = [];

  try {
    const workflow = createWorkflowSummaryFixture();

    const unsubscribe = subscribeWorkflowsStream({
      onWorkflows: (workflows) => {
        snapshots.push(workflows.map((item) => item.key));
      },
    });

    const eventSource = MockEventSource.instances.find(
      (instance) => instance.url === "/api/sessions/stream",
    );
    assert.ok(eventSource);

    eventSource.emit("workflows", [workflow]);
    eventSource.emit("workflows", [workflow]);
    eventSource.emit("workflowsUpdate", [workflow]);

    assert.deepEqual(snapshots, [["workflow-key"]]);

    unsubscribe();
  } finally {
    restoreEventSource();
  }
});

test("local workflow list updates wake the selected workflow detail subscription immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreEventSource = installMockEventSource();
  const initialDetail = createWorkflowDetailFixture();
  const updatedSummary = {
    ...createWorkflowSummaryFixture(),
    updatedAt: "2026-03-16T00:05:00.000Z",
    schedulerRunning: false,
    schedulerLastSessionId: "session-9",
    schedulerThreadId: "thread-9",
    schedulerLastTurnStatus: "completed",
  };
  const updatedDetail = {
    ...initialDetail,
    summary: updatedSummary,
    scheduler: {
      ...initialDetail.scheduler,
      running: false,
      lastSessionId: "session-9",
      threadId: "thread-9",
      lastTurnStatus: "completed",
    },
  } satisfies WorkflowDetailResponse;
  const detailResponses = [initialDetail, updatedDetail];
  let detailRequestIndex = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "/api/workflows/workflow-key" &&
      (init?.method ?? "GET") === "GET"
    ) {
      const response =
        detailResponses[
          Math.min(detailRequestIndex, detailResponses.length - 1)
        ] ?? updatedDetail;
      detailRequestIndex += 1;
      return jsonResponse(response);
    }
    throw new Error(`Unexpected local workflow request: ${url}`);
  };

  const sessionIds: Array<string | null> = [];

  try {
    const unsubscribeDetail = subscribeWorkflowDetailStream("workflow-key", {
      onWorkflowDetail: (detail) => {
        sessionIds.push(detail.scheduler.lastSessionId);
      },
    });
    const unsubscribeWorkflows = subscribeWorkflowsStream({
      onWorkflows: () => {},
    });

    await flushAsyncWork();
    assert.deepEqual(sessionIds, ["session-1"]);
    assert.equal(timerController.minPendingDelay(), 3000);

    const eventSource = MockEventSource.instances.find(
      (instance) => instance.url === "/api/sessions/stream",
    );
    assert.ok(eventSource);
    eventSource.emit("workflowsUpdate", [updatedSummary]);

    await flushAsyncWork();
    assert.deepEqual(sessionIds, ["session-1", "session-9"]);

    unsubscribeWorkflows();
    unsubscribeDetail();
  } finally {
    restoreEventSource();
    restoreTimers();
  }
});

test("subscribeConversationStream synthesizes bootstrap metadata for local SSE", async () => {
  const restoreEventSource = installMockEventSource();
  const batches: Array<{
    uuids: string[];
    phase: string | undefined;
    nextOffset: number | undefined;
    done: boolean | undefined;
  }> = [];
  let heartbeatCount = 0;

  try {
    const unsubscribe = subscribeConversationStream("local-session", {
      onMessages: (messages, batch) => {
        batches.push({
          uuids: messages.map((message) => message.uuid ?? ""),
          phase: batch?.phase,
          nextOffset: batch?.nextOffset,
          done: batch?.done,
        });
      },
      onHeartbeat: () => {
        heartbeatCount += 1;
      },
    });

    const eventSource = MockEventSource.instances[0];
    assert.ok(eventSource);
    assert.equal(
      eventSource.url,
      "/api/conversation/local-session/stream?offset=0",
    );

    eventSource.emit("messages", {
      messages: [
        {
          type: "user",
          uuid: "local-msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        },
      ],
      nextOffset: 10,
    });
    eventSource.emit("heartbeat", { timestamp: 1 });

    assert.deepEqual(batches, [
      {
        uuids: ["local-msg-1"],
        phase: "bootstrap",
        nextOffset: 10,
        done: true,
      },
    ]);
    assert.equal(heartbeatCount, 1);

    unsubscribe();
  } finally {
    restoreEventSource();
  }
});

test("subscribeConversationStream keeps local bootstrap phase until done", async () => {
  const restoreEventSource = installMockEventSource();
  const batches: Array<{
    uuids: string[];
    phase: string | undefined;
    nextOffset: number | undefined;
    done: boolean | undefined;
  }> = [];

  try {
    const unsubscribe = subscribeConversationStream("local-session", {
      onMessages: (messages, batch) => {
        batches.push({
          uuids: messages.map((message) => message.uuid ?? ""),
          phase: batch?.phase,
          nextOffset: batch?.nextOffset,
          done: batch?.done,
        });
      },
    });

    const eventSource = MockEventSource.instances[0];
    assert.ok(eventSource);

    eventSource.emit("messages", {
      messages: [
        {
          type: "user",
          uuid: "local-msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        },
      ],
      nextOffset: 10,
      done: false,
    });
    eventSource.emit("messages", {
      messages: [
        {
          type: "assistant",
          uuid: "local-msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        },
      ],
      nextOffset: 20,
      done: true,
    });

    assert.deepEqual(batches, [
      {
        uuids: ["local-msg-1"],
        phase: "bootstrap",
        nextOffset: 10,
        done: false,
      },
      {
        uuids: ["local-msg-2"],
        phase: "bootstrap",
        nextOffset: 20,
        done: true,
      },
    ]);

    unsubscribe();
  } finally {
    restoreEventSource();
  }
});

test("subscribeConversationStream tags bootstrap and incremental batches", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 10,
      done: false,
    },
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 20,
      done: true,
    },
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-3",
          timestamp: "2026-03-16T00:00:02.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 30,
      done: true,
    },
  ]);

  const phases: string[] = [];

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (_messages, batch) => {
        phases.push(batch?.phase ?? "missing");
      },
    });

    await flushAsyncWork();
    await timerController.runNext();

    assert.deepEqual(phases, ["bootstrap", "incremental"]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeConversationStream emits remote bootstrap immediately and backfills older history", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 4096,
      done: false,
    },
    {
      messages: [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 2048,
      done: true,
    },
  ]);

  const batches: Array<{
    ids: string[];
    phase: string | undefined;
    done: boolean | undefined;
  }> = [];

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (messages, batch) => {
        batches.push({
          ids: messages.map(getMessageIdentifier),
          phase: batch?.phase,
          done: batch?.done,
        });
      },
    });

    await flushAsyncWork();
    await timerController.runNext();

    assert.deepEqual(batches, [
      {
        ids: ["msg-2"],
        phase: "bootstrap",
        done: true,
      },
      {
        ids: ["msg-1"],
        phase: "incremental",
        done: true,
      },
    ]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeConversationStream resumes incrementally from an initial offset", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 20,
      done: true,
    },
  ]);

  const phases: string[] = [];

  try {
    const unsubscribe = subscribeConversationStream(
      "remote-session",
      {
        onMessages: (_messages, batch) => {
          phases.push(batch?.phase ?? "missing");
        },
      },
      { initialOffset: 10 },
    );

    await flushAsyncWork();

    assert.deepEqual(phases, ["incremental"]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeConversationStream emits an empty initial remote snapshot", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [],
      nextOffset: 0,
      done: true,
    },
  ]);
  const messageBatches: ConversationMessage[][] = [];
  let heartbeatCount = 0;

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (messages) => {
        messageBatches.push(messages);
      },
      onHeartbeat: () => {
        heartbeatCount += 1;
      },
    });

    await flushAsyncWork();

    assert.deepEqual(messageBatches, [[]]);
    assert.equal(heartbeatCount, 1);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("sendCodexMessage wakes the active remote conversation subscription immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationAndSendRequests([
    {
      messages: [],
      done: true,
    },
    {
      messages: [
        {
          type: "user",
          uuid: "sent-message",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      done: true,
    },
  ]);
  const messageBatches: string[][] = [];

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (messages) => {
        messageBatches.push(messages.map(getMessageIdentifier));
      },
    });

    await flushAsyncWork();
    assert.deepEqual(messageBatches, [[]]);
    assert.equal(timerController.minPendingDelay(), 1500);

    const response = await sendCodexMessage("remote-session", {
      text: "hello",
    });
    assert.equal(response.ok, true);

    await flushAsyncWork();
    assert.deepEqual(messageBatches[0], []);
    assert.deepEqual(messageBatches.at(-1), ["sent-message"]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("createWorkflow wakes the active remote workflows subscription immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const workflowSummary = {
    key: "remote-flow",
    id: "remote-flow",
    title: "Remote Flow",
    projectRoot: "/repo",
    projectName: "repo",
    status: "pending",
    schedulerRunning: false,
    schedulerPendingTrigger: false,
    targetBranch: "main",
    updatedAt: "2026-03-20T00:00:00.000Z",
    createdAt: "2026-03-20T00:00:00.000Z",
    request: "ship it",
    boundSessionId: null,
    taskCounts: {
      pending: 1,
      running: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      total: 1,
    },
    recentOutcomes: [],
  } satisfies WorkflowSummary;
  const restoreRemoteClient = mockRemoteWorkflowRequests({
    workflows: [[], [workflowSummary]],
  });
  const snapshots: string[][] = [];

  try {
    const unsubscribe = subscribeWorkflowsStream({
      onWorkflows: (workflows) => {
        snapshots.push(workflows.map((workflow) => workflow.key));
      },
    });

    await flushAsyncWork();
    assert.deepEqual(snapshots, [[]]);
    assert.equal(timerController.minPendingDelay(), 5000);

    const response = await createWorkflow({
      title: "Remote Flow",
      request: "ship it",
      projectRoot: "/repo",
    });
    assert.equal(response.workflowKey, "remote-flow");

    await flushAsyncWork();
    assert.deepEqual(snapshots.at(-1), ["remote-flow"]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("startWorkflowDaemon and workflow mutations wake remote workflow detail subscriptions immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const detailBase = {
    summary: {
      key: "remote-flow",
      id: "remote-flow",
      title: "Remote Flow",
      projectRoot: "/repo",
      projectName: "repo",
      status: "pending",
      schedulerRunning: false,
      schedulerPendingTrigger: false,
      targetBranch: "main",
      updatedAt: "2026-03-20T00:00:00.000Z",
      createdAt: "2026-03-20T00:00:00.000Z",
      request: "ship it",
      boundSessionId: null,
      taskCounts: {
        pending: 1,
        running: 0,
        success: 0,
        failed: 0,
        cancelled: 0,
        total: 1,
      },
      recentOutcomes: [],
    },
    boundSessionId: null,
    settings: {
      codexHome: null,
      codexCliPath: null,
      maxParallel: 1,
      mergePolicy: null,
      stopSignal: null,
    },
    scheduler: {
      running: false,
      pendingTrigger: false,
      threadId: null,
      lastSessionId: null,
      lastTurnId: null,
      lastTurnStatus: null,
      lastRunAt: null,
      lastReason: null,
      builtInPrompt: null,
      lastComposedPrompt: null,
      controllerMode: null,
      controlMessages: [],
    },
    tasks: [],
    history: [],
    raw: {},
  } satisfies WorkflowDetailResponse;
  const restoreRemoteClient = mockRemoteWorkflowRequests({
    daemonStatuses: [
      {
        state: "stopped",
        pid: null,
        port: null,
        startedAt: null,
        lastHeartbeatAt: null,
        lastRequestAt: null,
        queueDepth: 0,
        activeProjects: [],
        activeWorkflows: [],
        daemonId: null,
        daemonLogPath: null,
      },
      {
        state: "running",
        pid: 123,
        port: 4567,
        startedAt: "2026-03-20T00:01:00.000Z",
        lastHeartbeatAt: "2026-03-20T00:01:02.000Z",
        lastRequestAt: "2026-03-20T00:01:03.000Z",
        queueDepth: 1,
        activeProjects: ["/repo"],
        activeWorkflows: ["/repo/.codex-deck/remote-flow.json"],
        daemonId: "daemon-1",
        daemonLogPath: "/repo/.codex-deck/logs/daemon.log",
      },
    ],
    details: [
      detailBase,
      {
        ...detailBase,
        summary: {
          ...detailBase.summary,
          schedulerPendingTrigger: true,
          updatedAt: "2026-03-20T00:02:00.000Z",
        },
        scheduler: {
          ...detailBase.scheduler,
          pendingTrigger: true,
        },
      },
    ],
  });
  const daemonStates: string[] = [];
  const pendingTriggerStates: boolean[] = [];

  try {
    const unsubscribeDaemon = subscribeWorkflowDaemonStatusStream({
      onDaemonStatus: (status) => {
        daemonStates.push(status.state);
      },
    });
    const unsubscribeDetail = subscribeWorkflowDetailStream("remote-flow", {
      onWorkflowDetail: (detail) => {
        pendingTriggerStates.push(detail.scheduler.pendingTrigger);
      },
    });

    await flushAsyncWork();
    assert.deepEqual(daemonStates, ["stopped"]);
    assert.deepEqual(pendingTriggerStates, [false]);
    assert.equal(timerController.minPendingDelay(), 3000);

    const daemonResponse = await startWorkflowDaemon();
    assert.equal(daemonResponse.ok, true);

    await flushAsyncWork();
    assert.deepEqual(daemonStates.at(-1), "running");
    assert.deepEqual(pendingTriggerStates.at(-1), true);

    unsubscribeDetail();
    unsubscribeDaemon();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("remote workflow list updates wake the selected workflow detail subscription immediately", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const initialSummary = {
    key: "remote-flow",
    id: "remote-flow",
    title: "Remote Flow",
    projectRoot: "/repo",
    projectName: "repo",
    status: "running",
    schedulerRunning: false,
    schedulerPendingTrigger: false,
    targetBranch: "main",
    updatedAt: "2026-03-20T00:00:00.000Z",
    createdAt: "2026-03-20T00:00:00.000Z",
    request: "ship it",
    boundSessionId: null,
    schedulerLastSessionId: null,
    schedulerThreadId: null,
    schedulerLastReason: null,
    schedulerLastRunAt: null,
    schedulerLastTurnStatus: null,
    maxParallel: 1,
    mergePolicy: null,
    taskCounts: {
      pending: 1,
      running: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      total: 1,
    },
    recentOutcomes: [],
  } satisfies WorkflowSummary;
  const initialDetail = {
    summary: initialSummary,
    boundSessionId: null,
    settings: {
      codexHome: null,
      codexCliPath: null,
      maxParallel: 1,
      mergePolicy: null,
      stopSignal: null,
    },
    scheduler: {
      running: false,
      pendingTrigger: false,
      threadId: null,
      lastSessionId: null,
      lastTurnId: null,
      lastTurnStatus: null,
      lastRunAt: null,
      lastReason: null,
      builtInPrompt: null,
      lastComposedPrompt: null,
      controllerMode: null,
      controlMessages: [],
    },
    tasks: [],
    history: [],
    raw: {},
  } satisfies WorkflowDetailResponse;
  const updatedSummary = {
    ...initialSummary,
    updatedAt: "2026-03-20T00:02:00.000Z",
    schedulerRunning: true,
    schedulerLastSessionId: "scheduler-1",
    schedulerThreadId: "scheduler-1",
    schedulerLastRunAt: "2026-03-20T00:02:00.000Z",
    schedulerLastTurnStatus: "completed",
  };
  const updatedDetail = {
    ...initialDetail,
    summary: updatedSummary,
    scheduler: {
      ...initialDetail.scheduler,
      running: true,
      lastSessionId: "scheduler-1",
      threadId: "scheduler-1",
      lastRunAt: "2026-03-20T00:02:00.000Z",
      lastTurnStatus: "completed",
    },
  } satisfies WorkflowDetailResponse;
  const restoreRemoteClient = mockRemoteWorkflowRequests({
    workflows: [[initialSummary], [updatedSummary]],
    details: [initialDetail, updatedDetail],
  });
  const sessionIds: Array<string | null> = [];

  try {
    const unsubscribeWorkflows = subscribeWorkflowsStream({
      onWorkflows: () => {},
    });
    const unsubscribeDetail = subscribeWorkflowDetailStream("remote-flow", {
      onWorkflowDetail: (detail) => {
        sessionIds.push(detail.scheduler.lastSessionId);
      },
    });

    await flushAsyncWork();
    assert.equal(sessionIds[0], null);

    if (!sessionIds.includes("scheduler-1")) {
      await timerController.runNext();
    }
    assert.ok(sessionIds.includes("scheduler-1"));

    unsubscribeDetail();
    unsubscribeWorkflows();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("getConversation aggregates multiple remote chunks", async () => {
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 4096,
      done: false,
    },
    {
      messages: [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 2048,
      done: true,
    },
  ]);

  try {
    const messages = await getConversation("remote-session");
    assert.deepEqual(messages.map(getMessageIdentifier), ["msg-1", "msg-2"]);
  } finally {
    restoreRemoteClient();
  }
});

test("subscribeConversationStream drains multiple chunks in one poll", async () => {
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteConversationRequests([
    {
      messages: [
        {
          type: "user",
          uuid: "msg-1",
          timestamp: "2026-03-16T00:00:00.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 10,
      done: true,
    },
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-2",
          timestamp: "2026-03-16T00:00:01.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 15,
      done: false,
    },
    {
      messages: [
        {
          type: "assistant",
          uuid: "msg-3",
          timestamp: "2026-03-16T00:00:02.000Z",
        } as ConversationMessage,
      ],
      nextOffset: 20,
      done: true,
    },
  ]);

  const messageBatches: ConversationMessage[][] = [];

  try {
    const unsubscribe = subscribeConversationStream("remote-session", {
      onMessages: (messages) => {
        messageBatches.push(messages);
      },
    });
    await flushAsyncWork();

    await timerController.runNext();
    assert.deepEqual(
      messageBatches.map((batch) => batch.map(getMessageIdentifier)),
      [["msg-1"], ["msg-2", "msg-3"]],
    );

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("subscribeTerminalStream replays remote terminal bootstrap and incremental events", async () => {
  const terminalId = "terminal-1";
  const timerController = new ManualTimerController();
  const restoreTimers = timerController.install();
  const restoreRemoteClient = mockRemoteTerminalEventRequests(terminalId, [
    {
      bootstrap: {
        snapshot: {
          id: terminalId,
          terminalId,
          running: true,
          cwd: "/repo",
          shell: "zsh",
          output: "prompt> ",
          seq: 7,
          writeOwnerId: null,
        },
        artifacts: null,
      },
      events: [{ terminalId, seq: 8, type: "output", chunk: "hello\n" }],
      requiresReset: false,
      snapshot: null,
    },
    {
      events: [],
      requiresReset: true,
      snapshot: {
        id: terminalId,
        terminalId,
        running: true,
        cwd: "/repo",
        shell: "zsh",
        output: "replayed\n",
        seq: 12,
        writeOwnerId: "client-a",
      },
    },
  ]);
  const events: Array<{ type: string; seq: number }> = [];

  try {
    const unsubscribe = subscribeTerminalStream(
      {
        onEvent: (event) => {
          events.push({ type: event.type, seq: event.seq });
        },
      },
      { terminalId, bootstrap: true },
    );

    await flushAsyncWork();
    assert.deepEqual(events, [
      { type: "bootstrap", seq: 7 },
      { type: "output", seq: 8 },
    ]);

    await timerController.runNext();
    assert.deepEqual(events, [
      { type: "bootstrap", seq: 7 },
      { type: "output", seq: 8 },
      { type: "reset", seq: 12 },
      { type: "ownership", seq: 12 },
    ]);

    unsubscribe();
  } finally {
    restoreRemoteClient();
    restoreTimers();
  }
});

test("terminal helper routes request expected endpoints", async () => {
  const terminalId = "terminal-1";
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);

    if (String(input).endsWith(`/api/terminals/${terminalId}/binding`)) {
      if (init?.method === "POST") {
        return jsonResponse({
          terminalId,
          boundSessionId: "session-1",
        });
      }
      return jsonResponse({
        terminalId,
        boundSessionId: null,
      });
    }

    if (String(input).endsWith("/api/terminals/session-roles")) {
      return jsonResponse({
        sessions: [
          {
            sessionId: "session-1",
            role: "terminal",
            terminalId,
          },
        ],
      });
    }

    if (String(input).endsWith("/api/terminals") && init?.method === "POST") {
      return jsonResponse({
        id: terminalId,
        terminalId,
        running: true,
        cwd: "/repo",
        shell: "zsh",
        output: "$ ",
        seq: 6,
        writeOwnerId: null,
      });
    }

    if (String(input).endsWith("/api/terminals")) {
      return jsonResponse({
        terminals: [
          {
            id: terminalId,
            terminalId,
            display: "repo",
            firstCommand: null,
            timestamp: 1,
            project: "/repo",
            projectName: "repo",
            cwd: "/repo",
            shell: "zsh",
            running: true,
          },
        ],
      });
    }

    if (
      String(input).includes("/api/terminals/") &&
      String(input).includes("/input")
    ) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 7,
        writeOwnerId: null,
        startSeq: 6,
        startOffset: 2,
      });
    }

    if (
      String(input).includes("/api/terminals/") &&
      String(input).includes("/resize")
    ) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 8,
        writeOwnerId: null,
      });
    }

    if (
      String(input).includes("/api/terminals/") &&
      String(input).includes("/interrupt")
    ) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 9,
        writeOwnerId: null,
      });
    }

    if (
      String(input).includes("/api/terminals/") &&
      String(input).includes("/restart")
    ) {
      return jsonResponse({
        id: terminalId,
        terminalId,
        running: true,
        cwd: "/repo",
        shell: "zsh",
        output: "",
        seq: 10,
        writeOwnerId: null,
      });
    }

    if (
      String(input).includes(`/api/terminals/${terminalId}`) &&
      init?.method === "DELETE"
    ) {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({
      id: terminalId,
      terminalId,
      running: true,
      cwd: "/repo",
      shell: "zsh",
      output: "$ ",
      seq: 6,
      writeOwnerId: null,
    });
  };

  const created = await createTerminal({ cwd: "/repo" });
  const list = await listActiveTerminals();
  const binding = await getTerminalBinding(terminalId);
  const bound = await bindTerminalSession(terminalId, {
    sessionId: "session-1",
  });
  const sessionRoles = await getTerminalSessionRoles(["session-1"]);
  const snapshot = await getTerminalSnapshot(terminalId);
  const inputResult = await sendTerminalInput(terminalId, { input: "ls\\n" });
  const resizeResult = await resizeTerminal(terminalId, {
    cols: 120,
    rows: 40,
  });
  const interruptResult = await interruptTerminal(terminalId);
  const restarted = await restartTerminal(terminalId);
  const deleted = await deleteTerminal(terminalId);

  assert.equal(created.running, true);
  assert.equal(list.length, 1);
  assert.equal(binding.boundSessionId, null);
  assert.equal(bound.boundSessionId, "session-1");
  assert.equal(sessionRoles[0]?.terminalId, terminalId);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.shell, "zsh");
  assert.equal(inputResult.seq, 7);
  assert.equal(inputResult.startSeq, 6);
  assert.equal(inputResult.startOffset, 2);
  assert.equal(resizeResult.seq, 8);
  assert.equal(interruptResult.seq, 9);
  assert.equal(restarted.seq, 10);
  assert.equal(deleted.ok, true);
  assert.deepEqual(calls, [
    "/api/terminals:POST",
    "/api/terminals:GET",
    `/api/terminals/${terminalId}/binding:GET`,
    `/api/terminals/${terminalId}/binding:POST`,
    "/api/terminals/session-roles:POST",
    `/api/terminals/${terminalId}:GET`,
    `/api/terminals/${terminalId}/input:POST`,
    `/api/terminals/${terminalId}/resize:POST`,
    `/api/terminals/${terminalId}/interrupt:POST`,
    `/api/terminals/${terminalId}/restart:POST`,
    `/api/terminals/${terminalId}:DELETE`,
  ]);
});

test("terminal frozen block helper routes request expected endpoints", async () => {
  const terminalId = "terminal-1";
  const sessionId = "session-1";
  const viewport = { cols: 120, rows: 40 };
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);

    if (
      String(input) ===
        `/api/terminals/${terminalId}/frozen-blocks?sessionId=${sessionId}&cols=${viewport.cols}&rows=${viewport.rows}` &&
      init?.method !== "POST"
    ) {
      return jsonResponse({
        terminalId,
        sessionId,
        manifest: {
          terminalId,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          blocks: [],
        },
        blocks: [
          {
            blockId: "block-1",
            terminalId,
            sessionId,
            kind: "execution",
            sequence: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            messageKey: "message-1",
            stepId: null,
            transcriptPath: "blocks/block-1.txt",
            transcriptLength: 10,
            action: null,
            transcript: "pwd\n/repo\n",
          },
        ],
        timelineEntries: [
          {
            type: "output",
            key: "block:block-1",
            text: "pwd\n/repo\n",
          },
          {
            type: "card",
            key: "card:message-1",
            messageKey: "message-1",
          },
        ],
      });
    }

    if (String(input) === `/api/terminals/${terminalId}/frozen-blocks`) {
      return jsonResponse({
        block: {
          blockId: "block-2",
          terminalId,
          sessionId,
          kind: "manual",
          sequence: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageKey: "message-2",
          stepId: null,
          transcriptPath: "blocks/block-2.txt",
          transcriptLength: 25,
          action: null,
        },
      });
    }

    if (String(input) === `/api/terminals/${terminalId}/message-action`) {
      return jsonResponse({
        terminalId,
        sessionId,
        messageKey: "message-1",
        action: {
          kind: "ai-terminal-step-actions",
          steps: [
            {
              stepId: "step-1",
              decision: "rejected",
              reason: "Use a safer command.",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      });
    }

    return jsonResponse({ error: "unexpected route" }, 404);
  };

  const restored = await getTerminalFrozenBlocks(terminalId, sessionId, viewport);
  const persisted = await persistTerminalFrozenBlock(terminalId, {
    sessionId,
    kind: "manual",
    messageKey: "message-2",
    transcript: "prompt> pwd\n/repo\nprompt>\n",
    sequence: 2,
  });
  const actionPersisted = await persistTerminalMessageAction(terminalId, {
    sessionId,
    messageKey: "message-1",
    stepId: "step-1",
    decision: "rejected",
    reason: "Use a safer command.",
  });

  assert.equal(restored.blocks[0]?.transcript, "pwd\n/repo\n");
  assert.equal(restored.blocks[0]?.messageKey, "message-1");
  assert.deepEqual(restored.timelineEntries, [
    {
      type: "output",
      key: "block:block-1",
      text: "pwd\n/repo\n",
    },
    {
      type: "card",
      key: "card:message-1",
      messageKey: "message-1",
    },
  ]);
  assert.equal(persisted.block.blockId, "block-2");
  assert.equal(actionPersisted.action.steps[0]?.decision, "rejected");
  assert.deepEqual(calls, [
    `/api/terminals/${terminalId}/frozen-blocks?sessionId=${sessionId}&cols=${viewport.cols}&rows=${viewport.rows}:GET`,
    `/api/terminals/${terminalId}/frozen-blocks:POST`,
    `/api/terminals/${terminalId}/message-action:POST`,
  ]);
});

test("getSystemContext requests expected endpoint", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);
    return jsonResponse({
      osName: "macOS",
      osRelease: "macOS 15.4.1",
      osVersion: "15.4.1",
      architecture: "arm64",
      platform: "darwin",
      hostname: "host",
      defaultShell: "/bin/zsh",
    });
  };

  const result = await getSystemContext();
  assert.equal(result.osRelease, "macOS 15.4.1");
  assert.equal(result.defaultShell, "/bin/zsh");
  assert.deepEqual(calls, ["/api/system/context:GET"]);
});

test("runInTerminal sends command and returns incremental output", async () => {
  const terminalId = "terminal-1";
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${path}:${init?.method ?? "GET"}`);

    if (path.includes(`/api/terminals/${terminalId}/input?clientId=`)) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 11,
        writeOwnerId: null,
        startSeq: 10,
        startOffset: 2,
      });
    }

    if (path === `/api/terminals/${terminalId}/events?fromSeq=10&waitMs=2000`) {
      return jsonResponse({
        events: [
          {
            terminalId,
            seq: 11,
            type: "output",
            chunk: "\u001b[32mpwd\u001b[0m\n/repo\n",
          },
        ],
        requiresReset: false,
        snapshot: null,
      });
    }

    if (path === `/api/terminals/${terminalId}/events?fromSeq=11&waitMs=2000`) {
      return jsonResponse({
        events: [],
        requiresReset: false,
        snapshot: null,
      });
    }

    return jsonResponse({ error: `Unexpected path: ${path}` }, 404);
  };

  const result = await runInTerminal("pwd", {
    terminalId,
    clientId: "client-a",
    waitMs: 2000,
    timeoutMs: 6000,
  });

  assert.equal(result.terminalId, terminalId);
  assert.equal(result.clientId, "client-a");
  assert.equal(result.startSeq, 10);
  assert.equal(result.startOffset, 2);
  assert.equal(result.endSeq, 11);
  assert.equal(result.timedOut, false);
  assert.equal(result.output, "\u001b[32mpwd\u001b[0m\n/repo\n");
  assert.equal(result.rawOutput, "pwd\n/repo\n");
  assert.deepEqual(calls, [
    `/api/terminals/${terminalId}/input?clientId=client-a:POST`,
    `/api/terminals/${terminalId}/events?fromSeq=10&waitMs=2000:GET`,
    `/api/terminals/${terminalId}/events?fromSeq=11&waitMs=2000:GET`,
  ]);
});

test("runInTerminal claims write when current owner blocks input", async () => {
  const terminalId = "terminal-1";
  const calls: string[] = [];
  let inputAttempts = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${path}:${init?.method ?? "GET"}`);

    if (path.includes(`/api/terminals/${terminalId}/input?clientId=`)) {
      inputAttempts += 1;
      if (inputAttempts === 1) {
        return jsonResponse(
          { error: "another client owns terminal write" },
          403,
        );
      }
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 4,
        writeOwnerId: "client-a",
        startSeq: 3,
        startOffset: 2,
      });
    }

    if (path === `/api/terminals/${terminalId}/claim-write`) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 4,
        writeOwnerId: "client-a",
      });
    }

    if (path === `/api/terminals/${terminalId}/release-write`) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 4,
        writeOwnerId: null,
      });
    }

    if (path === `/api/terminals/${terminalId}/events?fromSeq=3&waitMs=1000`) {
      return jsonResponse({
        events: [{ terminalId, seq: 4, type: "output", chunk: "ok\n" }],
        requiresReset: false,
        snapshot: null,
      });
    }

    if (path === `/api/terminals/${terminalId}/events?fromSeq=4&waitMs=1000`) {
      return jsonResponse({
        events: [],
        requiresReset: false,
        snapshot: null,
      });
    }

    return jsonResponse({ error: `Unexpected path: ${path}` }, 404);
  };

  const result = await runInTerminal("echo ok", {
    terminalId,
    clientId: "client-a",
  });

  assert.equal(result.output, "ok\n");
  assert.equal(result.rawOutput, "ok\n");
  assert.equal(result.startSeq, 3);
  assert.equal(result.startOffset, 2);
  assert.equal(inputAttempts, 2);
  assert.deepEqual(calls, [
    `/api/terminals/${terminalId}/input?clientId=client-a:POST`,
    `/api/terminals/${terminalId}/claim-write:POST`,
    `/api/terminals/${terminalId}/input?clientId=client-a:POST`,
    `/api/terminals/${terminalId}/events?fromSeq=3&waitMs=1000:GET`,
    `/api/terminals/${terminalId}/events?fromSeq=4&waitMs=1000:GET`,
    `/api/terminals/${terminalId}/release-write:POST`,
  ]);
});

test("executeTerminalCommand delegates unowned-write handling to the backend", async () => {
  const terminalId = "terminal-1";
  const calls: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${path}:${init?.method ?? "GET"}`);

    if (path.includes(`/api/terminals/${terminalId}/execute?clientId=`)) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 9,
        writeOwnerId: "client-a",
        startSeq: 4,
        startOffset: 2,
        endSeq: 9,
        exitCode: 0,
        cwdAfter: "/repo",
        rawOutput: "0 ./a\n0 ./b\n",
        timedOut: false,
      });
    }

    return jsonResponse({ error: `Unexpected path: ${path}` }, 404);
  };

  const result = await executeTerminalCommand(
    terminalId,
    {
      command:
        "find . -type f -print0 | xargs -0 stat -f '%z %N' | sort -n | head -n 4",
      cwd: "/repo",
      displayCommand:
        "find . -type f -print0 | xargs -0 stat -f '%z %N' | sort -n | head -n 4",
    },
    "client-a",
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.cwdAfter, "/repo");
  assert.equal(result.startOffset, 2);
  assert.equal(result.rawOutput, "0 ./a\n0 ./b\n");
  assert.equal(result.timedOut, false);
  assert.deepEqual(calls, [
    `/api/terminals/${terminalId}/execute?clientId=client-a:POST`,
  ]);
});

test("runInTerminal can wait for an explicit completion marker across quiet polls", async () => {
  const terminalId = "terminal-2";
  const calls: string[] = [];
  let eventsCallCount = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${path}:${init?.method ?? "GET"}`);

    if (path.includes(`/api/terminals/${terminalId}/input?clientId=`)) {
      return jsonResponse({
        ok: true,
        id: terminalId,
        terminalId,
        running: true,
        seq: 21,
        writeOwnerId: "client-a",
        startSeq: 20,
        startOffset: 2,
      });
    }

    if (path.startsWith(`/api/terminals/${terminalId}/events?fromSeq=21&`)) {
      eventsCallCount += 1;
      if (eventsCallCount === 1) {
        return jsonResponse({
          events: [],
          requiresReset: false,
          snapshot: null,
        });
      }
      return jsonResponse({
        events: [
          {
            terminalId,
            seq: 22,
            type: "output",
            chunk:
              "__CODEX_DECK_AI_RESULT__ step=largest-files exit=0 cwd=/repo\n",
          },
        ],
        requiresReset: false,
        snapshot: null,
      });
    }

    if (path === `/api/terminals/${terminalId}/events?fromSeq=20&waitMs=1000`) {
      return jsonResponse({
        events: [
          {
            terminalId,
            seq: 21,
            type: "output",
            chunk: "find . -type f\n",
          },
        ],
        requiresReset: false,
        snapshot: null,
      });
    }

    return jsonResponse({ error: `Unexpected path: ${path}` }, 404);
  };

  const result = await runInTerminal("find . -type f", {
    terminalId,
    clientId: "client-a",
    waitMs: 1000,
    timeoutMs: 5000,
    untilPattern: "__CODEX_DECK_AI_RESULT__ step=largest-files ",
  });

  assert.equal(result.endSeq, 22);
  assert.equal(result.startOffset, 2);
  assert.equal(result.timedOut, false);
  assert.equal(
    result.rawOutput,
    "find . -type f\n__CODEX_DECK_AI_RESULT__ step=largest-files exit=0 cwd=/repo\n",
  );
  assert.deepEqual(calls, [
    `/api/terminals/${terminalId}/input?clientId=client-a:POST`,
    `/api/terminals/${terminalId}/events?fromSeq=20&waitMs=1000:GET`,
    `/api/terminals/${terminalId}/events?fromSeq=21&waitMs=1000:GET`,
    `/api/terminals/${terminalId}/events?fromSeq=21&waitMs=1000:GET`,
  ]);
});

test("session skills routes request expected endpoints", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)}:${init?.method ?? "GET"}`);
    if (String(input).endsWith("/skills")) {
      return jsonResponse({
        sessionId: "abc",
        projectPath: "/repo",
        cwd: "/repo",
        skills: [
          {
            name: "openai-docs",
            description: "Use official OpenAI docs.",
            shortDescription: "OpenAI docs",
            interface: {
              displayName: "OpenAI Docs",
              shortDescription: "Docs lookup",
              iconSmall: null,
              iconLarge: null,
              brandColor: null,
              defaultPrompt: null,
            },
            dependencies: null,
            path: "/repo/.codex/skills/openai-docs/SKILL.md",
            scope: "repo",
            enabled: true,
          },
        ],
        errors: [],
        unavailableReason: null,
      });
    }

    return jsonResponse({
      sessionId: "abc",
      path: "/repo/.codex/skills/openai-docs/SKILL.md",
      enabled: false,
      effectiveEnabled: false,
    });
  };

  const skills = await getSessionSkills("abc");
  const toggled = await setSessionSkillEnabled("abc", {
    path: "/repo/.codex/skills/openai-docs/SKILL.md",
    enabled: false,
  });

  assert.equal(skills.skills[0]?.name, "openai-docs");
  assert.equal(toggled.effectiveEnabled, false);
  assert.deepEqual(calls, [
    "/api/sessions/abc/skills:GET",
    "/api/sessions/abc/skills/config:POST",
  ]);
});

test("api helpers throw error payload message on non-2xx responses", async () => {
  globalThis.fetch = async () => {
    return jsonResponse({ error: "bad request" }, 400);
  };

  await assert.rejects(() => listCodexModels(), /bad request/);
});

test("api helpers fall back to status message when error payload is missing", async () => {
  globalThis.fetch = async () => {
    return jsonResponse({ message: "missing error field" }, 500);
  };

  await assert.rejects(
    () => listCodexCollaborationModes(),
    /Request failed with status 500/,
  );
});

test("getCodexThreadState omits turnId query when turnId is blank", async () => {
  let capturedUrl = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return jsonResponse({
      threadId: "thread",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    });
  };

  await getCodexThreadState("thread#1", "   ");
  assert.equal(capturedUrl, "/api/codex/threads/thread%231/state");
});

test("getCodexThreadState coalesces duplicate in-flight requests", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    await flushAsyncWork();
    return jsonResponse({
      threadId: "thread-1",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    });
  };

  const [first, second] = await Promise.all([
    getCodexThreadState("thread-1"),
    getCodexThreadState("thread-1"),
  ]);

  assert.equal(first.threadId, "thread-1");
  assert.equal(second.threadId, "thread-1");
  assert.deepEqual(calls, ["/api/codex/threads/thread-1/state"]);
});

test("listCodexUserInputRequests normalizes invalid payload to empty array", async () => {
  globalThis.fetch = async () => jsonResponse({ requests: "invalid" });

  const requests = await listCodexUserInputRequests("thread-1");
  assert.deepEqual(requests, []);
});
