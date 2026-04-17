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

test("persistTerminalSessionFrozenBlock stores manifest and block files under codex home", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-persist",
  );

  try {
    const persisted = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "message-1",
        transcript: "pwd\n/repo/app\n",
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
    const blockPath = join(sessionDir, persisted.entry.transcriptPath);

    await waitFor(() => existsSync(manifestPath) && existsSync(blockPath));

    const manifestText = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestText) as {
      terminalId: string;
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.terminalId, "terminal-1");
    assert.equal(manifest.blocks.length, 2);
    assert.deepEqual(
      manifest.blocks.map((block) => block.type),
      ["codex-session-message", "terminal-frozen-output"],
    );
    assert.deepEqual(manifest.blocks[0], {
      blockId: `${persisted.entry.entryId}-message`,
      type: "codex-session-message",
      createdAt: persisted.entry.createdAt,
      updatedAt: persisted.entry.updatedAt,
      sessionId: "session-1",
      messageKey: "message-1",
      action: null,
    });
    assert.deepEqual(manifest.blocks[1], {
      blockId: persisted.entry.entryId,
      type: "terminal-frozen-output",
      createdAt: persisted.entry.createdAt,
      updatedAt: persisted.entry.updatedAt,
      path: persisted.entry.transcriptPath,
      transcriptLength: persisted.entry.transcriptLength,
      stepId: null,
      source: {
        kind: "codex-session-message",
        blockId: `${persisted.entry.entryId}-message`,
      },
    });

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      {
        sessionId: "session-1",
      },
      rootDir,
    );
    assert.equal(restored.manifest.terminalId, "terminal-1");
    assert.deepEqual(restored.frozenOutputByMessageKey, {
      "message-1": "pwd\n/repo/app\n",
    });
    assert.deepEqual(restored.frozenOutputsInOrder, ["pwd\n/repo/app\n"]);
    assert.equal(restored.entries.length, 1);
    assert.equal(restored.entries[0]?.transcript, "pwd\n/repo/app\n");
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionFrozenBlock updates an existing message entry instead of duplicating it", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-update",
  );

  try {
    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "message-1",
        transcript: "first output\n",
      },
      rootDir,
    );

    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "message-1",
        transcript: "updated output\n",
      },
      rootDir,
    );

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      {
        sessionId: "session-1",
      },
      rootDir,
    );
    assert.equal(restored.entries.length, 1);
    assert.deepEqual(restored.frozenOutputByMessageKey, {
      "message-1": "updated output\n",
    });

    const manifestPath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
      "session.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.blocks.length, 2);
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionFrozenBlock stores manual anchored output without a codex message source", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-manual",
  );

  try {
    const persisted = await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        beforeMessageKey: "message-2",
        transcript: "prompt> pwd\n/repo/app\nprompt>\n",
      },
      rootDir,
    );

    const manifestPath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
      "session.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      blocks: Array<Record<string, unknown>>;
    };

    assert.equal(manifest.blocks.length, 1);
    assert.deepEqual(manifest.blocks[0], {
      blockId: persisted.entry.entryId,
      type: "terminal-frozen-output",
      createdAt: persisted.entry.createdAt,
      updatedAt: persisted.entry.updatedAt,
      path: persisted.entry.transcriptPath,
      transcriptLength: persisted.entry.transcriptLength,
      stepId: null,
      source: {
        kind: "terminal-inline-output",
        sessionId: "session-1",
        beforeMessageKey: "message-2",
      },
    });

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      {
        sessionId: "session-1",
      },
      rootDir,
    );
    assert.deepEqual(restored.frozenOutputByMessageKey, {});
    assert.deepEqual(restored.frozenOutputByBeforeMessageKey, {
      "message-2": "prompt> pwd\n/repo/app\nprompt>\n",
    });
    assert.deepEqual(restored.frozenOutputsInOrder, []);
    assert.equal(restored.entries[0]?.reference.kind, "terminal-inline-output");
  } finally {
    await cleanup();
  }
});

test("persistTerminalSessionMessageAction stores decisions inside the codex-session-message block", async () => {
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

    const manifestPath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
      "session.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      blocks: Array<Record<string, unknown>>;
    };

    assert.equal(manifest.blocks.length, 1);
    assert.equal(manifest.blocks[0]?.type, "codex-session-message");
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
          updatedAt: (
            manifest.blocks[0]?.action as {
              steps: Array<{ updatedAt: string }>;
            }
          ).steps[1]?.updatedAt,
        },
      ],
    });

    await persistTerminalSessionFrozenBlock(
      {
        terminalId: "terminal-1",
        sessionId: "session-1",
        messageKey: "plan-message-1",
        transcript: "git status\nclean\n",
      },
      rootDir,
    );

    const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      blocks: Array<Record<string, unknown>>;
    };
    assert.equal(updatedManifest.blocks.length, 2);
    assert.equal(updatedManifest.blocks[0]?.type, "codex-session-message");
    assert.deepEqual(
      updatedManifest.blocks[0]?.action,
      manifest.blocks[0]?.action,
    );
    assert.equal(updatedManifest.blocks[1]?.type, "terminal-frozen-output");
  } finally {
    await cleanup();
  }
});

test("getPersistedTerminalSessionArtifacts restores legacy combined manifest blocks", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "terminal-session-store-legacy",
  );

  try {
    const sessionDir = join(
      rootDir,
      "codex-deck",
      "terminal",
      "sessions",
      "terminal-1",
    );
    const blocksDir = join(sessionDir, "blocks");
    await mkdir(blocksDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify(
        {
          terminalId: "terminal-1",
          createdAt: "2026-04-16T09:42:18.187Z",
          updatedAt: "2026-04-16T09:43:28.475Z",
          blocks: [
            {
              blockId: "block-legacy-1",
              type: "codex-session-block-reference",
              createdAt: "2026-04-16T09:42:18.187Z",
              updatedAt: "2026-04-16T09:43:28.475Z",
              reference: {
                kind: "codex-session-message",
                sessionId: "session-1",
                messageKey: "message-1",
              },
              frozenArtifact: {
                kind: "terminal-frozen-output",
                path: "blocks/block-legacy-1.txt",
                transcriptLength: 14,
                stepId: null,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(join(blocksDir, "block-legacy-1.txt"), "pwd\n/repo/app\n");

    const restored = await getPersistedTerminalSessionArtifacts(
      "terminal-1",
      { sessionId: "session-1" },
      rootDir,
    );

    assert.equal(restored.entries.length, 1);
    assert.equal(restored.entries[0]?.entryId, "block-legacy-1");
    assert.equal(restored.entries[0]?.reference.messageKey, "message-1");
    assert.equal(restored.entries[0]?.transcript, "pwd\n/repo/app\n");
  } finally {
    await cleanup();
  }
});

test("readPersistedTerminalSessionManifestSync restores legacy combined manifest blocks", async () => {
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
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify(
        {
          terminalId: "terminal-1",
          createdAt: "2026-04-16T09:42:18.187Z",
          updatedAt: "2026-04-16T09:43:28.475Z",
          blocks: [
            {
              blockId: "block-legacy-1",
              type: "codex-session-block-reference",
              createdAt: "2026-04-16T09:42:18.187Z",
              updatedAt: "2026-04-16T09:43:28.475Z",
              reference: {
                kind: "codex-session-message",
                sessionId: "session-1",
                messageKey: "message-1",
              },
              frozenArtifact: {
                kind: "terminal-frozen-output",
                path: "blocks/block-legacy-1.txt",
                transcriptLength: 14,
                stepId: null,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const restored = readPersistedTerminalSessionManifestSync(
      "terminal-1",
      rootDir,
    );

    assert.equal(restored.terminalId, "terminal-1");
    assert.equal(restored.entries.length, 1);
    assert.equal(restored.entries[0]?.entryId, "block-legacy-1");
    assert.deepEqual(restored.entries[0]?.reference, {
      kind: "codex-session-message",
      sessionId: "session-1",
      messageKey: "message-1",
    });
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
        messageKey: "message-1",
        transcript: "done\n",
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
