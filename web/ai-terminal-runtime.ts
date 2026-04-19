import type {
  TerminalCommandResponse,
  TerminalInputResponse,
  TerminalPersistMessageActionResponse,
} from "@codex-deck/api";
import {
  buildApprovedAiTerminalInput,
  type AiTerminalStepDirective,
} from "./ai-terminal";

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

interface RunApprovedAiTerminalStepInput {
  sessionId: string;
  terminalId: string;
  messageKey: string;
  step: Pick<AiTerminalStepDirective, "stepId" | "command">;
}

interface RunApprovedAiTerminalStepDependencies {
  createClientId?: () => string;
  sendTerminalInput: (
    terminalId: string,
    request: { input: string },
    clientId?: string,
  ) => Promise<TerminalInputResponse>;
  claimTerminalWrite: (
    terminalId: string,
    clientId: string,
  ) => Promise<TerminalCommandResponse>;
  releaseTerminalWrite: (
    terminalId: string,
    clientId: string,
  ) => Promise<TerminalCommandResponse>;
  persistTerminalMessageAction: (
    terminalId: string,
    request: {
      sessionId: string;
      messageKey: string;
      stepId: string;
      decision: "approved";
      reason: null;
    },
  ) => Promise<TerminalPersistMessageActionResponse>;
}

export async function runApprovedAiTerminalStepInTerminal(
  input: RunApprovedAiTerminalStepInput,
  dependencies: RunApprovedAiTerminalStepDependencies,
): Promise<{ actionPersistError: string | null }> {
  const normalizedInput = buildApprovedAiTerminalInput(input.step);
  const clientId =
    dependencies.createClientId?.() ??
    (typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `terminal-approve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  let claimedWrite = false;
  try {
    await dependencies.sendTerminalInput(
      input.terminalId,
      { input: normalizedInput },
      clientId,
    );
  } catch (sendError) {
    const message =
      sendError instanceof Error ? sendError.message : String(sendError);
    if (!message.toLowerCase().includes("owns terminal write")) {
      throw sendError;
    }
    await dependencies.claimTerminalWrite(input.terminalId, clientId);
    claimedWrite = true;
    await dependencies.sendTerminalInput(
      input.terminalId,
      { input: normalizedInput },
      clientId,
    );
  } finally {
    if (claimedWrite) {
      void dependencies.releaseTerminalWrite(input.terminalId, clientId).catch(
        () => {},
      );
    }
  }

  try {
    await dependencies.persistTerminalMessageAction(input.terminalId, {
      sessionId: input.sessionId,
      messageKey: input.messageKey,
      stepId: input.step.stepId,
      decision: "approved",
      reason: null,
    });
    return { actionPersistError: null };
  } catch (persistError) {
    return {
      actionPersistError:
        persistError instanceof Error
          ? persistError.message
          : String(persistError),
    };
  }
}
