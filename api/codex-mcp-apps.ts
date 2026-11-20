// MCP App widgets (`mcpToolCall.mcpAppUi`): parsing persisted tool-call items,
// validating `ui://` resource reads, and gating widget-initiated tool calls.

import type {
  CodexMcpAppBlock,
  CodexMcpAppResourceResponse,
  ConversationMessage,
} from "./storage";
import type { McpServerInventory } from "./codex-native";

export const MCP_APP_HTML_MIME_PREFIX = "text/html";
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MCP_APP_MAX_RESULT_JSON_CHARS = 512 * 1024;
export const MCP_APP_MAX_ARGUMENTS_JSON_CHARS = 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedJson(value: unknown, maxChars: number): unknown | null {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    return text !== undefined && text.length <= maxChars ? value : null;
  } catch {
    return null;
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value ?? {};
}

/** Accepts `{Ok: result}` / `{Err: message}` (legacy) or a bare CallToolResult. */
function parseCallResult(value: unknown): {
  result: Record<string, unknown> | null;
  error: string | null;
} {
  const record = asRecord(value);
  if (!record) {
    return { result: null, error: typeof value === "string" ? value : null };
  }
  if ("Ok" in record) return parseCallResult(record.Ok);
  if ("Err" in record) {
    return { result: null, error: asString(record.Err) ?? "Tool call failed" };
  }
  if (!Array.isArray(record.content)) return { result: null, error: null };
  return { result: record, error: null };
}

/**
 * Builds the widget block from a persisted MCP tool call: paginated rollouts
 * store `item_completed` McpToolCall items (camelCase), legacy rollouts store
 * `mcp_tool_call_end` events (snake_case). Returns null without a UI resource.
 */
export function parseMcpAppToolCall(
  payload: Record<string, unknown>,
): CodexMcpAppBlock | null {
  const normalizedType = String(payload.type ?? "")
    .replace(/[\s_-]/g, "")
    .toLowerCase();
  let source: Record<string, unknown> | null = null;
  let legacy = false;
  if (normalizedType === "itemcompleted") {
    const item = asRecord(payload.item);
    const itemType = String(item?.type ?? "")
      .replace(/[\s_-]/g, "")
      .toLowerCase();
    if (itemType === "mcptoolcall") source = item;
  } else if (normalizedType === "mcptoolcallend") {
    source = payload;
    legacy = true;
  }
  if (!source) return null;

  const ui = asRecord(source.mcpAppUi ?? source.mcp_app_ui);
  const resourceUri =
    asString(ui?.resourceUri ?? ui?.resource_uri) ??
    asString(source.mcpAppResourceUri ?? source.mcp_app_resource_uri);
  if (!resourceUri || !resourceUri.startsWith("ui://")) return null;
  const preferred =
    ui?.preferredModelDisplayMode ?? ui?.preferred_model_display_mode;
  const invocation = legacy ? asRecord(source.invocation) : source;
  const server = asString(invocation?.server);
  const tool = asString(invocation?.tool);
  const callId = asString(legacy ? source.call_id : source.id);
  if (!server || !tool || !callId) return null;

  const { result, error } = parseCallResult(source.result);
  const itemError = asRecord(source.error);
  const status = legacy
    ? result
      ? result.isError === true
        ? "failed"
        : "completed"
      : "failed"
    : (asString(source.status) ?? "completed");
  return {
    callId,
    server,
    tool,
    resourceUri,
    displayMode:
      preferred === "inline" || preferred === "fullscreen" ? preferred : null,
    arguments:
      boundedJson(
        parseArguments(invocation?.arguments),
        MCP_APP_MAX_ARGUMENTS_JSON_CHARS,
      ) ?? {},
    result: boundedJson(result, MCP_APP_MAX_RESULT_JSON_CHARS) as
      | CodexMcpAppBlock["result"]
      | null,
    error: error ?? asString(itemError?.message),
    status,
  };
}

export function findMcpAppBlock(
  messages: ConversationMessage[],
  callId: string,
): CodexMcpAppBlock | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "mcp_app" && block.mcpApp?.callId === callId) {
        return block.mcpApp;
      }
    }
  }
  return null;
}

export type McpAppResource = CodexMcpAppResourceResponse;

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 64) : [];
}

/** Picks the HTML content for `uri` from an `mcpServer/resource/read` reply. */
export function extractMcpAppResource(
  response: unknown,
  uri: string,
): McpAppResource {
  const contents = asRecord(response)?.contents;
  if (!Array.isArray(contents)) {
    throw new Error("Invalid MCP resource response");
  }
  const candidates = contents
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => !!entry);
  const content =
    candidates.find((entry) => entry.uri === uri) ?? candidates[0] ?? null;
  if (!content) throw new Error("The MCP App resource is empty.");
  const mimeType = asString(content.mimeType) ?? "";
  if (!mimeType.toLowerCase().startsWith(MCP_APP_HTML_MIME_PREFIX)) {
    throw new Error(
      `Unsupported MCP App resource type: ${mimeType || "unknown"}`,
    );
  }
  let html: string;
  if (typeof content.text === "string") {
    html = content.text;
  } else if (typeof content.blob === "string") {
    if (content.blob.length > (MCP_APP_MAX_HTML_BYTES * 4) / 3 + 4) {
      throw new Error("The MCP App resource is too large.");
    }
    html = Buffer.from(content.blob, "base64").toString("utf8");
  } else {
    throw new Error("The MCP App resource has no content.");
  }
  if (Buffer.byteLength(html, "utf8") > MCP_APP_MAX_HTML_BYTES) {
    throw new Error("The MCP App resource is too large.");
  }
  const ui = asRecord(asRecord(content._meta)?.ui);
  const csp = asRecord(ui?.csp);
  return {
    uri: asString(content.uri) ?? uri,
    mimeType,
    html,
    // Domains are re-validated by the browser before building the CSP.
    csp: {
      connectDomains: arrayOrEmpty(csp?.connectDomains),
      resourceDomains: arrayOrEmpty(csp?.resourceDomains),
      frameDomains: arrayOrEmpty(csp?.frameDomains),
      baseUriDomains: arrayOrEmpty(csp?.baseUriDomains),
    },
    prefersBorder:
      typeof ui?.prefersBorder === "boolean" ? ui.prefersBorder : null,
  };
}

/**
 * MCP Apps visibility: tools without `_meta.ui.visibility` are callable by
 * both model and app; otherwise the list must include "app".
 */
export function isToolCallableFromApp(
  server: McpServerInventory | undefined,
  toolName: string,
): boolean {
  if (!server?.tools || typeof server.tools !== "object") return false;
  const tool = Object.entries(server.tools).find(
    ([key, value]) => key === toolName || asRecord(value)?.name === toolName,
  )?.[1];
  if (!tool) return false;
  const visibility = asRecord(asRecord(asRecord(tool)?._meta)?.ui)?.visibility;
  if (!Array.isArray(visibility)) return true;
  return visibility.includes("app");
}

/** Sliding-window limiter for widget tool calls, keyed per widget. */
export class McpAppRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.calls.get(key) ?? []).filter(
      (time) => now - time < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.calls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(key, recent);
    if (this.calls.size > 1000) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) this.calls.delete(oldest);
    }
    return true;
  }
}
