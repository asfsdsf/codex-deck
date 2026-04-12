import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const workflowScript = join(
  process.cwd(),
  "skills/codex-deck-flow/scripts/workflow.py",
);

async function initRepo(projectDir: string): Promise<void> {
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
}

async function createWorkflow(
  projectDir: string,
  workflowId: string,
  extraArgs: string[] = [],
): Promise<{ workflowPath: string; targetBranch: string }> {
  const workflowPath = join(projectDir, ".codex-deck", `${workflowId}.json`);
  await execFileAsync("python3", [
    workflowScript,
    "create",
    "--title",
    "Branch detection flow",
    "--request",
    "Exercise target branch defaults",
    "--project-root",
    projectDir,
    "--workflow-id",
    workflowId,
    "--codex-home",
    join(projectDir, ".codex-home"),
    ...extraArgs,
  ]);
  const payload = JSON.parse(await readFile(workflowPath, "utf-8")) as {
    workflow: {
      targetBranch: string;
    };
  };
  return {
    workflowPath,
    targetBranch: payload.workflow.targetBranch,
  };
}

test("workflow create defaults the target branch to the current checked-out branch", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-branch-default-"),
  );
  const projectDir = join(rootDir, "repo");

  try {
    await initRepo(projectDir);
    await execFileAsync("git", ["checkout", "-b", "feature/current-default"], {
      cwd: projectDir,
    });

    const workflow = await createWorkflow(projectDir, "current-branch-default");

    assert.equal(workflow.targetBranch, "feature/current-default");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow create preserves an explicit --target-branch override", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-branch-override-"),
  );
  const projectDir = join(rootDir, "repo");

  try {
    await initRepo(projectDir);
    await execFileAsync("git", ["checkout", "-b", "feature/current-default"], {
      cwd: projectDir,
    });

    const workflow = await createWorkflow(
      projectDir,
      "explicit-branch-override",
      ["--target-branch", "release/2026-03"],
    );

    assert.equal(workflow.targetBranch, "release/2026-03");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow create falls back to main when git cannot resolve a named branch", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-branch-fallback-"),
  );
  const projectDir = join(rootDir, "repo");

  try {
    await initRepo(projectDir);
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir })
    ).stdout.trim();
    await execFileAsync("git", ["checkout", "--detach", head], {
      cwd: projectDir,
    });

    const workflow = await createWorkflow(projectDir, "detached-head-fallback");

    assert.equal(workflow.targetBranch, "main");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
