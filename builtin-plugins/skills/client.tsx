import SkillsPane from "../../web/components/skills-pane";
import type { RightPaneToolProps } from "../right-pane/types";

export default function View(props: RightPaneToolProps) {
  const {
    skillsData,
    skillsLoading,
    skillsError,
    updatingSkillPath,
    onSelectSkillPath,
    onRefreshSkills,
    onToggleSkillEnabled,
  } = props;
  const catalogTargetId =
    props.threadId ?? props.workflowKey ?? props.sessionId;
  return (
    <SkillsPane
      data={skillsData?.sessionId === catalogTargetId ? skillsData : null}
      loading={skillsLoading}
      error={skillsError}
      updatingPath={updatingSkillPath}
      onSelect={onSelectSkillPath}
      onRefresh={onRefreshSkills}
      onToggle={onToggleSkillEnabled}
    />
  );
}
