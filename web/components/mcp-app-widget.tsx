import type {
  CodexMcpAppBlock,
  CodexMcpAppResourceResponse,
} from "@codex-deck/api";
import {
  AppWindow,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { callCodexMcpAppTool, readCodexMcpAppResource } from "../api";
import { useResolvedTheme } from "../hooks/use-resolved-theme";
import {
  buildMcpAppCsp,
  buildMcpAppSrcdoc,
  MCP_APP_DISPLAY_MODES,
  McpAppBridge,
  type McpAppDisplayMode,
  type McpAppHostContext,
  type McpAppToolCallResult,
} from "../mcp-app";

const HOST_VERSION = "0.2.4";
const INLINE_DEFAULT_HEIGHT = 320;
const INLINE_MIN_HEIGHT = 80;
const INLINE_MAX_HEIGHT = 900;

type PendingPrompt =
  | {
      kind: "tool";
      tool: string;
      argsPreview: string;
      resolve: (decision: "deny" | "once" | "always") => void;
    }
  | { kind: "link"; url: string; resolve: (open: boolean) => void };

function previewJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? "";
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "";
  }
}

function isPhoneWidth(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 640;
}

interface McpAppWidgetProps {
  threadId?: string;
  app: CodexMcpAppBlock;
}

/**
 * Renders an MCP App (`mcpAppUi`) in a sandboxed, opaque-origin iframe. The
 * widget is loaded on request and every tool call or link it asks for needs
 * the user's approval.
 */
export function McpAppWidget({ threadId, app }: McpAppWidgetProps) {
  const theme = useResolvedTheme();
  const [open, setOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>("inline");
  const [resource, setResource] = useState<CodexMcpAppResourceResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inlineHeight, setInlineHeight] = useState(INLINE_DEFAULT_HEIGHT);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<McpAppBridge | null>(null);
  const alwaysAllowedToolsRef = useRef(new Set<string>());
  const stateRef = useRef({ theme, displayMode });
  stateRef.current = { theme, displayMode };
  // Live re-parses hand us new objects for the same call; keep the bridge.
  const appRef = useRef(app);
  appRef.current = app;

  const load = useCallback(async () => {
    if (!threadId) {
      setError("This widget is not attached to a Codex thread.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setResource(
        await readCodexMcpAppResource({ threadId, callId: app.callId }),
      );
    } catch (loadError) {
      setResource(null);
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, [app.callId, threadId]);

  const openWidget = () => {
    setOpen(true);
    // Honour the descriptor's preferred presentation (`mcpAppUi`).
    setDisplayMode(app.displayMode === "fullscreen" ? "fullscreen" : "inline");
    if (!resource) void load();
  };

  const closeWidget = () => {
    if (prompt?.kind === "tool") prompt.resolve("deny");
    else if (prompt?.kind === "link") prompt.resolve(false);
    setPrompt(null);
    setOpen(false);
    setDisplayMode("inline");
  };

  const srcdoc = useMemo(
    () =>
      resource
        ? buildMcpAppSrcdoc(resource.html, buildMcpAppCsp(resource.csp))
        : null,
    [resource],
  );

  const hostContext = useCallback((): McpAppHostContext => {
    const frame = iframeRef.current;
    const touch =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    return {
      theme: stateRef.current.theme,
      displayMode: stateRef.current.displayMode,
      availableDisplayModes: MCP_APP_DISPLAY_MODES,
      platform: isPhoneWidth() ? "mobile" : "web",
      locale: typeof navigator !== "undefined" ? navigator.language : undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      containerDimensions: {
        width: frame?.clientWidth || undefined,
        maxHeight:
          stateRef.current.displayMode === "inline"
            ? INLINE_MAX_HEIGHT
            : frame?.clientHeight || undefined,
      },
      deviceCapabilities: { touch, hover: !touch },
      toolInfo: {
        id: app.callId,
        tool: { name: app.tool, inputSchema: { type: "object" } },
      },
    };
  }, [app.callId, app.tool]);

  const askToolCall = useCallback(
    (tool: string, args: Record<string, unknown>) =>
      new Promise<"deny" | "once" | "always">((resolve) => {
        setPrompt({
          kind: "tool",
          tool,
          argsPreview: previewJson(args),
          resolve: (decision) => {
            setPrompt(null);
            resolve(decision);
          },
        });
      }),
    [],
  );

  // One bridge per loaded document; recreated when the iframe remounts.
  useEffect(() => {
    if (!open || !srcdoc) return;
    const frame = iframeRef.current;
    if (!frame) return;
    const bridge = new McpAppBridge({
      post: (message) => frame.contentWindow?.postMessage(message, "*"),
      hostVersion: HOST_VERSION,
      hostContext,
      toolInput: appRef.current.arguments,
      toolResult:
        (appRef.current.result as McpAppToolCallResult | null) ?? null,
      toolError: appRef.current.error,
      onSizeChanged: ({ height }) => {
        if (typeof height === "number") {
          setInlineHeight(
            Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, height)),
          );
        }
      },
      onRequestDisplayMode: (mode) => {
        setDisplayMode(mode);
        return mode;
      },
      onOpenLink: (url) =>
        new Promise<boolean>((resolve) => {
          setPrompt({
            kind: "link",
            url,
            resolve: (allowed) => {
              setPrompt(null);
              if (allowed) window.open(url, "_blank", "noopener,noreferrer");
              resolve(allowed);
            },
          });
        }),
      onToolCall: async (tool, args) => {
        if (!threadId) throw new Error("No Codex thread for this widget.");
        if (!alwaysAllowedToolsRef.current.has(tool)) {
          const decision = await askToolCall(tool, args);
          if (decision === "deny")
            throw new Error("The user denied the tool call.");
          if (decision === "always") alwaysAllowedToolsRef.current.add(tool);
        }
        return callCodexMcpAppTool({
          threadId,
          callId: app.callId,
          tool,
          arguments: args,
        });
      },
    });
    bridgeRef.current = bridge;
    const onMessage = (event: MessageEvent) => {
      // Only the widget's own opaque-origin document may talk to the bridge.
      if (event.source !== frame.contentWindow || event.origin !== "null") {
        return;
      }
      bridge.handleMessage(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
    // displayMode is read through stateRef; a mode switch remounts the frame.
  }, [
    app.callId,
    askToolCall,
    displayMode,
    hostContext,
    open,
    reloadKey,
    srcdoc,
    threadId,
  ]);

  useEffect(() => {
    bridgeRef.current?.notifyHostContextChanged({ theme });
  }, [theme]);

  useEffect(() => {
    if (displayMode !== "fullscreen" || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDisplayMode("inline");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [displayMode, open]);

  const title = `${app.server} · ${app.tool}`;
  const bordered = resource?.prefersBorder !== false;

  const toolbar = (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-zinc-700/60 px-3 py-1.5 text-[11px] text-zinc-300">
      <AppWindow className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="shrink-0 font-semibold uppercase tracking-wide text-zinc-200">
        MCP App
      </span>
      <span
        className="min-w-0 flex-1 truncate text-zinc-400"
        title={app.resourceUri}
      >
        {title}
      </span>
      {open && (
        <>
          <button
            type="button"
            onClick={() => {
              setResource(null);
              setReloadKey((key) => key + 1);
              void load();
            }}
            disabled={loading}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800/70 disabled:opacity-50"
            title="Reload widget"
            aria-label="Reload widget"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={() =>
              setDisplayMode((mode) =>
                mode === "fullscreen" ? "inline" : "fullscreen",
              )
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800/70"
            title={
              displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"
            }
            aria-label={
              displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"
            }
          >
            {displayMode === "fullscreen" ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={closeWidget}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800/70"
            title="Close widget"
            aria-label="Close widget"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );

  const promptCard = prompt ? (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
      {prompt.kind === "tool" ? (
        <>
          <div className="font-medium">
            Allow this widget to call{" "}
            <span className="font-mono">
              {app.server}.{prompt.tool}
            </span>
            ?
          </div>
          {prompt.argsPreview && prompt.argsPreview !== "{}" && (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-zinc-700/60 bg-zinc-950/60 p-1.5 font-mono text-[11px] text-zinc-300">
              {prompt.argsPreview}
            </pre>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => prompt.resolve("once")}
              className="h-8 rounded border border-amber-400/40 bg-amber-500/20 px-3 text-amber-50 hover:bg-amber-500/30"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => prompt.resolve("always")}
              className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-zinc-200 hover:bg-zinc-700/80"
            >
              Always allow this tool here
            </button>
            <button
              type="button"
              onClick={() => prompt.resolve("deny")}
              className="h-8 rounded border border-zinc-700 bg-zinc-900/80 px-3 text-zinc-300 hover:bg-zinc-800/80"
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="font-medium">This widget wants to open a link:</div>
          <div className="mt-1 break-all font-mono text-[11px] text-amber-50/90">
            {prompt.url}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => prompt.resolve(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-amber-400/40 bg-amber-500/20 px-3 text-amber-50 hover:bg-amber-500/30"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open link
            </button>
            <button
              type="button"
              onClick={() => prompt.resolve(false)}
              className="h-8 rounded border border-zinc-700 bg-zinc-900/80 px-3 text-zinc-300 hover:bg-zinc-800/80"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  ) : null;

  const body = !open ? (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-zinc-400">
      <span className="min-w-0 flex-1 break-all font-mono">
        {app.resourceUri}
      </span>
      <button
        type="button"
        onClick={openWidget}
        disabled={!threadId}
        className="h-8 rounded border border-cyan-500/40 bg-cyan-500/15 px-3 text-cyan-100 transition-colors hover:bg-cyan-500/25 disabled:opacity-50"
      >
        Show widget
      </button>
    </div>
  ) : error ? (
    <div className="px-3 py-2 text-xs text-rose-200">
      Could not load the widget: {error}
    </div>
  ) : !srcdoc ? (
    <div className="px-3 py-2 text-xs text-zinc-400">Loading widget…</div>
  ) : (
    <iframe
      key={`${reloadKey}:${displayMode}`}
      ref={iframeRef}
      title={`MCP App: ${title}`}
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
      className={`block w-full border-0 bg-transparent ${
        displayMode === "fullscreen" ? "min-h-0 flex-1" : ""
      }`}
      style={displayMode === "inline" ? { height: inlineHeight } : undefined}
    />
  );

  const card = (
    <div
      className={
        displayMode === "fullscreen" && open
          ? "fixed inset-0 z-50 flex flex-col bg-zinc-950"
          : `overflow-hidden rounded-xl ${
              bordered ? "border border-zinc-700/70" : ""
            } bg-zinc-900/80`
      }
      role={displayMode === "fullscreen" && open ? "dialog" : undefined}
      aria-modal={displayMode === "fullscreen" && open ? true : undefined}
      aria-label={displayMode === "fullscreen" && open ? title : undefined}
    >
      {toolbar}
      {promptCard}
      {body}
    </div>
  );

  // The conversation list is virtualized with transforms, so fullscreen
  // renders into <body> (the frame reloads with displayMode "fullscreen").
  if (displayMode === "fullscreen" && open && typeof document !== "undefined") {
    return (
      <>
        <div className="rounded-xl border border-zinc-700/70 bg-zinc-900/80 px-3 py-2 text-[11px] text-zinc-400">
          MCP App {title} is open in fullscreen.
        </div>
        {createPortal(card, document.body)}
      </>
    );
  }
  return card;
}
