import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

const ACTION_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='slider']",
  "[role='textbox']",
  "[data-conversation-click-action='true']",
].join(", ");

function isCanvasClick(event: MouseEvent<HTMLDivElement>): boolean {
  const target = event.target;
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    target instanceof Element &&
    event.currentTarget.contains(target) &&
    !target.closest(ACTION_SELECTOR)
  );
}

export default function ConversationCanvas({
  viewMode,
  onViewModeChange,
  children,
}: {
  viewMode: boolean;
  onViewModeChange: (viewMode: boolean) => void;
  children: ReactNode;
}) {
  const clickSequenceRef = useRef({ blocked: false, startedInViewMode: false });

  useEffect(() => {
    if (!viewMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        onViewModeChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewMode, onViewModeChange]);

  return (
    <div
      role="region"
      aria-label="Message canvas"
      tabIndex={-1}
      className="relative flex-1 overflow-hidden touch-manipulation outline-none"
      onClickCapture={(event) => {
        if (event.detail <= 1) {
          clickSequenceRef.current = {
            blocked: false,
            startedInViewMode: viewMode,
          };
        }
        // Remember actions before their handlers can replace or expand content.
        if (!isCanvasClick(event)) clickSequenceRef.current.blocked = true;
      }}
      onClick={(event) => {
        if (viewMode && event.detail === 1 && isCanvasClick(event)) {
          onViewModeChange(false);
        }
      }}
      onDoubleClick={(event) => {
        const sequence = clickSequenceRef.current;
        // A double click used to exit must not immediately enter again.
        if (
          sequence.blocked ||
          sequence.startedInViewMode ||
          !isCanvasClick(event)
        ) {
          return;
        }
        event.currentTarget.focus({ preventScroll: true });
        onViewModeChange(true);
      }}
    >
      {children}
    </div>
  );
}
