import ExperimentalFeatures from "./experimental-features";
import type { BuiltinViewProps } from "../client-types";
export default function View({ context }: BuiltinViewProps) {
  return <ExperimentalFeatures threadId={context.threadId} />;
}
