import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export default function RightPaneTab({
  label,
  icon,
  active,
  quiet,
  kind,
  onSelect,
  onClose,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  quiet?: boolean;
  kind: string;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const labelElement = useRef<HTMLSpanElement>(null);
  const [fileWidth, setFileWidth] = useState(100);
  useLayoutEffect(() => {
    if (!kind.startsWith("file:") || !labelElement.current) return;
    const range = document.createRange();
    range.selectNodeContents(labelElement.current);
    // Document chips grow with their title before the strip starts scrolling.
    setFileWidth(
      Math.max(100, Math.min(170, range.getBoundingClientRect().width + 45)),
    );
  }, [kind, label]);
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      title={label}
      data-right-pane-tab={kind}
      style={
        kind.startsWith("file:")
          ? { width: fileWidth, flexBasis: fileWidth }
          : undefined
      }
      className={`right-pane__tab ${active && !quiet ? "right-pane__active-tab" : ""} ${quiet ? "right-pane__quiet-tab" : ""}`}
      onClick={onSelect}
      onAuxClick={(event) => {
        if (event.button === 1 && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const tabs = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
              '[role="tab"]',
            ) ?? [],
          );
          const index = tabs.indexOf(event.currentTarget);
          tabs[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) %
                  tabs.length
          ]?.focus();
        }
      }}
    >
      <span className="right-pane__tab-title">
        {icon}
        <span ref={labelElement} className="right-pane__tab-label">
          {label}
        </span>
      </span>
      {onClose ? (
        <button
          type="button"
          className="right-pane__close-tab"
          aria-label="Close"
          title={`Close ${label} tab`}
          tabIndex={active ? 0 : -1}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
