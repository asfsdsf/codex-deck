import type { RightPaneMode } from "./diff-pane";
import { FileTypeIcon } from "./deepseek/FileTypeIcon";
import { RightPaneIcon } from "./deepseek/right-pane-icons";
import { Sparkles, Terminal, Zap } from "lucide-react";

const entries: Array<{
  mode: Extract<
    RightPaneMode,
    "files" | "git" | "tasks" | "process" | "skills" | "hooks"
  >;
  title: string;
  description: string;
}> = [
  {
    mode: "files",
    title: "Files",
    description: "Browse workspace files",
  },
  {
    mode: "git",
    title: "Git",
    description: "Changes in the working tree",
  },
  {
    mode: "tasks",
    title: "Tasks",
    description: "Subagents spawned by this session",
  },
  {
    mode: "skills",
    title: "Skills",
    description: "Explore and manage agent capabilities",
  },
  {
    mode: "hooks",
    title: "Hooks",
    description: "Manage automation and view executions",
  },
  {
    mode: "process",
    title: "Process",
    description: "Background processes and live output",
  },
];

export default function RightPaneGuide(props: {
  onOpen: (mode: RightPaneMode) => void;
}) {
  return (
    <div className="right-pane-start">
      <div className="right-pane-start__entries">
        <RightPaneIcon
          name="hero"
          className="right-pane-start__compass"
          size={56}
        />
        {entries.map(({ mode, title, description }) => (
          <button
            key={mode}
            type="button"
            onClick={() => props.onOpen(mode)}
            className="right-pane-start__entry"
            data-right-pane-guide-entry={mode}
          >
            <span
              className={`right-pane-start__icon right-pane-start__icon--${mode}`}
            >
              {mode === "files" ? (
                <FileTypeIcon kind="folder" size={22} />
              ) : mode === "skills" ? (
                <Sparkles size={22} aria-hidden="true" />
              ) : mode === "hooks" ? (
                <Zap size={22} aria-hidden="true" />
              ) : mode === "process" ? (
                <Terminal size={22} aria-hidden="true" />
              ) : (
                <RightPaneIcon name={mode} size={22} />
              )}
            </span>
            <span className="right-pane-start__entry-copy">
              <span className="right-pane-start__entry-title">{title}</span>
              <span className="right-pane-start__entry-description">
                {description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
