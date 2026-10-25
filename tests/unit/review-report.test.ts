import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewReport, reviewLocationHref } from "../../web/review-report";
import { resolveProjectFileLinkTargetFromHref } from "../../web/path-utils";
import {
  reviewReportFixture,
  reviewUserActionFixture,
  wrapReviewResults,
} from "../fixtures/review-report";

test("native user_action reviews retain every finding in both multiline and flattened output", () => {
  for (const text of [
    reviewUserActionFixture,
    reviewUserActionFixture.replace(/\s+/g, " "),
  ]) {
    const parsed = parseReviewReport(text);
    assert.ok(parsed);
    assert.equal(parsed.format, "user-action");
    assert.equal(parsed.summary, reviewReportFixture.overall_explanation);
    assert.equal(parsed.findings.length, 4);
    for (const [index, finding] of parsed.findings.entries()) {
      const original = reviewReportFixture.findings[index];
      assert.equal(finding.title, original.title.replace(/^\[P2\] /, ""));
      assert.equal(finding.body, original.body);
      assert.equal(finding.priority, 2);
      assert.deepEqual(finding.location, {
        path: original.code_location.absolute_file_path,
        startLine: original.code_location.line_range.start,
        endLine: original.code_location.line_range.end,
      });
    }
  }
});

test("structured and fenced final reviews share the same findings and verdict", () => {
  const json = JSON.stringify(reviewReportFixture, null, 2);
  for (const text of [
    json,
    `\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    wrapReviewResults(json),
  ]) {
    const parsed = parseReviewReport(text);
    assert.ok(parsed);
    assert.equal(parsed.verdict, "incorrect");
    assert.equal(parsed.confidence, 0.99);
    assert.equal(parsed.summary, reviewReportFixture.overall_explanation);
    assert.equal(parsed.findings.length, 4);
    assert.equal(parsed.findings[1].body, reviewReportFixture.findings[1].body);
  }
});

test("reviews without findings show the supplied outcome without inventing findings", () => {
  const parsed = parseReviewReport(
    JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No actionable issues found.",
    }),
  );
  assert.equal(parsed?.verdict, "correct");
  assert.deepEqual(parsed?.findings, []);
  const unstructured = parseReviewReport(
    wrapReviewResults(
      "A narrative review with **suggestions** and no structured locations.",
    ),
  );
  assert.equal(
    unstructured?.summary,
    "A narrative review with **suggestions** and no structured locations.",
  );
  assert.equal(unstructured?.verdict, null);
});

test("wrapped findings preserve Markdown paragraphs, list items, and Windows paths with spaces", () => {
  const parsed = parseReviewReport(
    wrapReviewResults(
      `Summary.\n\nFull review comments:\n\n- [P1] Check the path — C:\\Project space\\main.ts:9-12\n  First **paragraph**.\n\n  - Keep this nested list.\n  - And this item.\n\n  Final paragraph.\n\n- [P3] Document the option — /repo/docs.md:3\n  Another body.`,
    ),
  );
  assert.ok(parsed);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].priority, 1);
  assert.equal(
    parsed.findings[0].body,
    "First **paragraph**.\n\n- Keep this nested list.\n- And this item.\n\nFinal paragraph.",
  );
  assert.deepEqual(parsed.findings[0].location, {
    path: "C:\\Project space\\main.ts",
    startLine: 9,
    endLine: 12,
  });
  assert.equal(parsed.findings[1].priority, 3);
});

test("ordinary JSON, quoted review examples, and incomplete or malformed reviews are left alone", () => {
  for (const text of [
    "Normal **Markdown**.",
    '{"name":"test","value":1}',
    '{"findings":[]}',
    '{"findings":["a string"]}',
    '{"findings":[{"title":"Missing body"}]}',
    JSON.stringify(reviewReportFixture).slice(0, -1),
    reviewUserActionFixture.replace("</user_action>", ""),
    reviewUserActionFixture.replace(
      "<action>review</action>",
      "<action>other</action>",
    ),
    `Example of a review:\n${reviewUserActionFixture}`,
  ])
    assert.equal(parseReviewReport(text), null, text.slice(0, 80));
});

test("invalid optional metadata is not displayed as a location or confidence", () => {
  const parsed = parseReviewReport(
    JSON.stringify({
      findings: [
        {
          title: "[P0] Fix the issue",
          body: "Details",
          priority: 12,
          confidence_score: 99,
          code_location: {
            absolute_file_path: "/repo/a.ts",
            line_range: { start: -1, end: 2 },
          },
        },
      ],
      overall_confidence_score: -1,
    }),
  );
  assert.equal(parsed?.findings[0].priority, 0);
  assert.equal(parsed?.findings[0].confidence, null);
  assert.equal(parsed?.findings[0].location, null);
  assert.equal(parsed?.confidence, null);
});

test("finding links resolve safely through the existing file viewer", () => {
  for (const [path, project, expectedPath] of [
    ["/repo/space dir/a#b.ts", "/repo", "space dir/a#b.ts"],
    ["C:\\Project space\\main.ts", "C:/Project space", "main.ts"],
  ]) {
    const href = reviewLocationHref({ path, startLine: 7, endLine: 10 });
    assert.deepEqual(resolveProjectFileLinkTargetFromHref(href, project), {
      path: expectedPath,
      line: 7,
      column: null,
    });
  }
  assert.equal(
    new URL(
      reviewLocationHref({
        path: "javascript:alert(1)",
        startLine: 1,
        endLine: 1,
      }),
      "https://deck.example",
    ).protocol,
    "https:",
  );
});
