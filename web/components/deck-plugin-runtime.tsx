import { getActiveCodexHomeId } from "../codex-home-scope";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDeckPluginRuntime,
  getDeckPluginFileUrl,
  saveDeckPluginState,
  requestDeckPluginWorker,
  getDeckPluginSecretStatus,
  setDeckPluginSecrets,
  callDeckPluginService,
} from "../deck-plugins-api";
import BuiltinPluginView from "../plugins/builtin-plugin-view";

const CHANNEL = "codex-deck-plugin";
const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;
const MAX_BRIDGE_REQUESTS_PER_MINUTE = 60;

interface PluginContext {
  threadId: string | null;
  cwd: string | null;
  model?: string | null;
  args?: string;
}

interface PluginRequest {
  channel: typeof CHANNEL;
  type: "request";
  requestId: string;
  method: string;
  params?: unknown;
}

interface PluginRuntimeProps {
  pluginId: string;
  homeId?: string;
  surface?: "panel" | "settings";
  viewId?: string;
  embedded?: boolean;
  fillPane?: boolean;
  context: PluginContext;
  onClose: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getMessageSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export default function DeckPluginRuntime({
  pluginId,
  homeId: requestedHomeId,
  surface = "panel",
  viewId,
  embedded = false,
  fillPane = false,
  context,
  onClose,
}: PluginRuntimeProps) {
  const homeId = useRef(requestedHomeId ?? getActiveCodexHomeId()).current;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const contextRef = useRef(context);
  const stateRef = useRef<Record<string, unknown>>({});
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const requestTimesRef = useRef<number[]>([]);
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<typeof getDeckPluginRuntime>
  > | null>(null);
  const [pluginState, setPluginState] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  contextRef.current = context;
  stateRef.current = pluginState;

  useEffect(() => {
    let current = true;
    setRuntime(null);
    setPluginState({});
    setError("");
    void getDeckPluginRuntime(pluginId, homeId).then(
      (result) => {
        if (!current) return;
        setRuntime(result);
        setPluginState(result.state);
      },
      (reason) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [pluginId, homeId]);

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(
      { channel: CHANNEL, ...message },
      "*",
    );
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      send({
        type: "theme",
        theme:
          document.documentElement.dataset.theme === "light" ? "light" : "dark",
      }),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [send]);

  useEffect(() => {
    if (runtime?.manifest.capabilities.includes("context.read"))
      send({ type: "context", context: contextRef.current });
  }, [
    runtime,
    send,
    context.threadId,
    context.cwd,
    context.model,
    context.args,
  ]);

  const respond = useCallback(
    (requestId: string, result?: unknown, errorMessage?: string) => {
      send({
        type: "response",
        requestId,
        ...(errorMessage ? { error: errorMessage } : { result }),
      });
    },
    [send],
  );

  const handleRequest = useCallback(
    async (request: PluginRequest) => {
      const frame = frameRef.current;
      if (
        !frame ||
        request.channel !== CHANNEL ||
        request.type !== "request" ||
        typeof request.requestId !== "string" ||
        request.requestId.length > 128 ||
        typeof request.method !== "string" ||
        request.method.length > 80 ||
        getMessageSize(request) > MAX_BRIDGE_MESSAGE_BYTES
      ) {
        return;
      }
      const now = Date.now();
      requestTimesRef.current = requestTimesRef.current.filter(
        (time) => now - time < 60_000,
      );
      if (requestTimesRef.current.length >= MAX_BRIDGE_REQUESTS_PER_MINUTE) {
        respond(
          request.requestId,
          undefined,
          "Plugin bridge rate limit exceeded.",
        );
        return;
      }
      requestTimesRef.current.push(now);

      if (
        ["workerRequest", "getSecrets", "setSecrets", "callService"].includes(
          request.method,
        )
      ) {
        const permission =
          request.method === "callService"
            ? "services.call"
            : request.method === "workerRequest"
              ? "worker.request"
              : request.method === "setSecrets"
                ? "secrets.write"
                : "secrets.read";
        if (!runtime?.manifest.capabilities.includes(permission)) {
          respond(
            request.requestId,
            undefined,
            `${permission} is not granted.`,
          );
          return;
        }
        try {
          const params = isObject(request.params) ? request.params : {};
          const result =
            request.method === "callService"
              ? await callDeckPluginService(
                  pluginId,
                  String(params.service ?? ""),
                  String(params.method ?? ""),
                  params.params ?? {},
                  homeId,
                )
              : request.method === "workerRequest"
                ? await requestDeckPluginWorker(
                    pluginId,
                    String(params.method ?? ""),
                    params.params ?? {},
                    homeId,
                  )
                : request.method === "getSecrets"
                  ? await getDeckPluginSecretStatus(pluginId, homeId)
                  : await setDeckPluginSecrets(
                      pluginId,
                      params as Record<string, string | null>,
                      homeId,
                    );
          respond(request.requestId, result);
        } catch (reason) {
          respond(
            request.requestId,
            undefined,
            reason instanceof Error ? reason.message : "Plugin request failed.",
          );
        }
        return;
      }
      if (request.method === "getContext") {
        if (!runtime?.manifest.capabilities.includes("context.read")) {
          respond(request.requestId, undefined, "context.read is not granted.");
          return;
        }
        respond(request.requestId, contextRef.current);
        return;
      }
      if (request.method === "getState") {
        if (!runtime?.manifest.capabilities.includes("state.read")) {
          respond(request.requestId, undefined, "state.read is not granted.");
          return;
        }
        respond(request.requestId, stateRef.current);
        return;
      }
      if (
        request.method !== "setState" ||
        !runtime?.manifest.capabilities.includes("state.write") ||
        !isObject(request.params) ||
        !isObject(request.params.state) ||
        getMessageSize(request.params.state) > MAX_BRIDGE_MESSAGE_BYTES
      ) {
        respond(
          request.requestId,
          undefined,
          "Unsupported plugin bridge request.",
        );
        return;
      }

      const nextState = request.params.state;
      setSaving(true);
      const write = writeQueueRef.current.then(async () => {
        await saveDeckPluginState(pluginId, nextState, homeId);
        stateRef.current = nextState;
        setPluginState(nextState);
      });
      writeQueueRef.current = write.catch(() => undefined);
      try {
        await write;
        respond(request.requestId, nextState);
      } catch (reason) {
        respond(
          request.requestId,
          undefined,
          reason instanceof Error ? reason.message : String(reason),
        );
      } finally {
        setSaving(false);
      }
    },
    [pluginId, respond, runtime, homeId],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current;
      if (
        event.origin !== "null" ||
        event.source !== frame?.contentWindow ||
        !isObject(event.data) ||
        event.data.channel !== CHANNEL
      ) {
        return;
      }
      void handleRequest(event.data as unknown as PluginRequest);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleRequest]);

  return (
    <section
      className={
        fillPane
          ? "flex flex-1 min-h-0 h-full flex-col"
          : "space-y-3 rounded-lg border border-zinc-700 bg-zinc-950/70 text-zinc-100 p-3"
      }
    >
      {!embedded && (
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="font-medium">{runtime?.plugin.name ?? "Plugin"}</h4>
            <p className="text-xs text-zinc-400">
              {runtime?.source === "builtin"
                ? "Built-in"
                : "Sandboxed plugin interface"}{" "}
              · {runtime?.plugin.version ?? ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {saving && (
              <span role="status" className="text-xs text-zinc-400">
                Saving plugin state…
              </span>
            )}
            <button
              type="button"
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              onClick={onClose}
            >
              Close plugin
            </button>
          </div>
        </header>
      )}

      {error && (
        <p role="alert" className="break-words text-sm text-rose-300">
          {error}
        </p>
      )}
      {!runtime && !error && (
        <p role="status" className="text-sm text-zinc-400">
          Loading plugin…
        </p>
      )}
      {runtime?.source === "builtin" ? (
        <BuiltinPluginView
          pluginId={pluginId}
          viewId={viewId}
          homeId={homeId}
          context={context}
        />
      ) : (
        runtime && (
          <iframe
            ref={frameRef}
            title={runtime.plugin.name}
            sandbox="allow-scripts"
            referrerPolicy="same-origin"
            src={getDeckPluginFileUrl(
              pluginId,
              runtime.manifest.contributions?.views?.find(
                (view) => view.id === viewId,
              )?.entrypoint ??
                runtime.manifest.entrypoints[surface] ??
                runtime.manifest.entrypoints.panel ??
                runtime.manifest.entrypoints.settings ??
                "",
              homeId,
            )}
            onLoad={() =>
              send({
                type: "initialize",
                theme:
                  document.documentElement.dataset.theme === "light"
                    ? "light"
                    : "dark",
                plugin: runtime.plugin,
                capabilities: runtime.manifest.capabilities,
                context: runtime.manifest.capabilities.includes("context.read")
                  ? contextRef.current
                  : null,
                state: runtime.manifest.capabilities.includes("state.read")
                  ? stateRef.current
                  : {},
              })
            }
            className={
              embedded
                ? fillPane
                  ? "w-full flex-1 min-h-0 border-0"
                  : "min-h-8 w-full rounded-lg border border-zinc-800 bg-white"
                : "h-[min(58dvh,36rem)] min-h-72 w-full rounded-lg border border-zinc-800 bg-white"
            }
            style={
              embedded && !fillPane
                ? {
                    height:
                      runtime.manifest.contributions?.views?.find(
                        (view) => view.id === viewId,
                      )?.height ??
                      (runtime.manifest.contributions?.views?.find(
                        (view) => view.id === viewId,
                      )?.slot === "session.toolbar"
                        ? 64
                        : 160),
                  }
                : undefined
            }
          />
        )
      )}
    </section>
  );
}
