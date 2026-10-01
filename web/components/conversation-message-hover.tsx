import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { ConversationHoverMetadata } from "../conversation-hover-metadata";

interface HoveredMessage {
  element: HTMLElement;
  number: string;
  blockIndex: number | null;
  metadata: ConversationHoverMetadata;
}

export default function ConversationMessageHover({
  containerRef,
  getMetadata,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  getMetadata: (
    messageNumber: number,
    blockIndex: number | null,
  ) => ConversationHoverMetadata | null;
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

  // Refresh metadata as live blocks gain usage or completion details.
  useLayoutEffect(() => {
    const previous = messageRef.current;
    if (!previous) return;
    const metadata = getMetadata(Number(previous.number), previous.blockIndex);
    const next =
      previous.element.isConnected && metadata
        ? { ...previous, metadata }
        : null;
    messageRef.current = next;
    setMessage(next);
  }, [getMetadata]);

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
      const target = event.target as Element;
      const candidate = target.closest<HTMLElement>(
        "[data-search-block-index]",
      );
      const blockElement =
        candidate && element.contains(candidate) ? candidate : null;
      const blockIndex = blockElement
        ? Number(blockElement.dataset.searchBlockIndex)
        : null;
      const hoveredElement = blockElement ?? element;
      const previous = messageRef.current;
      if (
        previous?.element !== hoveredElement ||
        previous.number !== number ||
        previous.blockIndex !== blockIndex
      ) {
        const metadata = getMetadata(Number(number), blockIndex);
        if (!metadata) {
          hide();
          return;
        }
        const next = {
          element: hoveredElement,
          number,
          blockIndex,
          metadata,
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
      frameRef.current = null;
    };
  }, [containerRef, getMetadata, positionTooltip]);

  if (
    !message ||
    (!message.metadata.showNumber &&
      !message.metadata.time &&
      !message.metadata.details.length)
  )
    return null;
  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-[min(360px,calc(100vw-16px))] break-words bg-transparent px-2.5 py-1.5 font-mono text-[10px] text-zinc-200"
    >
      {(message.metadata.showNumber || message.metadata.time) && (
        <div className="flex flex-wrap items-center gap-x-2">
          {message.metadata.showNumber && (
            <span className="font-semibold" data-hover-message-number>
              #{message.number}
            </span>
          )}
          {message.metadata.time && (
            <time
              dateTime={message.metadata.timestamp}
              className="text-zinc-400"
              data-hover-message-time
            >
              {message.metadata.time}
            </time>
          )}
        </div>
      )}
      {message.metadata.details.length > 0 && (
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {message.metadata.details.map(({ label, value }, index) => (
            <div key={`${label}:${index}`} className="contents">
              <dt className="text-zinc-400">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>,
    document.body,
  );
}
