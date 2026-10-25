import { useEffect, useState } from "react";
import type {
  CodexElicitationRequest,
  CodexElicitationResponse,
} from "@codex-deck/api";
import {
  elicitationFields,
  elicitationUrl,
  validateElicitationResponse,
  type ElicitationField,
} from "../../api/mcp-elicitation";
import { listCodexElicitations, respondCodexElicitation } from "../api";
import { usePageVisibility } from "../hooks/use-page-visibility";

export function PendingElicitations({
  sessionId,
  revision = 0,
}: {
  sessionId: string;
  revision?: number;
}) {
  const [requests, setRequests] = useState<CodexElicitationRequest[]>([]);
  const visible = usePageVisibility();
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const pending = await listCodexElicitations(sessionId);
        if (!cancelled) setRequests(pending);
      } catch {
        /* Retry transient failures without discarding the form draft. */
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, visible, revision]);
  return (
    <div className="space-y-3">
      {requests
        .filter((r) => r.threadId === sessionId)
        .map((request) => (
          <ElicitationCard
            key={request.requestId}
            request={request}
            onResolved={() =>
              setRequests((current) =>
                current.filter((r) => r.requestId !== request.requestId),
              )
            }
          />
        ))}
    </div>
  );
}

export function ElicitationCard({
  request,
  onResolved,
}: {
  request: CodexElicitationRequest;
  onResolved: () => void;
}) {
  let fields: ElicitationField[] = [];
  let unsupported: string | null = null;
  if (request.mode === "openai/userVerification")
    unsupported =
      "This request requires native device verification, which is unavailable in Codex Deck. Use a supported native client or decline this request.";
  else if (request.mode === "url") {
    if (!elicitationUrl(request.url))
      unsupported = "This authorization URL is not supported.";
  } else {
    try {
      fields = elicitationFields(request.requestedSchema);
    } catch (reason) {
      unsupported =
        reason instanceof Error ? reason.message : "Unsupported form";
    }
  }
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields
        .filter((f) => f.schema.default !== undefined)
        .map((f) => [f.name, f.schema.default]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (name: string, value: unknown) =>
    setValues((current) => ({ ...current, [name]: value }));
  const respond = async (action: CodexElicitationResponse["action"]) => {
    if (submitting) return;
    const content = Object.fromEntries(
      fields.flatMap((field) => {
        const value = values[field.name];
        if (value === undefined || value === "") return [];
        return [
          [
            field.name,
            field.type === "number" || field.type === "integer"
              ? Number(value)
              : value,
          ],
        ];
      }),
    );
    const response: CodexElicitationResponse = {
      action,
      content: action === "accept" && request.mode !== "url" ? content : null,
    };
    try {
      validateElicitationResponse(request, response);
      setError(null);
      setSubmitting(true);
      await respondCodexElicitation(
        request.threadId,
        request.requestId,
        response,
      );
      onResolved();
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Could not respond";
      if (message.includes("request not found")) onResolved();
      else setError(message);
    } finally {
      setSubmitting(false);
    }
  };
  const inputClass =
    "w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void respond("accept");
      }}
      className="min-w-0 space-y-3 rounded-xl border border-amber-500/30 bg-zinc-900 p-3 text-zinc-100"
    >
      <div className="text-sm font-semibold">
        MCP request · {request.serverName}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">
        {request.message}
      </p>
      {unsupported ? (
        <p className="text-sm text-amber-200">{unsupported}</p>
      ) : request.mode === "url" ? (
        <div className="space-y-2 text-sm">
          <a
            href={elicitationUrl(request.url)!}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-cyan-300 underline"
          >
            Open authorization: {request.url}
          </a>
          <p>Complete authorization in the new tab, then select Continue.</p>
        </div>
      ) : (
        fields.map((field) => (
          <label key={field.name} className="block space-y-1 text-sm">
            <span>
              {field.title}
              {field.required ? " *" : ""}
            </span>
            {field.description && (
              <span className="block text-xs text-zinc-400">
                {field.description}
              </span>
            )}
            {field.type === "boolean" ? (
              <select
                className={inputClass}
                disabled={submitting}
                required={field.required}
                value={
                  values[field.name] === undefined
                    ? ""
                    : String(values[field.name])
                }
                onChange={(e) =>
                  update(
                    field.name,
                    e.target.value === ""
                      ? undefined
                      : e.target.value === "true",
                  )
                }
              >
                <option value="">Select…</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : field.options ? (
              <select
                className={inputClass}
                disabled={submitting}
                required={field.required}
                multiple={field.type === "array"}
                value={
                  field.type === "array"
                    ? ((values[field.name] as string[]) ?? [])
                    : String(values[field.name] ?? "")
                }
                onChange={(e) =>
                  update(
                    field.name,
                    field.type === "array"
                      ? Array.from(e.target.selectedOptions, (o) => o.value)
                      : e.target.value,
                  )
                }
              >
                {field.type !== "array" && <option value="">Select…</option>}
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                disabled={submitting}
                required={field.required}
                type={
                  field.type === "number" || field.type === "integer"
                    ? "number"
                    : field.schema.format === "email"
                      ? "email"
                      : field.schema.format === "uri"
                        ? "url"
                        : field.schema.format === "date"
                          ? "date"
                          : "text"
                }
                step={field.type === "integer" ? 1 : "any"}
                min={
                  typeof field.schema.minimum === "number"
                    ? field.schema.minimum
                    : undefined
                }
                max={
                  typeof field.schema.maximum === "number"
                    ? field.schema.maximum
                    : undefined
                }
                minLength={
                  typeof field.schema.minLength === "number"
                    ? field.schema.minLength
                    : undefined
                }
                maxLength={
                  typeof field.schema.maxLength === "number"
                    ? field.schema.maxLength
                    : undefined
                }
                value={String(values[field.name] ?? "")}
                onChange={(e) => update(field.name, e.target.value)}
              />
            )}
          </label>
        ))
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!unsupported && (
          <button
            type="submit"
            disabled={submitting}
            className="rounded border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-sm text-cyan-100 disabled:opacity-50"
          >
            {submitting
              ? "Sending…"
              : request.mode === "url"
                ? "Continue"
                : "Submit"}
          </button>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => void respond("decline")}
          className="rounded border border-zinc-600 px-3 py-2 text-sm disabled:opacity-50"
        >
          Decline
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void respond("cancel")}
          className="rounded border border-zinc-600 px-3 py-2 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
