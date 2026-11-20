// Host side of MCP Apps (`io.modelcontextprotocol/ui`, spec 2026-01-26) for
// `mcpToolCall.mcpAppUi` widgets. The widget HTML runs in an opaque-origin
// sandboxed iframe (`srcdoc`, `sandbox="allow-scripts"`) and talks to Deck only
// through the JSON-RPC postMessage bridge below.

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_HOST_NAME = "codex-deck";

export type McpAppDisplayMode = "inline" | "fullscreen";
export const MCP_APP_DISPLAY_MODES: McpAppDisplayMode[] = [
  "inline",
  "fullscreen",
];

export interface McpAppCspDomains {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}

const DOMAIN_PATTERN =
  /^(https|wss):\/\/(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;
const MAX_DOMAINS = 32;

/** Keeps only plain https/wss origins so a declaration cannot inject CSP. */
export function sanitizeCspDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const domain = entry.trim().replace(/\/+$/, "");
    if (!DOMAIN_PATTERN.test(domain) || out.includes(domain)) continue;
    out.push(domain);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

export function emptyCspDomains(): McpAppCspDomains {
  return {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  };
}

/** The spec's restrictive default CSP, widened only by declared domains. */
export function buildMcpAppCsp(
  input: Partial<Record<keyof McpAppCspDomains, unknown>>,
): string {
  const connect = sanitizeCspDomains(input.connectDomains);
  const resources = sanitizeCspDomains(input.resourceDomains).filter((domain) =>
    domain.startsWith("https://"),
  );
  const frames = sanitizeCspDomains(input.frameDomains).filter((domain) =>
    domain.startsWith("https://"),
  );
  const baseUris = sanitizeCspDomains(input.baseUriDomains).filter((domain) =>
    domain.startsWith("https://"),
  );
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  const resourceList = resources.join(" ");
  return [
    "default-src 'none'",
    `script-src ${join("'self'", "'unsafe-inline'", resourceList)}`,
    `style-src ${join("'self'", "'unsafe-inline'", resourceList)}`,
    `img-src ${join("'self'", "data:", resourceList)}`,
    `font-src ${join("'self'", "data:", resourceList)}`,
    `media-src ${join("'self'", "data:", resourceList)}`,
    `connect-src ${connect.length > 0 ? connect.join(" ") : "'none'"}`,
    `frame-src ${frames.length > 0 ? frames.join(" ") : "'none'"}`,
    `base-uri ${baseUris.length > 0 ? baseUris.join(" ") : "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Puts the CSP meta first in the document (after a doctype, so standards
 * mode is kept) so it governs every element the widget declares.
 */
export function buildMcpAppSrcdoc(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    return `${doctype[0]}${meta}${html.slice(doctype[0].length)}`;
  }
  return `${meta}${html}`;
}

export interface McpAppHostContext {
  theme: "light" | "dark";
  displayMode: McpAppDisplayMode;
  availableDisplayModes: McpAppDisplayMode[];
  platform: "web" | "mobile";
  locale?: string;
  timeZone?: string;
  containerDimensions?: { width?: number; maxHeight?: number };
  deviceCapabilities?: { touch: boolean; hover: boolean };
  toolInfo?: {
    id: string;
    tool: { name: string; inputSchema: Record<string, unknown> };
  };
}

export interface McpAppToolCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

type JsonRpcId = string | number;

export interface McpAppBridgeOptions {
  post: (message: Record<string, unknown>) => void;
  hostVersion: string;
  hostContext: () => McpAppHostContext;
  toolInput: unknown;
  /** Completed CallToolResult, or null while unknown. */
  toolResult: McpAppToolCallResult | null;
  toolError?: string | null;
  onSizeChanged?: (size: { width?: number; height?: number }) => void;
  onRequestDisplayMode?: (mode: McpAppDisplayMode) => McpAppDisplayMode;
  /** Resolve true only after the user agreed to open the link. */
  onOpenLink?: (url: string) => Promise<boolean>;
  /** Resolve the tool result, or throw to report a denial/failure. */
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<McpAppToolCallResult>;
  onLog?: (params: unknown) => void;
  now?: () => number;
}

export const MCP_APP_MAX_MESSAGE_BYTES = 1024 * 1024;
export const MCP_APP_TOOL_CALLS_PER_MINUTE = 20;

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_SERVER_ERROR = -32000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * JSON-RPC bridge between one widget iframe and Deck. Callers must feed it
 * only messages whose `event.source` is that iframe's window.
 */
export class McpAppBridge {
  private initialized = false;
  private toolCallInFlight = false;
  private toolCallTimes: number[] = [];
  private disposed = false;

  constructor(private readonly options: McpAppBridgeOptions) {}

  dispose(): void {
    this.disposed = true;
  }

  private send(message: Record<string, unknown>): void {
    if (this.disposed) return;
    this.options.post({ jsonrpc: "2.0", ...message });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  notifyHostContextChanged(partial: Partial<McpAppHostContext>): void {
    if (this.initialized) {
      this.notify("ui/notifications/host-context-changed", partial);
    }
  }

  private sendToolData(): void {
    this.notify("ui/notifications/tool-input", {
      arguments: isRecord(this.options.toolInput) ? this.options.toolInput : {},
    });
    if (this.options.toolResult) {
      this.notify("ui/notifications/tool-result", this.options.toolResult);
    } else if (this.options.toolError) {
      this.notify("ui/notifications/tool-cancelled", {
        reason: this.options.toolError,
      });
    }
  }

  private allowToolCall(): boolean {
    const now = (this.options.now ?? Date.now)();
    this.toolCallTimes = this.toolCallTimes.filter(
      (time) => now - time < 60_000,
    );
    if (this.toolCallTimes.length >= MCP_APP_TOOL_CALLS_PER_MINUTE) {
      return false;
    }
    this.toolCallTimes.push(now);
    return true;
  }

  handleMessage(data: unknown): void {
    if (this.disposed || !isRecord(data) || data.jsonrpc !== "2.0") return;
    if (jsonSize(data) > MCP_APP_MAX_MESSAGE_BYTES) return;
    const method = data.method;
    // Responses to host requests (none are pending) are ignored.
    if (typeof method !== "string" || method.length > 128) return;
    const hasId =
      (typeof data.id === "string" && data.id.length <= 128) ||
      (typeof data.id === "number" && Number.isFinite(data.id));
    const id = hasId ? (data.id as JsonRpcId) : null;
    const params = isRecord(data.params) ? data.params : {};
    if (id === null) {
      this.handleNotification(method, params);
      return;
    }
    void this.handleRequest(id, method, params);
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    switch (method) {
      case "ui/notifications/initialized":
        if (this.initialized) this.sendToolData();
        return;
      case "ui/notifications/size-changed": {
        const size: { width?: number; height?: number } = {};
        for (const key of ["width", "height"] as const) {
          const value = params[key];
          if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0
          ) {
            size[key] = value;
          }
        }
        this.options.onSizeChanged?.(size);
        return;
      }
      case "notifications/message":
        this.options.onLog?.(params);
        return;
      default:
        return;
    }
  }

  private async handleRequest(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case "ui/initialize":
        this.initialized = true;
        this.respond(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: {
            name: MCP_APP_HOST_NAME,
            version: this.options.hostVersion,
          },
          hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
          hostContext: this.options.hostContext(),
        });
        return;
      case "ping":
        this.respond(id, {});
        return;
      case "ui/request-display-mode": {
        const mode = params.mode;
        if (mode !== "inline" && mode !== "fullscreen") {
          const current = this.options.hostContext().displayMode;
          this.respond(id, { mode: current });
          return;
        }
        const applied = this.options.onRequestDisplayMode?.(mode) ?? mode;
        this.respond(id, { mode: applied });
        return;
      }
      case "ui/open-link": {
        if (!isSafeExternalUrl(params.url) || !this.options.onOpenLink) {
          this.fail(
            id,
            JSONRPC_INVALID_PARAMS,
            "Only http(s) links can be opened.",
          );
          return;
        }
        const opened = await this.options.onOpenLink(params.url);
        if (opened) this.respond(id, {});
        else
          this.fail(
            id,
            JSONRPC_SERVER_ERROR,
            "The user declined to open the link.",
          );
        return;
      }
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (
          typeof name !== "string" ||
          !name ||
          name.length > 256 ||
          !isRecord(args) ||
          !this.options.onToolCall
        ) {
          this.fail(id, JSONRPC_INVALID_PARAMS, "Invalid tools/call request.");
          return;
        }
        if (this.toolCallInFlight) {
          this.fail(
            id,
            JSONRPC_SERVER_ERROR,
            "Another tool call is still running.",
          );
          return;
        }
        if (!this.allowToolCall()) {
          this.fail(
            id,
            JSONRPC_SERVER_ERROR,
            "Too many tool calls; try again later.",
          );
          return;
        }
        this.toolCallInFlight = true;
        try {
          this.respond(id, await this.options.onToolCall(name, args));
        } catch (error) {
          this.fail(
            id,
            JSONRPC_SERVER_ERROR,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.toolCallInFlight = false;
        }
        return;
      }
      default:
        this.fail(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `${method} is not supported by Codex Deck.`,
        );
    }
  }
}
