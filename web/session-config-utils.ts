import type {
  CodexCollaborationModeInput,
  CodexCollaborationModeOption,
  CodexConfigDefaultsResponse,
  CodexModelOption,
  CodexReasoningEffort,
} from "@codex-deck/api";

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function findModel(
  models: CodexModelOption[],
  modelId: string | null | undefined,
): CodexModelOption | null {
  const normalizedModelId = normalizeOptionalString(modelId);
  if (!normalizedModelId) {
    return null;
  }

  return models.find((model) => model.id === normalizedModelId) ?? null;
}

export function getModelDisplayName(
  models: CodexModelOption[],
  modelId: string | null | undefined,
): string | null {
  const normalizedModelId = normalizeOptionalString(modelId);
  if (!normalizedModelId) {
    return null;
  }

  return (
    findModel(models, normalizedModelId)?.displayName?.trim() ||
    normalizedModelId
  );
}

export function getEffectiveModelId(input: {
  selectedModelId: string | null | undefined;
  selectedModeOption: CodexCollaborationModeOption | null;
  configDefaults: CodexConfigDefaultsResponse;
  models: CodexModelOption[];
}): string | null {
  return (
    normalizeOptionalString(input.selectedModelId) ||
    normalizeOptionalString(input.selectedModeOption?.model) ||
    normalizeOptionalString(input.configDefaults.model) ||
    input.models.find((model) => model.isDefault && !model.hidden)?.id ||
    null
  );
}

export function getEffectiveReasoningEffort(input: {
  selectedEffort: CodexReasoningEffort | "" | null | undefined;
  selectedModeKey: string;
  selectedModeOption: CodexCollaborationModeOption | null;
  configDefaults: CodexConfigDefaultsResponse;
  models: CodexModelOption[];
  effectiveModelId: string | null;
}): CodexReasoningEffort | null {
  return (
    input.selectedEffort ||
    input.selectedModeOption?.reasoningEffort ||
    (input.selectedModeKey === "plan"
      ? input.configDefaults.planModeReasoningEffort
      : null) ||
    input.configDefaults.reasoningEffort ||
    findModel(input.models, input.effectiveModelId)?.defaultReasoningEffort ||
    null
  );
}

export function buildCollaborationModeInput(input: {
  selectedModeKey: string | null | undefined;
  selectedModeOption: CodexCollaborationModeOption | null;
  effectiveModelId: string | null;
  effectiveReasoningEffort: CodexReasoningEffort | null;
}): CodexCollaborationModeInput | null {
  const mode = normalizeOptionalString(input.selectedModeKey);
  if (!mode) {
    return null;
  }

  const model = normalizeOptionalString(input.effectiveModelId);
  if (!model) {
    return null;
  }

  const developerInstructions = normalizeOptionalString(
    input.selectedModeOption?.developerInstructions,
  );

  return {
    mode,
    settings: {
      model,
      ...(input.effectiveReasoningEffort
        ? { reasoningEffort: input.effectiveReasoningEffort }
        : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    },
  };
}

export function getCollaborationModeRequestValue(input: {
  selectedModeKey: string | null | undefined;
  selectedModeOption: CodexCollaborationModeOption | null;
  effectiveModelId: string | null;
  effectiveReasoningEffort: CodexReasoningEffort | null;
}): CodexCollaborationModeInput | null {
  const mode = normalizeOptionalString(input.selectedModeKey);
  if (!mode) {
    return null;
  }

  if (mode === "default" && !input.selectedModeOption) {
    // Legacy/compat path: no collaboration presets available from backend.
    return null;
  }

  return buildCollaborationModeInput(input);
}

export function getModelControlLabel(
  models: CodexModelOption[],
  effectiveModelId: string | null,
): string {
  const displayName = getModelDisplayName(models, effectiveModelId);
  return displayName ? `${displayName}(Default)` : "Default";
}

export function getEffortControlLabel(
  effectiveEffort: CodexReasoningEffort | null,
): string {
  return effectiveEffort ? `${effectiveEffort}(Default)` : "Default";
}
