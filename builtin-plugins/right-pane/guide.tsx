import type { PaneEntry } from "../../web/plugins/pane-entries";
import PaneMore from "../../web/plugins/pane-more";
import { FileTypeIcon } from "../../web/components/deepseek/FileTypeIcon";
import { RightPaneIcon } from "../../web/components/deepseek/right-pane-icons";
import { Puzzle, Sparkles, Terminal, Zap } from "lucide-react";
export function ToolIcon({ mode, size }: { mode: string; size: number }) {
  if (mode === "files") return <FileTypeIcon kind="folder" size={size} />;
  if (mode === "git" || mode === "tasks")
    return <RightPaneIcon name={mode} size={size} />;
  const Icon =
    mode === "skills"
      ? Sparkles
      : mode === "process"
        ? Terminal
        : mode === "hooks"
          ? Zap
          : Puzzle;
  return <Icon size={size} aria-hidden="true" />;
}
export default function RightPaneGuide({
  entries,
  onOpen,
  onBrowse,
  onCreate,
}: {
  entries: PaneEntry[];
  onOpen: (key: string) => void;
  onBrowse: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="right-pane-start">
      <div className="right-pane-start__entries">
        <RightPaneIcon
          name="hero"
          className="right-pane-start__compass"
          size={56}
        />
        {entries.map(({ key, view }) => (
          <button
            key={key}
            type="button"
            onClick={() => onOpen(key)}
            className="right-pane-start__entry"
            data-right-pane-guide-entry={key}
          >
            <span
              className={`right-pane-start__icon right-pane-start__icon--${key}`}
            >
              <ToolIcon mode={key} size={22} />
            </span>
            <span className="right-pane-start__entry-copy">
              <span className="right-pane-start__entry-title">
                {view.title}
              </span>
              {view.description && (
                <span className="right-pane-start__entry-description">
                  {view.description}
                </span>
              )}
            </span>
          </button>
        ))}
        <PaneMore side="right" onBrowse={onBrowse} onCreate={onCreate} />
      </div>
    </div>
  );
}
