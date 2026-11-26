import ConversationRecap from "./conversation-recap";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return context.threadId ? (
    <ConversationRecap threadId={context.threadId} />
  ) : (
    <p>Select a session for a recap.</p>
  );
}
