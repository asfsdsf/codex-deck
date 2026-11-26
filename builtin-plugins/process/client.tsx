import ProcessPane from "../../web/components/process-pane";
import type { RightPaneToolProps } from "../right-pane/types";
import EmptyState from "../right-pane/empty-state";
export default function View(props: RightPaneToolProps) {
  return props.threadId ? (
    <ProcessPane
      key={props.runtimeScopeKey + ":" + props.threadId}
      threadId={props.threadId}
      connectionMode={props.connectionMode ?? "local"}
    />
  ) : (
    <EmptyState text="Open a session to inspect its background processes and output." />
  );
}
