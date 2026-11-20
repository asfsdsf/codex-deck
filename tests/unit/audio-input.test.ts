import assert from "node:assert/strict";
import test from "node:test";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import {
  getConversation,
  initStorage,
  invalidateHistoryCache,
  loadStorage,
} from "../../api/storage";
import {
  createTempCodexDir,
  responseItemRawLine,
  sessionMetaLine,
  writeSessionFile,
} from "./test-utils";

const SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";

test("user audio input is parsed into audio content blocks", async () => {
  const { rootDir, sessionsDir, cleanup } =
    await createTempCodexDir("audio-input");
  try {
    await writeSessionFile(sessionsDir, `${SESSION}.jsonl`, [
      sessionMetaLine(SESSION, "/repo/project", Date.now()),
      responseItemRawLine({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "transcribe this" },
          { type: "input_audio", audio_url: "data:audio/webm;base64,AAA" },
        ],
      }),
    ]);
    initStorage(rootDir);
    invalidateHistoryCache();
    await loadStorage();
    const messages = await getConversation(SESSION);
    const user = messages.find((message) => message.type === "user");
    const content = user?.message?.content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(
      content.find((block) => block.type === "audio"),
      { type: "audio", audio_url: "data:audio/webm;base64,AAA" },
    );
  } finally {
    await cleanup();
  }
});

test("model/list input modalities reach the browser model options", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    ensureConnected: () => Promise<void>;
    ensureInitialized: () => Promise<void>;
  };
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  internal.request = async (method) => {
    if (method === "model/list")
      return {
        data: [
          {
            id: "audio-model",
            model: "audio-model",
            displayName: "Audio",
            inputModalities: ["text", "audio", 7],
            supportedReasoningEfforts: [],
          },
          {
            id: "legacy",
            model: "legacy",
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      };
    return {};
  };
  const models = await client.listModels();
  assert.deepEqual(
    models.find((model) => model.id === "audio-model")?.inputModalities,
    ["text", "audio"],
  );
  assert.equal(
    models.find((model) => model.id === "legacy")?.inputModalities,
    undefined,
  );
});
