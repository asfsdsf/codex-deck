import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemMessageLine,
  sessionMetaLine,
  writeSessionFile,
} from "../../unit/test-utils";

const ALPHA_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const BETA_SESSION_ID = "22222222-2222-2222-2222-222222222222";
const DANGLING_SESSION_ID = "33333333-3333-3333-3333-333333333333";
const DANGLING_TURN_ID = "turn-stalled-1";
const SERVER_START_TIMEOUT_MS = 15_000;

type SessionKey = "alpha" | "beta" | "dangling";
type ProjectKey = "alpha" | "beta";

interface CreateSessionOptions {
  sessionId: string;
  projectKey: ProjectKey;
  prompt: string;
  assistantReply?: string;
}

interface CreateHistoryOnlySessionOptions {
  sessionId: string;
  prompt: string;
}

export interface IntegrationAppFixture {
  baseURL: string;
  rootDir: string;
  projects: {
    alpha: string;
    beta: string;
  };
  sessions: Record<SessionKey, string>;
  readSessionFile: (sessionKey: SessionKey) => Promise<string>;
  appendSessionMessage: (
    sessionKey: SessionKey,
    role: "user" | "assistant",
    text: string,
  ) => Promise<void>;
  createSession: (options: CreateSessionOptions) => Promise<void>;
  createHistoryOnlySession: (
    options: CreateHistoryOnlySessionOptions,
  ) => Promise<void>;
  sessionFileExists: (sessionKey: SessionKey) => Promise<boolean>;
}

interface RunningIntegrationApp extends IntegrationAppFixture {
  close: () => Promise<void>;
}

function formatLogs(logs: string[]): string {
  return logs.join("").trim();
}

function appendLogs(logs: string[], prefix: string, chunk: Buffer): void {
  logs.push(`${prefix}${chunk.toString("utf-8")}`);
}

async function ensureBuildArtifacts(): Promise<void> {
  try {
    await Promise.all([
      access(join(process.cwd(), "dist", "index.js")),
      access(join(process.cwd(), "dist", "web", "index.html")),
    ]);
  } catch {
    throw new Error(
      "Build artifacts are missing. Run `pnpm build` before `playwright test`.",
    );
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a free TCP port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServerReady(
  baseURL: string,
  child: ChildProcessWithoutNullStreams,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  const healthUrl = `${baseURL}/api/sessions`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `codex-deck exited before becoming ready (exit ${child.exitCode}).\n${formatLogs(logs)}`,
      );
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is reachable or times out.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for codex-deck to start at ${baseURL}.\n${formatLogs(logs)}`,
  );
}

async function stopServerProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

  if (exited || child.exitCode !== null) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function createIntegrationApp(): Promise<RunningIntegrationApp> {
  await ensureBuildArtifacts();

  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "codex-deck-playwright",
  );
  const projectsRoot = join(rootDir, "projects");
  const alphaProject = join(projectsRoot, "project-alpha");
  const betaProject = join(projectsRoot, "project-beta");
  const historyPath = join(rootDir, "history.jsonl");

  await writeFile(historyPath, "", "utf-8");

  await mkdir(join(alphaProject, "src"), { recursive: true });
  await writeFile(
    join(alphaProject, "src", "main.ts"),
    [
      "export const launchChecklist = [",
      '  "review launch notes",',
      '  "ship docs",',
      "];",
      "",
      'export const projectName = "project-alpha";',
    ].join("\n"),
    "utf-8",
  );

  await mkdir(join(betaProject, "docs"), { recursive: true });
  await writeFile(
    join(betaProject, "docs", "notes.md"),
    ["# Beta notes", "", "- verify staging", "- prepare release"].join("\n"),
    "utf-8",
  );

  const now = Date.now();
  await writeSessionFile(sessionsDir, `${ALPHA_SESSION_ID}.jsonl`, [
    sessionMetaLine(ALPHA_SESSION_ID, alphaProject, now - 2_000),
    responseItemMessageLine("user", "Review the launch checklist"),
    responseItemMessageLine("assistant", "The deployment steps are ready."),
    responseItemMessageLine(
      "assistant",
      "Search launch references before shipping.",
    ),
  ]);

  await writeSessionFile(sessionsDir, `${BETA_SESSION_ID}.jsonl`, [
    sessionMetaLine(BETA_SESSION_ID, betaProject, now - 1_000),
    responseItemMessageLine("user", "Summarize the beta release notes"),
    responseItemMessageLine("assistant", "Beta release notes are ready."),
  ]);

  await writeSessionFile(sessionsDir, `${DANGLING_SESSION_ID}.jsonl`, [
    sessionMetaLine(DANGLING_SESSION_ID, alphaProject, now),
    responseItemMessageLine("user", "Investigate the stalled turn"),
    eventMsgLine({ type: "task_started", turn_id: DANGLING_TURN_ID }),
    responseItemMessageLine("assistant", "Still waiting on the stalled turn."),
  ]);
  const sessions: Record<SessionKey, string> = {
    alpha: ALPHA_SESSION_ID,
    beta: BETA_SESSION_ID,
    dangling: DANGLING_SESSION_ID,
  };

  const createSession = async ({
    sessionId,
    projectKey,
    prompt,
    assistantReply,
  }: CreateSessionOptions): Promise<void> => {
    const projectPath = projectKey === "alpha" ? alphaProject : betaProject;
    const lines = [
      sessionMetaLine(sessionId, projectPath, Date.now()),
      responseItemMessageLine("user", prompt),
    ];
    if (assistantReply) {
      lines.push(responseItemMessageLine("assistant", assistantReply));
    }

    await writeSessionFile(sessionsDir, `${sessionId}.jsonl`, lines);
  };

  const createHistoryOnlySession = async ({
    sessionId,
    prompt,
  }: CreateHistoryOnlySessionOptions): Promise<void> => {
    await appendFile(
      historyPath,
      `${JSON.stringify({
        session_id: sessionId,
        ts: Math.floor(Date.now() / 1000),
        text: prompt,
      })}\n`,
      "utf-8",
    );
  };

  const port = await getFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist", "index.js"),
      "--port",
      String(port),
      "--dir",
      rootDir,
      "--no-open",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk: Buffer) => {
    appendLogs(logs, "[stdout] ", chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    appendLogs(logs, "[stderr] ", chunk);
  });

  try {
    await waitForServerReady(baseURL, child, logs);
  } catch (error) {
    await stopServerProcess(child);
    await cleanup();
    throw error;
  }

  return {
    baseURL,
    rootDir,
    projects: {
      alpha: alphaProject,
      beta: betaProject,
    },
    sessions,
    readSessionFile: async (sessionKey: SessionKey) =>
      readFile(join(sessionsDir, `${sessions[sessionKey]}.jsonl`), "utf-8"),
    appendSessionMessage: async (
      sessionKey: SessionKey,
      role: "user" | "assistant",
      text: string,
    ) => {
      const sessionPath = join(sessionsDir, `${sessions[sessionKey]}.jsonl`);
      const line = responseItemMessageLine(
        role,
        text,
        new Date().toISOString(),
      );
      await appendFile(sessionPath, `${line}\n`, "utf-8");
    },
    createSession,
    createHistoryOnlySession,
    sessionFileExists: async (sessionKey: SessionKey) => {
      try {
        await access(join(sessionsDir, `${sessions[sessionKey]}.jsonl`));
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      await stopServerProcess(child);
      await cleanup();
    },
  };
}

export const test = base.extend<{ app: IntegrationAppFixture }>({
  app: async ({}, use) => {
    const app = await createIntegrationApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});

export { expect };
