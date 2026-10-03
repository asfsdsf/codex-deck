import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { getTopVisibleMessageNumber } from "../conversation-scroll-position";

interface ConversationPagerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  totalMessages: number;
  messagesPerPage: number;
  onJumpToMessage: (messageNumber: number) => void;
}

function MessageNumberSuffix({ digits }: { digits: string }) {
  return (
    <span
      className="text-[9px] font-normal text-zinc-400"
      style={{
        color: "var(--color-zinc-400)",
        WebkitTextFillColor: "var(--color-zinc-400)",
      }}
      data-message-number-suffix
    >
      {digits}
    </span>
  );
}

function MessageNumber({ number }: { number: number }) {
  const text = String(number);
  return (
    <>
      <span>{text.slice(0, -2)}</span>
      <MessageNumberSuffix digits={text.slice(-2)} />
    </>
  );
}

export default function ConversationPager({
  containerRef,
  totalMessages,
  messagesPerPage,
  onJumpToMessage,
}: ConversationPagerProps) {
  const [topMessageNumber, setTopMessageNumber] = useState(1);
  const [atBottom, setAtBottom] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editingSuffix, setEditingSuffix] = useState("01");
  const frameRef = useRef<number | null>(null);
  const cancelEditRef = useRef(false);
  const editingOffsetRef = useRef(1);
  const currentMessage = Math.max(1, Math.min(topMessageNumber, totalMessages));
  const currentPrefix = String(currentMessage).slice(0, -2);
  const digits = Math.max(String(totalMessages).length, 2);

  const schedulePositionUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      const number = getTopVisibleMessageNumber(container);
      if (number !== null) setTopMessageNumber(number);
      setAtBottom(
        container.scrollHeight - container.scrollTop - container.clientHeight <=
          1,
      );
    });
  }, [containerRef]);

  // Parent commits include virtual-page measurements, expansion, and live updates.
  useLayoutEffect(schedulePositionUpdate);
  useEffect(() => {
    const container = containerRef.current;
    container?.addEventListener("scroll", schedulePositionUpdate, {
      passive: true,
    });
    const observer = new ResizeObserver(schedulePositionUpdate);
    if (container) observer.observe(container);
    return () => {
      observer.disconnect();
      container?.removeEventListener("scroll", schedulePositionUpdate);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [containerRef, schedulePositionUpdate]);

  useEffect(() => {
    if (!editing) setInputValue(currentPrefix);
  }, [currentPrefix, editing]);

  const step = (direction: number) => {
    const container = containerRef.current;
    const current =
      (container && getTopVisibleMessageNumber(container)) ?? currentMessage;
    onJumpToMessage(
      Math.max(
        1,
        Math.min(totalMessages, current + direction * messagesPerPage),
      ),
    );
  };

  const renderStepButton = (direction: number) => (
    <button
      type="button"
      onClick={() => step(direction)}
      disabled={direction < 0 ? currentMessage <= 1 : atBottom}
      className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-zinc-50 hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:opacity-45 disabled:cursor-not-allowed"
      style={{
        color: "var(--app-page-control-foreground)",
        WebkitTextFillColor: "var(--app-page-control-foreground)",
      }}
      aria-label={direction < 0 ? "Previous page" : "Next page"}
      title={`${direction < 0 ? "Previous" : "Next"} ${messagesPerPage} messages`}
    >
      {direction < 0 ? "<" : ">"}
    </button>
  );

  return (
    <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg px-2 py-1">
      <div className="flex items-center justify-center gap-2">
        {renderStepButton(-1)}
        <div
          className="h-7 px-3 inline-flex items-center justify-center rounded border border-zinc-700/70 bg-zinc-900/60 text-[11px] font-mono font-bold text-zinc-50 tabular-nums"
          style={{ minWidth: `${digits * 2 + 6}ch` }}
          data-conversation-position
          data-current-message={currentMessage}
        >
          <div
            className="inline-flex h-full items-center justify-end"
            style={{ width: `${Math.max(digits, 3)}ch` }}
          >
            <div
              className="relative inline-flex h-full items-center justify-end"
              style={{ width: `${Math.max(digits - 2, 1)}ch` }}
            >
              <input
                type="text"
                inputMode="numeric"
                value={inputValue}
                onFocus={() => {
                  const container = containerRef.current;
                  const number =
                    (container && getTopVisibleMessageNumber(container)) ??
                    currentMessage;
                  editingOffsetRef.current = number % 100;
                  setEditingSuffix(String(number % 100).padStart(2, "0"));
                  setInputValue(String(number).slice(0, -2));
                  cancelEditRef.current = false;
                  setEditing(true);
                }}
                onChange={(event) =>
                  setInputValue(event.target.value.replace(/\D+/g, ""))
                }
                onBlur={() => {
                  setEditing(false);
                  if (cancelEditRef.current) return;
                  if (inputValue.length > 0) {
                    const target = Math.max(
                      1,
                      Math.min(
                        totalMessages,
                        Number(inputValue) * 100 + editingOffsetRef.current,
                      ),
                    );
                    setInputValue(String(target).slice(0, -2));
                    if (target !== currentMessage) onJumpToMessage(target);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    cancelEditRef.current = true;
                    event.currentTarget.blur();
                  }
                }}
                className="absolute inset-0 w-full border-0 bg-transparent p-0 text-right outline-none"
                style={{
                  color: editing
                    ? "var(--app-page-control-foreground)"
                    : "transparent",
                  WebkitTextFillColor: editing
                    ? "var(--app-page-control-foreground)"
                    : "transparent",
                }}
                aria-label="Page number"
                title="Edit the leading digits; the last two digits stay fixed"
                placeholder={editing ? "0" : undefined}
              />
              <span
                aria-hidden="true"
                className={editing ? "invisible" : "pointer-events-none"}
              >
                {currentPrefix}
              </span>
            </div>
            <MessageNumberSuffix
              digits={
                editing ? editingSuffix : String(currentMessage).slice(-2)
              }
            />
          </div>
          <span className="px-1 text-zinc-400">/</span>
          <span
            className="text-left"
            style={{ width: `${digits}ch` }}
            data-total-messages
          >
            <MessageNumber number={totalMessages} />
          </span>
        </div>
        {renderStepButton(1)}
      </div>
    </div>
  );
}
