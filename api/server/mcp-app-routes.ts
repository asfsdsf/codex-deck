import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  extractMcpAppResource,
  findMcpAppBlock,
  isToolCallableFromApp,
  MCP_APP_MAX_ARGUMENTS_JSON_CHARS,
  McpAppRateLimiter,
} from "../codex-mcp-apps";
import type {
  CodexMcpAppBlock,
  CodexMcpAppToolCallResponse,
  ConversationMessage,
} from "../storage";
import { getConversation } from "../storage";
import { responseStatusForError, toErrorMessage } from "./utils";

type McpAppClient = Pick<
  CodexAppServerClientFacade,
  "readMcpAppResource" | "callMcpServerTool" | "listMcpServers"
>;

function stringField(
  body: Record<string, unknown>,
  key: string,
  maxLength = 2048,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function registerMcpAppRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getClient?: () => McpAppClient;
    readConversation?: (threadId: string) => Promise<ConversationMessage[]>;
    rateLimiter?: McpAppRateLimiter;
  } = {},
) {
  const limiter = deps.rateLimiter ?? new McpAppRateLimiter();
  const client = () => (deps.getClient ?? getCodexAppServerClient)();

  /** Widgets may only act for a tool call that really declared them. */
  const resolveOrigin = async (
    threadId: string,
    callId: string,
  ): Promise<CodexMcpAppBlock | null> =>
    findMcpAppBlock(
      await (deps.readConversation ?? getConversation)(threadId),
      callId,
    );

  app.post("/api/codex/mcp-apps/resource", async (c) => {
    const body = await readBody(c);
    const threadId = body && stringField(body, "threadId", 256);
    const callId = body && stringField(body, "callId", 256);
    if (!body || !threadId || !callId) {
      return c.json({ error: "threadId and callId are required" }, 400);
    }
    try {
      const mcp = client();
      if (!mcp.readMcpAppResource) {
        return c.json({ error: "MCP resource reads are unavailable." }, 501);
      }
      const origin = await resolveOrigin(threadId, callId);
      if (!origin) {
        return c.json({ error: "MCP App tool call not found" }, 404);
      }
      deps.subscribe?.();
      const response = await mcp.readMcpAppResource({
        threadId,
        server: origin.server,
        uri: origin.resourceUri,
        originCallId: origin.callId,
      });
      return c.json(extractMcpAppResource(response, origin.resourceUri));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/mcp-apps/tool-call", async (c) => {
    const body = await readBody(c);
    const threadId = body && stringField(body, "threadId", 256);
    const callId = body && stringField(body, "callId", 256);
    const tool = body && stringField(body, "tool", 256);
    const args = body?.arguments ?? {};
    if (!body || !threadId || !callId || !tool) {
      return c.json({ error: "threadId, callId and tool are required" }, 400);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return c.json({ error: "arguments must be an object" }, 400);
    }
    if (JSON.stringify(args).length > MCP_APP_MAX_ARGUMENTS_JSON_CHARS) {
      return c.json({ error: "arguments are too large" }, 400);
    }
    try {
      const mcp = client();
      if (!mcp.callMcpServerTool || !mcp.listMcpServers) {
        return c.json({ error: "MCP tool calls are unavailable." }, 501);
      }
      const origin = await resolveOrigin(threadId, callId);
      if (!origin) {
        return c.json({ error: "MCP App tool call not found" }, 404);
      }
      // Only the originating server's tools that are visible to apps.
      const inventory = await mcp.listMcpServers(threadId);
      const server = inventory.servers.find(
        (entry) => entry.name === origin.server,
      );
      if (!isToolCallableFromApp(server, tool)) {
        return c.json(
          { error: `${tool} is not available to this MCP App.` },
          403,
        );
      }
      if (!limiter.allow(`${threadId}\u0000${callId}`)) {
        return c.json({ error: "Too many MCP App tool calls." }, 429);
      }
      deps.subscribe?.();
      const raw = await mcp.callMcpServerTool({
        threadId,
        server: origin.server,
        tool,
        arguments: args as Record<string, unknown>,
      });
      const record =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      if (!Array.isArray(record.content)) {
        throw new Error("Invalid MCP tool call response");
      }
      const response: CodexMcpAppToolCallResponse = {
        content: record.content,
        ...(record.structuredContent !== undefined
          ? { structuredContent: record.structuredContent }
          : {}),
        ...(typeof record.isError === "boolean"
          ? { isError: record.isError }
          : {}),
        ...(record._meta !== undefined ? { _meta: record._meta } : {}),
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
}
