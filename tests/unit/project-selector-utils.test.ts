import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectSelectorOptions,
  filterProjectSelectorOptions,
} from "../../web/project-selector-utils";

test("project selector options include all projects and project paths", () => {
  const options = buildProjectSelectorOptions([
    "/repo/project-a",
    "/repo/project-b",
  ]);

  assert.deepEqual(
    options.map((option) => ({
      project: option.project,
      label: option.label,
      description: option.description,
    })),
    [
      {
        project: null,
        label: "All Projects",
        description: null,
      },
      {
        project: "/repo/project-a",
        label: "project-a",
        description: "/repo/project-a",
      },
      {
        project: "/repo/project-b",
        label: "project-b",
        description: "/repo/project-b",
      },
    ],
  );
});

test("project selector filtering matches basename and path segments", () => {
  const options = buildProjectSelectorOptions([
    "/Users/test-user/Programming/Web/Project/codex-deck",
    "/Users/test-user/Programming/Web/Project/other-app",
  ]);

  assert.deepEqual(
    filterProjectSelectorOptions(options, "codex").map(
      (option) => option.project,
    ),
    ["/Users/test-user/Programming/Web/Project/codex-deck"],
  );

  assert.deepEqual(
    filterProjectSelectorOptions(options, "users web").map(
      (option) => option.project,
    ),
    [
      "/Users/test-user/Programming/Web/Project/codex-deck",
      "/Users/test-user/Programming/Web/Project/other-app",
    ],
  );

  assert.deepEqual(
    filterProjectSelectorOptions(options, "other-app").map(
      (option) => option.project,
    ),
    ["/Users/test-user/Programming/Web/Project/other-app"],
  );
});
