import type {
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
} from "@codex-deck/api";

export function ApprovalRequestRenderer(props: {
  request: CodexApprovalRequest;
  submitting: boolean;
  error?: string;
  onRespond?: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponsePayload,
  ) => void;
}) {
  const { request, submitting, onRespond, error } = props;

  return (
    <div className="mt-2 min-w-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="text-[11px] font-medium text-amber-200">
        Approval required
      </div>
      {request.reason && (
        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-amber-100/85">
          {request.reason}
        </div>
      )}
      {request.command && (
        <div className="mt-1 break-words text-xs text-zinc-200">
          <span className="text-zinc-400">Command:</span>{" "}
          <span className="font-mono">{request.command}</span>
        </div>
      )}
      {request.cwd && (
        <div className="mt-1 break-words text-xs text-zinc-200">
          <span className="text-zinc-400">Cwd:</span>{" "}
          <span className="font-mono">{request.cwd}</span>
        </div>
      )}
      {request.kind === "permissions" && request.permissions && (
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-zinc-700/45 bg-zinc-950/60 p-2 text-[10px] text-zinc-300">
          {JSON.stringify(request.permissions, null, 2)}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {request.kind === "permissions" ? (
          <>
            <button
              type="button"
              onClick={() =>
                onRespond?.(request, { grant: "allow", scope: "turn" })
              }
              disabled={submitting || !onRespond}
              className="min-h-8 rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-60"
            >
              Allow (turn)
            </button>
            <button
              type="button"
              onClick={() =>
                onRespond?.(request, { grant: "allow", scope: "session" })
              }
              disabled={submitting || !onRespond}
              className="min-h-8 rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-60"
            >
              Allow (session)
            </button>
            <button
              type="button"
              onClick={() => onRespond?.(request, { grant: "deny" })}
              disabled={submitting || !onRespond}
              className="min-h-8 rounded border border-red-400/35 bg-red-500/10 px-2 py-1 text-[11px] text-red-100 transition-colors hover:bg-red-500/20 disabled:cursor-default disabled:opacity-60"
            >
              Deny
            </button>
          </>
        ) : (
          request.availableDecisions.map((option) => (
            <button
              type="button"
              key={option.id}
              onClick={() => onRespond?.(request, { decisionId: option.id })}
              disabled={submitting || !onRespond}
              title={option.description}
              className="min-h-8 rounded border border-zinc-500/35 bg-zinc-500/10 px-2 py-1 text-[11px] text-zinc-100 transition-colors hover:bg-zinc-500/20 disabled:cursor-default disabled:opacity-60"
            >
              {option.label}
            </button>
          ))
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 break-words text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
