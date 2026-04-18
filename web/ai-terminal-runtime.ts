export {
  cleanAiTerminalExecutionOutput,
  cleanLiveAiTerminalExecutionOutput,
} from "../api/ai-terminal-output";

export type AiTerminalExecutionDisplayState =
  | "running"
  | "completed"
  | "failed";

export interface AiTerminalStepExecution {
  terminalId: string;
  stepId: string;
  command: string;
  cwd: string;
  status: AiTerminalExecutionDisplayState;
  startSeq: number;
  startOffset: number;
  startedAt: number;
  completedAt: number | null;
  frozenOutput: string | null;
}
