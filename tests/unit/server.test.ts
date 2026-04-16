import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  setCodexAppServerClientForTests,
  type CodexAppServerClientFacade,
} from "../../api/codex-app-server";
import {
  setLocalTerminalManagerForTests,
  type LocalTerminalManager,
} from "../../api/local-terminal";
import { INTERNAL_REMOTE_PROXY_ACCESS_HEADER } from "../../api/remote/internal-proxy";
import { createServer } from "../../api/server";
import { loadStorage } from "../../api/storage";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
  sessionMetaLine,
  writeSessionFile,
} from "./test-utils";

const SESSION_ID = "12345678-1234-1234-1234-1234567890ab";
const TASK_SESSION_ID = "22345678-1234-1234-1234-1234567890ab";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
  });
}

function hasCommand(command: string, args: string[] = ["--version"]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasWorkflowCommandTooling(): boolean {
  const hasPython =
    hasCommand("python3") ||
    hasCommand("python") ||
    hasCommand("py", ["-3", "--version"]);
  if (!hasPython) {
    return false;
  }
  if (process.platform === "win32" && !hasCommand("bash", ["--version"])) {
    return false;
  }
  return existsSync(
    join(
      process.cwd(),
      ".claude",
      "skills",
      "codex-deck-flow",
      "scripts",
      "run.sh",
    ),
  );
}

async function symlinkOrCopy(sourcePath: string, targetPath: string) {
  try {
    await symlink(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    await copyFile(sourcePath, targetPath);
  }
}

async function assertSamePath(actualPath: string, expectedPath: string) {
  assert.equal(await realpath(actualPath), await realpath(expectedPath));
}

async function requestJson(
  server: ReturnType<typeof createServer>,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await server.app.request(path, init);
  const body = await response.json();
  return {
    status: response.status,
    body,
  };
}

interface SseEventRecord {
  event: string;
  data: string;
}

async function readSseEvents(
  response: Response,
  expectedEvents: string[],
  timeoutMs: number = 200,
): Promise<SseEventRecord[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "expected response body reader");
  const decoder = new TextDecoder();
  const events: SseEventRecord[] = [];
  const expectedSet = new Set(expectedEvents);
  const seenExpected = new Set<string>();
  let buffer = "";

  const parseBuffer = () => {
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const lines = rawEvent.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      if (dataLines.length > 0) {
        events.push({
          event: eventName,
          data: dataLines.join("\n"),
        });
        if (expectedSet.has(eventName)) {
          seenExpected.add(eventName);
        }
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  };

  try {
    while (seenExpected.size < expectedSet.size) {
      const nextChunk = (await Promise.race([
        reader.read(),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        }),
      ])) as ReadableStreamReadResult<Uint8Array> | { timedOut: true };

      if ("timedOut" in nextChunk) {
        break;
      }
      if (nextChunk.done) {
        break;
      }

      buffer += decoder.decode(nextChunk.value, { stream: true });
      parseBuffer();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return events;
}

test("server routes return sessions/projects/conversation/context and fix dangling", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-core");
  const server = createServer({ port: 13001, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "hello server"),
      eventMsgLine({ type: "task_started", turn_id: "turn-1" }),
    ]);

    await loadStorage();

    const sessions = await requestJson(server, "/api/sessions");
    assert.equal(sessions.status, 200);
    assert.equal(
      (sessions.body as Array<{ id: string }>).some(
        (session) => session.id === SESSION_ID,
      ),
      true,
    );

    const sessionsDelta = await requestJson(server, "/api/sessions/delta");
    assert.equal(sessionsDelta.status, 200);
    assert.equal(
      (sessionsDelta.body as { isFullSnapshot?: boolean }).isFullSnapshot,
      true,
    );
    assert.equal(
      (
        sessionsDelta.body as { sessions?: Array<{ id: string }> }
      ).sessions?.some((session) => session.id === SESSION_ID),
      true,
    );

    const projects = await requestJson(server, "/api/projects");
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.body, ["/repo/app"]);

    await writeFile(
      join(rootDir, "config.toml"),
      ['model = "gpt-5.4"', 'model_reasoning_effort = "xhigh"'].join("\n"),
      "utf-8",
    );

    const defaults = await requestJson(server, "/api/codex/defaults");
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.body, {
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      planModeReasoningEffort: null,
    });

    const conversation = await requestJson(
      server,
      `/api/conversation/${SESSION_ID}`,
    );
    assert.equal(conversation.status, 200);
    assert.equal(
      Array.isArray(conversation.body) &&
        conversation.body.some(
          (message: { type?: string }) => message.type === "user",
        ),
      true,
    );

    const context = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/context`,
    );
    assert.equal(context.status, 200);
    assert.equal(
      (context.body as { sessionId?: string }).sessionId,
      SESSION_ID,
    );

    const fix = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/fix-dangling`,
      {
        method: "POST",
      },
    );
    assert.equal(fix.status, 200);
    assert.deepEqual(
      (fix.body as { danglingTurnIds?: string[] }).danglingTurnIds,
      ["turn-1"],
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("conversation chunk route returns bounded chunks with offsets", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-conversation-chunk",
  );
  const server = createServer({ port: 13017, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      responseItemMessageLine("user", "first chunk message ".repeat(80)),
      responseItemMessageLine("assistant", "second chunk message ".repeat(80)),
      responseItemMessageLine("assistant", "third chunk message ".repeat(80)),
    ]);

    await loadStorage();

    const firstChunk = await requestJson(
      server,
      `/api/conversation/${SESSION_ID}/chunk?offset=0&maxPayloadBytes=256`,
    );
    assert.equal(firstChunk.status, 200);
    assert.equal(
      Array.isArray((firstChunk.body as { messages?: unknown[] }).messages),
      true,
    );
    assert.equal(
      ((firstChunk.body as { messages?: unknown[] }).messages?.length ?? 0) > 0,
      true,
    );
    assert.equal(
      ((firstChunk.body as { nextOffset?: number }).nextOffset ?? 0) > 0,
      true,
    );
    assert.equal((firstChunk.body as { done?: boolean }).done, false);

    const firstOffset =
      (firstChunk.body as { nextOffset?: number }).nextOffset ?? 0;
    const secondChunk = await requestJson(
      server,
      `/api/conversation/${SESSION_ID}/chunk?offset=${firstOffset}&maxPayloadBytes=256`,
    );
    assert.equal(secondChunk.status, 200);
    assert.equal(
      ((secondChunk.body as { nextOffset?: number }).nextOffset ?? 0) >
        firstOffset,
      true,
    );

    const rawChunk = await requestJson(
      server,
      `/api/conversation/${SESSION_ID}/raw-chunk?offset=0&maxBytes=64`,
    );
    assert.equal(rawChunk.status, 200);
    assert.equal(
      typeof (rawChunk.body as { chunkBase64?: unknown }).chunkBase64,
      "string",
    );
    assert.equal(
      Buffer.from(
        (rawChunk.body as { chunkBase64: string }).chunkBase64,
        "base64",
      ).length <= 64,
      true,
    );
    assert.equal(
      ((rawChunk.body as { nextOffset?: number }).nextOffset ?? 0) > 0,
      true,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("sessions stream carries sessions, terminals, and workflows snapshots", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-global-stream");
  const server = createServer({ port: 13018, codexDir: rootDir, open: false });
  const terminalId = "terminal-global-1";
  const manager: LocalTerminalManager = {
    listTerminals: () => [
      {
        id: terminalId,
        terminalId,
        display: "repo",
        firstCommand: null,
        timestamp: 1,
        project: "/repo/app",
        projectName: "app",
        cwd: "/repo/app",
        shell: "zsh",
        running: true,
      },
    ],
    createTerminal: () => {
      throw new Error("not implemented");
    },
    closeTerminal: async () => false,
    getSnapshot: () => null,
    writeInput: () => undefined,
    resize: () => undefined,
    interrupt: () => undefined,
    restart: () => null,
    subscribeTerminal: () => () => {},
    subscribeTerminals: () => () => {},
    getEventsSince: () => ({ events: [], requiresReset: false }),
    claimWrite: () => undefined,
    releaseWrite: () => undefined,
    isWriteOwner: () => false,
  };

  try {
    setLocalTerminalManagerForTests(manager);
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "global stream"),
    ]);

    await loadStorage();

    const response = await server.app.request("/api/sessions/stream");
    assert.equal(response.status, 200);

    const events = await readSseEvents(response, [
      "sessions",
      "terminals",
      "workflows",
    ]);
    const eventMap = new Map(events.map((event) => [event.event, event.data]));

    assert.ok(eventMap.has("sessions"));
    assert.ok(eventMap.has("terminals"));
    assert.ok(eventMap.has("workflows"));

    const sessions = JSON.parse(eventMap.get("sessions") ?? "[]") as Array<{
      id: string;
    }>;
    const terminals = JSON.parse(eventMap.get("terminals") ?? "[]") as Array<{
      terminalId: string;
    }>;
    const workflows = JSON.parse(eventMap.get("workflows") ?? "[]") as unknown[];

    assert.equal(
      sessions.some((session) => session.id === SESSION_ID),
      true,
    );
    assert.equal(
      terminals.some((terminal) => terminal.terminalId === terminalId),
      true,
    );
    assert.deepEqual(workflows, []);
  } finally {
    setLocalTerminalManagerForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal stream can include bound session conversation batches", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-terminal-bound-session-stream");
  const server = createServer({ port: 13019, codexDir: rootDir, open: false });
  const terminalId = "terminal-bound-1";
  const manager: LocalTerminalManager = {
    listTerminals: () => [],
    createTerminal: () => {
      throw new Error("not implemented");
    },
    closeTerminal: async () => false,
    getSnapshot: (requestedTerminalId: string) =>
      requestedTerminalId === terminalId
        ? {
            id: terminalId,
            terminalId,
            running: true,
            cwd: "/repo/app",
            shell: "zsh",
            output: "",
            seq: 7,
            writeOwnerId: null,
          }
        : null,
    writeInput: () => undefined,
    resize: () => undefined,
    interrupt: () => undefined,
    restart: () => null,
    subscribeTerminal: () => () => {},
    subscribeTerminals: () => () => {},
    getEventsSince: () => ({ events: [], requiresReset: false }),
    claimWrite: () => undefined,
    releaseWrite: () => undefined,
    isWriteOwner: () => false,
  };

  try {
    setLocalTerminalManagerForTests(manager);
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("assistant", "terminal-bound reply"),
    ]);

    await loadStorage();

    const response = await server.app.request(
      `/api/terminals/${terminalId}/stream?fromSeq=0&conversationSessionId=${SESSION_ID}&conversationOffset=0`,
    );
    assert.equal(response.status, 200);

    const events = await readSseEvents(response, ["conversationMessages"]);
    const conversationEvent = events.find(
      (event) => event.event === "conversationMessages",
    );
    assert.ok(conversationEvent);

    const payload = JSON.parse(conversationEvent.data) as {
      messages?: Array<{ type?: string }>;
      nextOffset?: number;
      done?: boolean;
    };
    assert.equal(Array.isArray(payload.messages), true);
    assert.equal(
      payload.messages?.some((message) => message.type === "assistant"),
      true,
    );
    assert.equal(typeof payload.nextOffset, "number");
    assert.equal(payload.done, true);
  } finally {
    setLocalTerminalManagerForTests(null);
    server.stop();
    await cleanup();
  }
});

test("server returns 404 when fixing dangling for unknown session", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("server-fix-404");
  const server = createServer({ port: 13002, codexDir: rootDir, open: false });

  try {
    await loadStorage();

    const response = await requestJson(
      server,
      "/api/sessions/deadbeef-dead-beef-dead-beefdeadbeef/fix-dangling",
      { method: "POST" },
    );

    assert.equal(response.status, 404);
    assert.match(
      (response.body as { error?: string }).error ?? "",
      /session file not found/i,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("server delete and exists routes remove a session", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-delete-session",
  );
  const server = createServer({ port: 13003, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "delete from server"),
    ]);

    await loadStorage();

    const existsBefore = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/exists`,
    );
    assert.equal(existsBefore.status, 200);
    assert.equal((existsBefore.body as { exists?: boolean }).exists, true);

    const deleted = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}?clientId=test-client`,
      {
        method: "DELETE",
      },
    );
    assert.equal(deleted.status, 200);
    assert.equal(
      (deleted.body as { sessionId?: string }).sessionId,
      SESSION_ID,
    );

    const existsAfter = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/exists`,
    );
    assert.equal(existsAfter.status, 200);
    assert.equal((existsAfter.body as { exists?: boolean }).exists, false);

    const sessions = await requestJson(server, "/api/sessions");
    assert.equal(
      Array.isArray(sessions.body) &&
        sessions.body.some(
          (session: { id?: string }) => session.id === SESSION_ID,
        ),
      false,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("server delete route returns 404 when session does not exist", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("server-delete-404");
  const server = createServer({ port: 13016, codexDir: rootDir, open: false });

  try {
    await loadStorage();

    const response = await requestJson(
      server,
      "/api/sessions/deadbeef-dead-beef-dead-beefdeadbeef",
      {
        method: "DELETE",
      },
    );

    assert.equal(response.status, 404);
    assert.match(
      (response.body as { error?: string }).error ?? "",
      /session not found/i,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("workflow create route creates an empty workflow without requiring the codex-deck-flow skill", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflow-create-empty",
  );
  const projectDir = join(rootDir, "repo");
  const server = createServer({ port: 13024, codexDir: rootDir, open: false });

  try {
    await mkdir(projectDir, { recursive: true });
    runGit(projectDir, ["init", "-b", "main"]);
    runGit(projectDir, ["config", "user.name", "Test User"]);
    runGit(projectDir, ["config", "user.email", "test@example.com"]);
    await writeFile(join(projectDir, "README.md"), "base\n", "utf-8");
    runGit(projectDir, ["add", "README.md"]);
    runGit(projectDir, ["commit", "-m", "base"]);

    const createResponse = await requestJson(server, "/api/workflows/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "feature-delivery",
        request: "Empty workflow scaffold",
        projectRoot: projectDir,
        workflowId: "feature-delivery",
        tasksJson: "[]",
      }),
    });
    assert.equal(createResponse.status, 200);

    const created = createResponse.body as {
      ok?: boolean;
      workflowKey?: string;
      workflowPath?: string;
    };
    assert.equal(created.ok, true);
    assert.match(created.workflowKey ?? "", /^[0-9a-f]{12}--feature-delivery$/);
    assert.equal(
      created.workflowPath,
      join(projectDir, ".codex-deck", "feature-delivery.json"),
    );

    const workflowPayload = JSON.parse(
      await readFile(created.workflowPath as string, "utf-8"),
    ) as {
      workflow: {
        id?: string;
        title?: string;
        request?: string;
        projectRoot?: string;
        status?: string;
        targetBranch?: string;
      };
      scheduler?: {
        builtInPrompt?: string;
      };
      settings?: {
        codexHome?: string;
        maxParallel?: number;
      };
      tasks?: unknown[];
      history?: Array<{ type?: string; details?: { taskCount?: number } }>;
    };
    assert.equal(workflowPayload.workflow.id, "feature-delivery");
    assert.equal(workflowPayload.workflow.title, "feature-delivery");
    assert.equal(workflowPayload.workflow.request, "Empty workflow scaffold");
    assert.equal(workflowPayload.workflow.projectRoot, projectDir);
    assert.equal(workflowPayload.workflow.status, "draft");
    assert.equal(workflowPayload.workflow.targetBranch, "main");
    assert.equal(workflowPayload.settings?.codexHome, rootDir);
    assert.equal(workflowPayload.settings?.maxParallel, 1);
    assert.equal(Array.isArray(workflowPayload.tasks), true);
    assert.equal(workflowPayload.tasks?.length, 0);
    assert.equal(workflowPayload.history?.[0]?.type, "workflow_created");
    assert.equal(workflowPayload.history?.[0]?.details?.taskCount, 0);
    assert.match(
      workflowPayload.scheduler?.builtInPrompt ?? "",
      /You are the runtime scheduler for this workflow\./,
    );

    const registryPath = join(
      rootDir,
      "codex-deck",
      "workflows",
      `${created.workflowKey as string}.json`,
    );
    const registryPayload = JSON.parse(
      await readFile(registryPath, "utf-8"),
    ) as {
      workflow?: {
        id?: string;
        title?: string;
      };
      taskCounts?: {
        total?: number;
      };
    };
    assert.equal(registryPayload.workflow?.id, "feature-delivery");
    assert.equal(registryPayload.workflow?.title, "feature-delivery");
    assert.equal(registryPayload.taskCounts?.total, 0);

    const listResponse = await requestJson(server, "/api/workflows");
    assert.equal(listResponse.status, 200);
    assert.equal(
      (
        (listResponse.body as { workflows?: Array<{ key?: string }> })
          .workflows ?? []
      ).some((workflow) => workflow.key === created.workflowKey),
      true,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("workflow routes list detail logs and preview using registry data", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-workflows");
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowLogsDir = join(workflowDir, "logs");
  const workflowWorktreesDir = join(workflowDir, "worktrees");
  const workflowPath = join(workflowDir, "demo-flow.json");
  const workflowLockPath = join(workflowDir, "demo-flow.lock");
  const taskWorktreePath = join(workflowWorktreesDir, "task-a");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const sessionIndexDir = join(registryDir, "session-index");
  const daemonDir = join(rootDir, "codex-deck", "workflows", "daemon-state");
  const server = createServer({
    port: 13019,
    codexDir: rootDir,
    open: false,
  });

  try {
    await mkdir(projectDir, { recursive: true });
    await mkdir(workflowLogsDir, { recursive: true });
    await mkdir(workflowWorktreesDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await mkdir(daemonDir, { recursive: true });
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, projectDir, Date.now()),
      responseItemMessageLine("user", "workflow routes please"),
    ]);

    runGit(projectDir, ["init", "-b", "main"]);
    runGit(projectDir, ["config", "user.name", "Test User"]);
    runGit(projectDir, ["config", "user.email", "test@example.com"]);
    await writeFile(join(projectDir, "README.md"), "base\n", "utf-8");
    runGit(projectDir, ["add", "README.md"]);
    runGit(projectDir, ["commit", "-m", "base"]);
    runGit(projectDir, ["checkout", "-b", "flow/demo-flow/task-a"]);
    await writeFile(join(projectDir, "feature.txt"), "feature\n", "utf-8");
    runGit(projectDir, ["add", "feature.txt"]);
    runGit(projectDir, ["commit", "-m", "task a"]);
    runGit(projectDir, ["checkout", "main"]);
    runGit(projectDir, ["branch", "flow/demo-flow/task-b"]);
    runGit(projectDir, ["branch", "flow/demo-flow/integration"]);
    runGit(projectDir, [
      "worktree",
      "add",
      taskWorktreePath,
      "flow/demo-flow/task-a",
    ]);

    const workflowPayload = {
      workflow: {
        id: "demo-flow",
        title: "Demo Flow",
        createdAt: "2026-03-25T00:00:00Z",
        updatedAt: "2026-03-25T00:05:00Z",
        status: "running",
        targetBranch: "main",
        projectRoot: projectDir,
        request: "test workflow route coverage",
      },
      scheduler: {
        running: false,
        pendingTrigger: false,
        lastRunAt: "2026-03-25T00:05:00Z",
        lastSessionId: SESSION_ID,
        threadId: SESSION_ID,
        lastTurnId: "turn-123",
        lastTurnStatus: "completed",
        lastReason: "manual",
        controllerMode: "daemon",
        controller: { daemonId: "daemon-1" },
        builtInPrompt: "prompt",
        lastComposedPrompt: "composed",
        controlMessages: [],
      },
      settings: {
        codexHome: rootDir,
        codexCliPath: "codex",
        maxParallel: 2,
        mergePolicy: "integration-branch",
        stopSignal: "[codex-deck:stop-pending]",
      },
      tasks: [
        {
          id: "task-a",
          name: "Task A",
          prompt: "Do task A",
          dependsOn: [],
          status: "success",
          sessionId: TASK_SESSION_ID,
          branchName: "flow/demo-flow/task-a",
          worktreePath: taskWorktreePath,
          baseCommit: "abc123",
          resultCommit: "def456",
          startedAt: "2026-03-25T00:01:00Z",
          finishedAt: "2026-03-25T00:02:00Z",
          summary: "Task A complete",
          failureReason: null,
          noOp: false,
          stopPending: false,
          runnerPid: null,
        },
        {
          id: "task-b",
          name: "Task B",
          prompt: "Do task B",
          dependsOn: ["task-a"],
          status: "pending",
          sessionId: null,
          branchName: "flow/demo-flow/task-b",
          worktreePath: null,
          baseCommit: null,
          resultCommit: null,
          startedAt: null,
          finishedAt: null,
          summary: null,
          failureReason: null,
          noOp: false,
          stopPending: false,
          runnerPid: null,
        },
      ],
      history: [
        {
          at: "2026-03-25T00:00:00Z",
          type: "workflow_created",
          details: { taskCount: 2 },
        },
      ],
    };

    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowPayload, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(workflowLockPath, "", "utf-8");
    await writeFile(
      join(workflowLogsDir, "scheduler.log"),
      "main log\n",
      "utf-8",
    );
    await writeFile(
      join(workflowLogsDir, "task-a.log"),
      "task a log\n",
      "utf-8",
    );
    await writeFile(
      join(daemonDir, "state.json"),
      `${JSON.stringify(
        {
          state: "running",
          pid: 123,
          port: 456,
          startedAt: "2026-03-25T00:00:00Z",
          lastHeartbeatAt: "2026-03-25T00:05:00Z",
          lastRequestAt: "2026-03-25T00:05:01Z",
          queueDepth: 1,
          activeProjects: [projectDir],
          activeWorkflows: [workflowPath],
          daemonId: "daemon-1",
          daemonLogPath: join(daemonDir, "daemon.log"),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(join(daemonDir, "daemon.log"), "daemon log\n", "utf-8");
    await writeFile(
      join(registryDir, "demo-key.json"),
      `${JSON.stringify(
        {
          key: "demo-key",
          workflowPath,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await loadStorage();

    const listResponse = await requestJson(server, "/api/workflows");
    assert.equal(listResponse.status, 200);
    const listed =
      (
        listResponse.body as {
          workflows?: Array<{ key: string; title: string }>;
        }
      ).workflows ?? [];
    const listedWorkflowKeys = new Set(listed.map((workflow) => workflow.key));
    assert.equal(listed.length > 0, true);
    const demoFlow =
      listed.find((workflow) => workflow.key === "demo-key") ??
      listed.find((workflow) => workflow.title === "Demo Flow");
    assert.ok(demoFlow);
    const workflowKey = demoFlow?.key;
    assert.ok(workflowKey);
    const registryPath = join(registryDir, `${workflowKey as string}.json`);
    const mainSessionIndexPath = join(sessionIndexDir, `${SESSION_ID}.json`);
    const boundSessionIndexPath = join(sessionIndexDir, "bound-session-1.json");

    const initialMainSessionIndexText = await readFile(
      mainSessionIndexPath,
      "utf-8",
    );
    const initialMainSessionIndex = JSON.parse(initialMainSessionIndexText) as {
      sessionId: string;
      type: string;
      workflowKey: string;
      workflowId: string;
      workflowTitle: string;
      workflowPath: string;
      projectRoot: string;
      taskId: string | null;
      updatedAt: string | null;
    };
    assert.deepEqual(
      {
        ...initialMainSessionIndex,
        workflowPath: await realpath(initialMainSessionIndex.workflowPath),
        projectRoot: await realpath(initialMainSessionIndex.projectRoot),
      },
      {
        sessionId: SESSION_ID,
        type: "scheduler",
        workflowKey,
        workflowId: "demo-flow",
        workflowTitle: "Demo Flow",
        workflowPath: await realpath(workflowPath),
        projectRoot: await realpath(projectDir),
        taskId: null,
        updatedAt: "2026-03-25T00:05:00Z",
      },
    );
    await assertSamePath(initialMainSessionIndex.workflowPath, workflowPath);
    await assertSamePath(initialMainSessionIndex.projectRoot, projectDir);

    const detailResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}`,
    );
    assert.equal(detailResponse.status, 200);
    assert.equal(
      (detailResponse.body as { summary?: { id?: string } }).summary?.id,
      "demo-flow",
    );
    assert.equal(
      (detailResponse.body as { boundSessionId?: string | null })
        .boundSessionId ?? null,
      null,
    );
    assert.equal(
      (
        detailResponse.body as {
          tasks?: Array<{ id?: string; ready?: boolean }>;
        }
      ).tasks?.some((task) => task.id === "task-b" && task.ready === true),
      true,
    );
    const mainSessionWorkflowResponse = await requestJson(
      server,
      `/api/workflows/by-session/${encodeURIComponent(SESSION_ID)}`,
    );
    assert.equal(mainSessionWorkflowResponse.status, 200);
    assert.equal(
      (
        mainSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
            workflow?: { key?: string };
          } | null;
        }
      ).match?.role,
      "scheduler",
    );
    assert.equal(
      (
        mainSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
            workflow?: { key?: string };
          } | null;
        }
      ).match?.taskId,
      null,
    );
    const mainSessionWorkflowKey =
      (
        mainSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
            workflow?: { key?: string };
          } | null;
        }
      ).match?.workflow?.key ?? null;
    assert.equal(typeof mainSessionWorkflowKey, "string");
    assert.equal(
      listedWorkflowKeys.has(mainSessionWorkflowKey as string),
      true,
    );
    const taskSessionWorkflowResponse = await requestJson(
      server,
      `/api/workflows/by-session/${encodeURIComponent(TASK_SESSION_ID)}`,
    );
    assert.equal(taskSessionWorkflowResponse.status, 200);
    assert.equal(
      (
        taskSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
            workflow?: { key?: string };
          } | null;
        }
      ).match?.role,
      "task",
    );
    assert.equal(
      (
        taskSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
            workflow?: { key?: string };
          } | null;
        }
      ).match?.taskId,
      "task-a",
    );

    const bindResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}/bound-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: "bound-session-1" }),
      },
    );
    assert.equal(bindResponse.status, 200);
    assert.equal(
      (bindResponse.body as { command?: string }).command,
      "bind-session",
    );

    const reboundDetailResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}`,
    );
    assert.equal(reboundDetailResponse.status, 200);
    assert.equal(
      (reboundDetailResponse.body as { boundSessionId?: string | null })
        .boundSessionId,
      "bound-session-1",
    );

    const reboundWorkflowText = await readFile(workflowPath, "utf-8");
    assert.equal(
      (
        JSON.parse(reboundWorkflowText) as {
          workflow?: { boundSession?: string | null };
        }
      ).workflow?.boundSession,
      "bound-session-1",
    );
    const reboundRegistryText = await readFile(registryPath, "utf-8");
    assert.equal(
      (
        JSON.parse(reboundRegistryText) as {
          workflow?: { boundSession?: string | null };
        }
      ).workflow?.boundSession,
      "bound-session-1",
    );
    const reboundBoundSessionIndexText = await readFile(
      boundSessionIndexPath,
      "utf-8",
    );
    const reboundBoundSessionIndex = JSON.parse(
      reboundBoundSessionIndexText,
    ) as {
      sessionId: string;
      type: string;
      workflowKey: string;
      workflowId: string;
      workflowTitle: string;
      workflowPath: string;
      projectRoot: string;
      taskId: string | null;
      updatedAt: string | null;
    };
    assert.deepEqual(
      {
        ...reboundBoundSessionIndex,
        workflowPath: await realpath(reboundBoundSessionIndex.workflowPath),
        projectRoot: await realpath(reboundBoundSessionIndex.projectRoot),
      },
      {
        sessionId: "bound-session-1",
        type: "bound",
        workflowKey,
        workflowId: "demo-flow",
        workflowTitle: "Demo Flow",
        workflowPath: await realpath(workflowPath),
        projectRoot: await realpath(projectDir),
        taskId: null,
        updatedAt: "2026-03-25T00:05:00Z",
      },
    );
    await assertSamePath(reboundBoundSessionIndex.workflowPath, workflowPath);
    await assertSamePath(reboundBoundSessionIndex.projectRoot, projectDir);
    const reboundMainSessionIndexText = await readFile(
      mainSessionIndexPath,
      "utf-8",
    );
    assert.equal(
      (
        JSON.parse(reboundMainSessionIndexText) as {
          type?: string;
          workflowKey?: string;
        }
      ).type,
      "scheduler",
    );
    assert.equal(
      (
        JSON.parse(reboundMainSessionIndexText) as {
          type?: string;
          workflowKey?: string;
        }
      ).workflowKey,
      workflowKey,
    );
    const boundSessionWorkflowResponse = await requestJson(
      server,
      "/api/workflows/by-session/bound-session-1",
    );
    assert.equal(boundSessionWorkflowResponse.status, 200);
    assert.equal(
      (
        boundSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
          } | null;
        }
      ).match?.role,
      "bound",
    );
    assert.equal(
      (
        boundSessionWorkflowResponse.body as {
          match?: {
            role?: string;
            taskId?: string | null;
          } | null;
        }
      ).match?.taskId,
      null,
    );
    const missingSessionWorkflowResponse = await requestJson(
      server,
      "/api/workflows/by-session/missing-session",
    );
    assert.equal(missingSessionWorkflowResponse.status, 200);
    assert.equal(
      (
        missingSessionWorkflowResponse.body as {
          match?: unknown;
        }
      ).match ?? null,
      null,
    );
    const sessionRolesResponse = await requestJson(
      server,
      "/api/workflows/session-roles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionIds: [
            SESSION_ID,
            TASK_SESSION_ID,
            "bound-session-1",
            "missing",
          ],
        }),
      },
    );
    assert.equal(sessionRolesResponse.status, 200);
    assert.deepEqual(
      (
        sessionRolesResponse.body as {
          sessions?: Array<{
            sessionId?: string;
            role?: string;
            taskId?: string | null;
          }>;
        }
      ).sessions,
      [
        {
          sessionId: SESSION_ID,
          role: "scheduler",
          taskId: null,
        },
        {
          sessionId: TASK_SESSION_ID,
          role: "task",
          taskId: "task-a",
        },
        {
          sessionId: "bound-session-1",
          role: "bound",
          taskId: null,
        },
      ],
    );

    const clearBindResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}/bound-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: null }),
      },
    );
    assert.equal(clearBindResponse.status, 200);

    const clearedWorkflowText = await readFile(workflowPath, "utf-8");
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        (
          JSON.parse(clearedWorkflowText) as {
            workflow?: Record<string, unknown>;
          }
        ).workflow ?? {},
        "boundSession",
      ),
      false,
    );
    const clearedRegistryText = await readFile(registryPath, "utf-8");
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        (
          JSON.parse(clearedRegistryText) as {
            workflow?: Record<string, unknown>;
          }
        ).workflow ?? {},
        "boundSession",
      ),
      false,
    );
    assert.equal(
      await readFile(boundSessionIndexPath, "utf-8").catch(() => null),
      null,
    );
    assert.equal(
      (
        JSON.parse(await readFile(mainSessionIndexPath, "utf-8")) as {
          type?: string;
        }
      ).type,
      "scheduler",
    );

    const mainLogResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}/log?scope=scheduler`,
    );
    assert.equal(mainLogResponse.status, 200);
    assert.equal(
      (mainLogResponse.body as { content?: string }).content,
      "main log\n",
    );

    const daemonStatusResponse = await requestJson(
      server,
      "/api/workflows/daemon-status",
    );
    assert.equal(daemonStatusResponse.status, 200);
    assert.equal(
      (daemonStatusResponse.body as { state?: string }).state,
      "running",
    );

    if (hasWorkflowCommandTooling()) {
      const previewResponse = await requestJson(
        server,
        `/api/workflows/${encodeURIComponent(workflowKey as string)}/merge-preview`,
        { method: "POST" },
      );
      assert.equal(
        previewResponse.status,
        200,
        JSON.stringify(previewResponse.body, null, 2),
      );
      assert.equal(
        (previewResponse.body as { command?: string }).command,
        "merge-preview",
      );
      assert.match(
        (previewResponse.body as { output?: string }).output ?? "",
        /preview target:/i,
      );
    }

    const deleteResponse = await requestJson(
      server,
      `/api/workflows/${encodeURIComponent(workflowKey as string)}`,
      { method: "DELETE" },
    );
    assert.equal(
      deleteResponse.status,
      200,
      JSON.stringify(deleteResponse.body, null, 2),
    );
    assert.equal(
      (deleteResponse.body as { command?: string }).command,
      "delete",
    );
    assert.equal(await readFile(workflowPath, "utf-8").catch(() => null), null);
    assert.equal(
      await readFile(workflowLockPath, "utf-8").catch(() => null),
      null,
    );
    assert.equal(await readFile(registryPath, "utf-8").catch(() => null), null);
    assert.equal(
      await readFile(mainSessionIndexPath, "utf-8").catch(() => null),
      null,
    );
    assert.equal(
      await readFile(
        join(sessionIndexDir, `${TASK_SESSION_ID}.json`),
        "utf-8",
      ).catch(() => null),
      null,
    );
    assert.equal(
      await readFile(taskWorktreePath, "utf-8").catch(() => null),
      null,
    );
    assert.equal(
      execFileSync("git", ["branch", "--list", "flow/demo-flow/task-a"], {
        cwd: projectDir,
        stdio: "pipe",
      })
        .toString()
        .trim(),
      "",
    );
    assert.equal(
      execFileSync("git", ["branch", "--list", "flow/demo-flow/task-b"], {
        cwd: projectDir,
        stdio: "pipe",
      })
        .toString()
        .trim(),
      "",
    );
    assert.equal(
      execFileSync("git", ["branch", "--list", "flow/demo-flow/integration"], {
        cwd: projectDir,
        stdio: "pipe",
      })
        .toString()
        .trim(),
      "",
    );
    const deletedListResponse = await requestJson(server, "/api/workflows");
    assert.equal(deletedListResponse.status, 200);
    assert.deepEqual(
      (deletedListResponse.body as { workflows?: unknown[] }).workflows ?? [],
      [],
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("workflow list refreshes stale registry bound session from canonical workflow", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflows-stale-registry",
  );
  const previousCwd = process.cwd();
  const previousCodexHome = process.env.CODEX_HOME;
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "demo-flow.json");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const sessionIndexDir = join(registryDir, "session-index");
  const server = createServer({ port: 13020, codexDir: rootDir, open: false });

  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });

    const workflowPayload = {
      workflow: {
        id: "demo-flow",
        title: "Demo Flow",
        createdAt: "2026-03-25T00:00:00Z",
        updatedAt: "2026-03-25T00:05:00Z",
        status: "completed",
        targetBranch: "main",
        projectRoot: projectDir,
        request: "test stale registry refresh",
        boundSession: "bound-session-from-canonical",
      },
      scheduler: {
        running: false,
        pendingTrigger: false,
        lastRunAt: "2026-03-25T00:05:00Z",
        lastSessionId: SESSION_ID,
        threadId: SESSION_ID,
        lastTurnStatus: "completed",
        lastReason: "manual",
      },
      settings: {
        codexHome: rootDir,
        maxParallel: 2,
        mergePolicy: "integration-branch",
      },
      tasks: [],
      history: [],
    };

    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowPayload, null, 2)}\n`,
      "utf-8",
    );

    const staleRegistryPath = join(registryDir, "demo-key.json");
    await writeFile(
      staleRegistryPath,
      `${JSON.stringify(
        {
          key: "demo-key",
          workflowPath,
          workflow: {
            id: "demo-flow",
            title: "Demo Flow",
            status: "completed",
            projectRoot: projectDir,
            targetBranch: "main",
            updatedAt: "2026-03-25T00:05:00Z",
            createdAt: "2026-03-25T00:00:00Z",
            request: "test stale registry refresh",
          },
          scheduler: {
            running: false,
            pendingTrigger: false,
            lastSessionId: SESSION_ID,
            threadId: SESSION_ID,
            lastReason: "manual",
            lastRunAt: "2026-03-25T00:05:00Z",
            lastTurnStatus: "completed",
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 2,
            mergePolicy: "integration-branch",
          },
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    process.env.CODEX_HOME = rootDir;
    process.chdir(projectDir);
    await mkdir(
      join(projectDir, ".claude", "skills", "codex-deck-flow", "scripts"),
      {
        recursive: true,
      },
    );
    await symlinkOrCopy(
      join(
        previousCwd,
        ".claude",
        "skills",
        "codex-deck-flow",
        "scripts",
        "run.sh",
      ),
      join(
        projectDir,
        ".claude",
        "skills",
        "codex-deck-flow",
        "scripts",
        "run.sh",
      ),
    );

    await loadStorage();

    const listResponse = await requestJson(server, "/api/workflows");
    assert.equal(listResponse.status, 200);
    assert.equal(
      (
        listResponse.body as {
          workflows?: Array<{ key?: string; boundSessionId?: string | null }>;
        }
      ).workflows?.[0]?.boundSessionId,
      "bound-session-from-canonical",
    );

    const detailResponse = await requestJson(server, "/api/workflows/demo-key");
    assert.equal(detailResponse.status, 200);
    assert.equal(
      (detailResponse.body as { boundSessionId?: string | null })
        .boundSessionId,
      "bound-session-from-canonical",
    );

    const refreshedRegistryText = await readFile(staleRegistryPath, "utf-8");
    assert.equal(
      (
        JSON.parse(refreshedRegistryText) as {
          workflow?: { boundSession?: string | null };
        }
      ).workflow?.boundSession,
      "bound-session-from-canonical",
    );
    assert.equal(
      (
        JSON.parse(
          await readFile(join(sessionIndexDir, `${SESSION_ID}.json`), "utf-8"),
        ) as {
          type?: string;
          workflowId?: string;
        }
      ).type,
      "scheduler",
    );
    assert.equal(
      (
        JSON.parse(
          await readFile(
            join(sessionIndexDir, "bound-session-from-canonical.json"),
            "utf-8",
          ),
        ) as {
          type?: string;
          workflowId?: string;
        }
      ).type,
      "bound",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    server.stop();
    await cleanup();
  }
});

test("workflow session endpoints ignore malformed session index files for other projects", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflows-malformed-session-index",
  );
  const projectDir = await mkdtemp(join(tmpdir(), "workflow-project-"));
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "demo-flow.json");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const sessionIndexDir = join(registryDir, "session-index");
  const sessionIndexPath = join(sessionIndexDir, "foreign-session.json");
  const previousCwd = process.cwd();
  const server = createServer({ port: 13001, codexDir: rootDir, open: false });

  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(sessionIndexDir, { recursive: true });

    const workflowPayload = {
      workflow: {
        id: "demo-flow",
        title: "Demo Flow",
        status: "running",
        projectRoot: projectDir,
        targetBranch: "main",
        updatedAt: "2026-03-25T00:05:00Z",
        createdAt: "2026-03-25T00:00:00Z",
      },
      tasks: [],
      settings: {
        codexHome: rootDir,
      },
    };

    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowPayload, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(registryDir, "demo-key.json"),
      `${JSON.stringify(
        {
          key: "demo-key",
          workflowPath,
          workflow: workflowPayload.workflow,
          settings: workflowPayload.settings,
          sessionIndex: [],
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(sessionIndexPath, "{\n", "utf-8");

    process.chdir(previousCwd);

    const bySessionResponse = await requestJson(
      server,
      "/api/workflows/by-session/foreign-session",
    );
    assert.equal(bySessionResponse.status, 200);
    assert.equal(
      (
        bySessionResponse.body as {
          match?: unknown;
        }
      ).match ?? null,
      null,
    );

    const sessionRolesResponse = await requestJson(
      server,
      "/api/workflows/session-roles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionIds: ["foreign-session"],
        }),
      },
    );
    assert.equal(sessionRolesResponse.status, 200);
    assert.deepEqual(
      (
        sessionRolesResponse.body as {
          sessions?: Array<unknown>;
        }
      ).sessions ?? [],
      [],
    );
  } finally {
    process.chdir(previousCwd);
    server.stop();
    await rm(projectDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("workflow read routes tolerate unavailable backfill tooling", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflows-unavailable-backfill",
  );
  const projectDir = await mkdtemp(join(tmpdir(), "workflow-project-"));
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "demo-flow.json");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const sessionIndexDir = join(registryDir, "session-index");
  const previousPythonBin = process.env.PYTHON_BIN;
  const sessionId = "bound-session-unavailable-backfill";
  const server = createServer({ port: 13023, codexDir: rootDir, open: false });

  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(sessionIndexDir, { recursive: true });

    const workflowPayload = {
      workflow: {
        id: "demo-flow",
        title: "Demo Flow",
        status: "running",
        projectRoot: projectDir,
        targetBranch: "main",
        boundSession: sessionId,
        updatedAt: "2026-03-25T00:05:00Z",
        createdAt: "2026-03-25T00:00:00Z",
      },
      tasks: [],
      settings: {
        codexHome: rootDir,
      },
    };

    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowPayload, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(registryDir, "demo-key.json"),
      `${JSON.stringify(
        {
          key: "demo-key",
          workflowPath,
          workflow: workflowPayload.workflow,
          settings: workflowPayload.settings,
          sessionIndex: [
            {
              sessionId,
              type: "bound",
              taskId: null,
            },
          ],
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(sessionIndexDir, `${sessionId}.json`),
      `${JSON.stringify(
        {
          sessionId,
          type: "bound",
          workflowKey: "demo-key",
          workflowId: "demo-flow",
          workflowTitle: "Demo Flow",
          workflowPath,
          projectRoot: projectDir,
          taskId: null,
          updatedAt: "2026-03-25T00:05:00Z",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    process.env.PYTHON_BIN = "definitely-not-a-python-binary";

    const listResponse = await requestJson(server, "/api/workflows");
    assert.equal(listResponse.status, 200);
    assert.equal(
      (
        listResponse.body as {
          workflows?: Array<{ key?: string; boundSessionId?: string | null }>;
        }
      ).workflows?.[0]?.key,
      "demo-key",
    );
    assert.equal(
      (
        listResponse.body as {
          workflows?: Array<{ key?: string; boundSessionId?: string | null }>;
        }
      ).workflows?.[0]?.boundSessionId,
      sessionId,
    );

    const bySessionResponse = await requestJson(
      server,
      `/api/workflows/by-session/${encodeURIComponent(sessionId)}`,
    );
    assert.equal(bySessionResponse.status, 200);
    assert.equal(
      (
        bySessionResponse.body as {
          match?: { workflow?: { key?: string } | null } | null;
        }
      ).match?.workflow?.key,
      "demo-key",
    );
  } finally {
    if (previousPythonBin === undefined) {
      delete process.env.PYTHON_BIN;
    } else {
      process.env.PYTHON_BIN = previousPythonBin;
    }
    server.stop();
    await rm(projectDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("workflow session index keeps the first workflow for a shared session", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflows-session-index-conflict",
  );
  const previousCwd = process.cwd();
  const previousCodexHome = process.env.CODEX_HOME;
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const sessionIndexDir = join(registryDir, "session-index");
  const server = createServer({ port: 13022, codexDir: rootDir, open: false });
  const sharedSessionId = "shared-session-1";

  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(workflowDir, "a-flow.json"),
      `${JSON.stringify(
        {
          workflow: {
            id: "a-flow",
            title: "A Flow",
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-03-25T00:05:00Z",
            status: "running",
            targetBranch: "main",
            projectRoot: projectDir,
            request: "first flow",
          },
          scheduler: {
            running: false,
            pendingTrigger: false,
            lastRunAt: "2026-03-25T00:05:00Z",
            lastSessionId: sharedSessionId,
            threadId: sharedSessionId,
            lastTurnStatus: "completed",
            lastReason: "manual",
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          tasks: [],
          history: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(workflowDir, "b-flow.json"),
      `${JSON.stringify(
        {
          workflow: {
            id: "b-flow",
            title: "B Flow",
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-03-25T00:06:00Z",
            status: "running",
            targetBranch: "main",
            projectRoot: projectDir,
            request: "second flow",
          },
          scheduler: {
            running: false,
            pendingTrigger: false,
            lastRunAt: "2026-03-25T00:06:00Z",
            lastSessionId: sharedSessionId,
            threadId: sharedSessionId,
            lastTurnStatus: "completed",
            lastReason: "manual",
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          tasks: [],
          history: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(registryDir, "a-key.json"),
      `${JSON.stringify(
        {
          key: "a-key",
          workflowPath: join(workflowDir, "a-flow.json"),
          workflow: {
            id: "a-flow",
            title: "A Flow",
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-03-25T00:05:00Z",
            status: "running",
            targetBranch: "main",
            projectRoot: projectDir,
            request: "first flow",
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          sessionIndex: [],
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(registryDir, "b-key.json"),
      `${JSON.stringify(
        {
          key: "b-key",
          workflowPath: join(workflowDir, "b-flow.json"),
          workflow: {
            id: "b-flow",
            title: "B Flow",
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-03-25T00:06:00Z",
            status: "running",
            targetBranch: "main",
            projectRoot: projectDir,
            request: "second flow",
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          sessionIndex: [],
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    process.env.CODEX_HOME = rootDir;
    process.chdir(projectDir);
    await mkdir(
      join(projectDir, ".claude", "skills", "codex-deck-flow", "scripts"),
      {
        recursive: true,
      },
    );
    await symlinkOrCopy(
      join(
        previousCwd,
        ".claude",
        "skills",
        "codex-deck-flow",
        "scripts",
        "run.sh",
      ),
      join(
        projectDir,
        ".claude",
        "skills",
        "codex-deck-flow",
        "scripts",
        "run.sh",
      ),
    );

    await loadStorage();

    const listResponse = await requestJson(server, "/api/workflows");
    assert.equal(listResponse.status, 200);

    const sessionIndexText = await readFile(
      join(sessionIndexDir, `${sharedSessionId}.json`),
      "utf-8",
    );
    assert.equal(
      (
        JSON.parse(sessionIndexText) as {
          workflowId?: string;
          workflowTitle?: string;
        }
      ).workflowId,
      "a-flow",
    );
    assert.equal(
      (
        JSON.parse(sessionIndexText) as {
          workflowId?: string;
          workflowTitle?: string;
        }
      ).workflowTitle,
      "A Flow",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    server.stop();
    await cleanup();
  }
});

test("workflow routes stay available to the CLI internal proxy in remote mode", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-workflows-remote-proxy",
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "demo-flow.json");
  const registryDir = join(rootDir, "codex-deck", "workflows");
  const proxyAccessToken = "remote-proxy-token";
  const server = createServer({
    port: 13021,
    codexDir: rootDir,
    open: false,
    remoteServerUrl: "https://server.example.com",
    remoteProxyAccessToken: proxyAccessToken,
  });

  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(
        {
          workflow: {
            id: "demo-flow",
            title: "Demo Flow",
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-03-25T00:05:00Z",
            status: "running",
            targetBranch: "main",
            projectRoot: projectDir,
            request: "remote workflow proxy test",
          },
          scheduler: {
            running: true,
            pendingTrigger: false,
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          tasks: [],
          history: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(registryDir, "demo-key.json"),
      `${JSON.stringify(
        {
          key: "demo-key",
          workflowPath,
          workflow: {
            id: "demo-flow",
            title: "Demo Flow",
            status: "running",
            projectRoot: projectDir,
            targetBranch: "main",
            updatedAt: "2026-03-25T00:05:00Z",
            createdAt: "2026-03-25T00:00:00Z",
            request: "remote workflow proxy test",
          },
          scheduler: {
            running: true,
            pendingTrigger: false,
          },
          settings: {
            codexHome: rootDir,
            maxParallel: 1,
            mergePolicy: "integration-branch",
          },
          taskCounts: {
            total: 0,
            cancelled: 0,
            failed: 0,
            pending: 0,
            running: 0,
            success: 0,
          },
          recentOutcomes: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    process.env.CODEX_HOME = rootDir;
    await loadStorage();

    const directResponse = await requestJson(server, "/api/workflows");
    assert.equal(directResponse.status, 501);
    assert.equal(
      (directResponse.body as { error?: string }).error,
      "Workflow pane is unavailable in remote mode.",
    );

    const proxiedResponse = await requestJson(server, "/api/workflows", {
      headers: {
        [INTERNAL_REMOTE_PROXY_ACCESS_HEADER]: proxyAccessToken,
      },
    });
    assert.equal(proxiedResponse.status, 200);
    assert.equal(
      (
        proxiedResponse.body as {
          workflows?: Array<{ key?: string; title?: string }>;
        }
      ).workflows?.[0]?.key,
      "demo-key",
    );
    assert.equal(
      (
        proxiedResponse.body as {
          workflows?: Array<{ key?: string; title?: string }>;
        }
      ).workflows?.[0]?.title,
      "Demo Flow",
    );

    const proxiedDetailResponse = await requestJson(
      server,
      "/api/workflows/demo-key",
      {
        headers: {
          [INTERNAL_REMOTE_PROXY_ACCESS_HEADER]: proxyAccessToken,
        },
      },
    );
    assert.equal(proxiedDetailResponse.status, 200);
    assert.equal(
      (proxiedDetailResponse.body as { summary?: { id?: string } }).summary?.id,
      "demo-flow",
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    server.stop();
    await cleanup();
  }
});

test("server file-tree and file-content endpoints return project files safely", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-file-tree");
  const server = createServer({ port: 13004, codexDir: rootDir, open: false });
  const projectDir = join(rootDir, "repo");
  const workflowKey = "workflow-file-tree";
  const workflowPath = join(projectDir, ".codex-deck", `${workflowKey}.json`);
  const workflowRegistryPath = join(
    rootDir,
    "codex-deck",
    "workflows",
    `${workflowKey}.json`,
  );

  try {
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(join(projectDir, ".git"), { recursive: true });
    await mkdir(join(projectDir, ".codex-deck"), { recursive: true });
    await mkdir(join(rootDir, "codex-deck", "workflows"), { recursive: true });
    await writeFile(join(projectDir, "src", "app.ts"), "export const n = 1;\n");
    await writeFile(join(projectDir, "README.md"), "# hello\n");
    await writeFile(
      join(projectDir, "src", "large.ts"),
      "const a = 1;\n".repeat(30000),
    );
    await writeFile(
      join(projectDir, "src", "long-line.ts"),
      `${"x".repeat(10001)}\n`,
    );
    await writeFile(
      join(projectDir, "diagram.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2pWuoAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(
      join(projectDir, "guide.pdf"),
      Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
        "utf-8",
      ),
    );
    await writeFile(join(projectDir, ".git", "config"), "[core]\n");
    await writeFile(
      join(projectDir, "bin.dat"),
      Buffer.from([0, 255, 1, 2, 3, 4]),
    );
    await writeFile(
      workflowPath,
      JSON.stringify(
        {
          workflow: {
            id: "workflow-file-tree",
            title: "Workflow File Tree",
            status: "draft",
            projectRoot: projectDir,
          },
          settings: {
            codexHome: rootDir,
          },
          scheduler: {},
          tasks: [],
          history: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      workflowRegistryPath,
      JSON.stringify(
        {
          key: workflowKey,
          workflowPath,
        },
        null,
        2,
      ),
      "utf-8",
    );

    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, projectDir, Date.now()),
      responseItemMessageLine("user", "tree please"),
    ]);

    await loadStorage();

    const fileTree = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-tree`,
    );
    assert.equal(fileTree.status, 200);
    const files = (fileTree.body as { files?: string[] }).files ?? [];
    assert.equal(files.includes("src/app.ts"), true);
    assert.equal(files.includes("README.md"), true);
    assert.equal(
      files.some((path) => path.startsWith(".git/")),
      false,
    );

    const fileContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("src/app.ts")}`,
    );
    assert.equal(fileContent.status, 200);
    assert.equal(
      (fileContent.body as { content?: string }).content,
      "export const n = 1;\n",
    );
    assert.equal((fileContent.body as { page?: number }).page, 1);
    assert.equal((fileContent.body as { totalPages?: number }).totalPages, 1);
    assert.equal(
      (fileContent.body as { paginationMode?: string }).paginationMode,
      "lines",
    );
    assert.equal((fileContent.body as { lineStart?: number }).lineStart, 1);
    assert.equal((fileContent.body as { lineEnd?: number }).lineEnd, 1);
    assert.equal((fileContent.body as { isBinary?: boolean }).isBinary, false);
    assert.equal(
      (fileContent.body as { previewKind?: string | null }).previewKind,
      null,
    );

    const fileSearch = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-search?query=app&limit=5`,
    );
    assert.equal(fileSearch.status, 200);
    assert.deepEqual((fileSearch.body as { files?: string[] }).files, [
      "src/app.ts",
    ]);

    const binaryContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("bin.dat")}`,
    );
    assert.equal(binaryContent.status, 200);
    assert.equal((binaryContent.body as { isBinary?: boolean }).isBinary, true);
    assert.equal((binaryContent.body as { page?: number }).page, 1);
    assert.equal((binaryContent.body as { totalPages?: number }).totalPages, 1);
    assert.equal(
      (binaryContent.body as { paginationMode?: string }).paginationMode,
      "bytes",
    );
    assert.equal(
      (binaryContent.body as { previewKind?: string | null }).previewKind,
      null,
    );

    const imageContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("diagram.png")}`,
    );
    assert.equal(imageContent.status, 200);
    assert.equal((imageContent.body as { isBinary?: boolean }).isBinary, true);
    assert.equal(
      (imageContent.body as { previewKind?: string | null }).previewKind,
      "image",
    );
    assert.equal(
      (imageContent.body as { previewMediaType?: string | null })
        .previewMediaType,
      "image/png",
    );
    assert.equal(
      (
        imageContent.body as {
          previewDataUrl?: string | null;
        }
      ).previewDataUrl?.startsWith("data:image/png;base64,"),
      true,
    );

    const pdfContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("guide.pdf")}`,
    );
    assert.equal(pdfContent.status, 200);
    assert.equal((pdfContent.body as { isBinary?: boolean }).isBinary, true);
    assert.equal(
      (pdfContent.body as { previewKind?: string | null }).previewKind,
      "pdf",
    );
    assert.equal(
      (pdfContent.body as { previewMediaType?: string | null })
        .previewMediaType,
      "application/pdf",
    );
    assert.equal(
      (
        pdfContent.body as {
          previewDataUrl?: string | null;
        }
      ).previewDataUrl?.startsWith("data:application/pdf;base64,"),
      true,
    );

    const traversal = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("../secret.txt")}`,
    );
    assert.equal(traversal.status, 400);

    const pagedContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("src/large.ts")}&page=2`,
    );
    assert.equal(pagedContent.status, 200);
    assert.equal((pagedContent.body as { page?: number }).page, 2);
    assert.equal(
      ((pagedContent.body as { totalPages?: number }).totalPages ?? 0) > 1,
      true,
    );
    assert.equal(
      (pagedContent.body as { paginationMode?: string }).paginationMode,
      "lines",
    );
    assert.equal((pagedContent.body as { lineStart?: number }).lineStart, 1001);
    assert.equal((pagedContent.body as { lineEnd?: number }).lineEnd, 2000);

    const longLineContent = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/file-content?path=${encodeURIComponent("src/long-line.ts")}`,
    );
    assert.equal(longLineContent.status, 200);
    assert.equal(
      (longLineContent.body as { paginationMode?: string }).paginationMode,
      "bytes",
    );
    assert.equal(
      (longLineContent.body as { lineStart?: number | null }).lineStart,
      null,
    );
    assert.equal(
      (longLineContent.body as { lineEnd?: number | null }).lineEnd,
      null,
    );

    const workflowTree = await requestJson(
      server,
      `/api/workflow-project/${workflowKey}/file-tree/nodes?dir=&cursor=0&limit=200`,
    );
    assert.equal(workflowTree.status, 200);
    const workflowNodes =
      (workflowTree.body as { nodes?: Array<{ path?: string }> }).nodes ?? [];
    assert.equal(
      workflowNodes.some((node) => node.path === "src"),
      true,
    );

    const workflowSrcTree = await requestJson(
      server,
      `/api/workflow-project/${workflowKey}/file-tree/nodes?dir=${encodeURIComponent("src")}&cursor=0&limit=200`,
    );
    assert.equal(workflowSrcTree.status, 200);
    const workflowSrcNodes =
      (workflowSrcTree.body as { nodes?: Array<{ path?: string }> }).nodes ??
      [];
    assert.equal(
      workflowSrcNodes.some((node) => node.path === "src/app.ts"),
      true,
    );

    const workflowContent = await requestJson(
      server,
      `/api/workflow-project/${workflowKey}/file-content?path=${encodeURIComponent("src/app.ts")}`,
    );
    assert.equal(workflowContent.status, 200);
    assert.equal(
      (workflowContent.body as { content?: string }).content,
      "export const n = 1;\n",
    );

    const workflowLastTurnDiff = await requestJson(
      server,
      `/api/workflow-project/${workflowKey}/diff?mode=last-turn`,
    );
    assert.equal(workflowLastTurnDiff.status, 200);
    assert.equal(
      (workflowLastTurnDiff.body as { unavailableReason?: string })
        .unavailableReason,
      "Last-turn diff is unavailable without a session.",
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("server file routes resolve project path from thread summary before session indexing", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-file-tree-summary-fallback",
  );
  const server = createServer({ port: 13018, codexDir: rootDir, open: false });
  const projectDir = join(rootDir, "repo-fallback");
  const threadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => threadId,
    getThreadSummary: async (requestedThreadId: string) => {
      if (requestedThreadId !== threadId) {
        throw new Error("thread not found");
      }
      return {
        threadId,
        name: "Fallback Thread",
        preview: "fallback preview",
        cwd: projectDir,
        agentNickname: null,
        agentRole: null,
        status: "active",
        updatedAt: Date.now(),
      };
    },
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId,
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId,
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(
      join(projectDir, "src", "index.ts"),
      "export const v = 1;\n",
    );

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const fileTree = await requestJson(
      server,
      `/api/sessions/${threadId}/file-tree`,
    );
    assert.equal(fileTree.status, 200);
    const files = (fileTree.body as { files?: string[] }).files ?? [];
    assert.equal(files.includes("src/index.ts"), true);

    const fileContent = await requestJson(
      server,
      `/api/sessions/${threadId}/file-content?path=${encodeURIComponent("src/index.ts")}`,
    );
    assert.equal(fileContent.status, 200);
    assert.equal(
      (fileContent.body as { content?: string }).content,
      "export const v = 1;\n",
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal routes return snapshot, control responses, and stream events", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("server-terminal");
  const server = createServer({ port: 13015, codexDir: rootDir, open: false });

  let running = false;
  let seq = 3;
  let output = "boot line\\n";
  let writeInputCalls = 0;
  let resizeCalls = 0;
  let interruptCalls = 0;
  let restartCalls = 0;
  let closeCalls = 0;
  let writeOwnerId: string | null = null;
  let terminalCreated = false;
  const terminalId = "terminal-1";

  const makeSnapshot = () => ({
    id: terminalId,
    terminalId,
    running,
    cwd: "/repo/app",
    shell: "zsh",
    output,
    seq,
    writeOwnerId,
  });

  const manager: LocalTerminalManager = {
    listTerminals: () =>
      terminalCreated
        ? [
            {
              id: terminalId,
              terminalId,
              display: "app",
              firstCommand: null,
              timestamp: 1,
              project: "/repo/app",
              projectName: "app",
              cwd: "/repo/app",
              shell: "zsh",
              running,
            },
          ]
        : [],
    createTerminal: () => {
      terminalCreated = true;
      running = true;
      seq += 1;
      return makeSnapshot();
    },
    closeTerminal: async (requestedTerminalId: string) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return false;
      }
      closeCalls += 1;
      terminalCreated = false;
      running = false;
      writeOwnerId = null;
      return true;
    },
    getSnapshot: (requestedTerminalId: string) =>
      terminalCreated && requestedTerminalId === terminalId
        ? makeSnapshot()
        : null,
    writeInput: (requestedTerminalId: string, _input: string) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return;
      }
      writeInputCalls += 1;
      seq += 1;
    },
    resize: (requestedTerminalId: string, _cols: number, _rows: number) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return;
      }
      resizeCalls += 1;
      seq += 1;
    },
    interrupt: (requestedTerminalId: string) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return;
      }
      interruptCalls += 1;
      seq += 1;
    },
    restart: (requestedTerminalId: string) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return null;
      }
      restartCalls += 1;
      running = true;
      output = "";
      seq += 1;
      return makeSnapshot();
    },
    getEventsSince: (requestedTerminalId: string, fromSeq: number) =>
      requestedTerminalId !== terminalId || !terminalCreated
        ? null
        : {
            events:
              fromSeq <= 0
                ? [
                    {
                      terminalId,
                      seq: 2,
                      type: "output" as const,
                      chunk: "history\\n",
                    },
                  ]
                : fromSeq === 999
                  ? []
                  : [],
            requiresReset: fromSeq === 999,
          },
    subscribeTerminal: () => () => undefined,
    subscribeTerminals: () => () => undefined,
    dispose: async () => undefined,
    getWriteOwnerId: (requestedTerminalId: string) =>
      requestedTerminalId === terminalId && terminalCreated
        ? writeOwnerId
        : null,
    claimWrite: (requestedTerminalId: string, clientId: string) => {
      if (requestedTerminalId !== terminalId || !terminalCreated) {
        return;
      }
      writeOwnerId = clientId;
    },
    releaseWrite: (requestedTerminalId: string, clientId: string) => {
      if (
        requestedTerminalId === terminalId &&
        terminalCreated &&
        writeOwnerId === clientId
      ) {
        writeOwnerId = null;
      }
    },
    isWriteOwner: (requestedTerminalId: string, clientId: string) =>
      requestedTerminalId === terminalId && writeOwnerId === clientId,
  };

  try {
    setLocalTerminalManagerForTests(manager);
    await loadStorage();

    const initialList = await requestJson(server, "/api/terminals");
    assert.equal(initialList.status, 200);
    assert.deepEqual(initialList.body, { terminals: [] });

    const started = await requestJson(server, "/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo/app" }),
    });
    assert.equal(started.status, 200);
    assert.equal(
      (started.body as { terminalId?: string }).terminalId,
      terminalId,
    );

    const snapshot = await requestJson(server, `/api/terminals/${terminalId}`);
    assert.equal(snapshot.status, 200);
    assert.equal((snapshot.body as { running?: boolean }).running, true);

    const inputMissing = await requestJson(
      server,
      `/api/terminals/${terminalId}/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(inputMissing.status, 400);

    const inputResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "pwd\\n" }),
      },
    );
    assert.equal(inputResponse.status, 200);
    assert.equal(writeInputCalls, 1);

    const resizeInvalid = await requestJson(
      server,
      `/api/terminals/${terminalId}/resize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 1, rows: 20 }),
      },
    );
    assert.equal(resizeInvalid.status, 400);

    const resizeResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/resize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      },
    );
    assert.equal(resizeResponse.status, 403);
    assert.equal(resizeCalls, 0);

    const interruptResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/interrupt`,
      {
        method: "POST",
      },
    );
    assert.equal(interruptResponse.status, 200);
    assert.equal(interruptCalls, 1);

    const restartResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/restart`,
      {
        method: "POST",
      },
    );
    assert.equal(restartResponse.status, 200);
    assert.equal((restartResponse.body as { output?: string }).output, "");
    assert.equal(restartCalls, 1);

    const invalidStream = await requestJson(
      server,
      `/api/terminals/${terminalId}/stream?fromSeq=-1`,
    );
    assert.equal(invalidStream.status, 400);

    const invalidEvents = await requestJson(
      server,
      `/api/terminals/${terminalId}/events?fromSeq=-1`,
    );
    assert.equal(invalidEvents.status, 400);

    const invalidEventsWait = await requestJson(
      server,
      `/api/terminals/${terminalId}/events?fromSeq=0&waitMs=-1`,
    );
    assert.equal(invalidEventsWait.status, 400);

    const eventBatch = await requestJson(
      server,
      `/api/terminals/${terminalId}/events?fromSeq=0`,
    );
    assert.equal(eventBatch.status, 200);
    assert.deepEqual(eventBatch.body, {
      events: [{ terminalId, seq: 2, type: "output", chunk: "history\\n" }],
      requiresReset: false,
      snapshot: null,
    });

    const resetBatch = await requestJson(
      server,
      `/api/terminals/${terminalId}/events?fromSeq=999`,
    );
    assert.equal(resetBatch.status, 200);
    assert.deepEqual(resetBatch.body, {
      events: [],
      requiresReset: true,
      snapshot: {
        id: terminalId,
        terminalId,
        running,
        cwd: "/repo/app",
        shell: "zsh",
        output,
        seq,
        writeOwnerId,
      },
    });

    const claimResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/claim-write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "client-a" }),
      },
    );
    assert.equal(claimResponse.status, 200);
    assert.equal(
      (claimResponse.body as { writeOwnerId?: string | null }).writeOwnerId,
      "client-a",
    );

    const blockedInput = await requestJson(
      server,
      `/api/terminals/${terminalId}/input?clientId=client-b`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "blocked\\n" }),
      },
    );
    assert.equal(blockedInput.status, 403);

    const blockedResize = await requestJson(
      server,
      `/api/terminals/${terminalId}/resize?clientId=client-b`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      },
    );
    assert.equal(blockedResize.status, 403);

    const ownerResize = await requestJson(
      server,
      `/api/terminals/${terminalId}/resize?clientId=client-a`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      },
    );
    assert.equal(ownerResize.status, 200);
    assert.equal(resizeCalls, 1);

    const blockedInterrupt = await requestJson(
      server,
      `/api/terminals/${terminalId}/interrupt?clientId=client-b`,
      { method: "POST" },
    );
    assert.equal(blockedInterrupt.status, 403);

    const blockedRestart = await requestJson(
      server,
      `/api/terminals/${terminalId}/restart?clientId=client-b`,
      { method: "POST" },
    );
    assert.equal(blockedRestart.status, 403);

    const ownerInput = await requestJson(
      server,
      `/api/terminals/${terminalId}/input?clientId=client-a`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "allowed\\n" }),
      },
    );
    assert.equal(ownerInput.status, 200);

    const releaseResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/release-write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "client-a" }),
      },
    );
    assert.equal(releaseResponse.status, 200);
    assert.equal(
      (releaseResponse.body as { writeOwnerId?: string | null }).writeOwnerId,
      null,
    );

    const afterReleaseInput = await requestJson(
      server,
      `/api/terminals/${terminalId}/input?clientId=client-b`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "now allowed\\n" }),
      },
    );
    assert.equal(afterReleaseInput.status, 200);

    const closeResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}`,
      { method: "DELETE" },
    );
    assert.equal(closeResponse.status, 200);
    assert.deepEqual(closeResponse.body, { ok: true });
    assert.equal(closeCalls, 1);

    const missingAfterClose = await requestJson(
      server,
      `/api/terminals/${terminalId}`,
    );
    assert.equal(missingAfterClose.status, 404);
  } finally {
    setLocalTerminalManagerForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal binding routes persist bindings and expose terminal session roles", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-terminal-binding",
  );
  const server = createServer({ port: 13016, codexDir: rootDir, open: false });

  const terminalId = "terminal-binding-1";
  let terminalExists = true;

  const manager: LocalTerminalManager = {
    listTerminals: () =>
      terminalExists
        ? [
            {
              id: terminalId,
              terminalId,
              display: "repo",
              firstCommand: null,
              timestamp: 1,
              project: "/repo/app",
              projectName: "app",
              cwd: "/repo/app",
              shell: "zsh",
              running: true,
            },
          ]
        : [],
    createTerminal: () => ({
      id: terminalId,
      terminalId,
      running: true,
      cwd: "/repo/app",
      shell: "zsh",
      output: "",
      seq: 1,
      writeOwnerId: null,
    }),
    closeTerminal: async (requestedTerminalId: string) => {
      if (requestedTerminalId !== terminalId || !terminalExists) {
        return false;
      }
      terminalExists = false;
      return true;
    },
    getSnapshot: (requestedTerminalId: string) =>
      requestedTerminalId === terminalId && terminalExists
        ? {
            id: terminalId,
            terminalId,
            running: true,
            cwd: "/repo/app",
            shell: "zsh",
            output: "",
            seq: 1,
            writeOwnerId: null,
          }
        : null,
    restart: () => null,
    writeInput: () => undefined,
    resize: () => undefined,
    interrupt: () => undefined,
    getEventsSince: () => ({ events: [], requiresReset: false }),
    subscribeTerminal: () => () => undefined,
    subscribeTerminals: () => () => undefined,
    dispose: async () => undefined,
    getWriteOwnerId: () => null,
    claimWrite: () => undefined,
    releaseWrite: () => undefined,
    isWriteOwner: () => false,
  };

  const workflowSessionId = "workflow-session-1";
  const terminalSessionId = "terminal-session-1";

  try {
    setLocalTerminalManagerForTests(manager);
    await loadStorage();

    const initialBinding = await requestJson(
      server,
      `/api/terminals/${terminalId}/binding`,
    );
    assert.equal(initialBinding.status, 200);
    assert.equal(
      (initialBinding.body as { boundSessionId?: string | null })
        .boundSessionId,
      null,
    );

    const bindResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/binding`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: terminalSessionId }),
      },
    );
    assert.equal(bindResponse.status, 200);
    assert.equal(
      (bindResponse.body as { boundSessionId?: string | null }).boundSessionId,
      terminalSessionId,
    );

    const listResponse = await requestJson(server, "/api/terminals");
    assert.equal(listResponse.status, 200);
    assert.equal(
      (
        listResponse.body as {
          terminals?: Array<{ boundSessionId?: string | null }>;
        }
      ).terminals?.[0]?.boundSessionId,
      terminalSessionId,
    );

    const roleResponse = await requestJson(
      server,
      "/api/terminals/session-roles",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionIds: [terminalSessionId, "missing-session"],
        }),
      },
    );
    assert.equal(roleResponse.status, 200);
    assert.deepEqual((roleResponse.body as { sessions?: unknown[] }).sessions, [
      {
        sessionId: terminalSessionId,
        role: "terminal",
        terminalId,
      },
    ]);

    const workflowSessionIndexDir = join(
      rootDir,
      "codex-deck",
      "workflows",
      "session-index",
    );
    await mkdir(workflowSessionIndexDir, { recursive: true });
    await writeFile(
      join(workflowSessionIndexDir, `${workflowSessionId}.json`),
      JSON.stringify({
        sessionId: workflowSessionId,
        type: "bound",
      }),
      "utf-8",
    );

    const conflictResponse = await requestJson(
      server,
      `/api/terminals/${terminalId}/binding`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: workflowSessionId }),
      },
    );
    assert.equal(conflictResponse.status, 409);

    const storedBindingText = await readFile(
      join(rootDir, "codex-deck", "terminal", "bindings", `${terminalId}.json`),
      "utf-8",
    );
    assert.match(storedBindingText, /terminal-session-1/);
  } finally {
    setLocalTerminalManagerForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal frozen block routes persist artifacts under codex home and delete them with the terminal", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-terminal-frozen-blocks",
  );
  const server = createServer({ port: 13017, codexDir: rootDir, open: false });

  const terminalId = "terminal-frozen-1";
  let terminalExists = true;

  const manager: LocalTerminalManager = {
    listTerminals: () => [],
    createTerminal: () => ({
      id: terminalId,
      terminalId,
      running: true,
      cwd: "/repo/app",
      shell: "zsh",
      output: "",
      seq: 1,
      writeOwnerId: null,
    }),
    closeTerminal: async (requestedTerminalId: string) => {
      if (requestedTerminalId !== terminalId || !terminalExists) {
        return false;
      }
      terminalExists = false;
      return true;
    },
    getSnapshot: (requestedTerminalId: string) =>
      requestedTerminalId === terminalId && terminalExists
        ? {
            id: terminalId,
            terminalId,
            running: true,
            cwd: "/repo/app",
            shell: "zsh",
            output: "",
            seq: 1,
            writeOwnerId: null,
          }
        : null,
    restart: () => null,
    writeInput: () => undefined,
    resize: () => undefined,
    interrupt: () => undefined,
    getEventsSince: () => ({ events: [], requiresReset: false }),
    subscribeTerminal: () => () => undefined,
    subscribeTerminals: () => () => undefined,
    dispose: async () => undefined,
    getWriteOwnerId: () => null,
    claimWrite: () => undefined,
    releaseWrite: () => undefined,
    isWriteOwner: () => false,
  };

  try {
    setLocalTerminalManagerForTests(manager);
    await loadStorage();

    const persisted = await requestJson(
      server,
      `/api/terminals/${terminalId}/frozen-blocks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          messageKey: "message-1",
          transcript: "pwd\n/repo/app\n",
        }),
      },
    );
    assert.equal(persisted.status, 200);

    const manifestPath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      terminalId,
      "session.json",
    );
    assert.equal(existsSync(manifestPath), true);

    const restored = await requestJson(
      server,
      `/api/terminals/${terminalId}/frozen-blocks?sessionId=session-1`,
    );
    assert.equal(restored.status, 200);
    assert.deepEqual(
      (restored.body as { frozenOutputByMessageKey?: Record<string, string> })
        .frozenOutputByMessageKey,
      {
        "message-1": "pwd\n/repo/app\n",
      },
    );

    const deleted = await requestJson(server, `/api/terminals/${terminalId}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(manifestPath), false);
  } finally {
    setLocalTerminalManagerForTests(null);
    server.stop();
    await cleanup();
  }
});

test("system context route returns host release metadata", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-system-context",
  );
  const server = createServer({ port: 13007, codexDir: rootDir, open: false });

  try {
    await loadStorage();
    const response = await requestJson(server, "/api/system/context");
    assert.equal(response.status, 200);
    assert.equal(
      typeof (response.body as { osName?: unknown }).osName,
      "string",
    );
    assert.equal(
      typeof (response.body as { osRelease?: unknown }).osRelease,
      "string",
    );
    assert.equal(
      typeof (response.body as { architecture?: unknown }).architecture,
      "string",
    );
    assert.equal(
      typeof (response.body as { platform?: unknown }).platform,
      "string",
    );
    assert.equal(
      typeof (response.body as { hostname?: unknown }).hostname,
      "string",
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("codex thread creation and message endpoints validate payloads", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("server-validation");
  const server = createServer({ port: 13003, codexDir: rootDir, open: false });

  const tempDir = await mkdtemp(join(tmpdir(), "server-validation-path-"));
  const tempFile = join(tempDir, "not-a-dir.txt");
  await writeFile(tempFile, "file", "utf-8");

  try {
    await loadStorage();

    const missingCwd = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingCwd.status, 400);

    const missingPath = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: join(tempDir, "missing") }),
    });
    assert.equal(missingPath.status, 400);

    const notDirectory = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempFile }),
    });
    assert.equal(notDirectory.status, 400);

    const invalidModel = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempDir, model: 123 }),
    });
    assert.equal(invalidModel.status, 400);

    const invalidEffort = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempDir, effort: "very-high" }),
    });
    assert.equal(invalidEffort.status, 400);

    const missingThreadId = await requestJson(
      server,
      "/api/codex/threads/%20/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    assert.equal(missingThreadId.status, 400);

    const missingText = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(missingText.status, 400);

    const invalidInputShape = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "bad" }),
      },
    );
    assert.equal(invalidInputShape.status, 400);

    const invalidInputItem = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "image", missingUrl: "https://example.com/a.png" }],
        }),
      },
    );
    assert.equal(invalidInputItem.status, 400);

    const invalidCwd = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello", cwd: 123 }),
      },
    );
    assert.equal(invalidCwd.status, 400);

    const invalidMsgModel = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello", model: 123 }),
      },
    );
    assert.equal(invalidMsgModel.status, 400);

    const invalidMsgEffort = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello", effort: "bad" }),
      },
    );
    assert.equal(invalidMsgEffort.status, 400);

    const invalidServiceTier = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello", serviceTier: "turbo" }),
      },
    );
    assert.equal(invalidServiceTier.status, 400);

    const invalidCollaboration = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          collaborationMode: {
            mode: "plan",
            settings: { reasoningEffort: "bad" },
          },
        }),
      },
    );
    assert.equal(invalidCollaboration.status, 400);
  } finally {
    server.stop();
    await rm(tempDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("codex thread creation expands home shorthand cwd", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-thread-create-home-cwd",
  );
  const server = createServer({ port: 13019, codexDir: rootDir, open: false });
  let capturedCwd: string | null = null;

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async (input) => {
      capturedCwd = input.cwd;
      return "thread-home";
    },
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-home",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-home",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "~" }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { threadId?: string }).threadId,
      "thread-home",
    );
    assert.equal(capturedCwd, homedir());
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("state/interrupt/user-input routes validate ids and payload shapes", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-more-validation",
  );
  const server = createServer({ port: 13004, codexDir: rootDir, open: false });

  try {
    await loadStorage();

    const stateMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/state",
    );
    assert.equal(stateMissingThread.status, 400);

    const interruptMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/interrupt",
      { method: "POST" },
    );
    assert.equal(interruptMissingThread.status, 400);

    const listMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/requests/user-input",
    );
    assert.equal(listMissingThread.status, 400);

    const approvalsListMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/requests/approvals",
    );
    assert.equal(approvalsListMissingThread.status, 400);

    const renameMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/name",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      },
    );
    assert.equal(renameMissingThread.status, 400);

    const renameMissingName = await requestJson(
      server,
      "/api/codex/threads/thread/name",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(renameMissingName.status, 400);

    const forkMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/fork",
      { method: "POST" },
    );
    assert.equal(forkMissingThread.status, 400);

    const compactMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/compact",
      { method: "POST" },
    );
    assert.equal(compactMissingThread.status, 400);

    const agentMissingThread = await requestJson(
      server,
      "/api/codex/threads/%20/agent-threads",
    );
    assert.equal(agentMissingThread.status, 400);

    const missingRequestId = await requestJson(
      server,
      "/api/codex/threads/thread/requests/user-input/%20/respond",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: {} }),
      },
    );
    assert.equal(missingRequestId.status, 400);

    const invalidAnswers = await requestJson(
      server,
      "/api/codex/threads/thread/requests/user-input/request-1/respond",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [] }),
      },
    );
    assert.equal(invalidAnswers.status, 400);

    const missingApprovalRequestId = await requestJson(
      server,
      "/api/codex/threads/thread/requests/approvals/%20/respond",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: "accept" }),
      },
    );
    assert.equal(missingApprovalRequestId.status, 400);

    const invalidApprovalBody = await requestJson(
      server,
      "/api/codex/threads/thread/requests/approvals/request-1/respond",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([]),
      },
    );
    assert.equal(invalidApprovalBody.status, 400);

    const invalidJson = await requestJson(server, "/api/codex/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);

    const invalidThreadSummaryBody = await requestJson(
      server,
      "/api/codex/threads/summaries",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadIds: "thread-1" }),
      },
    );
    assert.equal(invalidThreadSummaryBody.status, 400);
  } finally {
    server.stop();
    await cleanup();
  }
});

test("session routes validate missing session ids", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-session-id-validation",
  );
  const server = createServer({ port: 13005, codexDir: rootDir, open: false });

  try {
    await loadStorage();

    const missingContextId = await requestJson(
      server,
      "/api/sessions/%20/context",
    );
    assert.equal(missingContextId.status, 400);
    assert.match(
      (missingContextId.body as { error?: string }).error ?? "",
      /session id is required/i,
    );

    const missingFixId = await requestJson(
      server,
      "/api/sessions/%20/fix-dangling",
      {
        method: "POST",
      },
    );
    assert.equal(missingFixId.status, 400);
    assert.match(
      (missingFixId.body as { error?: string }).error ?? "",
      /session id is required/i,
    );

    const missingDiffId = await requestJson(
      server,
      "/api/sessions/%20/diff?mode=unstaged",
    );
    assert.equal(missingDiffId.status, 400);
    assert.match(
      (missingDiffId.body as { error?: string }).error ?? "",
      /session id is required/i,
    );

    const invalidDiffMode = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/diff?mode=invalid`,
    );
    assert.equal(invalidDiffMode.status, 400);
    assert.match(
      (invalidDiffMode.body as { error?: string }).error ?? "",
      /mode must be one of/i,
    );

    const missingTerminalCleanId = await requestJson(
      server,
      "/api/sessions/%20/terminal-runs/clean",
      {
        method: "POST",
      },
    );
    assert.equal(missingTerminalCleanId.status, 400);
    assert.match(
      (missingTerminalCleanId.body as { error?: string }).error ?? "",
      /session id is required/i,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("session diff route returns git unstaged and staged file changes", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-diff-route");
  const server = createServer({ port: 13009, codexDir: rootDir, open: false });
  const repoDir = await mkdtemp(join(tmpdir(), "server-diff-repo-"));

  try {
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    await writeFile(join(repoDir, "tracked.txt"), "line one\n", "utf-8");
    runGit(repoDir, ["add", "tracked.txt"]);
    runGit(repoDir, ["commit", "-m", "initial commit"]);

    await writeFile(
      join(repoDir, "tracked.txt"),
      "line one\nline two\n",
      "utf-8",
    );
    await writeFile(join(repoDir, "staged.txt"), "new file\n", "utf-8");
    runGit(repoDir, ["add", "staged.txt"]);

    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, repoDir, Date.now()),
      responseItemMessageLine("user", "show diff"),
    ]);

    await loadStorage();

    const unstaged = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/diff?mode=unstaged`,
    );
    assert.equal(unstaged.status, 200);
    assert.equal(
      (unstaged.body as { files?: Array<{ path: string }> }).files?.some(
        (file) => file.path === "tracked.txt",
      ),
      true,
    );

    const staged = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/diff?mode=staged`,
    );
    assert.equal(staged.status, 200);
    assert.equal(
      (staged.body as { files?: Array<{ path: string }> }).files?.some(
        (file) => file.path === "staged.txt",
      ),
      true,
    );
  } finally {
    server.stop();
    await rm(repoDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("session diff last-turn mode falls back to changes since last user input", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-last-turn-fallback",
  );
  const server = createServer({ port: 13010, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "first user input"),
      responseItemRawLine({
        type: "function_call",
        call_id: "call_old",
        name: "edit",
        arguments: {
          file_path: "old-file.ts",
          old_string: "const oldValue = 1;\n",
          new_string: "const oldValue = 2;\n",
        },
      }),
      responseItemMessageLine("user", "latest user input"),
      responseItemRawLine({
        type: "function_call",
        call_id: "call_new",
        name: "edit",
        arguments: {
          file_path: "new-file.ts",
          old_string: "const value = 1;\n",
          new_string: "const value = 2;\n",
        },
      }),
    ]);

    await loadStorage();

    const response = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/diff?mode=last-turn`,
    );
    assert.equal(response.status, 200);

    const files = (response.body as { files?: Array<{ path: string }> }).files;
    assert.equal(Array.isArray(files), true);
    assert.equal(
      files?.some((file) => file.path === "new-file.ts"),
      true,
    );
    assert.equal(
      files?.some((file) => file.path === "old-file.ts"),
      false,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("terminal run routes return run list and run output", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-terminal-runs",
  );
  const server = createServer({ port: 13011, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({
        type: "exec_command_begin",
        source: "unified_exec_startup",
        call_id: "call_bg_1",
        process_id: "1000",
        command: ["bash", "-lc", "echo one"],
      }),
      eventMsgLine({
        type: "exec_command_output_delta",
        call_id: "call_bg_1",
        chunk: Buffer.from("line one\n", "utf-8").toString("base64"),
      }),
      eventMsgLine({
        type: "terminal_interaction",
        call_id: "call_bg_1",
        process_id: "1000",
        stdin: "pwd\n",
      }),
    ]);

    await loadStorage();

    const runsResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs`,
    );
    assert.equal(runsResponse.status, 200);
    const runs = (runsResponse.body as { runs?: Array<{ processId: string }> })
      .runs;
    assert.equal(Array.isArray(runs), true);
    assert.equal(runs?.[0]?.processId, "1000");

    const outputResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs/1000`,
    );
    assert.equal(outputResponse.status, 200);
    const output = (outputResponse.body as { output?: string }).output ?? "";
    assert.match(output, /line one/);
    assert.match(output, /\$ pwd/);
  } finally {
    server.stop();
    await cleanup();
  }
});

test("terminal run output route returns 404 for unknown process id", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-terminal-run-404",
  );
  const server = createServer({ port: 13012, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "hello"),
    ]);

    await loadStorage();

    const response = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs/4040`,
    );
    assert.equal(response.status, 404);
    assert.match(
      (response.body as { error?: string }).error ?? "",
      /not found/i,
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("terminal run output route merges live app-server deltas", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-terminal-runs-live-merge",
  );
  const server = createServer({ port: 13014, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
    listLiveTerminalRuns: () => [
      {
        threadId: SESSION_ID,
        processId: "1000",
        callId: "call_bg_1",
        command: "bash -lc ./slow_print.sh",
        output: "0\n1\n2\n",
        isRunning: true,
        updatedAt: Date.now(),
      },
    ],
    getLiveTerminalRun: () => ({
      threadId: SESSION_ID,
      processId: "1000",
      callId: "call_bg_1",
      command: "bash -lc ./slow_print.sh",
      output: "0\n1\n2\n",
      isRunning: true,
      updatedAt: Date.now(),
    }),
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call_bg_1",
        output:
          "Chunk ID: x\nProcess running with session ID 1000\nOutput:\n0\n",
      }),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const outputResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs/1000`,
    );
    assert.equal(outputResponse.status, 200);
    const output = (outputResponse.body as { output?: string }).output ?? "";
    assert.equal(output, "0\n1\n2\n");
    assert.equal(
      (outputResponse.body as { isRunning?: boolean }).isRunning,
      true,
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal runs clean route calls app-server cleanup operation", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-terminal-runs-clean",
  );
  const server = createServer({ port: 13015, codexDir: rootDir, open: false });
  const cleanedThreads: string[] = [];

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    cleanBackgroundTerminals: async (threadId: string) => {
      cleanedThreads.push(threadId);
    },
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      responseItemMessageLine("user", "clean"),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs/clean`,
      {
        method: "POST",
      },
    );

    assert.equal(response.status, 200);
    assert.equal((response.body as { ok?: boolean }).ok, true);
    assert.deepEqual(cleanedThreads, [SESSION_ID]);
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("terminal run routes parse exec_command_end-only records", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-terminal-runs-end-only",
  );
  const server = createServer({ port: 13013, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({
        type: "exec_command_end",
        source: "unified_exec_startup",
        call_id: "call_bg_end_only",
        process_id: "7000",
        command: ["bash", "-lc", "echo done"],
        aggregated_output: "done\n",
      }),
    ]);

    await loadStorage();

    const runsResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs`,
    );
    assert.equal(runsResponse.status, 200);
    const runs = (runsResponse.body as { runs?: Array<{ processId: string }> })
      .runs;
    assert.equal(runs?.length, 0);

    const outputResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/terminal-runs/7000`,
    );
    assert.equal(outputResponse.status, 404);
  } finally {
    server.stop();
    await cleanup();
  }
});

test("skills routes list session-scoped skills and update enabled state", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-skills-routes",
  );
  const server = createServer({ port: 13017, codexDir: rootDir, open: false });
  const projectDir = join(rootDir, "repo");
  await mkdir(projectDir, { recursive: true });

  const listSkillsCalls: Array<{ cwd: string; forceReload?: boolean }> = [];
  const writeSkillCalls: Array<{ path: string; enabled: boolean }> = [];

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
    listSkills: async (input) => {
      listSkillsCalls.push(input);
      return [
        {
          cwd: input.cwd,
          skills: [
            {
              name: "openai-docs",
              description: "Use OpenAI docs.",
              shortDescription: "Docs",
              interface: {
                displayName: "OpenAI Docs",
                shortDescription: "Official docs",
                iconSmall: null,
                iconLarge: null,
                brandColor: null,
                defaultPrompt: null,
              },
              dependencies: null,
              path: `${input.cwd}/.codex/skills/openai-docs/SKILL.md`,
              scope: "repo",
              enabled: true,
            },
          ],
          errors: [],
        },
      ];
    },
    writeSkillConfig: async (path, enabled) => {
      writeSkillCalls.push({ path, enabled });
      return {
        effectiveEnabled: enabled,
      };
    },
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, projectDir, Date.now()),
      responseItemMessageLine("user", "skills"),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const listResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/skills`,
    );
    assert.equal(listResponse.status, 200);
    assert.equal(
      (listResponse.body as { skills?: Array<{ name?: string }> }).skills?.[0]
        ?.name,
      "openai-docs",
    );
    assert.deepEqual(listSkillsCalls, [{ cwd: projectDir }]);

    const configResponse = await requestJson(
      server,
      `/api/sessions/${SESSION_ID}/skills/config`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `${projectDir}/.codex/skills/openai-docs/SKILL.md`,
          enabled: false,
        }),
      },
    );
    assert.equal(configResponse.status, 200);
    assert.equal(
      (configResponse.body as { effectiveEnabled?: boolean }).effectiveEnabled,
      false,
    );
    assert.deepEqual(writeSkillCalls, [
      {
        path: `${projectDir}/.codex/skills/openai-docs/SKILL.md`,
        enabled: false,
      },
    ]);
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("message route rejects invalid collaboration mode payload shapes", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-collab-validation",
  );
  const server = createServer({ port: 13006, codexDir: rootDir, open: false });

  try {
    await loadStorage();

    const invalidSettings = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          collaborationMode: { mode: "plan", settings: "bad" },
        }),
      },
    );
    assert.equal(invalidSettings.status, 400);

    const invalidModelType = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          collaborationMode: { mode: "plan", settings: { model: 123 } },
        }),
      },
    );
    assert.equal(invalidModelType.status, 400);

    const invalidDeveloperInstructions = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          collaborationMode: {
            mode: "plan",
            settings: { developerInstructions: 123 },
          },
        }),
      },
    );
    assert.equal(invalidDeveloperInstructions.status, 400);
  } finally {
    server.stop();
    await cleanup();
  }
});

test("message route forwards serviceTier to app-server", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-service-tier-forwarding",
  );
  const server = createServer({ port: 13015, codexDir: rootDir, open: false });
  let capturedServiceTier: string | null | undefined;

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async (input) => {
      capturedServiceTier = input.serviceTier;
      return { turnId: "turn-fast" };
    },
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          serviceTier: "fast",
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { turnId?: string | null }).turnId,
      "turn-fast",
    );
    assert.equal(capturedServiceTier, "fast");
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("message route strips null collaboration mode overrides before forwarding", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-collab-forwarding",
  );
  const server = createServer({ port: 13018, codexDir: rootDir, open: false });
  const capturedCollaborationModes: Array<unknown> = [];

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async (input) => {
      capturedCollaborationModes.push(input.collaborationMode);
      return { turnId: `turn-${capturedCollaborationModes.length}` };
    },
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const allNullResponse = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: null,
              reasoningEffort: null,
              developerInstructions: null,
            },
          },
        }),
      },
    );

    const mixedResponse = await requestJson(
      server,
      "/api/codex/threads/thread/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "hello again",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: null,
              reasoningEffort: "high",
              developerInstructions: null,
            },
          },
        }),
      },
    );

    assert.equal(allNullResponse.status, 200);
    assert.equal(mixedResponse.status, 200);
    assert.deepEqual(capturedCollaborationModes, [
      { mode: "plan" },
      {
        mode: "plan",
        settings: {
          reasoningEffort: "high",
        },
      },
    ]);
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("thread management routes forward rename/fork/compact/agent requests", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-thread-management",
  );
  const server = createServer({ port: 13016, codexDir: rootDir, open: false });
  const renamedThreads: Array<{ threadId: string; name: string }> = [];
  const compactedThreads: string[] = [];

  const threadMain = {
    threadId: "thread-main",
    name: "Main Thread",
    preview: "main preview",
    cwd: "/repo/main",
    agentNickname: null,
    agentRole: null,
    status: "active" as const,
    updatedAt: Date.now(),
  };
  const threadAgent = {
    threadId: "thread-agent",
    name: "Agent Thread",
    preview: "agent preview",
    cwd: "/repo/main",
    agentNickname: "atlas",
    agentRole: "explorer",
    status: "idle" as const,
    updatedAt: Date.now() - 1000,
  };

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    setThreadName: async (threadId: string, name: string) => {
      renamedThreads.push({ threadId, name });
    },
    forkThread: async () => ({
      ...threadAgent,
      threadId: "thread-forked",
      name: "Forked Thread",
    }),
    compactThread: async (threadId: string) => {
      compactedThreads.push(threadId);
    },
    getThreadSummary: async (threadId: string) => {
      if (threadId === threadMain.threadId) {
        return threadMain;
      }
      if (threadId === threadAgent.threadId) {
        return threadAgent;
      }
      throw new Error("thread not found");
    },
    listLoadedThreadIds: async () => [
      threadMain.threadId,
      threadAgent.threadId,
    ],
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const renameResponse = await requestJson(
      server,
      "/api/codex/threads/thread-main/name",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Thread" }),
      },
    );
    assert.equal(renameResponse.status, 200);
    assert.deepEqual(renamedThreads, [
      { threadId: "thread-main", name: "Renamed Thread" },
    ]);

    const forkResponse = await requestJson(
      server,
      "/api/codex/threads/thread-main/fork",
      {
        method: "POST",
      },
    );
    assert.equal(forkResponse.status, 200);
    assert.equal(
      (forkResponse.body as { thread?: { threadId?: string } }).thread
        ?.threadId,
      "thread-forked",
    );

    const compactResponse = await requestJson(
      server,
      "/api/codex/threads/thread-main/compact",
      {
        method: "POST",
      },
    );
    assert.equal(compactResponse.status, 200);
    assert.deepEqual(compactedThreads, ["thread-main"]);

    const agentThreadsResponse = await requestJson(
      server,
      "/api/codex/threads/thread-main/agent-threads",
    );
    assert.equal(agentThreadsResponse.status, 200);
    const agentThreads =
      (agentThreadsResponse.body as { threads?: Array<{ threadId: string }> })
        .threads ?? [];
    assert.deepEqual(
      agentThreads.map((thread) => thread.threadId),
      ["thread-main", "thread-agent"],
    );

    const summariesResponse = await requestJson(
      server,
      "/api/codex/threads/summaries",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadIds: ["thread-main", "thread-agent", "unknown-thread"],
        }),
      },
    );
    assert.equal(summariesResponse.status, 200);
    const summaries =
      (summariesResponse.body as { threads?: Array<{ threadId: string }> })
        .threads ?? [];
    assert.deepEqual(summaries.map((thread) => thread.threadId).sort(), [
      "thread-agent",
      "thread-main",
    ]);
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("conversation route returns empty list for unknown session", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-conversation-missing",
  );
  const server = createServer({ port: 13007, codexDir: rootDir, open: false });

  try {
    await loadStorage();
    const response = await requestJson(
      server,
      "/api/conversation/unknown-session",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  } finally {
    server.stop();
    await cleanup();
  }
});

test("thread state route preserves non-generating state when session log has no dangling turn", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("server-state-idle");
  const server = createServer({ port: 13008, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: SESSION_ID,
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: "turn-done",
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn-done" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn-done" }),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/state?turnId=turn-done`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { isGenerating?: boolean }).isGenerating,
      false,
    );
    assert.equal(
      (response.body as { activeTurnId?: string | null }).activeTurnId,
      null,
    );
    assert.equal(
      (response.body as { requestedTurnStatus?: string | null })
        .requestedTurnStatus,
      null,
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("thread state route clears ambiguous generating state when session log has no dangling turn", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-state-ambiguous-idle",
  );
  const server = createServer({ port: 13013, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: SESSION_ID,
      activeTurnId: null,
      isGenerating: true,
      requestedTurnId: "turn-done",
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn-done" }),
      eventMsgLine({ type: "task_complete", turn_id: "turn-done" }),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/state?turnId=turn-done`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { isGenerating?: boolean }).isGenerating,
      false,
    );
    assert.equal(
      (response.body as { activeTurnId?: string | null }).activeTurnId,
      null,
    );
    assert.equal(
      (response.body as { requestedTurnStatus?: string | null })
        .requestedTurnStatus,
      null,
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("thread state route preserves ambiguous generating state when session log still dangles", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-state-ambiguous-dangling",
  );
  const server = createServer({ port: 13014, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: SESSION_ID,
      activeTurnId: null,
      isGenerating: true,
      requestedTurnId: "turn-live",
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn-live" }),
    ]);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/state?turnId=turn-live`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { isGenerating?: boolean }).isGenerating,
      true,
    );
    assert.equal(
      (response.body as { activeTurnId?: string | null }).activeTurnId,
      "turn-live",
    );
    assert.equal(
      (response.body as { requestedTurnStatus?: string | null })
        .requestedTurnStatus,
      "inProgress",
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("thread state route falls back to session wait state when session log shows active turn", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-state-fallback",
  );
  const server = createServer({ port: 13009, codexDir: rootDir, open: false });

  try {
    await writeSessionFile(sessionsDir, `${SESSION_ID}.jsonl`, [
      sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
      eventMsgLine({ type: "task_started", turn_id: "turn-live" }),
    ]);

    await loadStorage();

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/state?turnId=turn-live`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (response.body as { isGenerating?: boolean }).isGenerating,
      true,
    );
    assert.equal(
      (response.body as { activeTurnId?: string | null }).activeTurnId,
      "turn-live",
    );
    assert.equal(
      (response.body as { requestedTurnStatus?: string | null })
        .requestedTurnStatus,
      "inProgress",
    );
  } finally {
    server.stop();
    await cleanup();
  }
});

test("thread state route degrades unknown rpc errors and reports dangling state without auto-fixing", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "server-state-rpc-fallback",
  );
  const server = createServer({ port: 13011, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => {
      throw new CodexAppServerRpcError(-32000, "unexpected backend failure");
    },
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
  };

  try {
    const sessionFile = await writeSessionFile(
      sessionsDir,
      `${SESSION_ID}.jsonl`,
      [
        sessionMetaLine(SESSION_ID, "/repo/app", Date.now()),
        eventMsgLine({ type: "task_started", turn_id: "turn-stale" }),
      ],
    );
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(sessionFile, staleDate, staleDate);

    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/state?turnId=turn-stale`,
    );
    assert.equal(response.status, 200);
    // Dangling state is reported as isGenerating (session log shows active turn)
    assert.equal(
      (response.body as { isGenerating?: boolean }).isGenerating,
      true,
    );
    assert.equal(
      (response.body as { activeTurnId?: string | null }).activeTurnId,
      "turn-stale",
    );

    // Session file must NOT be modified — fix dangling is manual-only
    const fileContent = await readFile(sessionFile, "utf-8");
    assert.ok(
      !fileContent.includes("Synthetic completion generated by Fix dangling"),
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("user-input requests route returns empty list on backend client failure", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-user-input-fallback",
  );
  const server = createServer({ port: 13012, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => {
      throw new CodexAppServerTransportError("app-server unavailable");
    },
    submitUserInput: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/requests/user-input`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as { requests?: unknown[] }).requests ?? [],
      [],
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});

test("approval requests route returns empty list on backend client failure", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "server-approval-fallback",
  );
  const server = createServer({ port: 13013, codexDir: rootDir, open: false });

  const mockClient: CodexAppServerClientFacade = {
    listModels: async () => [],
    listCollaborationModes: async () => [],
    createThread: async () => "thread-id",
    sendMessage: async () => ({ turnId: null }),
    getThreadState: async () => ({
      threadId: "thread-id",
      activeTurnId: null,
      isGenerating: false,
      requestedTurnId: null,
      requestedTurnStatus: null,
    }),
    getLastTurnDiff: async () => ({
      threadId: "thread-id",
      turnId: null,
      files: [],
    }),
    interruptThread: async () => undefined,
    listPendingUserInputRequests: () => [],
    submitUserInput: async () => undefined,
    listPendingApprovalRequests: () => {
      throw new CodexAppServerTransportError("app-server unavailable");
    },
    submitApproval: async () => undefined,
  };

  try {
    await loadStorage();
    setCodexAppServerClientForTests(mockClient);

    const response = await requestJson(
      server,
      `/api/codex/threads/${SESSION_ID}/requests/approvals`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (response.body as { requests?: unknown[] }).requests ?? [],
      [],
    );
  } finally {
    setCodexAppServerClientForTests(null);
    server.stop();
    await cleanup();
  }
});
