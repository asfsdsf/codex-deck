import CenteredConfirmDialog from "./centered-confirm-dialog";

interface MemoriesModalProps {
  open: boolean;
  useEnabled: boolean;
  generateEnabled: boolean;
  loading: boolean;
  saving: boolean;
  resetting: boolean;
  showResetConfirm: boolean;
  onClose: () => void;
  onChangeUseEnabled: (value: boolean) => void;
  onChangeGenerateEnabled: (value: boolean) => void;
  onSave: () => void;
  onShowResetConfirm: () => void;
  onHideResetConfirm: () => void;
  onConfirmReset: () => void;
}

export default function MemoriesModal(props: MemoriesModalProps) {
  const {
    open,
    useEnabled,
    generateEnabled,
    loading,
    saving,
    resetting,
    showResetConfirm,
    onClose,
    onChangeUseEnabled,
    onChangeGenerateEnabled,
    onSave,
    onShowResetConfirm,
    onHideResetConfirm,
    onConfirmReset,
  } = props;

  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
        onClick={(event) => {
          if (event.target !== event.currentTarget || saving || resetting) {
            return;
          }
          onClose();
        }}
      >
        <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="text-sm font-semibold text-zinc-100">Memories</div>
            <div className="mt-1 text-xs text-zinc-400">
              Choose how Codex uses and creates memories.
            </div>
          </div>
          <div className="space-y-3 p-4">
            {loading ? (
              <div className="rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                Loading memory settings...
              </div>
            ) : (
              <>
                <label className="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-900/70 px-3 py-3 transition-colors hover:bg-zinc-800/70">
                  <input
                    type="checkbox"
                    checked={useEnabled}
                    onChange={(event) => onChangeUseEnabled(event.target.checked)}
                    disabled={saving || resetting}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-100">
                      Use memories
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
                      Use memories in following threads. Applied at next thread.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-900/70 px-3 py-3 transition-colors hover:bg-zinc-800/70">
                  <input
                    type="checkbox"
                    checked={generateEnabled}
                    onChange={(event) =>
                      onChangeGenerateEnabled(event.target.checked)
                    }
                    disabled={saving || resetting}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-zinc-100">
                      Generate memories
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
                      Generate memories from following threads. Current thread included.
                    </span>
                  </span>
                </label>
                <div className="rounded border border-red-900/60 bg-red-950/20 px-3 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-red-100">
                        Reset all memories
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-red-200/75">
                        Clear local memory files and rollout summaries.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onShowResetConfirm}
                      disabled={saving || resetting || loading}
                      className="h-8 shrink-0 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {resetting ? "Resetting..." : "Reset"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || resetting}
              className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={loading || saving || resetting}
              className="h-8 rounded border border-blue-600/70 bg-blue-600/30 px-3 text-xs text-blue-100 transition-colors hover:bg-blue-600/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
      {showResetConfirm ? (
        <CenteredConfirmDialog
          title="Reset All Memories?"
          message="This clears local memory files and rollout summaries. This cannot be undone."
          tone="danger"
        >
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onHideResetConfirm}
              disabled={resetting}
              className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmReset}
              disabled={resetting}
              className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resetting ? "Resetting..." : "Reset all memories"}
            </button>
          </div>
        </CenteredConfirmDialog>
      ) : null}
    </>
  );
}
