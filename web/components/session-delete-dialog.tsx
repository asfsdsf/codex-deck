import CenteredConfirmDialog from "./centered-confirm-dialog";

export type SessionDeleteMode = "session" | "session-and-diff-guide" | null;

interface SessionDeleteDialogProps {
  sessionLabel: string;
  hasDiffGuide: boolean;
  deleteMode: SessionDeleteMode;
  onCancel: () => void;
  onConfirm: (deleteDiffGuide: boolean) => void;
}

export default function SessionDeleteDialog({
  sessionLabel,
  hasDiffGuide,
  deleteMode,
  onCancel,
  onConfirm,
}: SessionDeleteDialogProps) {
  const deleting = deleteMode !== null;
  const actions = hasDiffGuide
    ? [
        { label: "Delete session only", deleteDiffGuide: false },
        { label: "Delete session + diff guide", deleteDiffGuide: true },
      ]
    : [{ label: "Delete", deleteDiffGuide: false }];

  return (
    <CenteredConfirmDialog
      tone="danger"
      title={
        hasDiffGuide
          ? "Delete this diff guide session?"
          : "Delete this session?"
      }
      message={
        hasDiffGuide
          ? "This will delete the session. You can keep its generated diff guide files or delete them in the same action."
          : "This will delete the session rollout file, remove matching registry entries, and remove related state-db records."
      }
    >
      <p className="mt-2 break-all text-[11px] text-zinc-500">{sessionLabel}</p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={deleting}
          className="min-h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        {actions.map((action) => {
          const mode =
            hasDiffGuide && action.deleteDiffGuide
              ? "session-and-diff-guide"
              : "session";
          return (
            <button
              key={action.label}
              type="button"
              onClick={() => onConfirm(action.deleteDiffGuide)}
              disabled={deleting}
              className="min-h-8 rounded border border-red-600/70 bg-red-700/25 px-3 py-1.5 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleteMode === mode ? "Deleting..." : action.label}
            </button>
          );
        })}
      </div>
    </CenteredConfirmDialog>
  );
}
