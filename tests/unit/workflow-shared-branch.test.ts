import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const workflowScript = join(
  process.cwd(),
  "skills/codex-deck-flow/scripts/workflow.py",
);

function workflowJson(projectRoot: string, tasks: unknown[]): string {
  return `${JSON.stringify(
    {
      workflow: {
        id: "shared-branch-flow",
        title: "Shared branch flow",
        createdAt: "2026-03-27T00:00:00Z",
        updatedAt: "2026-03-27T00:00:00Z",
        status: "running",
        targetBranch: "main",
        projectRoot,
        request: "exercise shared branch workflow behavior",
      },
      scheduler: {
        running: false,
        pendingTrigger: false,
      },
      settings: {
        codexHome: join(projectRoot, ".codex-home"),
        codexCliPath: "codex",
        maxParallel: 2,
        mergePolicy: "integration-branch",
        stopSignal: "[codex-deck:stop-pending]",
      },
      tasks,
      history: [],
    },
    null,
    2,
  )}\n`;
}

async function initRepo(projectDir: string): Promise<string> {
  await mkdir(projectDir, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: projectDir,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: projectDir,
  });
  await writeFile(join(projectDir, "README.md"), "base\n", "utf-8");
  await execFileAsync("git", ["add", "README.md"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: projectDir });
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir })
  ).stdout.trim();
}

test("workflow validate rejects shared-branch tasks without dependency ordering", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-shared-branch-invalid-"),
  );
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "shared-branch-flow.json");

  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      workflowPath,
      workflowJson(projectDir, [
        {
          id: "task-a",
          name: "Task A",
          prompt: "Do A",
          dependsOn: [],
          status: "pending",
          sessionId: null,
          branchName: "flow/shared-branch-flow/shared",
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
        {
          id: "task-b",
          name: "Task B",
          prompt: "Do B",
          dependsOn: [],
          status: "pending",
          sessionId: null,
          branchName: "flow/shared-branch-flow/shared",
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
      ]),
      "utf-8",
    );

    await assert.rejects(
      execFileAsync("python3", [
        workflowScript,
        "validate",
        "--workflow",
        workflowPath,
      ]),
      (error: Error & { stderr?: string; stdout?: string }) => {
        assert.match(
          `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          /share branch .* but are not ordered by dependencies/i,
        );
        return true;
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow launch hands off a shared branch from a completed predecessor", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-shared-branch-launch-"),
  );
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "shared-branch-flow.json");
  const firstWorktree = join(workflowDir, "worktrees", "task-a");
  const secondWorktree = join(workflowDir, "worktrees", "task-b");

  try {
    const baseCommit = await initRepo(projectDir);
    await mkdir(join(workflowDir, "worktrees"), { recursive: true });

    await execFileAsync("git", [
      "-C",
      projectDir,
      "worktree",
      "add",
      "-B",
      "flow/shared-branch-flow/shared",
      firstWorktree,
      baseCommit,
    ]);
    await writeFile(join(firstWorktree, "task-a.txt"), "task a\n", "utf-8");
    await execFileAsync("git", ["add", "task-a.txt"], { cwd: firstWorktree });
    await execFileAsync("git", ["commit", "-m", "task a"], {
      cwd: firstWorktree,
    });
    const taskACommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: firstWorktree })
    ).stdout.trim();

    await writeFile(
      workflowPath,
      workflowJson(projectDir, [
        {
          id: "task-a",
          name: "Task A",
          prompt: "Do A",
          dependsOn: [],
          status: "success",
          sessionId: "session-a",
          branchName: "flow/shared-branch-flow/shared",
          worktreePath: firstWorktree,
          baseCommit,
          resultCommit: taskACommit,
          startedAt: "2026-03-27T00:00:01Z",
          finishedAt: "2026-03-27T00:00:02Z",
          summary: "done",
          failureReason: null,
          noOp: false,
          stopPending: false,
          runnerPid: null,
        },
        {
          id: "task-b",
          name: "Task B",
          prompt: "Do B",
          dependsOn: ["task-a"],
          status: "pending",
          sessionId: null,
          branchName: "flow/shared-branch-flow/shared",
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
      ]),
      "utf-8",
    );

    const validation = await execFileAsync("python3", [
      workflowScript,
      "validate",
      "--workflow",
      workflowPath,
    ]);
    assert.match(validation.stdout, /valid/i);

    const launchProbe = `
import argparse
import importlib.util
import json
import pathlib
import subprocess
import sys

workflow_path = pathlib.Path(sys.argv[1])
workflow_script = pathlib.Path(sys.argv[2])

spec = importlib.util.spec_from_file_location("codex_deck_workflow", workflow_script)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

module.run_task_runner = lambda wf_path, task_id: 424242
rc = module.cmd_launch_task(argparse.Namespace(workflow=str(workflow_path), task_id="task-b"))
payload = json.loads(workflow_path.read_text(encoding="utf-8"))
task_a = next(task for task in payload["tasks"] if task["id"] == "task-a")
task_b = next(task for task in payload["tasks"] if task["id"] == "task-b")
root = pathlib.Path(payload["workflow"]["projectRoot"])
worktree_list = subprocess.check_output(
    ["git", "-C", str(root), "worktree", "list", "--porcelain"],
    text=True,
)
print(json.dumps({
    "rc": rc,
    "taskAPathExists": pathlib.Path(task_a["worktreePath"]).exists(),
    "taskBPathExists": pathlib.Path(task_b["worktreePath"]).exists(),
    "taskBPath": task_b["worktreePath"],
    "taskBStatus": task_b["status"],
    "taskBRunnerPid": task_b["runnerPid"],
    "taskBBaseCommit": task_b["baseCommit"],
    "worktreeList": worktree_list,
}, ensure_ascii=True))
raise SystemExit(rc)
`;

    const launchResult = await execFileAsync(
      "python3",
      ["-c", launchProbe, workflowPath, workflowScript],
      { cwd: projectDir },
    );
    const summary = JSON.parse(
      launchResult.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .at(-1) ?? "{}",
    ) as {
      rc: number;
      taskAPathExists: boolean;
      taskBPathExists: boolean;
      taskBPath: string;
      taskBStatus: string;
      taskBRunnerPid: number;
      taskBBaseCommit: string;
      worktreeList: string;
    };

    assert.equal(summary.rc, 0);
    assert.equal(summary.taskAPathExists, false);
    assert.equal(summary.taskBPathExists, true);
    assert.equal(summary.taskBPath, secondWorktree);
    assert.equal(summary.taskBStatus, "running");
    assert.equal(summary.taskBRunnerPid, 424242);
    assert.equal(summary.taskBBaseCommit, taskACommit);
    assert.match(
      summary.worktreeList,
      /branch refs\/heads\/flow\/shared-branch-flow\/shared/,
    );
    assert.match(
      summary.worktreeList,
      new RegExp(secondWorktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      summary.worktreeList,
      new RegExp(firstWorktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
