import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";
import {
  applyConversationLiveEvent,
  readConversationMessageWindow,
  readConversationMessageUpdates,
  clearConversationIndexes,
} from "../../api/conversation-index";
import {
  generatedImageDataUrl,
  parseGeneratedImage,
} from "../../api/generated-images";
import {
  createTempCodexDir,
  eventMsgLine,
  responseItemRawLine,
  sessionMetaLine,
} from "./test-utils";

const image = {
  type: "image_generation_call",
  id: "ig-1",
  status: "completed",
  revised_prompt: "A blue square",
  result: "aW1hZ2U=",
};

test("image generation parses hosted, extension and legacy records, with safe inline previews", () => {
  for (const item of [
    image,
    {
      type: "ImageGeneration",
      id: "ig-1",
      status: "completed",
      result: image.result,
    },
    {
      type: "Extension",
      kind: "image_gen.generation",
      id: "ig-1",
      status: "completed",
      fileId: "file-1",
      savedPath: "/tmp/generated.png",
    },
  ]) {
    const state = new ConversationParserState();
    const line =
      item.type === "image_generation_call"
        ? responseItemRawLine(item)
        : eventMsgLine({ type: "item_completed", turn_id: "turn", item });
    parseConversationTextChunk(line + "\n", 0, undefined, state);
    assert.equal(state.messages.length, 1);
    const content = state.messages[0].message!.content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "image_generation");
    assert.equal(content[0].id, "ig-1");
  }
  assert.equal(parseGeneratedImage({ type: "message" }), null);
  assert.equal(
    generatedImageDataUrl(image.result),
    "data:image/png;base64,aW1hZ2U=",
  );
  assert.equal(generatedImageDataUrl("javascript:alert(1)"), null);
  assert.equal(generatedImageDataUrl("https://example.com/image.png"), null);
  assert.equal(generatedImageDataUrl("data:image/svg+xml;base64,abc"), null);
});

test("live and persisted image lifecycle events retain one card and stable numbering", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("live-images");
  const path = join(rootDir, "image.jsonl");
  try {
    await writeFile(
      path,
      sessionMetaLine("thread", "/repo", Date.now()) +
        "\n" +
        eventMsgLine({ type: "task_started", turn_id: "turn" }) +
        "\n",
    );
    const first = await readConversationMessageWindow(path);
    await applyConversationLiveEvent(path, {
      type: "image_generation_updated",
      threadId: "thread",
      turnId: "turn",
      itemId: "ig-1",
      item: {
        type: "imageGeneration",
        id: "ig-1",
        status: "in_progress",
        result: "",
      },
    });
    const live = await readConversationMessageUpdates(path, first.nextOffset);
    assert.equal(live.totalMessages, 1);
    const uuid = live.messages.find((m) => m.type === "assistant")!.uuid;
    await applyConversationLiveEvent(path, {
      type: "item_completed",
      threadId: "thread",
      turnId: "turn",
      itemId: "ig-1",
      item: { ...image, type: "imageGeneration" },
    });
    await appendFile(
      path,
      eventMsgLine({
        type: "image_generation_end",
        call_id: "ig-1",
        status: "completed",
        revised_prompt: image.revised_prompt,
        result: image.result,
      }) +
        "\n" +
        responseItemRawLine(image) +
        "\n",
    );
    const [a, b] = await Promise.all([
      readConversationMessageWindow(path),
      readConversationMessageWindow(path),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.totalMessages, 1);
    const message = a.messages.find((m) => m.type === "assistant")!;
    assert.equal(message.uuid, uuid);
    assert.equal(message.messageNumber, 1);
    assert.equal(message.streaming, false);
    assert.match(JSON.stringify(message), /A blue square/);
    clearConversationIndexes(path);
    const reloaded = await readConversationMessageWindow(path);
    assert.equal(reloaded.totalMessages, 1);
    assert.match(JSON.stringify(reloaded.messages), /A blue square/);
  } finally {
    clearConversationIndexes(path);
    await cleanup();
  }
});
