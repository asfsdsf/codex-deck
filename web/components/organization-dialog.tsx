import CodexEnvironments from "./codex-environments";
import CodexProjects from "./codex-projects";
import CodexRemoteControl from "./codex-remote-control";

// Native dialogs for upstream organization and remote APIs. The main app only
// routes slash commands here, keeping its own dialog switch small.

export type OrganizationDialogKind =
  | "remote-control"
  | "environments"
  | "projects";

const COMMANDS: Record<string, OrganizationDialogKind> = {
  "/remote-control": "remote-control",
  "/environments": "environments",
  "/projects": "projects",
};

const TITLES: Record<OrganizationDialogKind, string> = {
  "remote-control": "Codex remote control",
  environments: "Execution environments",
  projects: "Projects and sections",
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
  threadId,
}: {
  kind: OrganizationDialogKind;
  threadId: string | null;
}) {
  switch (kind) {
    case "remote-control":
      return <CodexRemoteControl />;
    case "environments":
      return <CodexEnvironments threadId={threadId} />;
    case "projects":
      return <CodexProjects threadId={threadId} />;
  }
}
