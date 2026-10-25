export const reviewReportFixture = {
  findings: [
    {
      title: "[P2] Reset the persisted tier when returning to Default speed",
      body: "With no `model_service_tier` configured, send once at `ultrafast` and then select “Default speed”: the empty selection omits `serviceTier`. However, `sendMessage()` persisted the previous tier through `thread/settings/update`, and upstream treats omission as preserving that tier. Subsequent turns therefore remain ultrafast while the UI shows Default. Explicitly apply the configured/catalog default instead; the workflow `serviceTierInput` helper has the same issue.",
      confidence_score: 0.99,
      priority: 2,
      code_location: {
        absolute_file_path:
          "/Users/example/codex-deck/web/app/codex-deck-app.tsx",
        line_range: { start: 9880, end: 9882 },
      },
    },
    {
      title: "[P2] Subscribe to shared threads before starting native review",
      body: "When a shared daemon already has the thread loaded for another client, `review/start` succeeds without triggering the resume fallback. Unlike `sendMessage()`, this path never subscribes Deck’s connection, so review lifecycle, progress, and hook notifications are not received or broadcast to browsers. Resume/subscribe before starting the review to preserve the fan-out invariant in [AGENTS.md:114](AGENTS.md#L114).",
      confidence_score: 0.99,
      priority: 2,
      code_location: {
        absolute_file_path: "/Users/example/codex-deck/api/codex-app-server.ts",
        line_range: { start: 2161, end: 2166 },
      },
    },
    {
      title: "[P2] Restrict thread runtime panels to session targets",
      body: "In workflow-project view, `codex-deck-app.tsx` sets `rightPaneSessionId` to the project filesystem path. Mounting `BackgroundTerminals` here sends that path to a thread-only RPC every five seconds, producing invalid-thread errors despite the existing workflow-unavailable state. Gate this panel on an actual session target, and likewise avoid passing the project path as `threadId` to `HooksPane`.",
      confidence_score: 0.99,
      priority: 2,
      code_location: {
        absolute_file_path:
          "/Users/example/codex-deck/web/components/diff-pane.tsx",
        line_range: { start: 1056, end: 1058 },
      },
    },
    {
      title: "[P2] Stop buffering runtime events after the snapshot settles",
      body: "For a tab left on a conversation receiving MCP progress, `updates` continues accumulating every payload after the initial GET resolves. The array is cleared only by that one promise callback, so later entries remain referenced indefinitely despite the displayed list being capped at 256. Buffer only while the snapshot is pending; `hook-execution-progress.tsx` contains the same unbounded-buffer pattern.",
      confidence_score: 0.99,
      priority: 2,
      code_location: {
        absolute_file_path:
          "/Users/example/codex-deck/web/components/operational-notices.tsx",
        line_range: { start: 49, end: 50 },
      },
    },
  ],
  overall_correctness: "patch is incorrect",
  overall_explanation:
    "The patch introduces service-tier reset, shared-daemon subscription, workflow routing, and browser memory-retention defects. The build passes; the unit suite recorded 754 passes and five failures from an unchanged KaTeX CSS import.",
  overall_confidence_score: 0.99,
};

export function wrapReviewResults(results: string): string {
  return `<user_action>
  <context>User initiated a review task. Here's the full review output from reviewer model. User may select one or more comments to resolve.</context>
  <action>review</action>
  <results>
${results}
  </results>
</user_action>`;
}

export const reviewUserActionFixture = wrapReviewResults(
  `${reviewReportFixture.overall_explanation}\n\nFull review comments:\n\n${reviewReportFixture.findings.map((finding) => `- ${finding.title} — ${finding.code_location.absolute_file_path}:${finding.code_location.line_range.start}-${finding.code_location.line_range.end}\n  ${finding.body}`).join("\n\n")}`,
);
