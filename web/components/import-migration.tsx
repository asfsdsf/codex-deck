import { useCallback, useEffect, useState } from "react";
import type { ImportDetection, ImportRun } from "../../api/codex-import";
import {
  detectCodexImport,
  dismissCodexImport,
  getCodexImport,
  startCodexImport,
} from "../extensions-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import {
  importGroups,
  importItemCount,
  importItemDescription,
  importItemDetail,
  importItemLabel,
  importResultTotals,
  importTypeLabel,
  remainingItemsHandoff,
} from "../import-migration-model";

const button =
  "min-h-9 rounded border border-zinc-700 px-3 py-1.5 disabled:opacity-50";

function RunStatus({
  run,
  busy,
  onDismiss,
}: {
  run: ImportRun;
  busy: boolean;
  onDismiss: () => void;
}) {
  const totals = importResultTotals(run.results);
  const summary = new Map<string, { count: number }>();
  for (const item of run.items) {
    const entry = summary.get(item.itemType) ?? { count: 0 };
    entry.count += importItemCount(item);
    summary.set(item.itemType, entry);
  }
  const handoff = remainingItemsHandoff(run.remainingItemCount);
  return (
    <section
      aria-live="polite"
      className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3"
    >
      {run.status === "running" && (
        <>
          <p>
            <span className="font-semibold text-cyan-300">Import started.</span>{" "}
            You can keep working while it finishes.
          </p>
          <p className="text-xs text-zinc-400">
            Imported setup will apply to new chats. Source: {run.sourceLabel}
          </p>
          <p className="font-semibold">Importing:</p>
          <ul className="space-y-0.5 text-xs">
            {[...summary].map(([type, entry]) => (
              <li key={type}>
                <span className="text-cyan-300">{importTypeLabel(type)}</span>:{" "}
                {entry.count}
              </li>
            ))}
          </ul>
          {handoff && <p className="text-xs text-zinc-400">{handoff}</p>}
        </>
      )}
      {run.status === "failed" && (
        <p role="alert" className="break-words text-red-400">
          {run.error}
        </p>
      )}
      {run.status === "completed" && (
        <p className="font-semibold">
          Import finished:{" "}
          <span className="text-emerald-300">{totals.imported} imported</span>,{" "}
          <span className={totals.failed ? "text-red-400" : "text-emerald-300"}>
            {totals.failed} failed
          </span>
          .
        </p>
      )}
      {run.results.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Results by type:</p>
          <ul className="space-y-1 text-xs">
            {run.results.map((result) => (
              <li key={result.itemType} className="min-w-0">
                <span className="text-cyan-300">
                  {importTypeLabel(result.itemType)}
                </span>
                :{" "}
                <span className="text-emerald-300">
                  {result.successes.length} imported
                </span>
                ,{" "}
                <span
                  className={
                    result.failures.length ? "text-red-400" : "text-emerald-300"
                  }
                >
                  {result.failures.length} failed
                </span>
                {result.failures.map((failure, index) => (
                  <p key={index} className="ml-3 break-words text-red-300">
                    {failure.source ? `${failure.source}: ` : ""}
                    {failure.message}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.status !== "running" && (
        <>
          <p className="text-xs text-zinc-400">
            Run /import again to check for additional items.
          </p>
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={onDismiss}
          >
            Check again
          </button>
        </>
      )}
    </section>
  );
}

export default function ImportMigration({ cwd }: { cwd: string | null }) {
  const load = useCallback(() => getCodexImport(), []);
  const { data, error, setData } = useNativeSnapshot("import", null, load);
  const [detection, setDetection] = useState<ImportDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const run = data?.run ?? null;

  const detect = useCallback(async () => {
    setDetecting(true);
    setActionError("");
    try {
      const result = await detectCodexImport(cwd);
      setDetection(result);
      const only = result.sources.length === 1 ? result.sources[0] : null;
      setSourceId(only?.id ?? null);
      setSelected(new Set(only?.items.map((_, index) => index) ?? []));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDetecting(false);
    }
  }, [cwd]);
  const showPicker = data !== null && (!run || run.status !== "running");
  useEffect(() => {
    if (showPicker && !detection && !detecting) void detect();
    // Detection runs once per dialog (and again after "Check again").
  }, [showPicker]);

  const source =
    detection?.sources.find((entry) => entry.id === sourceId) ?? null;
  const items = source?.items ?? [];

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError("");
    try {
      await work();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {run && (
        <RunStatus
          run={run}
          busy={busy}
          onDismiss={() =>
            void act(async () => {
              setData(await dismissCodexImport(run.id));
              setDetection(null);
              await detect();
            })
          }
        />
      )}
      {showPicker && !run && (
        <>
          {detecting && (
            <p role="status" className="text-zinc-400">
              Checking for importable setup…
            </p>
          )}
          {detection && !detection.sources.length && !detecting && (
            <p>
              {detection.errors.length
                ? `Could not check for importable setup: ${detection.errors.join("; ")}`
                : "No compatible setup was found to import."}
            </p>
          )}
          {detection && detection.sources.length > 1 && !source && (
            <section className="space-y-2">
              <h3 className="font-semibold">Choose an import source</h3>
              <p className="text-zinc-400">
                Select the app whose setup you want to import.
              </p>
              {detection.sources.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`${button} w-full text-left`}
                  onClick={() => {
                    setSourceId(entry.id);
                    setSelected(new Set(entry.items.map((_, index) => index)));
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </section>
          )}
          {source && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  setData(
                    await startCodexImport(
                      source.id,
                      items.filter((_, index) => selected.has(index)),
                      cwd,
                    ),
                  );
                });
              }}
            >
              <div>
                <h3 className="font-semibold">
                  Import setup from {source.label}
                </h3>
                <p className="text-zinc-400">
                  Bring over supported setup from another coding agent. Codex
                  may add files to your current project folder. Your existing
                  setup will not be changed.
                </p>
              </div>
              {importGroups(items).map((group) => {
                const all = group.indices.every((index) => selected.has(index));
                return (
                  <fieldset
                    key={group.label}
                    className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
                  >
                    <legend className="px-1 font-semibold">
                      {group.label}
                    </legend>
                    <label className="flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={all}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            for (const index of group.indices)
                              if (event.target.checked) next.add(index);
                              else next.delete(index);
                            return next;
                          })
                        }
                      />
                      {group.description}
                    </label>
                    {group.indices.map((index) => {
                      const item = items[index];
                      const detail = importItemDetail(item);
                      return (
                        <label
                          key={index}
                          className="flex min-w-0 items-start gap-3 py-1"
                        >
                          <input
                            className="mt-1"
                            type="checkbox"
                            checked={selected.has(index)}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(index);
                                else next.delete(index);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="block font-semibold">
                              {importItemLabel(item)}
                            </span>
                            <span className="block break-words text-xs text-zinc-400">
                              {importItemDescription(item)}
                            </span>
                            {detail && (
                              <span className="block break-words text-xs text-zinc-300">
                                {detail}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || !selected.size}
                  className="min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50"
                >
                  Import selected
                </button>
                {detection && detection.sources.length > 1 && (
                  <button
                    type="button"
                    className={button}
                    onClick={() => setSourceId(null)}
                  >
                    Choose another source
                  </button>
                )}
                <span className="text-xs text-zinc-400">
                  Selected {selected.size} of {items.length} item
                  {items.length === 1 ? "" : "s"}.
                </span>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
