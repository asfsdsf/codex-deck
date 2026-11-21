import { spawn } from "node:child_process";
import type { Context, Hono } from "hono";
import type {
  SessionGitActionRequest,
  SessionGitChange,
  SessionGitStatusResponse,
} from "../storage/runtime";

interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGit(projectPath: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function parseChanges(output: string): SessionGitChange[] {
  const parts = output.split("\0");
  const changes: SessionGitChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index] ?? "";
    if (record.length < 4 || record.startsWith("##")) continue;
    const indexStatus = record.slice(0, 1);
    const worktreeStatus = record.slice(1, 2);
    const path = record.slice(3);
    if (!path) continue;
    changes.push({
      path,
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === "?" && worktreeStatus === "?",
    });
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      index += 1;
    }
  }
  return changes;
}

async function getGitStatus(
  sessionId: string,
  projectPath: string | null | undefined,
  graphMode: "all" | "current" | "none" = "all",
): Promise<SessionGitStatusResponse> {
  const empty: SessionGitStatusResponse = {
    sessionId,
    projectPath: projectPath ?? null,
    branch: "",
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    graph: [],
    unavailableReason: null,
  };
  if (!projectPath) {
    return { ...empty, unavailableReason: "Project directory is unavailable." };
  }

  const [status, branch, upstream, graph] = await Promise.all([
    runGit(projectPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]),
    runGit(projectPath, ["branch", "--show-current"]),
    runGit(projectPath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]),
    graphMode === "none"
      ? Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      : runGit(projectPath, [
          "log",
          "--graph",
          "--oneline",
          "--decorate",
          ...(graphMode === "current" ? [] : ["--all"]),
          "-14",
        ]),
  ]);
  if (status.exitCode !== 0) {
    return {
      ...empty,
      unavailableReason:
        status.stderr.trim() || "Git status is unavailable for this project.",
    };
  }
  const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : null;
  const counts = upstreamName
    ? await runGit(projectPath, [
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${upstreamName}`,
      ])
    : null;
  const [ahead = "0", behind = "0"] = counts?.stdout.trim().split(/\s+/) ?? [];
  return {
    ...empty,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : "",
    upstream: upstreamName,
    ahead: Number.parseInt(ahead, 10) || 0,
    behind: Number.parseInt(behind, 10) || 0,
    changes: parseChanges(status.stdout),
    graph:
      graph.exitCode === 0
        ? graph.stdout.trimEnd().split("\n").filter(Boolean)
        : [],
  };
}

function fail(c: Context, message: string, status: 400 | 404 | 409 | 500) {
  return c.json({ error: message }, status);
}

export function registerGitWorkspaceRoutes(
  app: Hono,
  options: {
    resolveSessionProjectPath: (
      sessionId: string,
    ) => Promise<string | null | undefined>;
    resolveWorkflowProjectPath: (
      workflowKey: string,
    ) => Promise<string | null | undefined>;
    workflowRouteUnavailable: (headers: Headers) => boolean;
    onChanged?: (projectPath: string, key: string) => void;
  },
): void {
  const registerScope = (
    scope: "sessions" | "workflow-project",
    resolvePath: (key: string) => Promise<string | null | undefined>,
    param: "id" | "key",
  ) => {
    const base = `/api/${scope}/:${param}/git` as const;
    app.get(`${base}/status`, async (c) => {
      if (
        scope === "workflow-project" &&
        options.workflowRouteUnavailable(c.req.raw.headers)
      ) {
        return fail(c, "Workflow pane is unavailable in remote mode.", 409);
      }
      const sessionId = c.req.param(param)?.trim() ?? "";
      if (!sessionId) return fail(c, "Project identifier is required.", 400);
      const projectPath = await resolvePath(sessionId);
      if (projectPath === undefined) return fail(c, "Session not found.", 404);
      return c.json(
        await getGitStatus(
          sessionId,
          projectPath,
          c.req.query("graph") === "current"
            ? "current"
            : c.req.query("graph") === "none"
              ? "none"
              : "all",
        ),
      );
    });
    app.post(`${base}/action`, async (c) => {
      if (
        scope === "workflow-project" &&
        options.workflowRouteUnavailable(c.req.raw.headers)
      ) {
        return fail(c, "Workflow pane is unavailable in remote mode.", 409);
      }
      const sessionId = c.req.param(param)?.trim() ?? "";
      if (!sessionId) return fail(c, "Project identifier is required.", 400);
      const projectPath = await resolvePath(sessionId);
      if (projectPath === undefined) return fail(c, "Session not found.", 404);
      if (!projectPath)
        return fail(c, "Project directory is unavailable.", 409);
      let request: SessionGitActionRequest;
      try {
        request = await c.req.json<SessionGitActionRequest>();
      } catch {
        return fail(c, "Invalid Git action.", 400);
      }
      if (
        !request ||
        !["stage", "unstage", "commit"].includes(request.action)
      ) {
        return fail(c, "Git action must be stage, unstage, or commit.", 400);
      }
      if (request.action === "commit") {
        const message = request.message?.trim() ?? "";
        if (!message) return fail(c, "Commit message is required.", 400);
        const result = await runGit(projectPath, ["commit", "-m", message]);
        if (result.exitCode !== 0)
          return fail(c, result.stderr.trim() || "Git commit failed.", 409);
        options.onChanged?.(projectPath, sessionId);
        return c.json({
          ok: true,
          status: await getGitStatus(sessionId, projectPath),
        });
      }
      const paths = [
        ...new Set(
          (request.paths ?? [])
            .filter((path) => typeof path === "string" && path.trim())
            .map((path) => path.trim()),
        ),
      ];
      if (paths.length === 0)
        return fail(c, "Select at least one changed file.", 400);
      const status = await getGitStatus(sessionId, projectPath);
      if (status.unavailableReason)
        return fail(c, status.unavailableReason, 409);
      const valid = new Set(status.changes.map((change) => change.path));
      if (paths.some((path) => !valid.has(path))) {
        return fail(
          c,
          "A selected file is no longer changed in this project.",
          409,
        );
      }
      const args =
        request.action === "stage"
          ? ["add", "--", ...paths]
          : ["restore", "--staged", "--", ...paths];
      const result = await runGit(projectPath, args);
      if (result.exitCode !== 0)
        return fail(c, result.stderr.trim() || "Git action failed.", 409);
      options.onChanged?.(projectPath, sessionId);
      return c.json({
        ok: true,
        status: await getGitStatus(sessionId, projectPath),
      });
    });
  };

  registerScope("sessions", options.resolveSessionProjectPath, "id");
  registerScope("workflow-project", options.resolveWorkflowProjectPath, "key");
}
