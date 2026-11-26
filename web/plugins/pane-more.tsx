import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis, Puzzle, PencilLine } from "lucide-react";

export default function PaneMore({
  side,
  compact,
  onBrowse,
  onCreate,
}: {
  side: "left" | "right";
  compact?: boolean;
  onBrowse: () => void;
  onCreate: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector("button")?.focus();
    const close = () => setPosition(null);
    function dismiss(e: PointerEvent | FocusEvent) {
      if (
        !menu.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close();
    }
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [position]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="pane-more-trigger"
        aria-label={`More ${side} pane options`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={!!position}
        aria-controls={position ? id : undefined}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition(
            position
              ? null
              : {
                  left: Math.max(4, Math.min(rect.left, innerWidth - 200)),
                  top:
                    rect.bottom + 96 < innerHeight
                      ? rect.bottom + 4
                      : Math.max(4, rect.top - 90),
                },
          );
        }}
      >
        <Ellipsis size={16} />
        {!compact && "More"}
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={`${side} pane plugins`}
            className="pane-more-menu"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setPosition(null);
                trigger.current?.focus();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll("button"),
                );
                const index = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                items[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length
                ]?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setPosition(null);
                trigger.current?.focus();
                onBrowse();
              }}
            >
              <Puzzle size={15} />
              Browse other plugins
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setPosition(null);
                trigger.current?.focus();
                onCreate();
              }}
            >
              <PencilLine size={15} />
              Create your plugin
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
