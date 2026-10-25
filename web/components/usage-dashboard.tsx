import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageWindow } from "@codex-deck/api";
import { consumeCodexResetCredit, getCodexUsageDashboard } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const number = (value: number | null | undefined) =>
  value == null ? "Unavailable" : value.toLocaleString();
const date = (value: number | null | undefined) =>
  value == null ? "Unavailable" : new Date(value * 1000).toLocaleString();
function Window({ title, value }: { title: string; value: UsageWindow }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2">
        <span>
          {title}
          {value.windowDurationMins ? ` (${value.windowDurationMins} min)` : ""}
        </span>
        <span>{number(value.usedPercent)}% used</span>
      </div>
      <progress
        aria-label={`${title} usage`}
        className="h-2 w-full accent-cyan-500"
        max={100}
        value={Math.min(100, Math.max(0, value.usedPercent))}
      />
      <p className="text-xs text-zinc-400">Resets: {date(value.resetsAt)}</p>
    </div>
  );
}
function Limit({ name, value }: { name: string; value: UsageLimit }) {
  return (
    <article className="space-y-3 rounded-lg border border-zinc-700 p-3">
      <h3 className="break-all font-semibold">{value.limitName || name}</h3>
      {value.primary && <Window title="Primary window" value={value.primary} />}
      {value.secondary && (
        <Window title="Secondary window" value={value.secondary} />
      )}
      {value.rateLimitReachedType && (
        <p className="break-words text-amber-300">
          Limit state: {value.rateLimitReachedType}
        </p>
      )}
      {value.credits && (
        <p>
          Credits:{" "}
          {value.credits.unlimited
            ? "Unlimited"
            : (value.credits.balance ??
              (value.credits.hasCredits ? "Available" : "None"))}
        </p>
      )}
    </article>
  );
}
export default function UsageDashboard({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(() => getCodexUsageDashboard(threadId), [threadId]);
  const { data, loading, error, refresh } = useNativeSnapshot(
    "usage",
    threadId,
    load,
  );
  const [creditId, setCreditId] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const attempt = useRef<{ id: string; key: string } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const redeem = async () => {
    if (busy) return;
    if (!attempt.current || attempt.current.id !== creditId)
      attempt.current = { id: creditId, key: crypto.randomUUID() };
    setBusy(true);
    setResult("");
    try {
      const response = await consumeCodexResetCredit(
        attempt.current.key,
        creditId || null,
      );
      const labels: Record<string, string> = {
        reset: "Usage limits reset.",
        alreadyRedeemed: "This reset was already redeemed.",
        nothingToReset: "No current usage window is eligible for a reset.",
        noCredit: "No reset credits are available.",
      };
      setResult(labels[response.outcome] || response.outcome);
      attempt.current = null;
      setConfirm(false);
      refresh();
    } catch (reason) {
      setResult(
        `Could not redeem reset: ${reason instanceof Error ? reason.message : String(reason)}. Retry uses the same attempt ID.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const credits = data?.rates?.rateLimitResetCredits;
  const choices =
    credits?.credits?.filter(
      (credit) =>
        credit.status === "available" && credit.resetType === "codexRateLimits",
    ) ?? [];
  const limits =
    data?.rates?.rateLimitsByLimitId ??
    (data?.rates?.rateLimits ? { codex: data.rates.rateLimits } : {});
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-zinc-400">
          Account activity and estimated conversation costs.
        </p>
        <button
          disabled={loading || busy}
          onClick={refresh}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh usage
        </button>
      </div>
      {loading && <p role="status">Loading usage…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data?.errors.map((message) => (
        <p key={message} className="break-words text-amber-300">
          {message}
        </p>
      ))}
      {data?.rates && (
        <>
          <h3 className="font-semibold">Rate limits</h3>
          <p className="text-xs text-zinc-400">
            Included usage:{" "}
            {data.rates.ordinaryUsageAllowed == null
              ? "Availability not reported"
              : data.rates.ordinaryUsageAllowed
                ? "Allowed"
                : "Currently unavailable"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(limits).map(([name, value]) => (
              <Limit key={name} name={name} value={value} />
            ))}
          </div>
        </>
      )}
      {data?.thread && (
        <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
          <h3 className="font-semibold">Conversation estimate</h3>
          <p>
            {number(data.thread.estimatedUsageCreditsMicros / 1_000_000)}{" "}
            credits
            {data.thread.estimatedUsageUsdMicros != null
              ? ` · $${(data.thread.estimatedUsageUsdMicros / 1_000_000).toFixed(4)} USD`
              : ""}
          </p>
          <p className="text-xs text-zinc-400">
            Estimates supplied by Codex; billing may differ.
          </p>
          {data.thread.groups.map((group, index) => (
            <p key={index} className="break-words text-xs">
              {[group.model, group.reasoningEffort, group.speed]
                .filter(Boolean)
                .join(" · ")}{" "}
              · {number(group.estimatedUsageCreditsMicros / 1_000_000)} credits
              · {number(group.totalTokens)} tokens
            </p>
          ))}
        </section>
      )}
      {threadId && data && !data.thread && (
        <p className="text-zinc-400">
          Conversation credit estimate unavailable.
        </p>
      )}
      {data?.activity?.summary && (
        <section className="space-y-2">
          <h3 className="font-semibold">Usage history</h3>
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-700 p-3">
            {[
              ["Lifetime tokens", data.activity.summary.lifetimeTokens],
              ["Peak daily tokens", data.activity.summary.peakDailyTokens],
              [
                "Current streak (days)",
                data.activity.summary.currentStreakDays,
              ],
              [
                "Longest streak (days)",
                data.activity.summary.longestStreakDays,
              ],
              [
                "Longest turn (seconds)",
                data.activity.summary.longestRunningTurnSec,
              ],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs text-zinc-400">{label}</dt>
                <dd>{number(value as number | null)}</dd>
              </div>
            ))}
          </dl>
          <div className="max-h-48 overflow-auto">
            {data.activity.dailyUsageBuckets?.map((bucket) => (
              <div
                key={bucket.startDate}
                className="flex justify-between gap-3 border-b border-zinc-700/50 py-1"
              >
                <span>{bucket.startDate}</span>
                <span>{number(bucket.tokens)} tokens</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
        <h3 className="font-semibold">Usage limit resets</h3>
        <p>
          {credits
            ? `${credits.availableCount} reset credits available`
            : "Reset credits unavailable for this account or server."}
        </p>
        {credits && credits.availableCount > 0 && (
          <>
            <label className="block">
              Reset credit
              <select
                aria-label="Reset credit"
                disabled={busy || confirm}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 p-2"
                value={creditId}
                onChange={(event) => setCreditId(event.target.value)}
              >
                <option value="">Automatically select next credit</option>
                {choices.map((credit) => (
                  <option key={credit.id} value={credit.id}>
                    {credit.title || credit.id} · expires{" "}
                    {date(credit.expiresAt)}
                  </option>
                ))}
              </select>
            </label>
            {choices.find((credit) => credit.id === creditId)?.description && (
              <p className="text-xs text-zinc-400">
                {choices.find((credit) => credit.id === creditId)?.description}
              </p>
            )}
            {confirm ? (
              <div className="space-y-2">
                <p>
                  Redeem one reset credit for the eligible rate-limit windows?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    disabled={busy}
                    className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
                    onClick={() => void redeem()}
                  >
                    {busy ? "Redeeming…" : "Confirm redeem"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setConfirm(false)}
                    className="rounded border border-zinc-700 px-3 py-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                disabled={busy || loading}
                onClick={() => setConfirm(true)}
                className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
              >
                Redeem reset credit
              </button>
            )}
          </>
        )}
        {result && (
          <p role="status" className="break-words">
            {result}
          </p>
        )}
      </section>
    </div>
  );
}
