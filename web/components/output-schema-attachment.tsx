import { useState } from "react";
import { Braces, X } from "lucide-react";
import {
  parseOutputSchemaDraft,
  summarizeOutputSchema,
} from "../output-schema";

export interface AttachedOutputSchema {
  text: string;
  value: Record<string, unknown>;
}

/** Composer toolbar toggle for attaching a final-answer JSON schema. */
export function OutputSchemaToggleButton(props: {
  attached: boolean;
  open: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = props.attached
    ? "Edit JSON output schema"
    : "Attach JSON output schema";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={label}
      aria-label={label}
      aria-pressed={props.open || props.attached}
      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
    >
      <Braces
        className={`h-4 w-4 ${props.attached ? "text-cyan-300" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}

/** Editor shown above the composer textarea; validates before attaching. */
export function OutputSchemaPanel(props: {
  attached: AttachedOutputSchema | null;
  onAttach: (schema: AttachedOutputSchema) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.attached?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const attach = () => {
    const result = parseOutputSchemaDraft(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onAttach({ text, value: result.value });
  };
  return (
    <div className="mx-3 mt-2 rounded-xl border border-zinc-700/70 bg-zinc-900/70 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-200">
          JSON output schema for the next turn
        </span>
        <button
          type="button"
          onClick={props.onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="Close"
          aria-label="Close output schema editor"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            attach();
          }
        }}
        rows={5}
        spellCheck={false}
        aria-label="JSON output schema"
        placeholder={
          '{\n  "type": "object",\n  "properties": { "answer": { "type": "string" } },\n  "required": ["answer"]\n}'
        }
        className="block w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
      />
      {error ? <p className="mt-1.5 text-xs text-rose-400">{error}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-zinc-500">
          Codex shapes its final answer to this schema. Cleared after sending.
        </span>
        {props.attached ? (
          <button
            type="button"
            onClick={props.onRemove}
            className="min-h-7 rounded border border-zinc-500/50 bg-zinc-800/40 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700/50"
          >
            Remove
          </button>
        ) : null}
        <button
          type="button"
          onClick={attach}
          className="min-h-7 rounded border border-cyan-500/40 bg-cyan-600/20 px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-600/35"
        >
          {props.attached ? "Update" : "Attach"}
        </button>
      </div>
    </div>
  );
}

/** Chip that keeps an attached schema visible until it is sent or removed. */
export function OutputSchemaChip(props: {
  schema: AttachedOutputSchema;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex px-3 pt-2">
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-600/10 py-0.5 pl-2.5 pr-1 text-[11px] text-cyan-200">
        <Braces className="h-3 w-3 shrink-0" aria-hidden="true" />
        <button
          type="button"
          onClick={props.onEdit}
          disabled={props.disabled}
          className="truncate hover:underline"
          title="Edit JSON output schema"
        >
          Output schema: {summarizeOutputSchema(props.schema.value)}
        </button>
        <button
          type="button"
          onClick={props.onRemove}
          disabled={props.disabled}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-cyan-600/25"
          title="Remove JSON output schema"
          aria-label="Remove JSON output schema"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}
