export const OPERATIONAL_METHODS = [
  "item/mcpToolCall/progress",
  "model/rerouted",
  "model/verification",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "configWarning",
  "deprecationNotice",
  "warning",
  "guardianWarning",
] as const;
export type CodexOperationalMethod = (typeof OPERATIONAL_METHODS)[number];
export interface CodexOperationalNotification {
  id: string;
  timestamp: number;
  method: CodexOperationalMethod;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  details: Record<string, unknown>;
}
export class OperationalNotificationStore {
  private notices: CodexOperationalNotification[] = [];
  private warnings: CodexOperationalNotification[] = [];
  private sequence = 0;
  private epoch = `${Date.now()}-${Math.random()}`;
  record(method: string, params: unknown): CodexOperationalNotification | null {
    if (
      !(OPERATIONAL_METHODS as readonly string[]).includes(method) ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params)
    )
      return null;
    const details = params as Record<string, unknown>;
    const string = (key: string) =>
      typeof details[key] === "string" ? (details[key] as string) : null;
    const threadId = string("threadId");
    if (
      !["configWarning", "deprecationNotice", "warning"].includes(method) &&
      !threadId
    )
      return null;
    // Upstream TUI hides auto-review approval confirmations.
    if (
      method === "guardianWarning" &&
      string("message")?.startsWith("Automatic approval review approved (")
    )
      return null;
    let summary = string("summary") || string("message") || method;
    if (method === "model/rerouted")
      summary = `Model changed: ${string("fromModel") || "unknown"} → ${string("toModel") || "unknown"} (${string("reason") || "unspecified"})`;
    if (method === "model/verification")
      summary = `Model verification: ${Array.isArray(details.verifications) ? details.verifications.join(", ") : "received"}`;
    if (method.startsWith("modelProvider/authRecovery"))
      summary = `${method.endsWith("Started") ? "Recovering authentication" : "Authentication recovery completed"} (${string("provider") || "provider"}): ${string("message") || ""}`;
    const notice: CodexOperationalNotification = {
      id: `${this.epoch}:${++this.sequence}`,
      timestamp: Date.now(),
      method: method as CodexOperationalMethod,
      threadId,
      turnId: string("turnId"),
      itemId: string("itemId"),
      summary,
      details,
    };
    if (["warning", "configWarning", "deprecationNotice"].includes(method)) {
      this.warnings.push(notice);
      this.warnings = this.warnings.slice(-256);
    }
    // Progress messages replace only earlier progress for the same tool call.
    if (method === "item/mcpToolCall/progress")
      this.notices = this.notices.filter(
        (old) =>
          !(
            old.method === method &&
            old.threadId === threadId &&
            old.turnId === notice.turnId &&
            old.itemId === notice.itemId
          ),
      );
    this.notices.push(notice);
    this.notices = this.notices.slice(-256);
    return notice;
  }
  list(threadId?: string | null): CodexOperationalNotification[] {
    return this.notices.filter(
      (notice) => !notice.threadId || notice.threadId === threadId,
    );
  }
  listWarnings(threadId?: string | null): CodexOperationalNotification[] {
    return this.warnings.filter(
      (notice) => !notice.threadId || notice.threadId === threadId,
    );
  }
  clear(): void {
    this.notices = [];
    this.warnings = [];
  }
}
