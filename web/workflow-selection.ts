import type { WorkflowDetailResponse, WorkflowSummary } from "@codex-deck/api";

interface ResolveWorkflowSelectionInput {
  workflows: WorkflowSummary[];
  selectedWorkflowKey: string | null;
  pendingWorkflowKey?: string | null;
  workflowDetail: WorkflowDetailResponse | null;
  actionBusy: boolean;
}

interface ResolveWorkflowSelectionResult {
  nextSelectedWorkflowKey: string | null;
  shouldClearWorkflowDetail: boolean;
}

function workflowDetailMatchesSelection(
  selectedWorkflowKey: string | null,
  workflowDetail: WorkflowDetailResponse | null,
): boolean {
  return (
    typeof selectedWorkflowKey === "string" &&
    workflowDetail?.summary.key === selectedWorkflowKey
  );
}

function compareWorkflowSummaryFreshness(
  left: WorkflowSummary,
  right: WorkflowSummary,
): number {
  const leftUpdatedAt = Date.parse(left.updatedAt || "") || 0;
  const rightUpdatedAt = Date.parse(right.updatedAt || "") || 0;
  return leftUpdatedAt - rightUpdatedAt;
}

function mergeWorkflowSummaries(
  primary: WorkflowSummary,
  fallback: WorkflowSummary,
): WorkflowSummary {
  return {
    ...fallback,
    ...primary,
    targetBranch: primary.targetBranch ?? fallback.targetBranch,
    updatedAt: primary.updatedAt ?? fallback.updatedAt,
    createdAt: primary.createdAt ?? fallback.createdAt,
    request: primary.request ?? fallback.request,
    boundSessionId: primary.boundSessionId ?? fallback.boundSessionId,
    schedulerLastSessionId:
      primary.schedulerLastSessionId ?? fallback.schedulerLastSessionId,
    schedulerThreadId: primary.schedulerThreadId ?? fallback.schedulerThreadId,
    schedulerLastReason:
      primary.schedulerLastReason ?? fallback.schedulerLastReason,
    schedulerLastRunAt:
      primary.schedulerLastRunAt ?? fallback.schedulerLastRunAt,
    schedulerLastTurnStatus:
      primary.schedulerLastTurnStatus ?? fallback.schedulerLastTurnStatus,
    maxParallel: primary.maxParallel ?? fallback.maxParallel,
    mergePolicy: primary.mergePolicy ?? fallback.mergePolicy,
  };
}

export function resolveWorkflowSelection(
  input: ResolveWorkflowSelectionInput,
): ResolveWorkflowSelectionResult {
  const {
    workflows,
    selectedWorkflowKey,
    pendingWorkflowKey,
    workflowDetail,
    actionBusy,
  } = input;

  if (
    selectedWorkflowKey &&
    pendingWorkflowKey === selectedWorkflowKey &&
    !workflows.some((workflow) => workflow.key === selectedWorkflowKey)
  ) {
    return {
      nextSelectedWorkflowKey: selectedWorkflowKey,
      shouldClearWorkflowDetail: false,
    };
  }

  if (
    actionBusy &&
    workflowDetailMatchesSelection(selectedWorkflowKey, workflowDetail) &&
    (!selectedWorkflowKey ||
      !workflows.some((workflow) => workflow.key === selectedWorkflowKey))
  ) {
    return {
      nextSelectedWorkflowKey: selectedWorkflowKey,
      shouldClearWorkflowDetail: false,
    };
  }

  if (workflows.length === 0) {
    return {
      nextSelectedWorkflowKey: null,
      shouldClearWorkflowDetail: true,
    };
  }

  if (
    selectedWorkflowKey &&
    workflows.some((workflow) => workflow.key === selectedWorkflowKey)
  ) {
    return {
      nextSelectedWorkflowKey: selectedWorkflowKey,
      shouldClearWorkflowDetail: false,
    };
  }

  return {
    nextSelectedWorkflowKey: workflows[0]?.key ?? null,
    shouldClearWorkflowDetail: false,
  };
}

export function resolveSelectedWorkflowSummary(
  workflows: WorkflowSummary[],
  selectedWorkflowKey: string | null,
  workflowDetail: WorkflowDetailResponse | null,
): WorkflowSummary | null {
  if (!selectedWorkflowKey) {
    return null;
  }

  const detailSummary = workflowDetailMatchesSelection(
    selectedWorkflowKey,
    workflowDetail,
  )
    ? workflowDetail.summary
    : null;
  const listSummary =
    workflows.find((workflow) => workflow.key === selectedWorkflowKey) ?? null;

  if (!detailSummary) {
    return listSummary;
  }
  if (!listSummary) {
    return detailSummary;
  }

  const preferListSummary =
    compareWorkflowSummaryFreshness(listSummary, detailSummary) >= 0;
  return preferListSummary
    ? mergeWorkflowSummaries(listSummary, detailSummary)
    : mergeWorkflowSummaries(detailSummary, listSummary);
}
