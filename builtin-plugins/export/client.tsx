import TranscriptExport from "./transcript-export";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return context.threadId ? (
    <TranscriptExport threadId={context.threadId} filename={context.args} />
  ) : (
    <p>Select a session to export.</p>
  );
}
