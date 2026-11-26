import MemoryInsights from "./memory-insights";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return <MemoryInsights threadId={context.threadId} />;
}
