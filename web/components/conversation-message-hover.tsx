import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { formatLocalTimestamp } from "../utils";

interface HoveredMessage {
  element: HTMLElement;
  number: string;
  timestamp: string | undefined;
  time: string | null;
}

export default function ConversationMessageHover({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const [message, setMessage] = useState<HoveredMessage | null>(null);
  const messageRef = useRef<HoveredMessage | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);

  const positionTooltip = useCallback(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    const { x, y } = pointerRef.current;
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - width - 8));
    const top = Math.max(
      8,
      y + height + 20 <= window.innerHeight ? y + 12 : y - height - 12,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, []);

  useLayoutEffect(positionTooltip, [message, positionTooltip]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const hide = () => {
      messageRef.current = null;
      setMessage(null);
    };
    const move = (event: PointerEvent) => {
      const element =
        event.pointerType !== "touch" && event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-message-hover]")
          : null;
      if (!element || !container.contains(element)) {
        hide();
        return;
      }
      const number = element.dataset.conversationMessage;
      if (!number) return;
      const timestamp = element.dataset.messageTimestamp;
      const previous = messageRef.current;
      if (
        previous?.element !== element ||
        previous.number !== number ||
        previous.timestamp !== timestamp
      ) {
        const next = {
          element,
          number,
          timestamp,
          time: formatLocalTimestamp(timestamp),
        };
        messageRef.current = next;
        setMessage(next);
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          positionTooltip();
        });
      }
    };

    container.addEventListener("pointermove", move, { passive: true });
    container.addEventListener("pointerleave", hide);
    container.addEventListener("pointerdown", hide);
    container.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerleave", hide);
      container.removeEventListener("pointerdown", hide);
      container.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [containerRef, positionTooltip]);

  if (!message) return null;
  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="pointer-events-none fixed z-50 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-x-2 rounded-md border border-zinc-700/70 bg-zinc-900 px-2.5 py-1.5 font-mono text-[10px] text-zinc-200 shadow-lg shadow-black/10"
    >
      <span className="font-semibold" data-hover-message-number>
        #{message.number}
      </span>
      {message.time ? (
        <time
          dateTime={message.timestamp}
          className="text-zinc-400"
          data-hover-message-time
        >
          {message.time}
        </time>
      ) : (
        <span className="text-zinc-400">Time unavailable</span>
      )}
    </div>,
    document.body,
  );
}
