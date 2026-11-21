import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDeckPluginRuntime,
  getDeckPluginFileUrl,
  saveDeckPluginState,
} from "../deck-plugins-api";

const CHANNEL = "codex-deck-plugin";
const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;
const MAX_BRIDGE_REQUESTS_PER_MINUTE = 60;

interface PluginContext {
  threadId: string | null;
  cwd: string | null;
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
  context,
  onClose,
}: PluginRuntimeProps) {
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
    void getDeckPluginRuntime(pluginId).then(
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
  }, [pluginId]);

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(
      { channel: CHANNEL, ...message },
      "*",
    );
  }, []);

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
        await saveDeckPluginState(pluginId, nextState);
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
    [pluginId, respond, runtime],
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
    <section className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-950/70 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium">{runtime?.plugin.name ?? "Plugin"}</h4>
          <p className="text-xs text-zinc-400">
            Sandboxed plugin interface · {runtime?.plugin.version ?? ""}
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
      {runtime && (
        <iframe
          ref={frameRef}
          title={runtime.plugin.name}
          sandbox="allow-scripts"
          referrerPolicy="same-origin"
          src={getDeckPluginFileUrl(
            pluginId,
            runtime.manifest.entrypoints.panel,
          )}
          onLoad={() =>
            send({
              type: "initialize",
              plugin: runtime.plugin,
              apiVersion: runtime.manifest.apiVersion,
              capabilities: runtime.manifest.capabilities,
              context: runtime.manifest.capabilities.includes("context.read")
                ? contextRef.current
                : null,
              state: runtime.manifest.capabilities.includes("state.read")
                ? stateRef.current
                : {},
            })
          }
          className="h-[min(58dvh,36rem)] min-h-72 w-full rounded-lg border border-zinc-800 bg-white"
        />
      )}
    </section>
  );
}
