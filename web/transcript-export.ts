import type { ContentBlock, ConversationMessage } from "@codex-deck/api";

function codeBlock(text: string, language = "") {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
function printable(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}
function blockMarkdown(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text || "";
    case "thinking":
    case "reasoning":
    case "agent_reasoning":
      return `### Reasoning\n\n${block.thinking || block.text || ""}`;
    case "image":
      return block.image_url
        ? `![Attached image](<${block.image_url.replace(/>/g, "%3E")}>)`
        : "[Attached image]";
    case "image_generation": {
      const image = block.generatedImage;
      if (!image) return "[Generated image]";
      const parts = [
        `### Generated image (${image.status})`,
        image.prompt || "",
        image.failure || "",
        image.savedPath ? `Saved path:\n\n${codeBlock(image.savedPath)}` : "",
      ];
      if (image.result) {
        const url = /^(?:data:|https?:|\/)/i.test(image.result)
          ? image.result
          : `data:image/png;base64,${image.result}`;
        parts.push(`![Generated image](<${url.replace(/>/g, "%3E")}>)`);
      }
      return parts.filter(Boolean).join("\n\n");
    }
    case "tool_use":
      return `### Tool: ${block.name || "call"}${block.id ? ` (${block.id})` : ""}\n\n${codeBlock(printable(block.input), "json")}`;
    case "tool_result":
      return `### Tool result${block.is_error ? " (error)" : ""}${block.tool_use_id ? ` · ${block.tool_use_id}` : ""}\n\n${codeBlock(printable(block.content))}`;
    default:
      return `### ${block.type.replace(/_/g, " ")}\n\n${codeBlock(printable(block), "json")}`;
  }
}
export function transcriptMarkdown(
  messages: ConversationMessage[],
  threadId: string,
  title = "Conversation transcript",
): string {
  const entries = messages.map((message) => {
    const role =
      message.type === "user"
        ? "User"
        : message.type === "assistant"
          ? "Assistant"
          : message.type.replace(/[-_]/g, " ");
    const content = message.message?.content;
    const body =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map(blockMarkdown).filter(Boolean).join("\n\n")
          : message.summary ||
            (message.threadGoal
              ? codeBlock(printable(message.threadGoal), "json")
              : "");
    const metadata = [
      message.timestamp,
      message.message?.model,
      message.message?.phase,
      message.streaming ? "In progress" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `## ${role}${metadata ? `\n\n${metadata}` : ""}\n\n${body || `[${message.type.replace(/_/g, " ")}]`}`;
  });
  return `# ${title.replace(/[\r\n]+/g, " ")}\n\nSession: ${threadId}\n\n${entries.join("\n\n---\n\n")}\n`;
}
export function transcriptFilename(input: string, threadId: string): string {
  const clean = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  const base = clean || `conversation-${threadId}`;
  return /\.md$/i.test(base) ? base : `${base}.md`;
}
export function downloadMarkdown(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to begin consuming the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
