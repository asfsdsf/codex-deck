import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildSessionSearchArgs,
  detectSessionSearchCommand,
  searchSessionContent,
  SessionSearchCommandUnavailableError,
} from "../../api/session-content-search";
import type { SessionContentSearchCommand } from "../../api/storage";

test("detectSessionSearchCommand follows rg, ag, ack, grep priority", async () => {
  const pathValue = ["/first", "/second"].join(delimiter);
  const cases: Array<{
    available: SessionContentSearchCommand[];
    expected: SessionContentSearchCommand;
  }> = [
    { available: ["rg", "ag", "ack", "grep"], expected: "rg" },
    { available: ["ag", "ack", "grep"], expected: "ag" },
    { available: ["ack", "grep"], expected: "ack" },
    { available: ["grep"], expected: "grep" },
  ];

  for (const { available, expected } of cases) {
    const command = await detectSessionSearchCommand(
      pathValue,
      async (filePath) =>
        available.some((candidate) => filePath.endsWith(`/${candidate}`)),
    );
    assert.equal(command, expected);
  }
});

test("detectSessionSearchCommand returns null when no search command exists", async () => {
  assert.equal(
    await detectSessionSearchCommand("/missing", async () => false),
    null,
  );
});

test("buildSessionSearchArgs uses fixed-string mode and a separate query argument", () => {
  const query = "$(touch /tmp/should-not-run) [literal]*";
  const fixedStringOptionByCommand: Record<
    SessionContentSearchCommand,
    string
  > = {
    rg: "--fixed-strings",
    ag: "--literal",
    ack: "--literal",
    grep: "-F",
  };

  for (const command of ["rg", "ag", "ack", "grep"] as const) {
    const args = buildSessionSearchArgs(command, query);
    assert.ok(args.includes(fixedStringOptionByCommand[command]));
    assert.equal(args[args.indexOf("--") + 1], query);
    assert.equal(args.at(-1), ".");
  }
});

test("searchSessionContent maps command paths to indexed session ids", async () => {
  const searchRoot = await mkdtemp(join(tmpdir(), "session-content-search-"));
  const nestedDir = join(searchRoot, "2026", "07", "27");
  const firstPath = join(nestedDir, "first.jsonl");
  const secondPath = join(nestedDir, "second.jsonl");
  await mkdir(nestedDir, { recursive: true });

  try {
    let executedCommand: SessionContentSearchCommand | null = null;
    const result = await searchSessionContent(
      {
        query: "literal text",
        searchRoot,
        sessionFiles: [
          { sessionId: "session-1", filePath: firstPath },
          { sessionId: "session-2", filePath: secondPath },
        ],
      },
      {
        pathValue: "/tools",
        isExecutable: async (filePath) => filePath.endsWith("/rg"),
        executeSearchProcess: async (command, args, cwd) => {
          executedCommand = command;
          assert.equal(cwd, searchRoot);
          assert.equal(args[args.indexOf("--") + 1], "literal text");
          return {
            exitCode: 0,
            stdout: ["./2026/07/27/second.jsonl", firstPath, secondPath].join(
              "\n",
            ),
            stderr: "",
          };
        },
      },
    );

    assert.equal(executedCommand, "rg");
    assert.deepEqual(result, {
      query: "literal text",
      command: "rg",
      sessionIds: ["session-2", "session-1"],
    });
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
  }
});

test("searchSessionContent reports unavailable command tooling", async () => {
  await assert.rejects(
    searchSessionContent(
      { query: "text", searchRoot: "/missing", sessionFiles: [] },
      { pathValue: "/missing", isExecutable: async () => false },
    ),
    SessionSearchCommandUnavailableError,
  );
});
