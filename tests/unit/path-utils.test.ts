import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  getPathBaseName as getApiPathBaseName,
  isPathWithinDirectory,
  splitPathSegments as splitApiPathSegments,
} from "../../api/path-utils";
import {
  getPathBaseName as getWebPathBaseName,
  getPathExtension,
  getPathTail,
  isMarkdownPath,
  parseFileReference,
  resolveProjectFileLinkTargetFromHref,
  resolveProjectRelativePathFromHref,
  splitPathSegments as splitWebPathSegments,
  stripFileReferenceSuffix,
} from "../../web/path-utils";

test("splitPathSegments supports unix and windows separators", () => {
  assert.deepEqual(splitApiPathSegments("/Users/test-user/project/src"), [
    "Users",
    "test-user",
    "project",
    "src",
  ]);
  assert.deepEqual(splitApiPathSegments("C:\\Users\\test-user\\project\\src"), [
    "C:",
    "Users",
    "test-user",
    "project",
    "src",
  ]);

  assert.deepEqual(splitWebPathSegments("/Users/test-user/project/src"), [
    "Users",
    "test-user",
    "project",
    "src",
  ]);
  assert.deepEqual(splitWebPathSegments("C:\\Users\\test-user\\project\\src"), [
    "C:",
    "Users",
    "test-user",
    "project",
    "src",
  ]);
});

test("path basename and tail preview are cross-platform", () => {
  assert.equal(getApiPathBaseName("/repo/web/app.tsx"), "app.tsx");
  assert.equal(getApiPathBaseName("C:\\repo\\web\\app.tsx"), "app.tsx");

  assert.equal(getWebPathBaseName("/repo/web/app.tsx"), "app.tsx");
  assert.equal(getWebPathBaseName("C:\\repo\\web\\app.tsx"), "app.tsx");

  assert.equal(getPathTail("/repo/web/app.tsx"), "web/app.tsx");
  assert.equal(getPathTail("C:\\repo\\web\\app.tsx"), "web/app.tsx");
  assert.equal(getPathTail("/repo/web/app.tsx", 3), "repo/web/app.tsx");
});

test("isPathWithinDirectory detects nested and outside paths", () => {
  const root = join(process.cwd(), ".tmp-path-utils");
  const sessionsDir = join(root, "sessions");
  const nestedSessionFile = join(sessionsDir, "project", "session.jsonl");
  const outsideFile = join(root, "other", "session.jsonl");

  assert.equal(isPathWithinDirectory(nestedSessionFile, sessionsDir), true);
  assert.equal(isPathWithinDirectory(outsideFile, sessionsDir), false);
  assert.equal(isPathWithinDirectory(sessionsDir, sessionsDir), true);
});

test("stripFileReferenceSuffix removes markdown file line suffixes", () => {
  assert.equal(
    stripFileReferenceSuffix("/repo/src/app.tsx:42:3"),
    "/repo/src/app.tsx",
  );
  assert.equal(
    stripFileReferenceSuffix("/repo/src/app.tsx#L42C3"),
    "/repo/src/app.tsx",
  );
  assert.equal(
    stripFileReferenceSuffix("/repo/src/app.tsx"),
    "/repo/src/app.tsx",
  );
});

test("getPathExtension and isMarkdownPath support markdown variants", () => {
  assert.equal(getPathExtension("/repo/README.md"), "md");
  assert.equal(getPathExtension("/repo/docs/guide.markdown"), "markdown");
  assert.equal(getPathExtension("/repo/docs/guide.mdx#L32"), "mdx");
  assert.equal(getPathExtension("/repo/src/index.ts:10"), "ts");
  assert.equal(getPathExtension("/repo/.gitignore"), "");

  assert.equal(isMarkdownPath("/repo/README.md"), true);
  assert.equal(isMarkdownPath("/repo/docs/guide.mdx"), true);
  assert.equal(isMarkdownPath("/repo/docs/guide.markdown"), true);
  assert.equal(isMarkdownPath("/repo/src/index.ts"), false);
});

test("resolveProjectRelativePathFromHref handles absolute and relative file links", () => {
  assert.equal(
    resolveProjectRelativePathFromHref(
      "/repo/project/src/app.tsx:10",
      "/repo/project",
    ),
    "src/app.tsx",
  );
  assert.equal(
    resolveProjectRelativePathFromHref(
      "C:\\repo\\project\\src\\app.tsx#L10",
      "C:\\repo\\project",
    ),
    "src/app.tsx",
  );
  assert.equal(
    resolveProjectRelativePathFromHref("src/app.tsx", "/repo/project"),
    "src/app.tsx",
  );
  assert.equal(
    resolveProjectRelativePathFromHref("https://example.com", "/repo/project"),
    null,
  );
  assert.equal(
    resolveProjectRelativePathFromHref("/other/path/file.ts", "/repo/project"),
    null,
  );
});

test("parseFileReference parses markdown and colon line references", () => {
  assert.deepEqual(parseFileReference("/repo/src/app.tsx#L42C3"), {
    path: "/repo/src/app.tsx",
    line: 42,
    column: 3,
  });
  assert.deepEqual(parseFileReference("/repo/src/app.tsx:42:3"), {
    path: "/repo/src/app.tsx",
    line: 42,
    column: 3,
  });
  assert.deepEqual(parseFileReference("/repo/src/app.tsx:42"), {
    path: "/repo/src/app.tsx",
    line: 42,
    column: null,
  });
  assert.deepEqual(parseFileReference("/repo/src/app.tsx"), {
    path: "/repo/src/app.tsx",
    line: null,
    column: null,
  });
});

test("resolveProjectFileLinkTargetFromHref returns path and line info", () => {
  assert.deepEqual(
    resolveProjectFileLinkTargetFromHref(
      "/repo/project/src/app.tsx:88",
      "/repo/project",
    ),
    {
      path: "src/app.tsx",
      line: 88,
      column: null,
    },
  );
  assert.deepEqual(
    resolveProjectFileLinkTargetFromHref(
      "/repo/project/src/app.tsx#L88C4",
      "/repo/project",
    ),
    {
      path: "src/app.tsx",
      line: 88,
      column: 4,
    },
  );
  assert.equal(
    resolveProjectFileLinkTargetFromHref(
      "/other/path/file.ts:88",
      "/repo/project",
    ),
    null,
  );
});
