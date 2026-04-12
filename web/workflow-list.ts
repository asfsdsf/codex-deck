import type { WorkflowSummary } from "@codex-deck/api";

function formatRelativeTimestampLabel(
  timestamp: number,
  nowMs: number = Date.now(),
): string {
  const diffMs = nowMs - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function workflowListSignature(
  workflow: WorkflowSummary,
  nowMs: number = Date.now(),
): string {
  const timestamp = Date.parse(workflow.updatedAt || "") || 0;
  return JSON.stringify([
    workflow.key,
    workflow.title,
    workflow.status,
    workflow.projectRoot,
    workflow.projectName,
    workflow.boundSessionId || null,
    workflow.schedulerLastSessionId || null,
    workflow.schedulerRunning,
    workflow.taskCounts.total,
    workflow.taskCounts.success,
    workflow.taskCounts.running,
    workflow.taskCounts.failed,
    formatRelativeTimestampLabel(timestamp, nowMs),
  ]);
}

export function areWorkflowCollectionsVisiblyEquivalent(
  current: WorkflowSummary[],
  next: WorkflowSummary[],
  nowMs: number = Date.now(),
): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    if (
      workflowListSignature(current[index]!, nowMs) !==
      workflowListSignature(next[index]!, nowMs)
    ) {
      return false;
    }
  }

  return true;
}
