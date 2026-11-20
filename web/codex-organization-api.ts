import type {
  CodexProject,
  CodexThreadSection,
  ProjectsSnapshot,
  EnvironmentRegistration,
  EnvironmentsSnapshot,
  RemoteControlPairing,
  RemoteControlSnapshot,
  RemoteControlStatus,
  ThreadReadStateOperation,
  ThreadReadStatesSnapshot,
  ThreadReadStateUpdateResult,
} from "@codex-deck/api";
import { requestJson } from "./transport";

// Browser calls for upstream organization/remote APIs. These go through the
// active transport, so local and remote mode behave the same.

const threadPath = (threadId: string) =>
  `/api/codex/threads/${encodeURIComponent(threadId)}`;
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export function getThreadReadStates(): Promise<ThreadReadStatesSnapshot> {
  return requestJson("/api/codex/read-states");
}

export function updateThreadReadState(
  threadId: string,
  operation: ThreadReadStateOperation,
  expectedRevision: string,
): Promise<ThreadReadStateUpdateResult> {
  return requestJson(
    `${threadPath(threadId)}/read-state`,
    post({ operation, expectedRevision }),
  );
}

// Codex remote control (upstream `remoteControl/*`), not Deck remote access.
export function getCodexRemoteControl(): Promise<RemoteControlSnapshot> {
  return requestJson("/api/codex/remote-control");
}

export function setCodexRemoteControlEnabled(
  enabled: boolean,
  ephemeral: boolean,
): Promise<{ status: RemoteControlStatus }> {
  return requestJson(
    `/api/codex/remote-control/${enabled ? "enable" : "disable"}`,
    post({ ephemeral }),
  );
}

export function startCodexRemoteControlPairing(): Promise<RemoteControlPairing> {
  return requestJson("/api/codex/remote-control/pairing", post({}));
}

export function getCodexRemoteControlPairingStatus(
  pairing: Pick<RemoteControlPairing, "pairingCode" | "manualPairingCode">,
): Promise<{ claimed: boolean }> {
  return requestJson(
    "/api/codex/remote-control/pairing/status",
    post({
      pairingCode: pairing.pairingCode,
      manualPairingCode: pairing.manualPairingCode,
    }),
  );
}

export function revokeCodexRemoteControlClient(
  environmentId: string,
  clientId: string,
): Promise<{ ok: boolean }> {
  return requestJson(
    "/api/codex/remote-control/clients/revoke",
    post({ environmentId, clientId }),
  );
}

// Upstream execution environments (`environment/*`).
export function getCodexEnvironments(
  threadId: string | null,
): Promise<EnvironmentsSnapshot> {
  return requestJson(
    `/api/codex/environments${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}

export function addCodexEnvironment(input: {
  environmentId: string;
  execServerUrl: string;
  authBearerToken: string | null;
  connectTimeoutMs: number | null;
  requiredSkills: string[];
}): Promise<{ registration: EnvironmentRegistration }> {
  return requestJson("/api/codex/environments", post(input));
}

export function setCodexThreadEnvironmentSelection(
  threadId: string,
  selection: { environmentId: string; cwd: string } | null,
): Promise<{ ok: boolean }> {
  return requestJson(
    `${threadPath(threadId)}/environment-selection`,
    post(selection ?? { environmentId: null }),
  );
}

// Named projects and thread sections (upstream `project/*`, `threadSection/*`).
export function getCodexProjects(): Promise<ProjectsSnapshot> {
  return requestJson("/api/codex/projects");
}

export function createCodexProject(input: {
  name: string;
  roots: string[];
  idempotencyKey: string;
  threadIds?: string[];
}): Promise<{ project: CodexProject }> {
  return requestJson("/api/codex/projects", post(input));
}

const projectPath = (projectId: string) =>
  `/api/codex/projects/${encodeURIComponent(projectId)}`;

export function updateCodexProject(
  projectId: string,
  patch: { name?: string; roots?: string[] },
): Promise<{ project: CodexProject }> {
  return requestJson(`${projectPath(projectId)}/update`, post(patch));
}

export function moveCodexProject(
  projectId: string,
  beforeProjectId: string | null,
): Promise<{ ok: boolean }> {
  return requestJson(
    `${projectPath(projectId)}/move`,
    post({ beforeProjectId }),
  );
}

export function deleteCodexProject(
  projectId: string,
): Promise<{ ok: boolean }> {
  return requestJson(`${projectPath(projectId)}/delete`, post({}));
}

export function assignCodexThreadProject(
  threadId: string,
  projectId: string | null,
): Promise<{ ok: boolean }> {
  return requestJson(`${threadPath(threadId)}/project`, post({ projectId }));
}

export function moveCodexThreadSection(
  threadId: string,
  sectionId: string | null,
): Promise<{ ok: boolean }> {
  return requestJson(`${threadPath(threadId)}/section`, post({ sectionId }));
}

const sectionPath = (sectionId: string) =>
  `/api/codex/thread-sections/${encodeURIComponent(sectionId)}`;

export function createCodexThreadSection(
  name: string,
): Promise<{ section: CodexThreadSection }> {
  return requestJson("/api/codex/thread-sections", post({ name }));
}

export function renameCodexThreadSection(
  sectionId: string,
  name: string,
): Promise<{ section: CodexThreadSection }> {
  return requestJson(`${sectionPath(sectionId)}/update`, post({ name }));
}

export function deleteCodexThreadSection(
  sectionId: string,
): Promise<{ ok: boolean }> {
  return requestJson(`${sectionPath(sectionId)}/delete`, post({}));
}
