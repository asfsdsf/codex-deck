import { useCallback, useState } from "react";
import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexPermissionOption,
  CodexPermissionSelection,
} from "@codex-deck/api";
import { getCodexPermissions, setCodexPermissions } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import {
  describeApprovalPolicy,
  describeReviewer,
  describeSandbox,
} from "../permission-args";

const FULL_ACCESS_WARNING =
  "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval.";
const FULL_ACCESS_CAUTION =
  "Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
      <span className="text-zinc-500">{label}</span>
      <span className="min-w-0 break-all text-right">{value}</span>
    </div>
  );
}

export default function PermissionsPanel({
  threadId,
  onApplied,
}: {
  threadId: string;
  onApplied?: (message: string) => void;
}) {
  const load = useCallback(() => getCodexPermissions(threadId), [threadId]);
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "permissions",
    threadId,
    load,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<CodexPermissionOption | null>(
    null,
  );
  const [advancedProfile, setAdvancedProfile] = useState("");
  const [advancedApproval, setAdvancedApproval] = useState("");
  const [advancedReviewer, setAdvancedReviewer] = useState("");

  const apply = async (selection: CodexPermissionSelection, label: string) => {
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      setData(await setCodexPermissions(threadId, selection));
      const notice = `Permission selection requested: ${label}`;
      setMessage(notice);
      onApplied?.(notice);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      refresh();
    } finally {
      setSaving(false);
      setConfirming(null);
    }
  };
  const choose = (option: CodexPermissionOption) => {
    if (option.disabledReason || saving) return;
    if (option.requiresConfirmation) {
      setConfirming(option);
      return;
    }
    void apply(
      {
        profileId: option.profileId,
        approvalPolicy: option.approvalPolicy,
        approvalsReviewer: option.approvalsReviewer,
      },
      option.label,
    );
  };

  const settings = data?.settings;
  const profileIds = data?.profiles.map((profile) => profile.id) ?? [];
  const selectedProfile =
    advancedProfile || settings?.activePermissionProfile?.id || "";

  return (
    <div className="space-y-4 text-sm">
      <p className="text-zinc-400">
        Choose what Codex is allowed to do. Changes apply to subsequent turns of
        this conversation and are shared with every connected client.
      </p>
      {loading && !data && <p role="status">Loading permission profiles…</p>}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="break-words text-red-400">
            {error}
          </p>
          <button
            type="button"
            onClick={refresh}
            className="min-h-9 rounded border border-zinc-700 px-3 py-1"
          >
            Retry
          </button>
        </div>
      )}
      {settings && (
        <section className="space-y-1.5 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-xs text-zinc-300">
          <h3 className="mb-1 text-sm font-semibold text-zinc-100">
            Current permissions
          </h3>
          <Row
            label="Permission profile"
            value={settings.activePermissionProfile?.id ?? "Unknown"}
          />
          <Row
            label="Approval policy"
            value={describeApprovalPolicy(settings.approvalPolicy)}
          />
          <Row
            label="Approvals reviewer"
            value={describeReviewer(settings.approvalsReviewer)}
          />
          <Row
            label="Sandbox"
            value={describeSandbox(settings.sandboxPolicy)}
          />
          {settings.cwd && <Row label="Workspace" value={settings.cwd} />}
        </section>
      )}
      {confirming ? (
        <section
          role="alertdialog"
          aria-label="Enable full access?"
          className="space-y-3 rounded-lg border border-red-500/50 bg-red-950/30 p-3"
        >
          <h3 className="font-semibold text-zinc-100">Enable full access?</h3>
          <p className="text-zinc-300">
            {FULL_ACCESS_WARNING}{" "}
            <span className="text-red-300">{FULL_ACCESS_CAUTION}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void apply(
                  {
                    profileId: confirming.profileId,
                    approvalPolicy: confirming.approvalPolicy,
                    approvalsReviewer: confirming.approvalsReviewer,
                  },
                  confirming.label,
                )
              }
              className="min-h-9 rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
              title="Apply full access for this session"
            >
              Yes, continue anyway
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirming(null)}
              className="min-h-9 rounded border border-zinc-700 px-3 py-1"
              title="Go back without enabling full access"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : (
        data && (
          <section className="space-y-2">
            <h3 className="font-semibold text-zinc-100">
              Update Model Permissions
            </h3>
            {data.subtitle && <p className="text-zinc-400">{data.subtitle}</p>}
            {data.options.map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={saving || !!option.disabledReason}
                aria-pressed={option.isCurrent}
                onClick={() => choose(option)}
                className={`block w-full rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
                  option.isCurrent
                    ? "border-cyan-500/70 bg-cyan-950/30"
                    : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-500"
                }`}
              >
                <span className="flex flex-wrap items-center gap-2 font-semibold text-zinc-100">
                  <span className="break-all">{option.label}</span>
                  {option.isCurrent && (
                    <span className="rounded bg-cyan-900/60 px-1.5 py-0.5 text-[11px] font-medium text-cyan-200">
                      Current
                    </span>
                  )}
                </span>
                <span className="mt-1 block break-words text-xs text-zinc-400">
                  {option.description}
                </span>
                {option.disabledReason && (
                  <span className="mt-1 block text-xs text-amber-300">
                    {option.disabledReason}
                  </span>
                )}
              </button>
            ))}
          </section>
        )
      )}
      {data && data.profiles.length > 0 && !confirming && (
        <details className="rounded-lg border border-zinc-700 p-3">
          <summary className="cursor-pointer font-semibold text-zinc-100">
            Advanced
          </summary>
          <p className="mt-2 text-xs text-zinc-400">
            Combine a profile with an explicit approval policy or reviewer, like
            <code className="mx-1 break-all">
              /permissions &lt;profile-id&gt; --approval-policy=… --reviewer=…
            </code>
            . The profile determines the sandbox.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-zinc-400">
              Profile
              <select
                value={selectedProfile}
                onChange={(event) => setAdvancedProfile(event.target.value)}
                className="min-h-9 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
              >
                {!profileIds.includes(selectedProfile) && (
                  <option value="">Select a profile</option>
                )}
                {profileIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-zinc-400">
              Approval policy
              <select
                value={advancedApproval}
                onChange={(event) => setAdvancedApproval(event.target.value)}
                className="min-h-9 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
              >
                <option value="">Profile default</option>
                <option value="untrusted">untrusted</option>
                <option value="on-request">on-request</option>
                <option value="never">never</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-zinc-400">
              Reviewer
              <select
                value={advancedReviewer}
                onChange={(event) => setAdvancedReviewer(event.target.value)}
                className="min-h-9 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
              >
                <option value="">Profile default</option>
                <option value="user">You (user)</option>
                {data.autoReviewAvailable && (
                  <option value="auto_review">Auto-review</option>
                )}
              </select>
            </label>
          </div>
          <button
            type="button"
            disabled={saving || !profileIds.includes(selectedProfile)}
            onClick={() => {
              const selection: CodexPermissionSelection = {
                profileId: selectedProfile,
                approvalPolicy:
                  (advancedApproval as CodexApprovalPolicy) || null,
                approvalsReviewer:
                  (advancedReviewer as CodexApprovalsReviewer) || null,
              };
              if (
                selectedProfile === ":danger-full-access" &&
                !window.confirm(`${FULL_ACCESS_WARNING} ${FULL_ACCESS_CAUTION}`)
              )
                return;
              void apply(selection, selectedProfile);
            }}
            className="mt-3 min-h-9 rounded bg-cyan-600 px-3 py-1 text-white disabled:opacity-50"
          >
            {saving ? "Applying…" : "Apply"}
          </button>
        </details>
      )}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}
