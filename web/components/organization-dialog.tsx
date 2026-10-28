import CodexRemoteControl from "./codex-remote-control";

// Native dialogs for upstream organization and remote APIs. The main app only
// routes slash commands here, keeping its own dialog switch small.

export type OrganizationDialogKind = "remote-control";

const COMMANDS: Record<string, OrganizationDialogKind> = {
  "/remote-control": "remote-control",
};

const TITLES: Record<OrganizationDialogKind, string> = {
  "remote-control": "Codex remote control",
};

export function getOrganizationDialogForCommand(
  commandName: string,
): OrganizationDialogKind | null {
  return COMMANDS[commandName] ?? null;
}

export function isOrganizationDialogKind(
  kind: string,
): kind is OrganizationDialogKind {
  return Object.prototype.hasOwnProperty.call(TITLES, kind);
}

export function getOrganizationDialogTitle(kind: string): string | null {
  return isOrganizationDialogKind(kind) ? TITLES[kind] : null;
}

export default function OrganizationDialogBody({
  kind,
}: {
  kind: OrganizationDialogKind;
  threadId: string | null;
}) {
  switch (kind) {
    case "remote-control":
      return <CodexRemoteControl />;
  }
}
