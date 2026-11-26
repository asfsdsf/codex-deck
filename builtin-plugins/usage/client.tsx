import UsageDashboard from "./usage-dashboard";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return <UsageDashboard threadId={context.threadId} />;
}
