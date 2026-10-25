import { useCallback } from "react";
import { getCodexConfigDiagnostics } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

function sourceName(source: unknown): string {
  if (!source || typeof source !== "object") return "Source not reported";
  const value = source as Record<string, unknown>;
  const labels: Record<string, string> = {
    packagedDefaults: "Packaged defaults",
    mdm: "Managed preferences",
    system: "System",
    enterpriseManaged: "Enterprise managed",
    user: "User",
    project: "Project",
    sessionFlags: "Session flags",
    legacyManagedConfigTomlFromFile: "Legacy managed file",
    legacyManagedConfigTomlFromMdm: "Legacy managed preferences",
  };
  const type = typeof value.type === "string" ? value.type : "Unknown layer";
  const detail = [
    value.file,
    value.dot_codex_folder,
    value.domain,
    value.name,
    value.id,
    value.profile,
  ].filter((item) => typeof item === "string");
  return `${labels[type] || type}${detail.length ? ` · ${detail.join(" · ")}` : ""}`;
}
function JsonDetails({
  title,
  value,
  open = false,
}: {
  title: string;
  value: unknown;
  open?: boolean;
}) {
  return (
    <details
      open={open}
      className="rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
    >
      <summary className="cursor-pointer font-medium">{title}</summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
export default function ConfigDiagnostics({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(
    () => getCodexConfigDiagnostics(threadId),
    [threadId],
  );
  const { data, error, loading, refresh } = useNativeSnapshot(
    "diagnostics",
    threadId,
    load,
  );
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-zinc-400">
          Inspect host configuration and managed requirements. Conversation turn
          overrides are separate. Credential and environment values are
          redacted.
        </p>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh configuration
        </button>
      </div>
      {loading && <p role="status">Loading configuration diagnostics…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="break-all text-zinc-400">
            Configuration scope: {data.cwd || "Host defaults"}
          </p>
          {data.errors.map((message) => (
            <p
              role="alert"
              key={message}
              className="break-words text-amber-300"
            >
              {message}
            </p>
          ))}
          {data.config && (
            <JsonDetails title="Effective configuration" value={data.config} />
          )}
          <section className="space-y-2" aria-label="Configuration layers">
            <h3 className="font-semibold">Configuration layers</h3>
            <p className="text-xs text-zinc-400">
              Reported stack order. Value origins below identify the layer that
              supplied each setting.
            </p>
            {data.layers == null ? (
              <p className="text-zinc-400">
                Layer details were not exposed by the connected server.
              </p>
            ) : data.layers.length === 0 ? (
              <p className="text-zinc-400">No layers reported.</p>
            ) : (
              data.layers.map((layer, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-lg border border-zinc-700 p-3"
                >
                  <p className="break-all font-medium">
                    {index + 1}. {sourceName(layer.name)}
                  </p>
                  <p className="break-all text-xs text-zinc-500">
                    Version: {layer.version}
                  </p>
                  {layer.disabledReason && (
                    <p className="break-words text-amber-300">
                      Disabled: {layer.disabledReason}
                    </p>
                  )}
                  <JsonDetails title="Layer values" value={layer.config} />
                </div>
              ))
            )}
          </section>
          <section className="space-y-2" aria-label="Value origins">
            <h3 className="font-semibold">Value origins</h3>
            {Object.keys(data.origins).length === 0 ? (
              <p className="text-zinc-400">Value origins were not reported.</p>
            ) : (
              <dl className="divide-y divide-zinc-700 rounded-lg border border-zinc-700 px-3">
                {Object.entries(data.origins).map(([key, raw]) => {
                  const origin =
                    raw && typeof raw === "object"
                      ? (raw as Record<string, unknown>)
                      : {};
                  return (
                    <div key={key} className="py-2">
                      <dt className="break-all font-mono text-xs">{key}</dt>
                      <dd className="mt-1 break-all text-xs text-zinc-400">
                        {sourceName(origin.name)}
                        {typeof origin.version === "string"
                          ? ` · ${origin.version}`
                          : ""}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>
          <section className="space-y-2" aria-label="Managed requirements">
            <h3 className="font-semibold">Managed requirements</h3>
            {data.requirements ? (
              <JsonDetails
                title="Effective requirements"
                value={data.requirements}
                open
              />
            ) : (
              <p className="text-zinc-400">
                {data.errors.some((message) =>
                  message.startsWith("Requirements unavailable"),
                )
                  ? "Requirements could not be read."
                  : "No managed requirements reported."}
              </p>
            )}
            {data.supportsIndependentSpeedModes != null && (
              <p className="text-xs text-zinc-400">
                Independent speed policy:{" "}
                {data.supportsIndependentSpeedModes
                  ? "Supported"
                  : "Not supported"}
              </p>
            )}
            {data.requirementSources != null ? (
              <JsonDetails
                title="Requirement sources"
                value={data.requirementSources}
                open
              />
            ) : (
              <p className="text-xs text-zinc-400">
                Requirement sources are not exposed by the connected server.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
