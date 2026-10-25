import assert from "node:assert/strict";
import test from "node:test";
import {
  transcriptFilename,
  transcriptMarkdown,
} from "../../web/transcript-export";

test("Markdown exports retain ordering, multiline text, tool details, and generated images", () => {
  const markdown = transcriptMarkdown(
    [
      {
        type: "user",
        timestamp: "2026-10-25",
        message: {
          role: "user",
          content: "Investigate **this**.\nKeep details.",
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call",
              name: "shell",
              input: { command: "echo hello" },
            },
            {
              type: "tool_result",
              tool_use_id: "call",
              content: "hello\n```\ncode",
              is_error: true,
            },
            {
              type: "image_generation",
              generatedImage: {
                status: "completed",
                result: "YWJj",
                prompt: "A diagram",
              },
            },
            { type: "text", text: "Done." },
          ],
        },
      },
      { type: "summary", summary: "Compacted conversation" },
    ],
    "thread",
  );
  assert.ok(markdown.indexOf("## User") < markdown.indexOf("## Assistant"));
  assert.match(markdown, /Investigate \*\*this\*\*\.\nKeep details/);
  assert.match(markdown, /Tool: shell \(call\)/);
  assert.match(
    markdown,
    /Tool result \(error\) · call\n\n````\nhello\n```\ncode\n````/,
  );
  assert.match(markdown, /data:image\/png;base64,YWJj/);
  assert.match(markdown, /Compacted conversation/);
});
test("export file names remain a single Markdown file", () => {
  assert.equal(transcriptFilename("../launch/notes", "id"), "_launch_notes.md");
  assert.equal(transcriptFilename("report.MD", "id"), "report.MD");
  assert.equal(transcriptFilename("", "id"), "conversation-id.md");
});
