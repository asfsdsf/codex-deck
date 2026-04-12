import type {
  CollapsedViewportLine,
  CollapsedViewportSegment,
} from "../message-viewport-groups";
import { useHighlightedShellCommand } from "./tool-renderers/shell-highlight";

function getCollapsedSegmentClassName(
  segment: CollapsedViewportSegment,
): string {
  switch (segment.kind) {
    case "label":
      return "font-semibold text-amber-200";
    case "detail":
      return "text-zinc-300";
    case "path":
      return "font-medium text-cyan-100";
    case "query":
      return "font-medium text-emerald-200";
    case "range":
      return "font-medium text-violet-200";
    case "count-add":
      return "text-emerald-300";
    case "count-remove":
      return "text-rose-300";
    case "punctuation":
      return "text-zinc-500";
    case "command":
      return "command-syntax text-zinc-100";
    case "error":
      return "text-rose-200";
    default:
      return "text-inherit";
  }
}

function getCollapsedSegmentSpacingClassName(
  segment: CollapsedViewportSegment,
  index: number,
): string {
  if (segment.kind === "punctuation") {
    return segment.text === "(" || segment.text === ")" ? "" : "mx-1";
  }

  return index === 0 ? "" : "ml-1";
}

function ShellHighlightedInlineCommand(props: {
  command: string;
  className: string;
}) {
  const { command, className } = props;
  const highlightedCommand = useHighlightedShellCommand(command);

  return (
    <span
      className={`command-syntax-inline ${className}`}
      dangerouslySetInnerHTML={{ __html: highlightedCommand }}
    />
  );
}

export function CollapsedViewportSummary(props: {
  line: CollapsedViewportLine;
}): JSX.Element {
  const { line } = props;

  if (Array.isArray(line.segments) && line.segments.length > 0) {
    return (
      <span className="block min-w-0 flex-1 truncate whitespace-nowrap">
        {line.segments.map((segment, index) => {
          const className = getCollapsedSegmentClassName(segment);
          const spacingClassName = getCollapsedSegmentSpacingClassName(
            segment,
            index,
          );

          if (segment.kind === "command") {
            return (
              <ShellHighlightedInlineCommand
                key={`${segment.kind}:${index}:${segment.text}`}
                command={segment.text}
                className={`${className} ${spacingClassName} whitespace-pre`}
              />
            );
          }

          return (
            <span
              key={`${segment.kind}:${index}:${segment.text}`}
              className={`${className} ${spacingClassName}`}
            >
              {segment.text}
            </span>
          );
        })}
      </span>
    );
  }

  return <span className="min-w-0 flex-1 truncate">{line.text}</span>;
}
