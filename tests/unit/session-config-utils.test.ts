import assert from "node:assert/strict";
import test from "node:test";
import type {
  CodexCollaborationModeOption,
  CodexConfigDefaultsResponse,
  CodexModelOption,
} from "@codex-deck/api";
import {
  buildCollaborationModeInput,
  getCollaborationModeRequestValue,
  getEffectiveModelId,
  getEffectiveReasoningEffort,
  getEffortControlLabel,
  getModelControlLabel,
  getModelDisplayName,
} from "../../web/session-config-utils";

const MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "",
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high", "xhigh"],
  },
  {
    id: "gpt-4",
    displayName: "GPT-4",
    description: "",
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium"],
  },
];

const DEFAULTS: CodexConfigDefaultsResponse = {
  model: "gpt-5.4",
  reasoningEffort: "xhigh",
  planModeReasoningEffort: "high",
};

test("session config utils prefer explicit selections over defaults", () => {
  const selectedModeOption: CodexCollaborationModeOption | null = {
    mode: "plan",
    name: "Plan",
    model: "gpt-4",
    reasoningEffort: "medium",
  };

  const effectiveModelId = getEffectiveModelId({
    selectedModelId: "gpt-5.4",
    selectedModeOption,
    configDefaults: DEFAULTS,
    models: MODELS,
  });
  const effectiveEffort = getEffectiveReasoningEffort({
    selectedEffort: "minimal",
    selectedModeKey: "plan",
    selectedModeOption,
    configDefaults: DEFAULTS,
    models: MODELS,
    effectiveModelId,
  });

  assert.equal(effectiveModelId, "gpt-5.4");
  assert.equal(effectiveEffort, "minimal");
});

test("session config utils fall back to collaboration mode and config defaults", () => {
  const modeModel = getEffectiveModelId({
    selectedModelId: "",
    selectedModeOption: {
      mode: "review",
      name: "Review",
      model: "gpt-4",
      reasoningEffort: "low",
    },
    configDefaults: DEFAULTS,
    models: MODELS,
  });
  const defaultModel = getEffectiveModelId({
    selectedModelId: "",
    selectedModeOption: null,
    configDefaults: DEFAULTS,
    models: MODELS,
  });
  const defaultEffort = getEffectiveReasoningEffort({
    selectedEffort: "",
    selectedModeKey: "default",
    selectedModeOption: null,
    configDefaults: DEFAULTS,
    models: MODELS,
    effectiveModelId: defaultModel,
  });
  const planEffort = getEffectiveReasoningEffort({
    selectedEffort: "",
    selectedModeKey: "plan",
    selectedModeOption: null,
    configDefaults: DEFAULTS,
    models: MODELS,
    effectiveModelId: defaultModel,
  });

  assert.equal(modeModel, "gpt-4");
  assert.equal(defaultModel, "gpt-5.4");
  assert.equal(defaultEffort, "xhigh");
  assert.equal(planEffort, "high");
});

test("session config utils fall back to model defaults when config lacks effort", () => {
  const configDefaults: CodexConfigDefaultsResponse = {
    model: null,
    reasoningEffort: null,
    planModeReasoningEffort: null,
  };
  const effectiveModelId = getEffectiveModelId({
    selectedModelId: "gpt-4",
    selectedModeOption: null,
    configDefaults,
    models: MODELS,
  });
  const effectiveEffort = getEffectiveReasoningEffort({
    selectedEffort: "",
    selectedModeKey: "default",
    selectedModeOption: null,
    configDefaults,
    models: MODELS,
    effectiveModelId,
  });

  assert.equal(effectiveEffort, "medium");
});

test("session config utils format labels from effective values", () => {
  assert.equal(getModelDisplayName(MODELS, "gpt-5.4"), "GPT-5.4");
  assert.equal(getModelControlLabel(MODELS, "gpt-4"), "GPT-4(Default)");
  assert.equal(getEffortControlLabel("high"), "high(Default)");
  assert.equal(getModelControlLabel(MODELS, null), "Default");
  assert.equal(getEffortControlLabel(null), "Default");
});

test("buildCollaborationModeInput includes effective plan settings", () => {
  assert.deepEqual(
    buildCollaborationModeInput({
      selectedModeKey: "plan",
      selectedModeOption: {
        mode: "plan",
        name: "Plan",
        model: null,
        reasoningEffort: "medium",
        developerInstructions: null,
      },
      effectiveModelId: "gpt-5.4",
      effectiveReasoningEffort: "medium",
    }),
    {
      mode: "plan",
      settings: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
    },
  );
});

test("buildCollaborationModeInput returns null for missing model", () => {
  assert.equal(
    buildCollaborationModeInput({
      selectedModeKey: "plan",
      selectedModeOption: null,
      effectiveModelId: null,
      effectiveReasoningEffort: "high",
    }),
    null,
  );
  assert.equal(
    buildCollaborationModeInput({
      selectedModeKey: "plan",
      selectedModeOption: {
        mode: "plan",
        name: "Plan",
        model: null,
        reasoningEffort: "medium",
      },
      effectiveModelId: null,
      effectiveReasoningEffort: "medium",
    }),
    null,
  );
});

test("getCollaborationModeRequestValue returns null for default mode when presets are unavailable", () => {
  assert.equal(
    getCollaborationModeRequestValue({
      selectedModeKey: "default",
      selectedModeOption: null,
      effectiveModelId: "gpt-5.4",
      effectiveReasoningEffort: "high",
    }),
    null,
  );
});

test("getCollaborationModeRequestValue returns non-default mode payload", () => {
  assert.deepEqual(
    getCollaborationModeRequestValue({
      selectedModeKey: "plan",
      selectedModeOption: {
        mode: "plan",
        name: "Plan",
        model: null,
        reasoningEffort: "medium",
      },
      effectiveModelId: "gpt-5.4",
      effectiveReasoningEffort: "medium",
    }),
    {
      mode: "plan",
      settings: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
    },
  );
});

test("getCollaborationModeRequestValue returns default mode payload when preset exists", () => {
  assert.deepEqual(
    getCollaborationModeRequestValue({
      selectedModeKey: "default",
      selectedModeOption: {
        mode: "default",
        name: "Default",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      effectiveModelId: "gpt-5.4",
      effectiveReasoningEffort: "high",
    }),
    {
      mode: "default",
      settings: {
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
    },
  );
});
