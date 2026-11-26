import RetainedWarnings from "./retained-warnings";
import ConfigDiagnostics from "./config-diagnostics";
import type { BuiltinViewProps } from "../client-types";
export default function View({ viewId, context }: BuiltinViewProps) {
  return viewId === "debug-config" ? (
    <ConfigDiagnostics threadId={context.threadId} />
  ) : (
    <RetainedWarnings threadId={context.threadId} />
  );
}
