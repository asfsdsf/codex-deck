import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

function workflowJson(projectRoot: string): string {
  return `${JSON.stringify(
    {
      workflow: {
        id: "preview-flow",
        title: "Preview Flow",
        createdAt: "2026-03-25T00:00:00Z",
        updatedAt: "2026-03-25T00:05:00Z",
        status: "completed",
        targetBranch: "main",
        projectRoot,
        request: "preview merge behavior",
      },
      scheduler: {
        running: false,
        pendingTrigger: false,
      },
      settings: {
        codexHome: join(projectRoot, ".codex-home"),
        codexCliPath: "codex",
        maxParallel: 1,
        mergePolicy: "integration-branch",
        stopSignal: "[codex-deck:stop-pending]",
      },
      tasks: [
        {
          id: "task-a",
          name: "Task A",
          prompt: "Do A",
          dependsOn: [],
          status: "success",
          sessionId: null,
          branchName: "flow/preview-flow/task-a",
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
      history: [],
    },
    null,
    2,
  )}\n`;
}

test("workflow merge --preview reports branches without switching HEAD", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-preview-"));
  const projectDir = join(rootDir, "repo");
  const workflowDir = join(projectDir, ".codex-deck");
  const workflowPath = join(workflowDir, "preview-flow.json");
  const runScript = join(
    process.cwd(),
    "skills/codex-deck-flow/scripts/run.sh",
  );

  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(workflowPath, workflowJson(projectDir), "utf-8");

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
    await execFileAsync("git", ["checkout", "-b", "flow/preview-flow/task-a"], {
      cwd: projectDir,
    });
    await writeFile(join(projectDir, "feature.txt"), "feature\n", "utf-8");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: projectDir });
    await execFileAsync("git", ["commit", "-m", "task a"], { cwd: projectDir });
    await execFileAsync("git", ["checkout", "main"], { cwd: projectDir });

    const beforeHead = (
      await execFileAsync("git", ["branch", "--show-current"], {
        cwd: projectDir,
      })
    ).stdout.trim();

    const { stdout } = await execFileAsync(
      runScript,
      ["merge", "--workflow", workflowPath, "--preview"],
      { cwd: projectDir },
    );

    const afterHead = (
      await execFileAsync("git", ["branch", "--show-current"], {
        cwd: projectDir,
      })
    ).stdout.trim();

    assert.equal(beforeHead, "main");
    assert.equal(afterHead, "main");
    assert.match(stdout, /preview target: main/i);
    assert.match(stdout, /flow\/preview-flow\/task-a/);
    assert.match(stdout, /task a/i);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
