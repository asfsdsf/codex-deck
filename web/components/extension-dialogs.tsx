import CodexAccount from "./codex-account";
import ImportMigration from "./import-migration";
import NativeDialog from "./native-dialog";
import PresetsAdmin from "./presets-admin";

export type ExtensionDialogState =
  | {
      kind: "presets";
      threadId: string | null;
      cwd: string | null;
      /** Text after `/presets`, used to start a new preset from a draft. */
      draft?: string;
    }
  | {
      kind: "account";
      threadId: string | null;
      /** `/logout` opens with the logout confirmation showing. */
      confirmLogout?: boolean;
    }
  | { kind: "import"; threadId: string | null; cwd: string | null };

const TITLES: Record<ExtensionDialogState["kind"], string> = {
  presets: "Presets",
  account: "Codex account",
  import: "Import setup",
};

/**
 * Hosts the native account/extension dialogs (`/presets`, `/login`, ...).
 * Kept apart from the main app's `nativeDialog` chain so each surface stays
 * isolated.
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
      {dialog.kind === "account" && (
        <CodexAccount key={key} confirmLogout={dialog.confirmLogout} />
      )}
      {dialog.kind === "import" && (
        <ImportMigration key={key} cwd={dialog.cwd} />
      )}
    </NativeDialog>
  );
}
