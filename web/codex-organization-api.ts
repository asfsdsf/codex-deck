import type {
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
