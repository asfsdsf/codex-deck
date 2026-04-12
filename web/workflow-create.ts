import type { CreateWorkflowRequest } from "@codex-deck/api";

const WORKFLOW_ID_PROMPT_REGEX = /^[A-Za-z0-9_-]+$/;

export function isValidWorkflowIdForPrompt(value: string): boolean {
  const workflowId = value.trim();
  return workflowId.length > 0 && WORKFLOW_ID_PROMPT_REGEX.test(workflowId);
}

export function buildEmptyWorkflowCreateRequest(
  workflowId: string,
  projectRoot: string,
): CreateWorkflowRequest {
  const normalizedId = workflowId.trim();
  return {
    title: normalizedId,
    request: "Empty workflow scaffold",
    projectRoot: projectRoot.trim(),
    workflowId: normalizedId,
    tasksJson: "[]",
  };
}
