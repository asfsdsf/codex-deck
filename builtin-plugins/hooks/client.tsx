import HooksPane from "../../web/components/hooks-pane";
import type { RightPaneToolProps } from "../right-pane/types";

export default function View(props: RightPaneToolProps) {
  const {
    sessionId,
    hooksData,
    hooksLoading,
    hooksError,
    updatingHookKey,
    onRefreshHooks,
    onSelectHookKey,
    onToggleHookEnabled,
    onTrustHook,
    onTrustAllHooks,
  } = props;
  const catalogTargetId =
    props.threadId ?? props.workflowKey ?? props.sessionId;
  return (
    <div className="right-pane-inspector">
      <HooksPane
        key={props.runtimeScopeKey + ":" + sessionId}
        threadId={props.threadId}
        hooksData={hooksData?.sessionId === catalogTargetId ? hooksData : null}
        hooksLoading={hooksLoading}
        hooksError={hooksError}
        updatingHookKey={updatingHookKey}
        onRefreshHooks={onRefreshHooks}
        onSelectHookKey={onSelectHookKey}
        onToggleHookEnabled={onToggleHookEnabled}
        onTrustHook={onTrustHook}
        onTrustAllHooks={onTrustAllHooks}
      />
    </div>
  );
}
