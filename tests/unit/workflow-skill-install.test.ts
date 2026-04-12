import assert from "node:assert/strict";
import test from "node:test";
import type { CodexSkillMetadata } from "@codex-deck/api";
import {
  buildWorkflowSkillInstallMessagePrefix,
  getWorkflowSkillAvailability,
} from "../../web/workflow-skill-install";

function createSkill(
  overrides: Partial<CodexSkillMetadata>,
): CodexSkillMetadata {
  return {
    name: "codex-deck-flow",
    description: "Workflow orchestration",
    shortDescription: null,
    interface: null,
    dependencies: null,
    path: "/repo/.claude/skills/codex-deck-flow/SKILL.md",
    scope: "repo",
    enabled: true,
    ...overrides,
  };
}

test("workflow skill availability detects a project-local codex-deck-flow skill", () => {
  const availability = getWorkflowSkillAvailability([createSkill({})], "/repo");

  assert.deepEqual(availability, {
    hasProjectLocalInstall: true,
    hasGlobalInstall: false,
    isInstalled: true,
  });
});

test("workflow skill availability detects a global codex-deck-flow skill", () => {
  const availability = getWorkflowSkillAvailability(
    [
      createSkill({
        path: "/home/example/.codex/skills/codex-deck-flow/SKILL.md",
        scope: "user",
      }),
    ],
    "/repo",
  );

  assert.deepEqual(availability, {
    hasProjectLocalInstall: false,
    hasGlobalInstall: true,
    isInstalled: true,
  });
});

test("workflow skill availability ignores unrelated skills", () => {
  const availability = getWorkflowSkillAvailability(
    [
      createSkill({
        name: "openai-docs",
        path: "/repo/.claude/skills/openai-docs/SKILL.md",
      }),
    ],
    "/repo",
  );

  assert.deepEqual(availability, {
    hasProjectLocalInstall: false,
    hasGlobalInstall: false,
    isInstalled: false,
  });
});

test("workflow skill availability falls back to path checks for unknown scope", () => {
  const availability = getWorkflowSkillAvailability(
    [
      createSkill({
        path: "C:\\repo\\.claude\\skills\\codex-deck-flow\\SKILL.md",
        scope: "unknown",
      }),
      createSkill({
        path: "C:\\Users\\example\\.codex\\skills\\codex-deck-flow\\SKILL.md",
        scope: "unknown",
      }),
    ],
    "C:\\repo",
  );

  assert.deepEqual(availability, {
    hasProjectLocalInstall: true,
    hasGlobalInstall: true,
    isInstalled: true,
  });
});

test("workflow skill installer prefixes match the requested install location", () => {
  assert.equal(
    buildWorkflowSkillInstallMessagePrefix("local"),
    "$skill-installer install the codex-deck-flow skill from GitHub repo asfsdsf/codex-deck, branch main, path skills/codex-deck-flow, into the appropriate project-local skills destination that you infer automatically from the local context. Do not install globally. Then do following: ",
  );
  assert.equal(
    buildWorkflowSkillInstallMessagePrefix("global"),
    "$skill-installer install the codex-deck-flow skill globally from GitHub repo asfsdsf/codex-deck, branch main, path skills/codex-deck-flow, using the default global Codex skills directory. Then do following: ",
  );
});
