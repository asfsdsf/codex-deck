import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getPersistedTerminalSessionArtifacts,
  persistTerminalSessionFrozenBlock,
  persistTerminalSessionMessageBlock,
  persistTerminalSessionMessageAction,
  readPersistedTerminalSessionManifestSync,
  removeTerminalSessionArtifacts,
} from "../../api/terminal-session-store";
import { createTempCodexDir, waitFor } from "./test-utils";

const sampleSnapshot = {
  format: "xterm-serialize-v1" as const,
  cols: 80,
  rows: 24,
  data: '\u001b[?1049h\u001b[Hpwd\r\n/repo/app\r\n',
};

test("persistTerminalSessionFrozenBlock stores canonical block manifest and snapshot", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-persist",
  );

  try {
    const persisted = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        captureKind: "manual",
        messageKey: "message-1",
        snapshot: sampleSnapshot,
        sequence: 1,
      },
      rootDir,
    );

    const sessionDir = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
    );
    const manifestPath = join(sessionDir, "session.json");
    const blockPath = join(sessionDir, persisted.block.snapshotPath ?? "");

    await waitFor(() => existsSync(manifestPath) && existsSync(blockPath));

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      terminalId: string;
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.terminalId, "terminal-1");
    assert.equal(manifest.blocks.length, 1);
    assert.equal(manifest.blocks[0]?.type, "terminal_snapshot");
    assert.equal(manifest.blocks[0]?.captureKind, "manual");
    assert.equal(manifest.blocks[0]?.messageKey, "message-1");
    assert.equal(manifest.blocks[0]?.sequence, 1);
    assert.equal(manifest.blocks[0]?.snapshotFormat, "xterm-serialize-v1");

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );
    assert.equal(restored.blocks.length, 1);
    assert.deepEqual(restored.blocks[0]?.snapshot, sampleSnapshot);
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionFrozenBlock appends a new manual block instead of mutating an existing frozen block", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-update",
  );

  try {
    const first = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        captureKind: "manual",
        snapshot: {
          ...sampleSnapshot,
          data: "first output snapshot",
        },
        sequence: 1,
      },
      rootDir,
    );

    const second = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        captureKind: "manual",
        snapshot: {
          ...sampleSnapshot,
          cols: 120,
          data: "second output snapshot",
        },
        sequence: 2,
      },
      rootDir,
    );

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );
    assert.equal(restored.blocks.length, 2);
    assert.equal(restored.blocks[0]?.snapshot?.data, "first output snapshot");
    assert.equal(restored.blocks[0]?.cols, sampleSnapshot.cols);
    assert.equal(restored.blocks[0]?.sequence, 1);
    assert.equal(restored.blocks[0]?.blockId, first.block.blockId);
    assert.equal(restored.blocks[1]?.snapshot?.data, "second output snapshot");
    assert.equal(restored.blocks[1]?.cols, 120);
    assert.equal(restored.blocks[1]?.sequence, 2);
    assert.equal(restored.blocks[1]?.blockId, second.block.blockId);
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionFrozenBlock stores manual blocks with explicit sequence", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-manual",
  );

  try {
    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        captureKind: "manual",
        messageKey: "message-2",
        snapshot: {
          ...sampleSnapshot,
          rows: 12,
          data: "prompt snapshot",
        },
        sequence: 3,
      },
      rootDir,
    );

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );
    assert.equal(restored.blocks.length, 1);
    assert.equal(restored.blocks[0]?.type, "terminal_snapshot");
    assert.equal(restored.blocks[0]?.captureKind, "manual");
    assert.equal(restored.blocks[0]?.messageKey, "message-2");
    assert.equal(restored.blocks[0]?.sequence, 3);
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionMessageBlock stores canonical AI terminal plan blocks", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-plan",
  );

  try {
    const persisted = await persistTerminalSessionMessageBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "plan-message-1",
        type: "ai_terminal_plan",
        sequence: 2,
        leadingMarkdown: "Inspect the repo first.",
        trailingMarkdown: "Then continue.",
        rawBlock: "<ai-terminal-plan>...</ai-terminal-plan>",
        contextNote: "Review before running.",
        steps: [
          {
            stepId: "check-status",
            stepGoal: "Inspect status",
            command: "git status --short",
            explanation: null,
            cwd: "/repo/app",
            shell: "zsh",
            risk: "low",
            nextAction: "approve",
            contextNote: null,
          },
        ],
        stepFeedback: [
          {
            kind: "execution",
            stepId: "check-status",
            updatedAt: "2026-01-01T00:00:00.000Z",
            status: "success",
            exitCode: 0,
            cwdAfter: "/repo/app",
            outputSummary: "Clean working tree.",
            errorSummary: null,
            outputReference: null,
          },
        ],
      },
      rootDir,
    );

    const manifest = readPersistedTerminalSessionManifestSync("terminal-1", rootDir);
    assert.equal(manifest.blocks.length, 1);
    assert.equal(manifest.blocks[0]?.type, "ai_terminal_plan");
    assert.equal(manifest.blocks[0]?.leadingMarkdown, "Inspect the repo first.");
    assert.equal(manifest.blocks[0]?.steps?.[0]?.stepId, "check-status");
    assert.equal(manifest.blocks[0]?.stepFeedback?.[0]?.kind, "execution");
    assert.equal(persisted.block.type, "ai_terminal_plan");
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionMessageAction stores actions on canonical AI terminal plan blocks", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-action",
  );

  try {
    await persistTerminalSessionMessageBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "plan-message-1",
        type: "ai_terminal_plan",
        rawBlock: "<ai-terminal-plan>...</ai-terminal-plan>",
        steps: [
          {
            stepId: "check-status",
            stepGoal: "Inspect status",
            command: "git status --short",
            explanation: null,
            cwd: "/repo/app",
            shell: "zsh",
            risk: "low",
            nextAction: "approve",
            contextNote: null,
          },
          {
            stepId: "run-tests",
            stepGoal: "Run tests",
            command: "pnpm test",
            explanation: null,
            cwd: "/repo/app",
            shell: "zsh",
            risk: "medium",
            nextAction: "approve",
            contextNote: null,
          },
        ],
      },
      rootDir,
    );
    const approved = await persistTerminalSessionMessageAction(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "plan-message-1",
        stepId: "check-status",
        decision: "approved",
        reason: null,
      },
      rootDir,
    );
    await persistTerminalSessionMessageAction(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "plan-message-1",
        stepId: "run-tests",
        decision: "rejected",
        reason: "Use the targeted test first.",
      },
      rootDir,
    );

    const manifest = readPersistedTerminalSessionManifestSync("terminal-1", rootDir);
    assert.equal(manifest.blocks.length, 1);
    assert.equal(manifest.blocks[0]?.type, "ai_terminal_plan");
    assert.deepEqual(manifest.blocks[0]?.stepActions, [
        {
          stepId: "check-status",
          decision: "approved",
          reason: null,
          updatedAt: approved.stepActions[0]?.updatedAt,
        },
        {
          stepId: "run-tests",
          decision: "rejected",
          reason: "Use the targeted test first.",
          updatedAt: manifest.blocks[0]?.stepActions?.[1]?.updatedAt,
        },
      ]);
    assert.equal(manifest.blocks[0]?.stepFeedback?.[0]?.kind, "rejection");
  } finally {
    await cleanup();
  }
});

test("readPersistedTerminalSessionManifestSync returns empty manifest for legacy shape", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-legacy-sync",
  );

  try {
    const sessionDir = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify({
        terminalId: "terminal-1",
        entries: [{ entryId: "legacy-1" }],
      }),
      "utf-8",
    );

    const restored = readPersistedTerminalSessionManifestSync(
      "terminal-1",
      rootDir,
    );
    assert.equal(restored.blocks.length, 0);
  } finally {
    await cleanup();
  }
});

test("removeTerminalSessionArtifacts deletes the persisted terminal session directory", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-remove",
  );

  try {
    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        captureKind: "manual",
        messageKey: "message-1",
        snapshot: {
          ...sampleSnapshot,
          data: "done snapshot",
        },
        sequence: 1,
      },
      rootDir,
    );

    const sessionDir = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
    );
    await waitFor(() => existsSync(sessionDir));

    await removeTerminalSessionArtifacts("terminal-1", rootDir);

    assert.equal(existsSync(sessionDir), false);
  } finally {
    await cleanup();
  }
});
