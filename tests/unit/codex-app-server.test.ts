import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  isCodexReasoningEffort,
} from "../../api/codex-app-server";

test("isCodexReasoningEffort validates supported values", () => {
  assert.equal(isCodexReasoningEffort("none"), true);
  assert.equal(isCodexReasoningEffort("minimal"), true);
  assert.equal(isCodexReasoningEffort("low"), true);
  assert.equal(isCodexReasoningEffort("medium"), true);
  assert.equal(isCodexReasoningEffort("high"), true);
  assert.equal(isCodexReasoningEffort("xhigh"), true);

  assert.equal(isCodexReasoningEffort(""), false);
  assert.equal(isCodexReasoningEffort("ultra"), false);
  assert.equal(isCodexReasoningEffort(null), false);
  assert.equal(isCodexReasoningEffort(undefined), false);
});

test("Codex app-server error classes preserve structured fields", () => {
  const rpc = new CodexAppServerRpcError(-32000, "rpc failed", {
    requestId: 42,
  });
  const transport = new CodexAppServerTransportError("offline");

  assert.equal(rpc.name, "CodexAppServerRpcError");
  assert.equal(rpc.code, -32000);
  assert.deepEqual(rpc.data, { requestId: 42 });
  assert.equal(rpc.message, "rpc failed");

  assert.equal(transport.name, "CodexAppServerTransportError");
  assert.equal(transport.message, "offline");
});

test("client lifecycle helpers are callable and close idempotently", async () => {
  const clientA = getCodexAppServerClient();
  const clientB = getCodexAppServerClient();

  assert.equal(typeof clientA.listModels, "function");
  assert.equal(typeof clientA.createThread, "function");
  assert.equal(typeof clientA.sendMessage, "function");
  assert.equal(typeof clientA.getThreadState, "function");
  assert.equal(typeof clientA.listPendingUserInputRequests, "function");
  assert.equal(typeof clientA.listPendingApprovalRequests, "function");

  // Wrapper objects can differ while sharing the same underlying client.
  assert.notEqual(clientA, clientB);

  await closeCodexAppServerClient();
  await closeCodexAppServerClient();
});

test("stdout parser reconstructs multi-line app-server responses with utf-8 content", () => {
  const parser = new __TEST_ONLY__.AppServerStdoutMessageParser();
  const fixtureDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "stdout-parser",
    "多语言-fixture",
  );
  const rawResponse = JSON.stringify({
    id: 3,
    result: {
      thread: {
        id: "thread-demo-001",
        turns: [
          {
            id: "turn-a",
            status: "completed",
            items: [
              {
                type: "commandExecution",
                id: "call-a",
                command: "cat report.txt",
                cwd: fixtureDir,
                processId: "123",
                status: "completed",
                commandActions: [],
                aggregatedOutput: "alpha\n示例二\nomega",
                exitCode: 0,
                durationMs: 5,
              },
            ],
          },
        ],
      },
    },
  }).replace("alpha\\n示例二\\nomega", "alpha\n示例二\nomega");
  const bytes = Buffer.from(rawResponse, "utf8");
  const chunks = [
    bytes.subarray(0, 17),
    bytes.subarray(17, 33),
    bytes.subarray(33, 34),
    bytes.subarray(34, 61),
    bytes.subarray(61),
  ];

  const parsedMessages = chunks.flatMap((chunk) => parser.push(chunk));

  assert.equal(parsedMessages.length, 1);
  assert.equal(parsedMessages[0]?.id, 3);

  const aggregatedOutput =
    (
      (
        (parsedMessages[0]?.result as Record<string, unknown>)?.thread as {
          turns?: Array<{
            items?: Array<{ aggregatedOutput?: unknown }>;
          }>;
        }
      )?.turns?.[0]?.items?.[0] as { aggregatedOutput?: unknown }
    )?.aggregatedOutput ?? null;
  const cwd =
    (
      (
        (parsedMessages[0]?.result as Record<string, unknown>)?.thread as {
          turns?: Array<{
            items?: Array<{ cwd?: unknown }>;
          }>;
        }
      )?.turns?.[0]?.items?.[0] as { cwd?: unknown }
    )?.cwd ?? null;

  assert.equal(aggregatedOutput, "alpha\n示例二\nomega");
  assert.equal(cwd, fixtureDir);
});

test("Windows command resolution prefers spawnable codex wrappers", () => {
  const resolved = __TEST_ONLY__.resolveWindowsCommandPath("codex", {
    lookupCommand: () => [
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex",
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.ps1",
    ],
  });

  assert.equal(
    resolved,
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
  );
});

test("Windows path resolution upgrades extensionless codex shims to .cmd", () => {
  const resolved = __TEST_ONLY__.resolveWindowsCommandPath(
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex",
    {
      pathExists: (path) =>
        path === "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    },
  );

  assert.equal(
    resolved,
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
  );
});

test("Windows spawn spec uses the shell for .cmd wrappers only", () => {
  const cmdSpec = __TEST_ONLY__.createCodexAppServerSpawnSpec(
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    "win32",
  );
  assert.deepEqual(cmdSpec, {
    command:
      '"C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd" app-server',
    args: [],
    shell: true,
  });

  const exeSpec = __TEST_ONLY__.createCodexAppServerSpawnSpec(
    "C:\\Program Files\\Codex\\codex.exe",
    "win32",
  );
  assert.deepEqual(exeSpec, {
    command: "C:\\Program Files\\Codex\\codex.exe",
    args: ["app-server"],
  });
});
