import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexWorkspaceError } from "./codex-working-directory";

/** App-server `GuardianApprovalReviewAction` (camelCase, tagged by `type`). */
export type CodexGuardianAction = { type: string; [key: string]: unknown };
export type CodexGuardianStatus =
  | "inProgress"
  | "approved"
  | "denied"
  | "timedOut"
  | "aborted";

export interface CodexGuardianReview {
  reviewId: string;
  threadId: string;
  turnId: string;
  targetItemId: string | null;
  status: CodexGuardianStatus;
  riskLevel: string | null;
  userAuthorization: string | null;
  rationale: string | null;
  decisionSource: string | null;
  startedAtMs: number;
  completedAtMs: number | null;
  action: CodexGuardianAction;
  summary: string;
  /** Set once a user approved one retry through `/approve`. */
  retryApprovedAt: number | null;
}

export interface CodexGuardianSnapshot {
  threadId: string;
  reviews: CodexGuardianReview[];
  /** Upstream `RecentAutoReviewDenials`: newest first, at most ten. */
  denials: CodexGuardianReview[];
  strictReview: { turnId: string; startedAtMs: number } | null;
}

const MAX_REVIEWS_PER_THREAD = 50;
const MAX_RECENT_DENIALS = 10;
const STATUSES = ["inProgress", "approved", "denied", "timedOut", "aborted"];

export const STRICT_REVIEW_MESSAGE =
  "This request requires additional safety checks, some tool calls might take extra time";
export const RETRY_APPROVED_MESSAGE =
  "Approval recorded for one retry of the selected auto-review denial.";
export const RETRY_APPROVED_HINT =
  "The model will see the approval context; the retry still goes through auto-review.";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

function shellJoin(argv: string[]): string {
  return argv
    .map((arg) =>
      /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

/** Upstream `auto_review_denials::action_summary`. */
export function guardianActionSummary(action: CodexGuardianAction): string {
  switch (action.type) {
    case "command":
      return text(action.command) ?? "command";
    case "execve": {
      const argv = Array.isArray(action.argv)
        ? action.argv.filter((arg): arg is string => typeof arg === "string")
        : [];
      return shellJoin(argv.length ? argv : [text(action.program) ?? ""]);
    }
    case "writeStdin":
      return `send input to terminal ${text(action.processId) ?? "?"}: ${truncate(
        JSON.stringify(text(action.stdin) ?? ""),
        80,
      )}`;
    case "applyPatch": {
      const files = Array.isArray(action.files) ? action.files : [];
      return files.length === 1
        ? `apply_patch touching ${String(files[0])}`
        : `apply_patch touching ${files.length} files`;
    }
    case "networkAccess":
      return `network access to ${text(action.target) ?? "?"}`;
    case "mcpToolCall":
      return `MCP ${text(action.toolName) ?? "tool"} on ${
        text(action.connectorName) ?? text(action.server) ?? "server"
      }`;
    case "requestPermissions": {
      const reason = text(action.reason);
      return reason ? `permission request: ${reason}` : "permission request";
    }
    default:
      return action.type;
  }
}

const snake = (value: string) =>
  value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [snake(key), snakeKeys(entry)]),
  );
}

/**
 * Rebuilds the core `GuardianAssessmentEvent` (snake_case) that
 * `thread/approveGuardianDeniedAction` expects from the app-server review.
 */
export function toGuardianAssessmentEvent(
  review: CodexGuardianReview,
): Record<string, unknown> {
  const action = snakeKeys(review.action) as Record<string, unknown>;
  action.type = snake(review.action.type);
  for (const key of ["source", "protocol"])
    if (typeof action[key] === "string")
      action[key] = snake(action[key] as string);
  if (
    action.type === "write_stdin" &&
    typeof action.cwd === "string" &&
    isAbsolute(action.cwd)
  )
    action.cwd = pathToFileURL(action.cwd).href;
  return {
    id: review.reviewId,
    ...(review.targetItemId ? { target_item_id: review.targetItemId } : {}),
    turn_id: review.turnId,
    started_at_ms: review.startedAtMs,
    ...(review.completedAtMs != null
      ? { completed_at_ms: review.completedAtMs }
      : {}),
    status: snake(review.status),
    ...(review.riskLevel ? { risk_level: review.riskLevel } : {}),
    ...(review.userAuthorization
      ? { user_authorization: review.userAuthorization }
      : {}),
    ...(review.rationale ? { rationale: review.rationale } : {}),
    ...(review.decisionSource
      ? { decision_source: snake(review.decisionSource) }
      : {}),
    action,
  };
}

export function parseGuardianReviewNotification(
  params: unknown,
): CodexGuardianReview | null {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : null;
  const review =
    record?.review && typeof record.review === "object"
      ? (record.review as Record<string, unknown>)
      : null;
  const action =
    record?.action &&
    typeof record.action === "object" &&
    typeof (record.action as { type?: unknown }).type === "string"
      ? (record.action as CodexGuardianAction)
      : null;
  if (
    !record ||
    !review ||
    !action ||
    typeof record.threadId !== "string" ||
    typeof record.reviewId !== "string" ||
    typeof review.status !== "string" ||
    !STATUSES.includes(review.status)
  )
    return null;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    reviewId: record.reviewId,
    threadId: record.threadId,
    turnId: text(record.turnId) ?? "",
    targetItemId: text(record.targetItemId),
    status: review.status as CodexGuardianStatus,
    riskLevel: text(review.riskLevel),
    userAuthorization: text(review.userAuthorization),
    rationale: text(review.rationale),
    decisionSource: text(record.decisionSource),
    startedAtMs: number(record.startedAtMs) ?? Date.now(),
    completedAtMs: number(record.completedAtMs),
    action,
    summary: guardianActionSummary(action),
    retryApprovedAt: null,
  };
}

type Rpc = (
  method: string,
  params: Record<string, unknown>,
  threadId?: string | null,
) => Promise<unknown>;

/**
 * Retains auto-review lifecycle events (transient in Codex rollouts) for every
 * browser client, and serializes `/approve` retries across clients.
 */
export class GuardianReviewStore {
  private reviews = new Map<string, CodexGuardianReview[]>();
  private strict = new Map<string, { turnId: string; startedAtMs: number }>();
  private approving = new Set<string>();

  public constructor(
    private readonly rpc: Rpc,
    private readonly notify: (threadId: string) => void,
  ) {}

  /** Returns true when the notification is an auto-review lifecycle event. */
  public handleNotification(method: string, params: unknown): boolean {
    if (
      method === "item/autoApprovalReview/started" ||
      method === "item/autoApprovalReview/completed"
    ) {
      const review = parseGuardianReviewNotification(params);
      if (review) this.record(review);
      return true;
    }
    if (method === "autoApprovalReview/strictReviewRequired") {
      const record = params as Record<string, unknown> | null;
      if (record && typeof record.threadId === "string") {
        this.strict.set(record.threadId, {
          turnId: text(record.turnId) ?? "",
          startedAtMs:
            typeof record.startedAtMs === "number"
              ? record.startedAtMs
              : Date.now(),
        });
        this.notify(record.threadId);
      }
      return true;
    }
    if (method === "turn/completed") {
      const record = params as Record<string, unknown> | null;
      const threadId = typeof record?.threadId === "string" && record.threadId;
      if (threadId) {
        let changed = this.strict.delete(threadId);
        // A finished turn cannot still be reviewing; settle stale entries.
        for (const review of this.reviews.get(threadId) ?? [])
          if (review.status === "inProgress") {
            review.status = "aborted";
            review.completedAtMs = Date.now();
            changed = true;
          }
        if (changed) this.notify(threadId);
      }
    }
    return false;
  }

  private record(review: CodexGuardianReview) {
    const list = this.reviews.get(review.threadId) ?? [];
    const previous = list.find((entry) => entry.reviewId === review.reviewId);
    // Completed events never regress to in-progress.
    if (
      previous &&
      previous.status !== "inProgress" &&
      review.status === "inProgress"
    )
      return;
    const next = list.filter((entry) => entry.reviewId !== review.reviewId);
    next.push({
      ...review,
      retryApprovedAt: previous?.retryApprovedAt ?? null,
    });
    this.reviews.set(review.threadId, next.slice(-MAX_REVIEWS_PER_THREAD));
    this.notify(review.threadId);
  }

  public snapshot(threadId: string): CodexGuardianSnapshot {
    const reviews = this.reviews.get(threadId) ?? [];
    return {
      threadId,
      reviews: reviews.map((review) => ({ ...review })),
      denials: reviews
        .filter(
          (review) => review.status === "denied" && !review.retryApprovedAt,
        )
        .sort((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0))
        .slice(0, MAX_RECENT_DENIALS)
        .map((review) => ({ ...review })),
      strictReview: this.strict.get(threadId) ?? null,
    };
  }

  public async approveDenial(
    threadId: string,
    reviewId: string,
  ): Promise<CodexGuardianSnapshot> {
    const key = `${threadId}\u0000${reviewId}`;
    const review = this.snapshot(threadId).denials.find(
      (entry) => entry.reviewId === reviewId,
    );
    // Claim before awaiting so two clients cannot approve the same denial.
    if (!review || this.approving.has(key))
      throw new CodexWorkspaceError(
        "That auto-review denial is no longer available.",
        409,
      );
    this.approving.add(key);
    try {
      await this.rpc(
        "thread/approveGuardianDeniedAction",
        { threadId, event: toGuardianAssessmentEvent(review) },
        threadId,
      );
      const stored = this.reviews
        .get(threadId)
        ?.find((entry) => entry.reviewId === reviewId);
      if (stored) stored.retryApprovedAt = Date.now();
      this.notify(threadId);
      return this.snapshot(threadId);
    } finally {
      this.approving.delete(key);
    }
  }
}
