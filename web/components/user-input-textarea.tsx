import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const UserInputResizeContext = createContext<
  ((textarea: HTMLTextAreaElement) => () => void) | null
>(null);

export function UserInputResizeContainer({
  onResizeStart,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  onResizeStart: (textarea: HTMLTextAreaElement) => () => void;
}) {
  return (
    <UserInputResizeContext.Provider value={onResizeStart}>
      <div {...props}>{children}</div>
    </UserInputResizeContext.Provider>
  );
}

export function UserInputTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  const beginResize = useContext(UserInputResizeContext);
  const [height, setHeight] = useState<number>();

  const finishResize = () => {
    dragRef.current = null;
    finishRef.current?.();
    finishRef.current = null;
  };
  useEffect(() => () => finishRef.current?.(), []);

  return (
    <div className="relative">
      <textarea
        {...props}
        ref={textareaRef}
        data-user-input-answer
        style={{
          ...props.style,
          display: "block",
          resize: "none",
          height: height ?? props.style?.height,
        }}
      />
      {!props.disabled && (
        <button
          type="button"
          aria-label="Resize answer"
          title="Drag to resize, or use the up and down arrow keys"
          className="absolute bottom-0 right-0 flex h-5 w-5 touch-none cursor-ns-resize items-center justify-center rounded-sm text-zinc-500 focus-visible:outline-2 focus-visible:outline-violet-400"
          onPointerDown={(event) => {
            const textarea = textareaRef.current;
            if (event.button !== 0 || !textarea) return;
            // Prevent focusing the handle from scrolling the conversation.
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            finishResize();
            finishRef.current = beginResize?.(textarea) ?? null;
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startHeight: textarea.getBoundingClientRect().height,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setHeight(
              Math.max(32, drag.startHeight + event.clientY - drag.startY),
            );
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(event) => {
            const textarea = textareaRef.current;
            if (
              !textarea ||
              (event.key !== "ArrowUp" && event.key !== "ArrowDown")
            )
              return;
            event.preventDefault();
            finishResize();
            const finish = beginResize?.(textarea) ?? (() => {});
            finishRef.current = finish;
            setHeight(
              Math.max(
                32,
                textarea.getBoundingClientRect().height +
                  (event.key === "ArrowDown" ? 16 : -16),
              ),
            );
            requestAnimationFrame(() => {
              if (finishRef.current === finish) finishResize();
            });
          }}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
          >
            <path d="m3 10 7-7M7 10l3-3" />
          </svg>
        </button>
      )}
    </div>
  );
}
