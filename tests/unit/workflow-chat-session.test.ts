import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationMessage,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import {
  buildStrictTaskCreateApprovalMessage,
  getStrictTaskCreateDirectiveFromMessages,
  getLatestWorkflowCreatePreviewMessage,
  parseStrictTaskCreateAssistantDirective,
  resolveStrictTaskCreateDraft,
  resolveWorkflowChatSessionPlan,
} from "../../web/workflow-chat-session";

function createAssistantMessage(
  text: string,
  turnId?: string | null,
): ConversationMessage {
  return {
    type: "assistant",
    turnId: turnId ?? undefined,
    message: {
      role: "assistant",
      content: text,
    },
  };
}

function createAssistantOutputBlockMessage(
  text: string,
  turnId?: string | null,
): ConversationMessage {
  return {
    type: "assistant",
    turnId: turnId ?? undefined,
    message: {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
        },
      ],
    },
  };
}

function createAssistantToolResultMessage(
  content: string,
  toolName?: string,
): ConversationMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          ...(toolName ? { name: toolName } : {}),
          content,
          is_error: false,
        },
      ],
    },
  };
}

function createWorkflowSummary(
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    key: "workflow-key",
    workflowPath: "/repo/project-a/.codex-deck/workflow.json",
    id: "workflow-id",
    title: "Workflow Title",
    status: "running",
    projectRoot: "/repo/project-a",
    projectName: "project-a",
    targetBranch: "main",
    updatedAt: "2026-03-25T00:00:00.000Z",
    createdAt: "2026-03-25T00:00:00.000Z",
    request: "Do the work",
    boundSessionId: null,
    schedulerRunning: false,
    schedulerPendingTrigger: false,
    schedulerLastSessionId: "scheduler-session",
    schedulerThreadId: "scheduler-thread",
    schedulerLastReason: null,
    schedulerLastRunAt: null,
    schedulerLastTurnStatus: null,
    maxParallel: 1,
    mergePolicy: "integration-branch",
    taskCounts: {
      total: 1,
      pending: 0,
      running: 1,
      success: 0,
      failed: 0,
      blocked: 0,
    },
    recentOutcomes: [],
    ...overrides,
  };
}

function createWorkflowDetail(
  overrides: Partial<WorkflowDetailResponse> = {},
): WorkflowDetailResponse {
  return {
    summary: createWorkflowSummary(),
    boundSessionId: null,
    settings: {
      codexHome: null,
      codexCliPath: "codex",
      maxParallel: 1,
      mergePolicy: "integration-branch",
      stopSignal: "[codex-deck:stop-pending]",
    },
    scheduler: {
      running: false,
      pendingTrigger: false,
      lastRunAt: null,
      lastSessionId: "scheduler-session",
      threadId: "scheduler-thread",
      lastTurnId: null,
      lastTurnStatus: null,
      lastReason: null,
      controllerMode: null,
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

test("workflow chat opens an existing bound session without changing the project filter", () => {
  const plan = resolveWorkflowChatSessionPlan(
    createWorkflowDetail({
      boundSessionId: " bound-session ",
    }),
  );

  assert.deepEqual(plan, {
    kind: "open-bound-session",
    sessionId: "bound-session",
    projectRoot: "/repo/project-a",
    preserveProjectFilter: true,
  });
});

test("workflow chat creates and binds a new session without changing the project filter", () => {
  const plan = resolveWorkflowChatSessionPlan(createWorkflowDetail());

  assert.deepEqual(plan, {
    kind: "create-bound-session",
    workflowId: "workflow-id",
    projectRoot: "/repo/project-a",
    preserveProjectFilter: true,
  });
});

test("workflow chat reports an error when no workflow ID exists yet", () => {
  const baseDetail = createWorkflowDetail();
  const plan = resolveWorkflowChatSessionPlan(
    createWorkflowDetail({
      summary: {
        ...baseDetail.summary,
        id: "   ",
      },
    }),
  );

  assert.deepEqual(plan, {
    kind: "error",
    message: "This workflow does not have a workflow ID.",
  });
});

test("workflow chat creation does not require a scheduler session ID", () => {
  const baseDetail = createWorkflowDetail();
  const plan = resolveWorkflowChatSessionPlan(
    createWorkflowDetail({
      scheduler: {
        ...baseDetail.scheduler,
        lastSessionId: "   ",
      },
      summary: {
        ...baseDetail.summary,
        schedulerLastSessionId: "   ",
      },
    }),
  );

  assert.deepEqual(plan, {
    kind: "create-bound-session",
    workflowId: "workflow-id",
    projectRoot: "/repo/project-a",
    preserveProjectFilter: true,
  });
});

test("workflow chat reports an error when creating a bound session without a project path", () => {
  const baseDetail = createWorkflowDetail();
  const plan = resolveWorkflowChatSessionPlan(
    createWorkflowDetail({
      summary: {
        ...baseDetail.summary,
        projectRoot: "   ",
      },
    }),
  );

  assert.deepEqual(plan, {
    kind: "error",
    message: "This workflow does not have a project path.",
  });
});

test("strict task create parser detects question suffix", () => {
  assert.deepEqual(
    parseStrictTaskCreateAssistantDirective(
      "Need one more detail. <codex-deck-flow>Question<codex-deck-flow/>",
    ),
    { kind: "question" },
  );
});

test("strict task create parser detects request approve suffix", () => {
  assert.deepEqual(
    parseStrictTaskCreateAssistantDirective(
      "Please approve this workflow. <codex-deck-flow>Request approve:feature-delivery.json<codex-deck-flow/>   ",
    ),
    {
      kind: "request-approve",
      workflowFileName: "feature-delivery.json",
    },
  );
});

test("strict task create parser ignores malformed suffix", () => {
  assert.deepEqual(
    parseStrictTaskCreateAssistantDirective(
      "Please approve this workflow. <codex-deck-flow>Request approve:<codex-deck-flow/>",
    ),
    { kind: "none" },
  );
});

test("strict task create parser ignores suffix when more text follows", () => {
  assert.deepEqual(
    parseStrictTaskCreateAssistantDirective(
      "Please approve. <codex-deck-flow>Request approve:feature.json<codex-deck-flow/> extra",
    ),
    { kind: "none" },
  );
});

test("strict task create draft resolver matches exact workflow path", () => {
  const draft = resolveStrictTaskCreateDraft(
    [
      createWorkflowSummary({
        key: "feature-delivery",
        workflowPath: "/repo/project-a/.codex-deck/feature-delivery.json",
        id: "feature-delivery",
      }),
      createWorkflowSummary({
        key: "other-workflow",
        workflowPath: "/repo/project-a/.codex-deck/other-workflow.json",
        id: "other-workflow",
      }),
    ],
    "/repo/project-a",
    "feature-delivery.json",
  );

  assert.deepEqual(draft, {
    workflowKey: "feature-delivery",
    workflowPath: "/repo/project-a/.codex-deck/feature-delivery.json",
    workflowId: "feature-delivery",
    workflowFileName: "feature-delivery.json",
    projectRoot: "/repo/project-a",
  });
});

test("strict task create draft resolver returns null when workflow is missing", () => {
  assert.equal(
    resolveStrictTaskCreateDraft(
      [createWorkflowSummary()],
      "/repo/project-a",
      "missing.json",
    ),
    null,
  );
});

test("strict task create approval message includes workflow reuse data", () => {
  assert.equal(
    buildStrictTaskCreateApprovalMessage(
      {
        workflowKey: "feature-delivery",
        workflowPath: "/repo/project-a/.codex-deck/feature-delivery.json",
        workflowId: "feature-delivery",
        workflowFileName: "feature-delivery.json",
        projectRoot: "/repo/project-a",
        boundSessionId: null,
      },
      "session-123",
    ),
    'Approve. The workflow draft already exists. Do not create it again. Reuse the existing workflow and continue from it.\n\nWorkflow data:\n{"workflowPath":"/repo/project-a/.codex-deck/feature-delivery.json","workflowFileName":"feature-delivery.json","workflowId":"feature-delivery","projectRoot":"/repo/project-a","boundSessionId":"session-123"}',
  );
});

test("strict task create directive falls back to latest assistant message when turn id is missing", () => {
  assert.deepEqual(
    getStrictTaskCreateDirectiveFromMessages([
      createAssistantMessage("Older reply"),
      createAssistantMessage(
        "Approve this draft.<codex-deck-flow>Request approve:two-number-scripts.json<codex-deck-flow/>",
      ),
    ]),
    {
      kind: "request-approve",
      workflowFileName: "two-number-scripts.json",
    },
  );
});

test("strict task create directive falls back to latest strict reply when turn id does not match stored messages", () => {
  assert.deepEqual(
    getStrictTaskCreateDirectiveFromMessages(
      [
        createAssistantMessage(
          "Old draft.<codex-deck-flow>Request approve:old.json<codex-deck-flow/>",
          "turn-old",
        ),
        createAssistantOutputBlockMessage(
          "New draft.<codex-deck-flow>Request approve:number-scripts.json<codex-deck-flow/>",
          null,
        ),
      ],
      "turn-new",
    ),
    {
      kind: "request-approve",
      workflowFileName: "number-scripts.json",
    },
  );
});

test("strict task create directive prefers assistant message from the requested turn", () => {
  assert.deepEqual(
    getStrictTaskCreateDirectiveFromMessages(
      [
        createAssistantMessage(
          "Old draft.<codex-deck-flow>Request approve:old.json<codex-deck-flow/>",
          "turn-old",
        ),
        createAssistantMessage(
          "New draft.<codex-deck-flow>Request approve:new.json<codex-deck-flow/>",
          "turn-new",
        ),
      ],
      "turn-new",
    ),
    {
      kind: "request-approve",
      workflowFileName: "new.json",
    },
  );
});

test("strict task create directive accepts summary messages", () => {
  assert.deepEqual(
    getStrictTaskCreateDirectiveFromMessages([
      {
        type: "summary",
        turnId: "turn-summary",
        summary:
          "Ready.<codex-deck-flow>Request approve:two-number-scripts.json<codex-deck-flow/>",
      },
    ]),
    {
      kind: "request-approve",
      workflowFileName: "two-number-scripts.json",
    },
  );
});

test("strict task create directive accepts assistant output_text blocks", () => {
  assert.deepEqual(
    getStrictTaskCreateDirectiveFromMessages([
      createAssistantOutputBlockMessage(
        "Ready.<codex-deck-flow>Request approve:number-scripts.json<codex-deck-flow/>",
        "turn-output",
      ),
    ]),
    {
      kind: "request-approve",
      workflowFileName: "number-scripts.json",
    },
  );
});

test("workflow create preview shows the latest visible non-user important message", () => {
  const preview = getLatestWorkflowCreatePreviewMessage([
    createAssistantToolResultMessage("Older command output", "exec_command"),
    createAssistantMessage("Latest plain text reply"),
  ]);

  assert.deepEqual(preview, createAssistantMessage("Latest plain text reply"));
});

test("workflow create preview ignores later user messages but does not show hidden default messages", () => {
  const blockReply = createAssistantToolResultMessage(
    "Build failed",
    "exec_command",
  );

  const preview = getLatestWorkflowCreatePreviewMessage([
    blockReply,
    {
      type: "user",
      message: {
        role: "user",
        content: "try again",
      },
    },
  ]);

  assert.equal(preview, null);
});

test("workflow create preview skips hidden default-segment messages and falls back to the latest important message", () => {
  const preview = getLatestWorkflowCreatePreviewMessage([
    createAssistantToolResultMessage("Initial command output", "exec_command"),
    createAssistantMessage("Later plain text reply"),
    createAssistantToolResultMessage("Later hidden output", "exec_command"),
  ]);

  assert.deepEqual(preview, createAssistantMessage("Later plain text reply"));
});

test("workflow create preview ignores reasoning because it is not an important viewport message", () => {
  const reasoningMessage: ConversationMessage = {
    type: "reasoning",
    message: {
      role: "assistant",
      content: "internal reasoning block",
    },
  };

  const preview = getLatestWorkflowCreatePreviewMessage([
    createAssistantMessage("visible text reply"),
    reasoningMessage,
  ]);

  assert.deepEqual(preview, createAssistantMessage("visible text reply"));
});
