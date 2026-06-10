import { getCodexDir, getSessions } from "../storage";
import { getCodexAppServerClient } from "../codex-app-server";
import type { CodexAppServerEvent } from "../storage";
import { getWorkflowSummaryByKey } from "../workflows";

export interface SessionSkillsChangedEvent {
  sessionId: string;
  path: string;
  enabled: boolean;
  effectiveEnabled: boolean;
  timestampMs: number;
}

export interface RouteContextDependencies {
  workflowRouteUnavailable: (headers: Headers) => boolean;
  resolveSessionProjectPath: (
    sessionId: string,
  ) => Promise<string | null | undefined>;
  resolveWorkflowProjectPath: (
    workflowKey: string,
  ) => Promise<string | null | undefined>;
  emitSkillsChanged: (event: SessionSkillsChangedEvent) => void;
  emitAppServerEvent: (event: CodexAppServerEvent) => void;
}

export async function resolveSessionProjectPath(
  sessionId: string,
): Promise<string | null | undefined> {
  const sessions = await getSessions();
  const session = sessions.find((entry) => entry.id === sessionId);
  if (session) {
    const projectPath = session.project?.trim();
    return projectPath ? projectPath : null;
  }

  const getThreadSummary = getCodexAppServerClient().getThreadSummary;
  if (typeof getThreadSummary !== "function") {
    return undefined;
  }

  try {
    const summary = await getThreadSummary(sessionId);
    const cwd = summary.cwd.trim();
    return cwd ? cwd : null;
  } catch {
    return undefined;
  }
}

export async function resolveWorkflowProjectPath(
  workflowKey: string,
): Promise<string | null | undefined> {
  const summary = await getWorkflowSummaryByKey(workflowKey, getCodexDir());
  if (!summary) {
    return undefined;
  }
  const projectPath = summary.projectRoot?.trim();
  return projectPath ? projectPath : null;
}
