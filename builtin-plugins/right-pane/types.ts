import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  SessionDiffResponse,
  SessionFileContentResponse,
  SessionHooksResponse,
  SessionFileTreeNodesResponse,
  SessionSkillsResponse,
  SessionTerminalRunSummary,
  CodexThreadSummary,
} from "@codex-deck/api";
import type { PaneEntry } from "../../web/plugins/pane-entries";
export type RightPaneMode = string;
export interface RightPaneProps {
  entries: PaneEntry[];
  homeId: string;
  onBrowsePlugins: () => void;
  onCreatePlugin: () => void;
  runtimeScopeKey?: string;
  connectionMode?: "local" | "remote";
  collapsed: boolean;
  fileLinkOpenVersion: number;
  isMobilePhone: boolean;
  mode: RightPaneMode;
  sessionId: string | null;
  /** Actual Codex thread ID; null for workflow project targets. */
  threadId: string | null;
  width: number;
  loading: boolean;
  error: string | null;
  diffData: SessionDiffResponse | null;
  fileTreeNodesData: SessionFileTreeNodesResponse | null;
  fileTreeLoadingMore: boolean;
  fileContent: SessionFileContentResponse | null;
  fileContentLoading: boolean;
  fileContentError: string | null;
  fileContentPage: number;
  selectedFilePath: string | null;
  targetLineNumber: number | null;
  terminalRuns: SessionTerminalRunSummary[];
  terminalRunsLoading: boolean;
  terminalRunsError: string | null;
  selectedTerminalRunId: string | null;
  terminalRunOutput: string;
  terminalRunOutputLoading: boolean;
  terminalRunOutputError: string | null;
  hooksData: SessionHooksResponse | null;
  hooksLoading: boolean;
  hooksError: string | null;
  selectedHookKey: string | null;
  updatingHookKey: string | null;
  skillsData: SessionSkillsResponse | null;
  skillsLoading: boolean;
  skillsError: string | null;
  selectedSkillPath: string | null;
  updatingSkillPath: string | null;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onChangeMode: (mode: RightPaneMode) => void;
  onSecondaryModeChange?: (mode: RightPaneMode | null) => void;
  onSelectFilePath: (path: string) => void;
  onOpenFileTreeDirectory: (dirPath: string) => void;
  onLoadMoreFileTreeNodes: () => void;
  onRefreshFiles: () => void;
  onChangeFileContentPage: (page: number) => void;
  onSelectTerminalRun: (processId: string) => void;
  onRefreshTerminalRuns: () => void;
  onSelectHookKey: (key: string) => void;
  onToggleHookEnabled: (
    hook: SessionHooksResponse["hooks"][number],
    enabled: boolean,
  ) => void;
  onTrustHook: (hook: SessionHooksResponse["hooks"][number]) => void;
  onTrustAllHooks: () => void;
  onRefreshHooks: () => void;
  onSelectSkillPath: (path: string) => void;
  onToggleSkillEnabled: (path: string, enabled: boolean) => void;
  onRefreshSkills: () => void;
  agentThreads?: CodexThreadSummary[];
  agentThreadsLoading?: boolean;
  agentThreadsError?: string | null;
  onRefreshAgentThreads?: () => void;
  onOpenAgentThread?: (threadId: string) => void;
  workspacePath?: string | null;
  workflowKey?: string | null;
}
export interface RightPaneToolProps extends RightPaneProps {
  previewOpen: boolean;
  setPreviewOpen: (value: boolean) => void;
}
