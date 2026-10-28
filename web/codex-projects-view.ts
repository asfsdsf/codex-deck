import type { CodexProject, ProjectsSnapshot } from "@codex-deck/api";

export const EMPTY_PROJECTS: ProjectsSnapshot = {
  available: false,
  unavailableReason: null,
  projects: [],
  sections: null,
  threads: {},
};

/** "Project · Section" badge text for a session row, or null when unassigned. */
export function getThreadOrganizationLabel(
  snapshot: ProjectsSnapshot | null,
  threadId: string,
): string | null {
  const thread = snapshot?.threads[threadId];
  if (!snapshot?.available || !thread) return null;
  const project = thread.projectId
    ? snapshot.projects.find((entry) => entry.id === thread.projectId)?.name
    : null;
  const section = thread.sectionId
    ? snapshot.sections?.find((entry) => entry.id === thread.sectionId)?.name
    : null;
  return [project, section].filter(Boolean).join(" · ") || null;
}

/** Recent thread IDs whose working directory is exactly `cwd`. */
export function getThreadsInDirectory(
  snapshot: ProjectsSnapshot,
  cwd: string,
): string[] {
  return Object.entries(snapshot.threads)
    .filter(([, thread]) => thread.cwd === cwd)
    .map(([threadId]) => threadId);
}

/** `beforeProjectId` for moving a project one step up or down. */
export function getProjectMoveTarget(
  projects: CodexProject[],
  index: number,
  direction: -1 | 1,
): string | null | undefined {
  if (direction === -1) return index > 0 ? projects[index - 1].id : undefined;
  if (index >= projects.length - 1) return undefined;
  return projects[index + 2]?.id ?? null;
}

export function parseRootList(value: string): string[] {
  return [
    ...new Set(
      value
        .split("\n")
        .map((root) => root.trim())
        .filter(Boolean),
    ),
  ];
}

/** Stable retry key; `crypto.randomUUID` needs a secure context. */
export function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID();
  return `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
