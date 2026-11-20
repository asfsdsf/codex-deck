import { useCallback, useState } from "react";
import {
  PRESET_SLOTS,
  validatePresetInput,
  type CodexPreset,
} from "../../api/codex-presets";
import {
  deleteCodexPreset,
  getCodexPresets,
  saveCodexPreset,
} from "../extensions-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

/** Mirrors upstream `quick_dial_label`: label, else the first input line. */
export function presetDisplayLabel(preset: {
  input: string;
  label: string | null;
}): string {
  const text = preset.label?.trim() ? preset.label : preset.input;
  return text.trimStart().split("\n")[0] ?? "";
}

interface Editor {
  slot: string;
  label: string;
  input: string;
  editing: boolean;
}
type Pending =
  | { kind: "save"; editor: Editor; previous: CodexPreset | null }
  | { kind: "delete"; preset: CodexPreset };

const buttonClass =
  "min-h-9 rounded border border-zinc-700 px-3 py-1.5 disabled:opacity-50";

export default function PresetsAdmin({
  cwd,
  initialDraft,
  runDisabledReason,
  onRun,
}: {
  cwd: string | null;
  initialDraft?: string;
  runDisabledReason: string | null;
  onRun: (input: string) => Promise<boolean>;
}) {
  const load = useCallback(() => getCodexPresets(cwd), [cwd]);
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "presets",
    null,
    load,
  );
  const presets = data?.presets ?? [];
  const bySlot = new Map(presets.map((preset) => [preset.slot, preset]));
  const firstEmpty = PRESET_SLOTS.find((slot) => !bySlot.has(slot)) ?? "1";
  const [editor, setEditor] = useState<Editor | null>(() =>
    initialDraft?.trim()
      ? { slot: "", label: "", input: initialDraft, editing: false }
      : null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");

  const editorSlot = editor ? editor.slot || firstEmpty : "";
  const editorError = editor ? validatePresetInput(editor.input) : null;
  const editorBytes = editor
    ? new TextEncoder().encode(editor.input).length
    : 0;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await work();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const commitSave = (target: Editor) =>
    act(async () => {
      const snapshot = await saveCodexPreset(
        target.slot,
        { input: target.input, label: target.label.trim() || null },
        { expectedVersion: data?.version ?? null, cwd },
      );
      setData(snapshot);
      setPending(null);
      setEditor(null);
      setMessage(`Saved preset ${target.slot}.`);
    });
  const requestSave = () => {
    if (!editor || editorError) return;
    const target = { ...editor, slot: editorSlot };
    const previous = bySlot.get(target.slot) ?? null;
    if (previous?.readOnly) {
      setActionError(
        `Preset ${target.slot} is defined outside your user config. Edit its source configuration instead.`,
      );
      return;
    }
    // Upstream saves into an empty slot directly and confirms replacements.
    if (previous) setPending({ kind: "save", editor: target, previous });
    else void commitSave(target);
  };
  const run = (preset: CodexPreset) =>
    act(async () => {
      if (preset.invalidReason)
        throw new Error(`Preset ${preset.slot}: ${preset.invalidReason}`);
      await onRun(preset.input);
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Run or save reusable prompts and slash commands. Presets are stored in
        your Codex config (<code className="break-all">tui.presets</code>) and
        are shared with Codex CLI.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className="min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50"
          onClick={() => {
            setPending(null);
            setEditor({ slot: "", label: "", input: "", editing: false });
          }}
        >
          New preset
        </button>
        <button
          type="button"
          disabled={busy || loading}
          className={buttonClass}
          onClick={refresh}
        >
          Refresh
        </button>
      </div>
      {runDisabledReason && (
        <p className="text-xs text-amber-300">{runDisabledReason}</p>
      )}
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {message && (
        <p role="status" className="text-emerald-300">
          {message}
        </p>
      )}
      {loading && !data && <p role="status">Loading presets…</p>}

      {editor && (
        <form
          className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            requestSave();
          }}
        >
          <h3 className="font-semibold">
            {editor.editing && bySlot.has(editor.slot)
              ? `Edit preset ${editor.slot}`
              : "New preset"}
          </h3>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Slot</span>
              <select
                value={editorSlot}
                disabled={editor.editing || busy}
                onChange={(event) =>
                  setEditor({ ...editor, slot: event.target.value })
                }
                className="min-h-9 rounded border border-zinc-700 bg-zinc-950 px-2"
              >
                {PRESET_SLOTS.map((slot) => {
                  const saved = bySlot.get(slot);
                  return (
                    <option key={slot} value={slot} disabled={saved?.readOnly}>
                      {slot}
                      {saved ? ` · ${presetDisplayLabel(saved)}` : " · empty"}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-xs text-zinc-400">Label</span>
              <input
                value={editor.label}
                maxLength={120}
                placeholder="Optional short name"
                onChange={(event) =>
                  setEditor({ ...editor, label: event.target.value })
                }
                className="min-h-9 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2"
              />
            </label>
          </div>
          <textarea
            value={editor.input}
            aria-label="Preset input"
            placeholder="Write a prompt or slash command"
            rows={5}
            onChange={(event) =>
              setEditor({ ...editor, input: event.target.value })
            }
            className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={editorError ? "text-red-400" : "text-zinc-500"}>
              {editor.input.trim() && editorError
                ? editorError
                : `${editorBytes.toLocaleString()} / 8,000 bytes`}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setEditor(null);
                  setPending(null);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || Boolean(editorError)}
                className="min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50"
              >
                {bySlot.has(editorSlot) ? "Review changes" : "Save preset"}
              </button>
            </span>
          </div>
        </form>
      )}

      {pending && (
        <div
          role="alertdialog"
          aria-label="Confirm preset change"
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="font-semibold">
            {pending.kind === "delete"
              ? `Delete preset ${pending.preset.slot}?`
              : `Replace preset ${pending.editor.slot}?`}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-300">
            {pending.kind === "delete"
              ? presetDisplayLabel(pending.preset)
              : `${pending.previous?.input.trim() ?? ""}\n→ ${pending.editor.input.trim()}`}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className="min-h-9 rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50"
              onClick={() =>
                pending.kind === "save"
                  ? void commitSave(pending.editor)
                  : void act(async () => {
                      const snapshot = await deleteCodexPreset(
                        pending.preset.slot,
                        { expectedVersion: data?.version ?? null, cwd },
                      );
                      setData(snapshot);
                      setPending(null);
                      setMessage(`Deleted preset ${pending.preset.slot}.`);
                    })
              }
            >
              {pending.kind === "delete"
                ? `Delete preset ${pending.preset.slot}`
                : `Replace preset ${pending.editor.slot}`}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {data && !presets.length && !editor && (
        <p className="text-zinc-400">No presets saved. Create one to start.</p>
      )}
      <ul className="space-y-2">
        {presets.map((preset) => (
          <li
            key={preset.slot}
            className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-600 font-mono text-xs">
                {preset.slot}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold">
                  {presetDisplayLabel(preset)}
                </p>
                {preset.label && (
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs text-zinc-400">
                    {preset.input}
                  </p>
                )}
                {preset.readOnly && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Defined in {preset.source ?? "another"} configuration ·
                    read-only here
                  </p>
                )}
                {preset.invalidReason && (
                  <p className="mt-1 text-xs text-red-400">
                    {preset.invalidReason}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  busy ||
                  Boolean(runDisabledReason) ||
                  Boolean(preset.invalidReason)
                }
                className="min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() => void run(preset)}
              >
                Run
              </button>
              <button
                type="button"
                disabled={busy || preset.readOnly}
                className={buttonClass}
                onClick={() => {
                  setPending(null);
                  setEditor({
                    slot: preset.slot,
                    label: preset.label ?? "",
                    input: preset.input,
                    editing: true,
                  });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy || preset.readOnly}
                className={buttonClass}
                onClick={() => setPending({ kind: "delete", preset })}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
