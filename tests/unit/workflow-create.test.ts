import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmptyWorkflowCreateRequest,
  isValidWorkflowIdForPrompt,
} from "../../web/workflow-create";

test("isValidWorkflowIdForPrompt accepts letters, numbers, hyphens, and underscores", () => {
  assert.equal(isValidWorkflowIdForPrompt("feature-1"), true);
  assert.equal(isValidWorkflowIdForPrompt("flow_2"), true);
  assert.equal(isValidWorkflowIdForPrompt("A1_b-c"), true);
});

test("isValidWorkflowIdForPrompt rejects spaces and special characters", () => {
  assert.equal(isValidWorkflowIdForPrompt(""), false);
  assert.equal(isValidWorkflowIdForPrompt("   "), false);
  assert.equal(isValidWorkflowIdForPrompt("flow id"), false);
  assert.equal(isValidWorkflowIdForPrompt("flow.id"), false);
  assert.equal(isValidWorkflowIdForPrompt("flow@id"), false);
});

test("buildEmptyWorkflowCreateRequest uses ID defaults and empty tasks JSON", () => {
  assert.deepEqual(buildEmptyWorkflowCreateRequest("workflow-id", "/repo"), {
    title: "workflow-id",
    request: "Empty workflow scaffold",
    projectRoot: "/repo",
    workflowId: "workflow-id",
    tasksJson: "[]",
  });
});
