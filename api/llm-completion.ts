import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

interface ReplyPart {
  type?: string;
  text?: string;
  thinking?: string;
  summary?: string;
}

interface ReplyMessage {
  content?: string | ReplyPart[];
  refusal?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: ReplyPart[];
}

function replyText(message: ReplyMessage) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const structuredThinking = [
    ...(Array.isArray(message.reasoning_details)
      ? message.reasoning_details
      : []),
    ...parts,
  ]
    .flatMap((part) => {
      switch (part?.type) {
        case "reasoning.summary":
          return typeof part.summary === "string" ? [part.summary] : [];
        case "reasoning.text":
          return typeof part.text === "string" ? [part.text] : [];
        case "thinking":
          return typeof part.thinking === "string" ? [part.thinking] : [];
        default:
          return [];
      }
    })
    .join("\n\n");
  const thinking =
    [message.reasoning_content, message.reasoning, structuredThinking].find(
      (value) => typeof value === "string" && value.length > 0,
    ) ?? "";
  const content =
    typeof message.content === "string"
      ? message.content
      : parts
          .filter(
            (part) => part?.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("");
  return {
    thinking,
    content:
      content || (typeof message.refusal === "string" ? message.refusal : ""),
  };
}

// Some compatible endpoints encode thinking in a leading tag instead of a field.
function splitReply(content: string, thinking: string) {
  const start = content.trimStart();
  if (!start.startsWith("<think>")) return { content, thinking };
  const end = start.indexOf("</think>", 7);
  return {
    content: end < 0 ? "" : start.slice(end + 8).trimStart(),
    thinking: thinking || start.slice(7, end < 0 ? undefined : end).trim(),
  };
}

async function* eventData(response: Response) {
  if (!response.body) throw new Error("Missing completion stream");
  const input = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let data: string[] = [];
  try {
    for await (const line of lines) {
      if (line === "" && data.length) {
        yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length) yield data.join("\n");
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function readChatCompletion(
  response: Response,
  onThinking: (thinking: string) => Promise<void>,
) {
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  ) {
    const payload = await response.json();
    const { content, thinking } = replyText(
      payload?.choices?.[0]?.message ?? {},
    );
    return splitReply(content, thinking);
  }

  let content = "";
  let thinking = "";
  let finished = false;
  let publishedThinking = "";
  let lastWrite = 0;
  for await (const data of eventData(response)) {
    if (data.trim() === "[DONE]") {
      finished = true;
      break;
    }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error("Provider stream failed");
    const choice = chunk.choices?.find(
      (item: { index?: number }) => (item.index ?? 0) === 0,
    );
    if (!choice) continue;
    if (choice.finish_reason) finished = true;
    const delta = replyText(choice.delta ?? {});
    content += delta.content;
    thinking += delta.thinking;
    // Coalesce token writes; the completed turn always includes the last delta.
    if (Date.now() - lastWrite >= 200) {
      const snapshot = splitReply(content, thinking).thinking;
      if (snapshot && snapshot !== publishedThinking) {
        publishedThinking = snapshot;
        lastWrite = Date.now();
        await onThinking(snapshot);
      }
    }
  }
  if (!finished) throw new Error("Incomplete completion stream");
  return splitReply(content, thinking);
}
