import { useCallback, useState } from "react";
import {
  getCodexMcpInventory,
  loginCodexMcpServer,
  reloadCodexMcpServers,
} from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

export default function McpAdmin({ threadId }: { threadId: string | null }) {
  const load = useCallback(() => getCodexMcpInventory(threadId), [threadId]);
  const { data, loading, error, refresh } = useNativeSnapshot(
    "mcp",
    threadId,
    load,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [login, setLogin] = useState<{
    name: string;
    authorizationUrl: string;
  } | null>(null);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError("");
    try {
      await work();
      refresh();
    } catch (reason) {
      setActionError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Configured MCP servers, their connections, and available tools.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy || loading}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          onClick={refresh}
        >
          Refresh inventory
        </button>
        <button
          disabled={busy}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          onClick={() =>
            void act(async () => {
              await reloadCodexMcpServers();
            })
          }
        >
          Reload configuration
        </button>
      </div>
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {loading && <p role="status">Loading MCP inventory…</p>}
      {login && (
        <div className="rounded border border-cyan-500/30 bg-cyan-500/10 p-3">
          <p>Continue OAuth login for {login.name}.</p>
          <a
            className="text-cyan-300 underline"
            href={login.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open authorization page
          </a>
          <p className="mt-1 text-xs text-zinc-400">
            Complete authorization using a browser that can reach the callback
            address supplied by the MCP server.
          </p>
        </div>
      )}
      {data && !data.servers.length && <p>No MCP servers configured.</p>}
      {data?.servers.map((server) => (
        <article
          key={server.name}
          className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
        >
          <h3 className="break-all font-semibold">{server.name}</h3>
          <p className="text-xs text-zinc-400">
            {server.runtimeStatus || "Connection status unavailable"} ·
            Authentication: {server.authStatus}
          </p>
          {server.authStatus !== "unsupported" && (
            <button
              disabled={busy}
              className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-50"
              onClick={() =>
                void act(async () => {
                  const result = await loginCodexMcpServer(
                    server.name,
                    threadId,
                  );
                  setLogin({
                    name: server.name,
                    authorizationUrl: result.authorizationUrl,
                  });
                })
              }
            >
              OAuth login
            </button>
          )}
          {server.toolsError && (
            <p className="break-words text-red-400">{server.toolsError}</p>
          )}
          <details>
            <summary className="cursor-pointer">
              Tools ({Object.keys(server.tools).length})
            </summary>
            <div className="mt-2 space-y-2">
              {Object.entries(server.tools).map(([name, tool]) => (
                <details
                  key={name}
                  className="rounded border border-zinc-700/60 p-2"
                >
                  <summary className="cursor-pointer break-all font-mono text-xs">
                    {name}
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-zinc-300">
                    {tool.description}
                  </p>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(tool.inputSchema, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          </details>
          <p className="text-xs text-zinc-400">
            {server.resources.length} resources ·{" "}
            {server.resourceTemplates.length} resource templates
          </p>
          {data.updates
            .filter((update) => update.name === server.name)
            .map((update, index) => (
              <p
                key={index}
                role="status"
                className="break-words text-xs text-zinc-300"
              >
                {update.status
                  ? `Startup: ${update.status}`
                  : `OAuth: ${update.success ? "completed" : "failed"}`}{" "}
                {update.error}
              </p>
            ))}
        </article>
      ))}
    </div>
  );
}
