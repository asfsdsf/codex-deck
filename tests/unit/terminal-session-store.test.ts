import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getPersistedTerminalSessionArtifacts,
  persistTerminalSessionFrozenBlock,
  persistTerminalSessionMessageAction,
  readPersistedTerminalSessionManifestSync,
  removeTerminalSessionArtifacts,
} from "../../api/terminal-session-store";
import { createTempCodexDir, waitFor } from "./test-utils";

test("persistTerminalSessionFrozenBlock stores canonical block manifest and transcript", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-persist",
  );

  try {
    const persisted = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "execution",
        messageKey: "message-1",
        transcript: "pwd\n/repo/app\n",
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
    const blockPath = join(sessionDir, persisted.block.transcriptPath ?? "");

    await waitFor(() => existsSync(manifestPath) && existsSync(blockPath));

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      terminalId: string;
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.terminalId, "terminal-1");
    assert.equal(manifest.blocks.length, 1);
    assert.equal(manifest.blocks[0]?.kind, "execution");
    assert.equal(manifest.blocks[0]?.messageKey, "message-1");
    assert.equal(manifest.blocks[0]?.sequence, 1);

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );
    assert.equal(restored.blocks.length, 1);
    assert.equal(restored.blocks[0]?.transcript, "pwd\n/repo/app\n");
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionFrozenBlock updates existing logical block instead of duplicating it", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-update",
  );

  try {
    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "execution",
        messageKey: "message-1",
        transcript: "first output\n",
        sequence: 1,
      },
      rootDir,
    );

    const updated = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "execution",
        messageKey: "message-1",
        transcript: "updated output\n",
        sequence: 2,
      },
      rootDir,
    );

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );
    assert.equal(restored.blocks.length, 1);
    assert.equal(restored.blocks[0]?.transcript, "updated output\n");
    assert.equal(restored.blocks[0]?.sequence, 2);
    assert.equal(restored.blocks[0]?.blockId, updated.block.blockId);
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
        kind: "manual",
        messageKey: "message-2",
        transcript: "prompt> pwd\n/repo/app\nprompt>\n",
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
    assert.equal(restored.blocks[0]?.kind, "manual");
    assert.equal(restored.blocks[0]?.messageKey, "message-2");
    assert.equal(restored.blocks[0]?.sequence, 3);
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionMessageAction stores decisions on canonical execution block", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-action",
  );

  try {
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
    assert.equal(manifest.blocks[0]?.kind, "execution");
    assert.deepEqual(manifest.blocks[0]?.action, {
      kind: "ai-terminal-step-actions",
      steps: [
        {
          stepId: "check-status",
          decision: "approved",
          reason: null,
          updatedAt: approved.action.steps[0]?.updatedAt,
        },
        {
          stepId: "run-tests",
          decision: "rejected",
          reason: "Use the targeted test first.",
          updatedAt: manifest.blocks[0]?.action?.steps[1]?.updatedAt,
        },
      ],
    });

    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "execution",
        messageKey: "plan-message-1",
        transcript: "git status\nclean\n",
        sequence: 1,
      },
      rootDir,
    );

    const updatedManifest = readPersistedTerminalSessionManifestSync(
      "terminal-1",
      rootDir,
    );
    assert.equal(updatedManifest.blocks.length, 1);
    assert.equal(updatedManifest.blocks[0]?.transcriptPath, "blocks/" + updatedManifest.blocks[0]?.blockId + ".txt");
    assert.equal(updatedManifest.blocks[0]?.action?.steps.length, 2);
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
        kind: "execution",
        messageKey: "message-1",
        transcript: "done\n",
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
