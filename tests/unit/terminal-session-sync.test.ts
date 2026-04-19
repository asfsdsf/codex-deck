import assert from "node:assert/strict";
import test from "node:test";
import { getCodexDir, initStorage, loadStorage } from "../../api/storage";
import { syncTerminalSessionArtifacts } from "../../api/terminal-session-sync";
import {
  createTempCodexDir,
  responseItemMessageLine,
  sessionMetaLine,
  writeSessionFile,
} from "./test-utils";

const planMessage = `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-status</step_id>
    <command><![CDATA[git status --short]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`;

const finishedMessage =
  "<requirement_finished>Repository check complete.</requirement_finished>";

test("syncTerminalSessionArtifacts appends new blocks and preserves existing order on update", async () => {
  const { rootDir, sessionsDir, cleanup } = await createTempCodexDir(
    "terminal-session-sync",
  );
  const previousCodexDir = getCodexDir();

  try {
    initStorage(rootDir);
    await writeSessionFile(sessionsDir, "session-1.jsonl", [
      sessionMetaLine("session-1", "/repo/app", Date.now()),
      responseItemMessageLine(
        "assistant",
        planMessage,
        "2026-01-01T00:00:00.000Z",
      ),
      responseItemMessageLine(
        "assistant",
        finishedMessage,
        "2026-01-01T00:00:01.000Z",
      ),
    ]);
    await loadStorage();

    const firstSync = await syncTerminalSessionArtifacts({
      terminalId: "terminal-1",
      sessionId: "session-1",
      codexHome: rootDir,
    });

    assert.deepEqual(
      firstSync.manifest.blocks.map((block) => block.type),
      ["ai_terminal_plan", "ai_terminal_complete"],
    );
    assert.equal(
      firstSync.manifest.blocks[firstSync.manifest.blocks.length - 1]?.type,
      "ai_terminal_complete",
    );

    const firstOrder = firstSync.manifest.blocks.map((block) => ({
      blockId: block.blockId,
      sequence: block.sequence,
      type: block.type,
    }));

    const secondSync = await syncTerminalSessionArtifacts({
      terminalId: "terminal-1",
      sessionId: "session-1",
      codexHome: rootDir,
    });

    assert.deepEqual(
      secondSync.manifest.blocks.map((block) => ({
        blockId: block.blockId,
        sequence: block.sequence,
        type: block.type,
      })),
      firstOrder,
    );
  } finally {
    initStorage(previousCodexDir);
    await cleanup();
  }
});
