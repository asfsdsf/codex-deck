import type {
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
} from "@codex-deck/api";
import { ApprovalRequestRenderer } from "./approval-request";

export function PendingApprovalRequests({
  requests,
  submittingRequestIds,
  errors,
  onRespond,
}: {
  requests: readonly CodexApprovalRequest[];
  submittingRequestIds: readonly string[];
  errors: Readonly<Record<string, string>>;
  onRespond: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponsePayload,
  ) => void;
}) {
  if (!requests.length) return null;

  return (
    <section aria-label="Pending approvals" className="mt-4 space-y-3">
      {requests.map((request) => (
        <div
          key={request.requestId}
          data-pending-approval-request={request.requestId}
        >
          <ApprovalRequestRenderer
            request={request}
            submitting={submittingRequestIds.includes(request.requestId)}
            error={errors[request.requestId]}
            onRespond={onRespond}
          />
        </div>
      ))}
    </section>
  );
}
