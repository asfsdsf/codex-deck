import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const workflowScript = join(
  process.cwd(),
  "skills/codex-deck-flow/scripts/workflow.py",
);

async function assertSamePath(actualPath: string, expectedPath: string) {
  assert.equal(await realpath(actualPath), await realpath(expectedPath));
}

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

type CreateOptions = {
  projectDir: string;
  codexHome: string;
  title: string;
  request: string;
  workflowId?: string;
  extraArgs?: string[];
};

async function runCreate(options: CreateOptions) {
  const args = [
    workflowScript,
    "create",
    "--title",
    options.title,
    "--request",
    options.request,
    "--project-root",
    options.projectDir,
    "--codex-home",
    options.codexHome,
    ...(options.workflowId ? ["--workflow-id", options.workflowId] : []),
    ...(options.extraArgs ?? []),
  ];
  return execFileAsync("python3", args);
}

test("workflow create rejects duplicate IDs in the same project and suggests alternatives", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-create-conflict-"));
  const projectDir = join(rootDir, "repo");
  const codexHome = join(rootDir, "codex-home");

  try {
    await initRepo(projectDir);
    await runCreate({
      projectDir,
      codexHome,
      title: "Feature Delivery",
      request: "Create the first workflow",
      workflowId: "feature-delivery",
    });

    await assert.rejects(
      runCreate({
        projectDir,
        codexHome,
        title: "Feature Delivery",
        request: "Create the second workflow",
        workflowId: "feature-delivery",
      }),
      (error: Error & { stderr?: string; stdout?: string }) => {
        assert.match(error.stderr ?? "", /error: workflow already exists:/);
        assert.match(
          error.stderr ?? "",
          /requested workflow id: feature-delivery/,
        );
        assert.match(
          error.stderr ?? "",
          /suggested workflow id: feature-delivery-2/,
        );
        assert.match(
          error.stderr ?? "",
          /suggested workflow path: .*feature-delivery-2\.json/,
        );
        return true;
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow create treats title sanitization collisions as conflicts in one project", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-sanitize-conflict-"),
  );
  const projectDir = join(rootDir, "repo");
  const codexHome = join(rootDir, "codex-home");

  try {
    await initRepo(projectDir);
    await runCreate({
      projectDir,
      codexHome,
      title: "Feature Delivery",
      request: "Create the first workflow",
    });

    await assert.rejects(
      runCreate({
        projectDir,
        codexHome,
        title: "Feature_delivery",
        request: "Create a colliding workflow",
      }),
      (error: Error & { stderr?: string; stdout?: string }) => {
        assert.match(
          error.stderr ?? "",
          /requested workflow id: feature-delivery/,
        );
        assert.match(
          error.stderr ?? "",
          /suggested workflow id: feature-delivery-2/,
        );
        return true;
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow create json conflict payload skips occupied suffix suggestions", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-json-conflict-"),
  );
  const projectDir = join(rootDir, "repo");
  const codexHome = join(rootDir, "codex-home");

  try {
    await initRepo(projectDir);
    await runCreate({
      projectDir,
      codexHome,
      title: "Base workflow",
      request: "Create the base workflow",
      workflowId: "feature-delivery",
    });
    await runCreate({
      projectDir,
      codexHome,
      title: "Reserved suffix workflow",
      request: "Reserve the first suffix",
      workflowId: "feature-delivery-2",
    });

    await assert.rejects(
      runCreate({
        projectDir,
        codexHome,
        title: "Conflicting workflow",
        request: "Create the conflicting workflow",
        workflowId: "feature-delivery",
        extraArgs: ["--json"],
      }),
      (error: Error & { stdout?: string }) => {
        const payload = JSON.parse(error.stdout ?? "") as {
          ok: boolean;
          error: string;
          requestedId: string;
          conflictingPath: string;
          suggestedIds: string[];
          suggestedPath: string;
        };
        assert.equal(payload.ok, false);
        assert.equal(payload.error, "workflow-id-conflict");
        assert.equal(payload.requestedId, "feature-delivery");
        assert.match(payload.conflictingPath, /feature-delivery\.json$/);
        assert.deepEqual(payload.suggestedIds.slice(0, 3), [
          "feature-delivery-3",
          "feature-delivery-4",
          "feature-delivery-5",
        ]);
        assert.match(payload.suggestedPath, /feature-delivery-3\.json$/);
        return true;
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow create json success payload returns the final workflow ID and path", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-json-success-"),
  );
  const projectDir = join(rootDir, "repo");
  const codexHome = join(rootDir, "codex-home");

  try {
    await initRepo(projectDir);
    const result = await runCreate({
      projectDir,
      codexHome,
      title: "Workflow Success",
      request: "Create a workflow",
      workflowId: "workflow-success",
      extraArgs: ["--json"],
    });
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      workflowId: string;
      workflowPath: string;
      projectRoot: string;
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.workflowId, "workflow-success");
    await assertSamePath(
      payload.workflowPath,
      join(projectDir, ".codex-deck", "workflow-success.json"),
    );
    await assertSamePath(payload.projectRoot, projectDir);
    await access(payload.workflowPath, constants.F_OK);
    const workflow = JSON.parse(
      await readFile(payload.workflowPath, "utf-8"),
    ) as {
      workflow: {
        id: string;
      };
    };
    assert.equal(workflow.workflow.id, "workflow-success");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("the same workflow ID is allowed in different projects and resolves within project scope", async () => {
  const rootDir = await mkdtemp(
    join(tmpdir(), "workflow-create-cross-project-"),
  );
  const projectA = join(rootDir, "repo-a");
  const projectB = join(rootDir, "repo-b");
  const codexHome = join(rootDir, "shared-codex-home");

  try {
    await initRepo(projectA);
    await initRepo(projectB);

    await runCreate({
      projectDir: projectA,
      codexHome,
      title: "Shared Workflow",
      request: "Create workflow in project A",
      workflowId: "shared-workflow",
    });
    await runCreate({
      projectDir: projectB,
      codexHome,
      title: "Shared Workflow",
      request: "Create workflow in project B",
      workflowId: "shared-workflow",
    });

    const resolveA = await execFileAsync("python3", [
      workflowScript,
      "resolve-workflow",
      "--project-root",
      projectA,
      "--workflow-id",
      "shared-workflow",
      "--codex-home",
      codexHome,
      "--json",
    ]);
    const resolveB = await execFileAsync("python3", [
      workflowScript,
      "resolve-workflow",
      "--project-root",
      projectB,
      "--workflow-id",
      "shared-workflow",
      "--codex-home",
      codexHome,
      "--json",
    ]);

    const payloadA = JSON.parse(resolveA.stdout) as {
      workflowPath: string;
      projectRoot: string;
      exists: boolean;
    };
    const payloadB = JSON.parse(resolveB.stdout) as {
      workflowPath: string;
      projectRoot: string;
      exists: boolean;
    };

    assert.equal(payloadA.exists, true);
    assert.equal(payloadB.exists, true);
    await assertSamePath(payloadA.projectRoot, projectA);
    await assertSamePath(payloadB.projectRoot, projectB);
    await assertSamePath(
      payloadA.workflowPath,
      join(projectA, ".codex-deck", "shared-workflow.json"),
    );
    await assertSamePath(
      payloadB.workflowPath,
      join(projectB, ".codex-deck", "shared-workflow.json"),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
