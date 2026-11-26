import DaybreakSettings from "./daybreak-settings";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return context.threadId ? (
    <DaybreakSettings
      threadId={context.threadId}
      model={context.model ?? null}
    />
  ) : (
    <p>Select a session to manage Daybreak.</p>
  );
}
