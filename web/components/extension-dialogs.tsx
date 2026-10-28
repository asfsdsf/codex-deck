import NativeDialog from "./native-dialog";
import PresetsAdmin from "./presets-admin";

export type ExtensionDialogState = {
  kind: "presets";
  threadId: string | null;
  cwd: string | null;
  /** Text after `/presets`, used to start a new preset from a draft. */
  draft?: string;
};

const TITLES: Record<ExtensionDialogState["kind"], string> = {
  presets: "Presets",
};

/**
 * Hosts the native account/extension dialogs (`/presets`, ...). Kept apart
 * from the main app's `nativeDialog` chain so each surface stays isolated.
 */
export default function ExtensionDialogs({
  dialog,
  homeId,
  onClose,
  onRunPreset,
}: {
  dialog: ExtensionDialogState;
  homeId: string | null;
  onClose: () => void;
  onRunPreset: (threadId: string, input: string) => Promise<boolean>;
}) {
  const key = `${homeId}:${dialog.kind}:${dialog.threadId}`;
  return (
    <NativeDialog title={TITLES[dialog.kind]} onClose={onClose}>
      {dialog.kind === "presets" && (
        <PresetsAdmin
          key={key}
          cwd={dialog.cwd}
          initialDraft={dialog.draft}
          runDisabledReason={
            dialog.threadId ? null : "Select a session to run presets."
          }
          onRun={async (input) => {
            if (!dialog.threadId) return false;
            const ran = await onRunPreset(dialog.threadId, input);
            if (ran) onClose();
            return ran;
          }}
        />
      )}
    </NativeDialog>
  );
}
