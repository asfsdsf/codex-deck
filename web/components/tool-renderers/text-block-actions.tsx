import { Languages, Loader2 } from "lucide-react";
import type { useTextTranslations } from "../../hooks/use-text-translations";
import { CopyButton } from "./copy-button";

interface Props {
  translation: ReturnType<typeof useTextTranslations>;
  copyText: string;
  label: string;
}

export function TextBlockActions({ translation, copyText, label }: Props) {
  const title = translation.showing
    ? "Show original"
    : translation.error
      ? `Translation failed: ${translation.error}. Click to retry.`
      : `Translate ${label} to Chinese`;
  const actionClass =
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/30 hover:bg-zinc-700/50 transition-colors";

  return (
    <div
      data-text-block-actions={label}
      className="flex min-w-0 flex-wrap items-center justify-end gap-1"
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          translation.toggle();
        }}
        disabled={translation.status === "loading"}
        title={title}
        aria-label={
          translation.showing
            ? "Show original"
            : `Translate ${label} to Chinese`
        }
        aria-pressed={translation.showing}
        aria-busy={translation.status === "loading"}
        className={actionClass}
      >
        {translation.status === "loading" ? (
          <Loader2 size={12} className="animate-spin text-zinc-400" />
        ) : (
          <Languages
            size={12}
            className={
              translation.showing
                ? "text-cyan-300"
                : translation.error
                  ? "text-rose-400"
                  : "text-zinc-500 hover:text-zinc-300"
            }
          />
        )}
      </button>
      <CopyButton
        text={copyText}
        title={`Copy ${label}`}
        className={actionClass}
      />
      {translation.error && (
        <p role="status" className="w-full break-words text-xs text-rose-400">
          Translation failed: {translation.error}
        </p>
      )}
    </div>
  );
}
