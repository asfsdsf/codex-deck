export type CenterViewMode = "session" | "terminal" | "workflow";

export type RightPaneTarget =
  | {
      kind: "session";
      sessionId: string;
    }
  | {
      kind: "workflow-project";
      workflowKey: string;
      projectPath: string;
    }
  | null;

export interface ResolveRightPaneTargetInput {
  centerView: CenterViewMode;
  selectedSessionId: string | null;
  terminalSessionId: string | null;
  workflowProjectPath: string | null;
  workflowKey: string | null;
}

export function resolveRightPaneTarget(
  input: ResolveRightPaneTargetInput,
): RightPaneTarget {
  if (input.centerView === "workflow") {
    if (!input.workflowProjectPath || !input.workflowKey) {
      return null;
    }
    return {
      kind: "workflow-project",
      workflowKey: input.workflowKey,
      projectPath: input.workflowProjectPath,
    };
  }

  if (input.centerView === "terminal") {
    if (!input.terminalSessionId) {
      return null;
    }
    return {
      kind: "session",
      sessionId: input.terminalSessionId,
    };
  }

  if (!input.selectedSessionId) {
    return null;
  }

  return {
    kind: "session",
    sessionId: input.selectedSessionId,
  };
}

export interface ResolvePaneSlashCommandNavigationInput {
  centerView: CenterViewMode;
  commandSessionId: string | null;
  paneSessionId: string | null;
}

export interface PaneSlashCommandNavigation {
  preserveCenterView: boolean;
  shouldClearWorkflowTaskSelection: boolean;
  shouldSelectCommandSession: boolean;
}

export function resolvePaneSlashCommandNavigation(
  input: ResolvePaneSlashCommandNavigationInput,
): PaneSlashCommandNavigation {
  const commandSessionId = input.commandSessionId?.trim() || null;
  const paneSessionId = input.paneSessionId?.trim() || null;

  if (commandSessionId && paneSessionId === commandSessionId) {
    return {
      preserveCenterView: true,
      shouldClearWorkflowTaskSelection: input.centerView === "workflow",
      shouldSelectCommandSession: false,
    };
  }

  return {
    preserveCenterView: false,
    shouldClearWorkflowTaskSelection: false,
    shouldSelectCommandSession: !!commandSessionId,
  };
}
